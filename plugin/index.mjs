/**
 * Hebbian Memory Hook v3 — OpenClaw Plugin (SQLite + Embeddings)
 *
 * Replaces the JSON-based v2 plugin with:
 *   - SQLite via better-sqlite3 (concurrent-safe, indexed, ACID)
 *   - Semantic search via nomic-embed-text embeddings (768-dim)
 *   - Token-budgeted context injection
 *   - Combined scoring: semantic similarity + activation + domain match
 *
 * Hooks:
 *   before_agent_start → embed query → retrieve → token-budget → prependContext
 *   after_tool_call    → bump domain activations
 *   before_compaction  → mine session transcript
 *   session_end        → log stats
 *   gateway_start      → open DB, verify health
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  openDb, closeDb, retrieve, bumpActivations, wireCoOccurrences,
  getStats, generateEmbeddings, embeddingToBlob, blobToEmbedding,
  getMeta, setMeta, DEFAULT_DB_PATH,
} from "./hebbian-db.mjs";

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULTS = {
  dbPath: DEFAULT_DB_PATH,
  sessionExtractor: join(homedir(), "claudia/scripts/hebbian-session-extractor-v2.mjs"),
  maxContextTokens: 800,
  maxEntries: 30,
  semanticWeight: 0.6,
  activationWeight: 0.3,
  domainWeight: 0.1,
  embeddingCacheTtlMs: 300_000, // cache query embeddings for 5 min
};

// ─── Domain keyword map (fast pre-filter before semantic search) ──────────────

const DOMAIN_KEYWORDS = {
  "peekaboo-web": ["peekaboo", "safari", "browser", "webpage", "website", "click", "form", "login", "signup", "checkbox"],
  "form-handling-patterns": ["form", "signup", "register", "login", "submit", "checkbox", "dropdown"],
  "comfyui": ["comfyui", "dreamshaper", "animatediff", "stable diffusion", "sd 1.5", "image gen"],
  "tiktok": ["tiktok", "video", "content", "upload", "viral", "hook"],
  "tiktok-automation-workflow": ["tiktok pipeline", "video pipeline", "automation", "n8n"],
  "tiktok-growth-patterns": ["growth", "followers", "algorithm", "engagement", "analytics"],
  "video-pipeline": ["ffmpeg", "esrgan", "upscale", "ken burns", "encode", "mux"],
  "tts": ["qwen", "tts", "voice", "speech", "audio", "voice clone", "edge-tts"],
  "podcast": ["podcast", "episode", "spotify", "rss"],
  "hebbian": ["hebbian", "memory", "activation", "decay", "co-occurrence", "atomic", "pattern"],
  "openclaw": ["openclaw", "gateway", "session", "spawn", "sub-agent", "config"],
  "inter-agent-communication": ["sub-agent", "spawn", "worker", "captain", "orchestrat"],
  "ollama": ["ollama", "qwen2.5", "local model", "vision"],
  "deepseek": ["deepseek", "research", "reasoning"],
  "business": ["revenue", "fiverr", "etsy", "listing", "customer", "pricing", "monetiz", "patreon"],
  "infrastructure": ["n8n", "cron", "task", "alert", "database", "sqlite"],
  "macos": ["applescript", "keychain", "finder", "mail.app", "cliclick"],
  "security": ["security", "injection", "permission", "access", "credential"],
  "model-routing": ["model", "routing", "sonnet", "opus", "claude", "budget"],
  "trading": ["trading", "alpaca", "stock", "portfolio", "market"],
};

// Tool name → domains for after_tool_call bumps
const TOOL_DOMAIN_MAP = {
  browser: ["peekaboo-web"],
  web_fetch: ["peekaboo-web"],
  web_search: ["tools"],
  exec: ["infrastructure", "macos"],
  tts: ["tts"],
  canvas: ["comfyui", "video-pipeline"],
  sessions_spawn: ["inter-agent-communication"],
  subagents: ["inter-agent-communication"],
  cron: ["infrastructure"],
  message: ["openclaw"],
  gateway: ["openclaw"],
};

// ─── State ────────────────────────────────────────────────────────────────────

let db = null;
let pluginLogger = null;
let embeddingCache = new Map(); // text → { embedding, ts }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Quick domain hint extraction from message text.
 * Used alongside semantic search to boost domain-matching results.
 */
function extractDomainHints(text) {
  if (!text || typeof text !== "string") return [];
  const lower = text.toLowerCase();
  const scored = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        scored[domain] = (scored[domain] || 0) + (kw.includes(" ") ? 3 : 2);
      }
    }
  }

  return Object.entries(scored)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

