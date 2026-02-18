#!/usr/bin/env node
/**
 * Hebbian Memory Manager v3 — SQLite Backend
 *
 * Drop-in replacement for the JSON-based manager.
 * All functions now read/write SQLite via hebbian-db.mjs.
 * The JSON file is no longer the source of truth.
 *
 * Exports the same API as v2 for backward compatibility:
 *   loadHebbian, saveHebbian, recordRetrieval, calculateActivation,
 *   updateCoOccurrences, addEntry, hashContent, pruneEntries,
 *   getTopEntries, getStats, updateAllActivations
 *
 * Plus new exports:
 *   getDb() — direct access to the SQLite database
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  openDb, closeDb, upsertMemory, bumpActivations,
  wireCoOccurrences, getStats as getDbStats, decayAll,
  getMeta, setMeta, embeddingText, generateEmbeddings,
  embeddingToBlob, DEFAULT_DB_PATH,
} from "../lib/db.mjs";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  dbPath: DEFAULT_DB_PATH,
  decayRate: 0.9995, // Multiplicative daily decay factor
};

// ─── Database access ─────────────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (!_db) {
    _db = openDb(CONFIG.dbPath);
  }
  return _db;
}

// ─── Backward-compatible API ─────────────────────────────────────────────────

/**
 * "Load" — returns a data-like object for compatibility.
 * Scripts that call loadHebbian() get a proxy that reads from SQLite.
 */
export async function loadHebbian() {
  const db = getDb();
  return {
    version: "3.0",
    entries: new Proxy({}, {
      get(target, id) {
        if (id === Symbol.iterator || id === Symbol.toPrimitive) return undefined;
        if (typeof id !== "string") return undefined;
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
        if (!row) return undefined;
        // Reconstitute tags
        row.tags = db.prepare("SELECT tag FROM tags WHERE memory_id = ?").all(id).map(r => r.tag);
        return row;
      },
      has(target, id) {
        if (typeof id !== "string") return false;
        const row = db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id);
        return !!row;
      },
      set(target, id, value) {
        // Upsert into SQLite
        upsertMemory(db, { ...value, id });
        return true;
      },
      ownKeys() {
        return db.prepare("SELECT id FROM memories").all().map(r => r.id);
      },
      getOwnPropertyDescriptor(target, id) {
        const row = db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id);
        if (row) return { configurable: true, enumerable: true, writable: true };
        return undefined;
      },
    }),
    co_occurrences: {}, // Legacy — co-occurrences now in their own table
    tags: {}, // Legacy — tags now in their own table
    _db: db, // Direct access for advanced scripts
  };
}

/**
 * "Save" — for scripts that modify entries then call saveHebbian(data).
 * With SQLite, writes happen immediately, so this is mostly a no-op.
 * We keep it for backward compatibility.
 */
export async function saveHebbian(data) {
  // No-op — writes go directly to SQLite now
  return true;
}

/**
 * Record a retrieval event for an entry.
 */
export function recordRetrieval(data, entryId) {
  const db = getDb();
  bumpActivations(db, [entryId], 0.5);
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(entryId);
}

/**
 * Update co-occurrences between entries retrieved together.
 */
export function updateCoOccurrences(data, entryIds) {
  const db = getDb();
  wireCoOccurrences(db, entryIds);
}

/**
 * Add a new entry to the store.
 */
export function addEntry(data, entry) {
  const db = getDb();
  const id = entry.id || generateEntryId(entry.source, entry.title);

  const record = {
    id,
    title: entry.title || null,
    source: entry.source || null,
    source_section: entry.source_section || null,
    created: entry.created || new Date().toISOString(),
    last_retrieved: entry.last_retrieved || new Date().toISOString(),
    retrieval_count: entry.retrieval_count || 1,
    content_hash: entry.content_hash || null,
    activation: entry.activation || 0.5, // Initial activation
    detail: entry.detail || null,
    domain: entry.domain || null,
    pattern_type: entry.pattern_type || null,
    tags: entry.tags || [],
    embedding: null, // Will be generated async
  };

  upsertMemory(db, record);

  // Generate embedding async (fire-and-forget)
  const text = embeddingText(record);
  generateEmbeddings([text])
    .then(([emb]) => {
      const blob = embeddingToBlob(emb);
      db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(blob, id);
    })
    .catch(() => {}); // Silent failure — embedding can be retried later

  // Return the entry (for scripts that modify it after addEntry)
  return record;
}

/**
 * Simple content hash for change detection.
 */
export function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Recalculate all activations (apply multiplicative decay).
 */
