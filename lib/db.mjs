/**
 * Hebbian Memory — SQLite Database Layer
 *
 * Shared between the OpenClaw plugin and CLI scripts.
 * Uses better-sqlite3 for synchronous, high-performance access.
 *
 * Schema:
 *   memories       — all memory entries (legacy + atomic + session-learned)
 *   tags           — junction table for tag lookups
 *   co_occurrences — bidirectional co-occurrence weights
 *
 * Embeddings: 768-dim float32 vectors from nomic-embed-text via Ollama.
 * Stored as BLOBs, cosine similarity computed in JS (fast enough at <10K entries).
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";

const DEFAULT_DB_PATH = `${homedir()}/.hebbian/hebbian.db`;
const OLLAMA_URL = "http://127.0.0.1:11434/api/embed";

/**
 * HTTP POST using node:http — bypasses undici/fetch which fails inside the
 * gateway process with opaque "fetch failed" errors.
 */
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`Ollama embed failed: ${res.statusCode} ${text}`));
            return;
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`Ollama embed: invalid JSON — ${text.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("Ollama embed timeout (15s)")); });
    req.write(payload);
    req.end();
  });
}
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    title TEXT,
    source TEXT,
    source_section TEXT,
    created TEXT NOT NULL,
    last_retrieved TEXT,
    retrieval_count INTEGER DEFAULT 0,
    content_hash TEXT,
    activation REAL DEFAULT 0,
    detail TEXT,
    domain TEXT,
    pattern_type TEXT,
    embedding BLOB,
    status TEXT DEFAULT 'active',
    superseded_by TEXT,
    corrects TEXT,
    FOREIGN KEY (superseded_by) REFERENCES memories(id),
    FOREIGN KEY (corrects) REFERENCES memories(id)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
  CREATE INDEX IF NOT EXISTS idx_memories_activation ON memories(activation DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_pattern_type ON memories(pattern_type);
  CREATE INDEX IF NOT EXISTS idx_memories_domain_activation ON memories(domain, activation DESC);

  CREATE TABLE IF NOT EXISTS tags (
    memory_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

  CREATE TABLE IF NOT EXISTS co_occurrences (
    memory_a TEXT NOT NULL,
    memory_b TEXT NOT NULL,
    weight REAL DEFAULT 1,
    PRIMARY KEY (memory_a, memory_b),
    FOREIGN KEY (memory_a) REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (memory_b) REFERENCES memories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_co_occ_a ON co_occurrences(memory_a);
  CREATE INDEX IF NOT EXISTS idx_co_occ_b ON co_occurrences(memory_b);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

// ─── Database connection ────────────────────────────────────────────────────

let _db = null;

export function openDb(dbPath = DEFAULT_DB_PATH) {
  if (_db) return _db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA_SQL);

  // Store schema version
  const setMeta = _db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const getMeta = _db.prepare("SELECT value FROM meta WHERE key = ?");
  const ver = getMeta.get("schema_version");
  if (!ver) setMeta.run("schema_version", "3.0");

  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Prepared statements (lazy-init) ────────────────────────────────────────

const stmts = {};

function prepareStatements(db) {
  if (stmts._ready) return stmts;

  stmts.insertMemory = db.prepare(`
    INSERT OR REPLACE INTO memories
      (id, title, source, source_section, created, last_retrieved,
       retrieval_count, content_hash, activation, detail, domain, pattern_type, embedding,
       status, superseded_by, corrects)
    VALUES
      (@id, @title, @source, @source_section, @created, @last_retrieved,
       @retrieval_count, @content_hash, @activation, @detail, @domain, @pattern_type, @embedding,
       @status, @superseded_by, @corrects)
  `);

  stmts.insertTag = db.prepare(`
    INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)
  `);

  stmts.insertCoOcc = db.prepare(`
    INSERT INTO co_occurrences (memory_a, memory_b, weight)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_a, memory_b) DO UPDATE SET weight = weight + excluded.weight
  `);

  stmts.getMemory = db.prepare("SELECT * FROM memories WHERE id = ?");

  stmts.bumpActivation = db.prepare(`
    UPDATE memories
    SET activation = activation + ?,
        retrieval_count = retrieval_count + 1,
        last_retrieved = ?
    WHERE id = ?
  `);

  stmts.getByDomain = db.prepare(`
    SELECT * FROM memories
    WHERE domain = ?
    ORDER BY activation DESC
    LIMIT ?
  `);

  stmts.getTopByActivation = db.prepare(`
    SELECT * FROM memories
    ORDER BY activation DESC
    LIMIT ?
  `);

  stmts.getCoOccurrences = db.prepare(`
    SELECT memory_b AS related_id, weight
    FROM co_occurrences
    WHERE memory_a = ?
    ORDER BY weight DESC
    LIMIT ?
  `);

  stmts.countMemories = db.prepare("SELECT COUNT(*) AS cnt FROM memories");
  stmts.countAtomic = db.prepare("SELECT COUNT(*) AS cnt FROM memories WHERE domain IS NOT NULL AND pattern_type IS NOT NULL");
  stmts.countCoOcc = db.prepare("SELECT COUNT(*) AS cnt FROM co_occurrences");

  stmts.getAllDomains = db.prepare(`
    SELECT domain, COUNT(*) AS cnt, MAX(activation) AS max_act
    FROM memories
    WHERE domain IS NOT NULL
    GROUP BY domain
    ORDER BY cnt DESC
  `);

  stmts.getWithEmbedding = db.prepare("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL");

  stmts.setEmbedding = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");

  stmts.getByDomainAll = db.prepare(`
    SELECT * FROM memories WHERE domain = ? ORDER BY activation DESC
  `);

  stmts.decayAll = db.prepare(`
    UPDATE memories SET activation = activation * ?
  `);

  stmts.getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  stmts.setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

  stmts._ready = true;
  return stmts;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Insert or update a memory entry.
 */
export function upsertMemory(db, entry) {
  const s = prepareStatements(db);
  s.insertMemory.run({
    id: entry.id,
    title: entry.title || null,
    source: entry.source || null,
    source_section: entry.source_section || null,
    created: entry.created || new Date().toISOString(),
    last_retrieved: entry.last_retrieved || null,
    retrieval_count: entry.retrieval_count || 0,
    content_hash: entry.content_hash || null,
    activation: entry.activation || 0,
    detail: entry.detail || null,
    domain: entry.domain || null,
    pattern_type: entry.pattern_type || null,
    embedding: entry.embedding || null,
    status: entry.status || 'active',
    superseded_by: entry.superseded_by || null,
    corrects: entry.corrects || null,
  });

  // Update tags
  if (entry.tags?.length) {
    for (const tag of entry.tags) {
      s.insertTag.run(entry.id, tag);
    }
  }
}

/**
 * Bump activation for a list of memory IDs.
 * Returns the number of bumped entries.
 */
export function bumpActivations(db, ids, amount = 0.5) {
  const s = prepareStatements(db);
  const now = new Date().toISOString();
  let bumped = 0;

  const bumpTx = db.transaction((idList) => {
    for (const id of idList) {
      const info = s.bumpActivation.run(amount, now, id);
      if (info.changes > 0) bumped++;
    }
  });

  bumpTx(ids);
  return bumped;
}

/**
 * Wire co-occurrences between IDs (same-domain patterns retrieved together).
 */
export function wireCoOccurrences(db, ids) {
  const s = prepareStatements(db);

  // Group by domain
  const byDomain = {};
  for (const id of ids) {
    const mem = s.getMemory.get(id);
    if (!mem) continue;
    const d = mem.domain || "general";
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(id);
  }

  const wireTx = db.transaction(() => {
    for (const domainIds of Object.values(byDomain)) {
      if (domainIds.length < 2) continue;
      for (let i = 0; i < domainIds.length; i++) {
        for (let j = i + 1; j < domainIds.length; j++) {
          s.insertCoOcc.run(domainIds[i], domainIds[j], 1);
          s.insertCoOcc.run(domainIds[j], domainIds[i], 1);
        }
      }
    }
  });

  wireTx();
}

/**
 * Get spreading activation — find related patterns via co-occurrences.
 */
export function getSpreadingActivation(db, activeIds, limit = 10) {
  const s = prepareStatements(db);
  const boosts = {};
  const activeSet = new Set(activeIds);

  for (const id of activeIds) {
    const related = s.getCoOccurrences.all(id, 20);
    for (const { related_id, weight } of related) {
      if (activeSet.has(related_id)) continue;
      boosts[related_id] = (boosts[related_id] || 0) + weight * 0.3;
    }
  }

  return Object.entries(boosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, boost]) => {
      const mem = s.getMemory.get(id);
      return mem ? { ...mem, spreadBoost: boost } : null;
    })
    .filter(Boolean);
}

/**
 * Get stats about the memory store.
 */
export function getStats(db) {
  const s = prepareStatements(db);
  return {
    total: s.countMemories.get().cnt,
    atomic: s.countAtomic.get().cnt,
    coOccurrences: s.countCoOcc.get().cnt,
    domains: s.getAllDomains.all(),
  };
}

/**
 * Apply decay to all activations (multiplicative).
 */
export function decayAll(db, factor = 0.9995) {
  const s = prepareStatements(db);
  return s.decayAll.run(factor);
}

/**
 * Get/set metadata.
 */
export function getMeta(db, key) {
  const s = prepareStatements(db);
  const row = s.getMeta.get(key);
  return row?.value ?? null;
}

export function setMeta(db, key, value) {
  const s = prepareStatements(db);
  s.setMeta.run(key, String(value));
}

// ─── Embedding utilities ────────────────────────────────────────────────────

/**
 * Generate embedding text from a memory entry.
 * Combines fields that carry semantic meaning.
 */
export function embeddingText(entry) {
  const parts = [];
  if (entry.domain) parts.push(`[${entry.domain}]`);
  if (entry.pattern_type) parts.push(`(${entry.pattern_type})`);
  if (entry.title) parts.push(entry.title);
  if (entry.detail && entry.detail !== entry.title) parts.push(entry.detail);
  if (entry.source_section && !parts.some((p) => p.includes(entry.source_section))) {
    parts.push(entry.source_section);
  }
  return parts.join(" ").slice(0, 512); // Truncate for embedding model
}

/**
 * Call Ollama to generate embeddings for one or more texts.
 * Returns array of Float32Arrays.
 */
export async function generateEmbeddings(texts, model = EMBED_MODEL) {
  const results = [];

  // Ollama /api/embed supports array input
  const batchSize = 25;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await httpPost(OLLAMA_URL, { model, input: batch });
    for (const emb of data.embeddings) {
      results.push(new Float32Array(emb));
    }
  }

  return results;
}

/**
 * Convert Float32Array to/from Buffer for SQLite BLOB storage.
 */
export function embeddingToBlob(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function blobToEmbedding(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Cosine similarity between two Float32Arrays.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic search: find the most similar memories to a query embedding.
 * Brute-force cosine similarity — fast enough for <50K entries.
 */
export function semanticSearch(db, queryEmbedding, limit = 20) {
  const s = prepareStatements(db);
  const rows = s.getWithEmbedding.all();

  const scored = rows
    .map((row) => {
      const emb = blobToEmbedding(row.embedding);
      const sim = cosineSimilarity(queryEmbedding, emb);
      return { id: row.id, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

/**
 * Combined retrieval: semantic similarity + activation + domain match.
 * This is the main retrieval function for context injection.
 *
 * Scoring strategy:
 *   - Semantic similarity is the primary signal (embeddings)
 *   - Activation is a secondary signal (usage frequency)
 *   - Domain match provides a bonus when keyword hints are available
 *   - "general" domain entries (legacy file-level) are deprioritized
 *   - Daily logs and catch-all entries get a penalty
 *   - Rules/directives get a bonus (more actionable)
 *   - Spreading activation fills remaining budget (clearly separated)
 */
export function retrieve(db, options = {}) {
  const {
    queryEmbedding = null,
    domains = [],
    limit = 20,
    tokenBudget = 800, // ~3200 chars
    semanticWeight = 0.6,
    activationWeight = 0.3,
    domainWeight = 0.1,
  } = options;

  const s = prepareStatements(db);

  // Get candidates — all entries with embeddings for semantic search,
  // plus domain-specific entries if hints provided
  let candidates;
  if (queryEmbedding) {
    // Semantic mode: scan all entries with embeddings (exclude deprecated)
    const all = db.prepare(
      "SELECT * FROM memories WHERE embedding IS NOT NULL AND (status = 'active' OR status IS NULL)"
    ).all();
    candidates = all;
  } else if (domains.length > 0) {
    // Domain-only mode (no embedding available)
    candidates = [];
    const domainQuery = db.prepare(
      "SELECT * FROM memories WHERE domain = ? AND (status = 'active' OR status IS NULL) ORDER BY activation DESC"
    );
    for (const domain of domains) {
      candidates.push(...domainQuery.all(domain));
    }
  } else {
    // Fallback: top by activation (exclude deprecated)
    const fallbackQuery = db.prepare(
      "SELECT * FROM memories WHERE (status = 'active' OR status IS NULL) ORDER BY activation DESC LIMIT ?"
    );
    candidates = fallbackQuery.all(100);
  }

  if (candidates.length === 0) return [];

  // Normalize activation for scoring (exclude outliers)
  const activations = candidates.map((c) => c.activation || 0).sort((a, b) => a - b);
  const p95 = activations[Math.floor(activations.length * 0.95)] || 1;
  const maxActivation = Math.max(p95, 1);

  // Score each candidate
  const scored = [];
  for (const entry of candidates) {
    let score = 0;
    let semanticSim = 0;

    // Semantic similarity component (0-1 range, primary signal)
    if (queryEmbedding && entry.embedding) {
      const emb = blobToEmbedding(entry.embedding);
      semanticSim = cosineSimilarity(queryEmbedding, emb);
      score += semanticSim * semanticWeight;
    }

    // Hard floor: if we have embeddings and similarity is below threshold, skip entirely
    // This prevents irrelevant entries from sneaking in via high activation alone
    if (queryEmbedding && semanticSim < 0.3) continue;

    // Activation component (normalized 0-1, capped at p95)
    const normAct = Math.min((entry.activation || 0) / maxActivation, 1);
    score += normAct * activationWeight;

    // Recency bonus: entries retrieved in last 24h get a small boost
    if (entry.last_retrieved) {
      const hoursSince = (Date.now() - new Date(entry.last_retrieved).getTime()) / 3600000;
      if (hoursSince < 24) score += 0.03;
    }

    // Domain match bonus
    if (domains.length > 0 && entry.domain) {
      const matched = domains.some((d) =>
        entry.domain.toLowerCase().includes(d.toLowerCase())
      );
      score += matched ? domainWeight : 0;
    }

    // Type bonuses: actionable patterns rank higher
    if (entry.pattern_type === "rule" || entry.pattern_type === "directive") score += 0.08;
    if (entry.pattern_type === "correction" || entry.pattern_type === "bug-insight") score += 0.05;
    if (entry.pattern_type === "command") score += 0.04;
    if (entry.pattern_type === "solution") score += 0.03;

    // Penalties for low-signal entries
    const isGeneral = (entry.domain || "general") === "general";
    const isDailyLog = (entry.title || "").toLowerCase().includes("daily log");
    const isLegacyFile = !entry.pattern_type;
    const detail = entry.detail || entry.title || "";

    if (isGeneral) score -= 0.2;  // Always penalize general — it's a catch-all
    if (isDailyLog) score -= 0.25; // Daily logs rarely useful as context
    if (isLegacyFile) score -= 0.1; // Prefer atomic patterns over file-level blobs
    if (detail.length < 20) score -= 0.15; // Very short entries are low-signal

    scored.push({ ...entry, score, semanticSim });
  }

  scored.sort((a, b) => b.score - a.score);

  // Token-budgeted selection
  const selected = [];
  let charsUsed = 0;
  const charBudget = tokenBudget * 4; // rough token-to-char ratio
  const seenDomains = new Map(); // domain → count (for diversity)

  for (const entry of scored) {
    const detail = entry.detail || entry.title || "";
    const entryChars = detail.length + 20;  // full detail, no truncation
    if (charsUsed + entryChars > charBudget && selected.length > 0) break;

    // Diversity: limit entries per domain to prevent one domain hogging the budget
    const dom = entry.domain || "general";
    const domCount = seenDomains.get(dom) || 0;
    if (domCount >= 3) continue; // max 3 per domain — forces variety

    selected.push(entry);
    charsUsed += entryChars;
    seenDomains.set(dom, domCount + 1);
    if (selected.length >= limit) break;
  }

  // Spreading activation — fill remaining budget with related patterns
  if (charsUsed < charBudget * 0.9 && selected.length > 0) {
    const activeIds = selected.map((s) => s.id);
    const related = getSpreadingActivation(db, activeIds, 8);
    for (const rel of related) {
      const entryChars = (rel.detail || rel.title || "").length + 20;
      if (charsUsed + entryChars > charBudget) break;
      selected.push({ ...rel, score: rel.spreadBoost * 0.01, spreadingActivation: true });
      charsUsed += entryChars;
    }
  }

  return selected;
}

/**
 * Mark a memory as deprecated/superseded by a newer entry.
 */
export function deprecateMemory(db, oldId, newId) {
  const update = db.prepare("UPDATE memories SET status = 'deprecated', superseded_by = ? WHERE id = ?");
  return update.run(newId, oldId);
}

/**
 * Mark a memory as a correction of another entry.
 */
export function markAsCorrection(db, correctionId, correctedId) {
  const update = db.prepare("UPDATE memories SET corrects = ? WHERE id = ?");
  return update.run(correctedId, correctionId);
}

/**
 * Find all deprecated memories (for cleanup/review).
 */
export function getDeprecated(db, limit = 100) {
  const stmt = db.prepare(`
    SELECT m.*, newer.detail as superseded_by_detail
    FROM memories m
    LEFT JOIN memories newer ON m.superseded_by = newer.id
    WHERE m.status = 'deprecated'
    ORDER BY m.last_retrieved DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

export { DEFAULT_DB_PATH, EMBED_DIM, EMBED_MODEL, OLLAMA_URL };