/**
 * Get or generate embedding for a text, with caching.
 */
async function getEmbedding(text, cfg) {
  const cacheKey = text.slice(0, 200);
  const cached = embeddingCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cfg.embeddingCacheTtlMs) {
    return cached.embedding;
  }

  try {
    const [embedding] = await generateEmbeddings([text]);
    embeddingCache.set(cacheKey, { embedding, ts: Date.now() });

    // Trim cache if it gets large
    if (embeddingCache.size > 100) {
      const oldest = [...embeddingCache.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, 50);
      for (const [k] of oldest) embeddingCache.delete(k);
    }

    return embedding;
  } catch (err) {
    pluginLogger?.warn?.(`hebbian-hook: embedding generation failed: ${err.message} | cause: ${err.cause?.message || err.cause?.code || 'none'} | stack: ${(err.stack || '').split('\n')[1]?.trim() || 'no stack'}`);
    return null;
  }
}

/**
 * Format retrieved memories into markdown context block.
 */
function formatContext(entries, stats, maxTokens) {
  const maxChars = maxTokens * 4;

  let md = `# Hebbian Memory — Active Patterns\n`;
  md += `*${stats.total} memories | ${stats.atomic} atomic | ${stats.coOccurrences} wired pairs*\n\n`;

  // Group by domain, preserving score order within each domain
  const byDomain = {};
  const domainOrder = []; // track insertion order (highest-scored domain first)
  for (const entry of entries) {
    const domain = entry.domain || entry.source_section?.split("/")[0] || "general";
    if (!byDomain[domain]) {
      byDomain[domain] = [];
      domainOrder.push(domain);
    }
    byDomain[domain].push(entry);
  }

  for (const domain of domainOrder) {
    const domainEntries = byDomain[domain];
    const header = `## ${domain}\n`;
    if (md.length + header.length > maxChars - 60) break;
    md += header;

    for (const entry of domainEntries) {
      const type = entry.pattern_type || "memory";
      const detail = entry.detail || entry.title || "";

      // Skip entries with very short details — they waste a line
      if (detail.length < 20) continue;

      const icon = type === "rule" ? "⚡"
        : type === "command" ? "💻"
        : type === "directive" ? "🚨"
        : type === "correction" ? "⚠️"
        : type === "bug-insight" ? "🐛"
        : "📌";
      const spreading = entry.spreadingActivation ? " 🔗" : "";
      // Full detail — the token budget already controls total context size
      const line = `- ${icon} ${detail}${spreading}\n`;

      if (md.length + line.length > maxChars - 60) {
        md += `\n`;
        return md;
      }
      md += line;
    }
    md += "\n";
  }

  return md;
}

/**
 * Trigger session mining (fire-and-forget via child process).
 */