export function updateAllActivations(data) {
  const db = getDb();
  const before = db.prepare("SELECT AVG(activation) AS avg FROM memories").get();
  decayAll(db, CONFIG.decayRate);
  const after = db.prepare("SELECT AVG(activation) AS avg FROM memories").get();
  const count = db.prepare("SELECT COUNT(*) AS cnt FROM memories").get().cnt;
  return {
    entriesUpdated: count,
    avgBefore: before.avg,
    avgAfter: after.avg,
  };
}

/**
 * Prune — v2+: no deletion, just report low-activation entries.
 */
export function pruneEntries(data) {
  const db = getDb();
  const low = db.prepare(
    "SELECT id FROM memories WHERE activation < 0"
  ).all().map(r => r.id);
  return low;
}

/**
 * Get top N entries by activation.
 */
export function getTopEntries(data, n = 10) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM memories ORDER BY activation DESC LIMIT ?"
  ).all(n);
}

/**
 * Stats about the Hebbian store.
 */
export function getStats(data) {
  const db = getDb();
  return getDbStats(db);
}

/**
 * Calculate activation — passthrough for compatibility.
 */
export function calculateActivation(entry) {
  return entry.activation || 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateEntryId(source, title) {
  const clean = (str) =>
    (str || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
  return `${clean(source)}-${clean(title)}`;
}

// ─── CLI interface ───────────────────────────────────────────────────────────

const isMainModule = process.argv[1]?.endsWith("hebbian-manager.mjs");
if (isMainModule) {
  const command = process.argv[2];
  const db = getDb();

  switch (command) {
    case "stats": {
      const stats = getDbStats(db);
      const embCount = db.prepare(
        "SELECT COUNT(*) AS cnt FROM memories WHERE embedding IS NOT NULL"
      ).get().cnt;
      console.log(JSON.stringify({
        ...stats,
        embeddingCoverage: `${embCount}/${stats.total}`,
      }, null, 2));
      break;
    }
    case "top": {
      const n = parseInt(process.argv[3]) || 10;
      const rows = db.prepare(
        "SELECT id, title, domain, pattern_type, activation FROM memories ORDER BY activation DESC LIMIT ?"
      ).all(n);
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    case "get": {
      const entryId = process.argv[3];
      if (!entryId) { console.error("Usage: hebbian-manager.mjs get <entry-id>"); process.exit(1); }
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(entryId);
      if (row) {
        row.tags = db.prepare("SELECT tag FROM tags WHERE memory_id = ?").all(entryId).map(r => r.tag);
        // Don't print embedding blob
        delete row.embedding;
        console.log(JSON.stringify(row, null, 2));
      } else {
        console.error(`Entry not found: ${entryId}`);
        process.exit(1);
      }
      break;
    }
    case "record": {
      const entryId = process.argv[3];
      if (!entryId) { console.error("Usage: hebbian-manager.mjs record <entry-id>"); process.exit(1); }
      bumpActivations(db, [entryId], 0.5);
      const row = db.prepare("SELECT id, activation, retrieval_count FROM memories WHERE id = ?").get(entryId);
      console.log(JSON.stringify(row, null, 2));
      break;
    }
    case "update-all": {
      const result = updateAllActivations({});
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "prune": {
      const low = db.prepare("SELECT id, activation FROM memories WHERE activation < 0 ORDER BY activation ASC LIMIT 20").all();
      console.log(`${low.length} entries with negative activation (kept, not deleted):`);
      low.forEach(r => console.log(`  ${r.id}: ${r.activation.toFixed(3)}`));
      break;
    }
    case "embed-missing": {
      // Generate embeddings for entries that don't have them
      const missing = db.prepare("SELECT id, title, detail, domain, pattern_type, source_section FROM memories WHERE embedding IS NULL").all();
      console.log(`${missing.length} entries missing embeddings`);
      if (missing.length === 0) break;

      const batchSize = 25;
      let done = 0;
      const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");

      for (let i = 0; i < missing.length; i += batchSize) {
        const batch = missing.slice(i, i + batchSize);
        const texts = batch.map(e => embeddingText(e));
        try {
          const embeddings = await generateEmbeddings(texts);
          const tx = db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              update.run(embeddingToBlob(embeddings[j]), batch[j].id);
            }
          });
          tx();
          done += batch.length;
          process.stdout.write(`  ${done}/${missing.length}\r`);
        } catch (err) {
          console.error(`Batch failed: ${err.message}`);
        }
      }
      console.log(`\nEmbedded ${done}/${missing.length}`);
      break;
    }
    default:
      console.log(`Hebbian Memory Manager v3 (SQLite backend)

Commands:
  stats                 Show store statistics
  top [n]               Show top N entries by activation
  get <entry-id>        Show a specific entry
  record <entry-id>     Record a retrieval event
  update-all            Apply decay to all activations
  prune                 Report low-activation entries (no deletion)
  embed-missing         Generate embeddings for entries without them

DB: ${CONFIG.dbPath}
`);
  }

  closeDb();
}