function triggerSessionMining(cfg, sessionFile) {
  if (!sessionFile || !cfg.sessionExtractor) return;
  if (!existsSync(cfg.sessionExtractor)) return;

  try {
    const child = execFile("node", [cfg.sessionExtractor, sessionFile], {
      timeout: 120_000,
      env: { ...process.env, PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" },
    });
    child.unref?.();
    pluginLogger?.info?.(`hebbian-hook: triggered session mining for ${sessionFile}`);
  } catch (err) {
    pluginLogger?.warn?.(`hebbian-hook: session mining failed: ${err.message}`);
  }
}

// ─── Plugin export ───────────────────────────────────────────────────────────

export default function register(api) {
  pluginLogger = api.logger;
  const pcfg = api.pluginConfig ?? {};

  const cfg = {
    dbPath: pcfg.dbPath || DEFAULTS.dbPath,
    sessionExtractor: pcfg.sessionExtractor || DEFAULTS.sessionExtractor,
    maxContextTokens: pcfg.maxContextTokens || DEFAULTS.maxContextTokens,
    maxEntries: pcfg.maxEntries || DEFAULTS.maxEntries,
    semanticWeight: pcfg.semanticWeight ?? DEFAULTS.semanticWeight,
    activationWeight: pcfg.activationWeight ?? DEFAULTS.activationWeight,
    domainWeight: pcfg.domainWeight ?? DEFAULTS.domainWeight,
    embeddingCacheTtlMs: pcfg.embeddingCacheTtlMs || DEFAULTS.embeddingCacheTtlMs,
  };

  api.logger.info?.(`hebbian-hook v3: registered (db: ${cfg.dbPath})`);

  // ─── before_agent_start: semantic retrieval + context injection ───────────
  api.on("before_agent_start", async (event, ctx) => {
    try {
      if (!db) return;

      const prompt = event.prompt || "";
      if (!prompt.trim()) return;

      // 1. Extract domain hints (fast keyword scan)
      const domainHints = extractDomainHints(prompt);

      // 2. Generate query embedding (with cache)
      const queryEmbedding = await getEmbedding(prompt.slice(0, 512), cfg);

      // 3. Retrieve with combined scoring
      const patterns = retrieve(db, {
        queryEmbedding,
        domains: domainHints,
        limit: cfg.maxEntries,
        tokenBudget: cfg.maxContextTokens,
        semanticWeight: cfg.semanticWeight,
        activationWeight: cfg.activationWeight,
        domainWeight: cfg.domainWeight,
      });

      if (patterns.length === 0) return;

      // 4. Bump retrieved patterns (synchronous — fast with SQLite)
      const ids = patterns
        .filter((e) => e.domain && e.pattern_type)
        .map((e) => e.id)
        .slice(0, 20);

      if (ids.length > 0) {
        bumpActivations(db, ids, 0.5);
        wireCoOccurrences(db, ids);
      }

      // 5. Format and inject
      const stats = getStats(db);
      const context = formatContext(patterns, stats, cfg.maxContextTokens);
      return { prependContext: context };
    } catch (err) {
      api.logger.warn?.(`hebbian-hook: before_agent_start error: ${err.message}`);
    }
  }, { priority: 10 });

  // ─── after_tool_call: bump domain-related patterns ───────────────────────
  api.on("after_tool_call", async (event, ctx) => {
    try {
      if (!db) return;

      const domains = TOOL_DOMAIN_MAP[event.toolName];
      if (!domains?.length) return;

      // Find top patterns in the relevant domains
      const getByDomain = db.prepare(
        "SELECT id FROM memories WHERE domain = ? ORDER BY activation DESC LIMIT 5"
      );

      const ids = [];
      for (const domain of domains) {
        const rows = getByDomain.all(domain);
        ids.push(...rows.map((r) => r.id));
      }

      if (ids.length > 0) {
        bumpActivations(db, ids, 0.3);
      }
    } catch (err) {
      api.logger.warn?.(`hebbian-hook: after_tool_call error: ${err.message}`);
    }
  }, { priority: 50 });

  // ─── before_compaction: mine session before it's lost ────────────────────
  api.on("before_compaction", async (event, ctx) => {
    if (event.sessionFile) {
      triggerSessionMining(cfg, event.sessionFile);
    }
  }, { priority: 50 });

  // ─── session_end: log stats ──────────────────────────────────────────────
  api.on("session_end", async (event, ctx) => {
    if (db) {
      const stats = getStats(db);
      api.logger.info?.(
        `hebbian-hook: session ${event.sessionId} ended ` +
        `(${event.messageCount} msgs, ${Math.round((event.durationMs || 0) / 1000)}s) — ` +
        `${stats.total} memories, ${stats.coOccurrences} co-occurrences`
      );
    }
  }, { priority: 90 });

  // ─── gateway_start: open DB, verify ──────────────────────────────────────
  api.on("gateway_start", async () => {
    try {
      db = openDb(cfg.dbPath);
      const stats = getStats(db);
      api.logger.info?.(
        `hebbian-hook v3: DB loaded — ${stats.total} memories, ` +
        `${stats.atomic} atomic, ${stats.coOccurrences} co-occurrences`
      );

      // Check embeddings coverage
      const embCount = db.prepare(
        "SELECT COUNT(*) AS cnt FROM memories WHERE embedding IS NOT NULL"
      ).get().cnt;
      const coverage = ((embCount / stats.total) * 100).toFixed(0);
      api.logger.info?.(`hebbian-hook v3: ${embCount}/${stats.total} entries have embeddings (${coverage}%)`);

      if (embCount < stats.total * 0.5) {
        api.logger.warn?.(
          `hebbian-hook v3: low embedding coverage (${coverage}%). ` +
          `Run: node hebbian-migrate.mjs to generate embeddings`
        );
      }
    } catch (err) {
      api.logger.warn?.(`hebbian-hook v3: DB open failed: ${err.message}`);
    }
  }, { priority: 10 });

  // ─── gateway_stop: close DB cleanly ──────────────────────────────────────
  api.on("gateway_stop", async () => {
    closeDb();
    db = null;
    api.logger.info?.("hebbian-hook v3: DB closed");
  }, { priority: 90 });
}
