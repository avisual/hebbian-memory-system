#!/usr/bin/env node
/**
 * Hebbian Reasoning Extractor
 *
 * Processes thinking/reasoning blocks from session transcripts through
 * a local LLM (qwen2.5-coder:7b) to extract structured insights,
 * then stores them as Hebbian memories with embeddings.
 *
 * Workflow:
 *   1. Scan session files for thinking blocks >= 100 chars
 *   2. Filter out heartbeat/routine blocks
 *   3. Send each block to Ollama LLM with extraction prompt
 *   4. Parse structured output → insert into SQLite
 *   5. Generate embeddings for new entries (switches to nomic-embed-text)
 *
 * Usage:
 *   node hebbian-reasoning-extractor.mjs [--dry-run] [--limit N] [--resume]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const SESSIONS_DIR = join(homedir(), ".openclaw/agents/main/sessions");
const DB_PATH = join(homedir(), ".openclaw/workspace/memory/hebbian.db");
const PROGRESS_FILE = join(homedir(), "claudia/runtime/reasoning-extraction-progress.json");
const LLM_MODEL = "qwen2.5-coder:7b";
const EMBED_MODEL = "nomic-embed-text-cpu";
const OLLAMA_URL = "http://127.0.0.1:11434";

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1]) : Infinity;
const RESUME = args.includes("--resume");

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function httpPost(url, body, timeoutMs = 60000) {
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
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error(`Invalid JSON: ${text.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout (${timeoutMs}ms)`)));
    req.write(payload);
    req.end();
  });
}

async function ollamaGenerate(prompt, model = LLM_MODEL) {
  const data = await httpPost(`${OLLAMA_URL}/api/generate`, {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.1, num_predict: 512 },
  }, 120000);
  return data.response || "";
}

async function ollamaEmbed(texts, model = EMBED_MODEL) {
  const results = [];
  const batchSize = 25;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await httpPost(`${OLLAMA_URL}/api/embed`, {
      model,
      input: batch,
    }, 30000);
    for (const emb of data.embeddings) {
      results.push(new Float32Array(emb));
    }
  }
  return results;
}

async function ollamaLoad(model) {
  try {
    await httpPost(`${OLLAMA_URL}/api/generate`, {
      model,
      prompt: "",
      keep_alive: "10m",
    }, 120000);
  } catch {
    // Model loading can return empty response, that's fine
  }
}

async function ollamaUnload(model) {
  try {
    await httpPost(`${OLLAMA_URL}/api/generate`, {
      model,
      prompt: "",
      keep_alive: 0,
    }, 10000);
  } catch {}
}

// ─── Extraction prompt ──────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract reusable knowledge from this AI assistant's internal reasoning block.

RULES:
- Extract 0-2 insights ONLY if they contain durable, reusable knowledge
- Each insight must be DIRECTLY STATED in the text — never infer or fabricate values
- If a number/value/path/command appears, quote it exactly from the text
- SKIP: routine decisions, status checks, greetings, process descriptions, vague plans
- SKIP: anything that is transient state (current disk usage, email count, time-specific facts)
- GOOD: technical bugs found, tool behaviors discovered, user preferences learned, architecture decisions made, configuration that works/fails, performance numbers from actual tests

Output EXACTLY this JSON format (one per line, no markdown):
{"domain":"<topic>","type":"<fact|bug-insight|solution|decision|correction|rule|discovery|benchmark|config>","detail":"<insight quoted/paraphrased from text>"}

If nothing qualifies, output: NONE

TEXT:
`;

// ─── Heartbeat/noise filter ─────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /heartbeat/i,
  /HEARTBEAT_OK/,
  /^(Let me check|I need to respond|The user is asking|John is saying|John said)/,
  /^This is a heartbeat/,
  /nothing needs attention/i,
  /reply.*NO_REPLY/i,
  /^I should respond with HEARTBEAT/,
  /just (say|respond|reply).*hello/i,
  /^(OK|Okay),?\s+(let me|I'll|I need to)/i,
  /^The user (wants|is asking|said)/i,
  /^I('m| am) being asked/i,
  /^This is (just )?a (simple|routine|standard)/i,
];

function isNoise(text) {
  if (text.length < 100) return true;
  const first200 = text.slice(0, 200);
  return NOISE_PATTERNS.some((p) => p.test(first200));
}

// ─── Session scanning ───────────────────────────────────────────────────────

function scanSessions() {
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
  const blocks = [];

  for (const f of files) {
    const sessionId = f.replace(".jsonl", "");
    const lines = readFileSync(join(SESSIONS_DIR, f), "utf8").split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "message" && msg.message?.role === "assistant") {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === "thinking" && b.thinking && !isNoise(b.thinking)) {
                blocks.push({
                  sessionId,
                  text: b.thinking,
                  msgId: msg.id,
                  timestamp: msg.timestamp,
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  return blocks;
}

// ─── Database operations (inline, avoid import issues) ──────────────────────

let db = null;

function insertMemory(entry) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, title, source, source_section, created, retrieval_count,
       content_hash, activation, detail, domain, pattern_type, embedding)
    VALUES
      (@id, @title, @source, @source_section, @created, 0,
       @content_hash, @activation, @detail, @domain, @pattern_type, NULL)
  `);
  return stmt.run(entry);
}

function memoryExists(contentHash) {
  return db.prepare("SELECT 1 FROM memories WHERE content_hash = ?").get(contentHash) != null;
}

// ─── Content hash for dedup ─────────────────────────────────────────────────

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return "reason-" + Math.abs(h).toString(36);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("[reasoning-extractor] Scanning sessions...");
  const allBlocks = scanSessions();
  console.log(`[reasoning-extractor] Found ${allBlocks.length} thinking blocks (after noise filter)`);

  // Resume support
  let processed = new Set();
  if (RESUME && existsSync(PROGRESS_FILE)) {
    const progress = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
    processed = new Set(progress.processed || []);
    console.log(`[reasoning-extractor] Resuming — ${processed.size} blocks already done`);
  }

  const blocks = allBlocks.filter((b) => !processed.has(b.msgId + ":" + b.text.slice(0, 50)));
  const toProcess = blocks.slice(0, LIMIT);
  console.log(`[reasoning-extractor] Processing ${toProcess.length} blocks (limit: ${LIMIT === Infinity ? "none" : LIMIT})`);

  if (DRY_RUN) {
    console.log("[reasoning-extractor] DRY RUN — showing first 3 blocks:");
    for (const b of toProcess.slice(0, 3)) {
      console.log(`  [${b.sessionId.slice(0, 8)}] ${b.text.slice(0, 100)}...`);
    }
    return;
  }

  // Open database
  const bsqlite3Path = join(homedir(), ".openclaw/extensions/hebbian-hook/node_modules/better-sqlite3/lib/index.js");
  const { default: Database } = await import(bsqlite3Path);
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Phase 1: Load LLM and extract
  console.log(`[reasoning-extractor] Loading ${LLM_MODEL}...`);
  await ollamaLoad(LLM_MODEL);

  let extracted = 0, skipped = 0, errors = 0;
  const newEntryIds = [];
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const block = toProcess[i];
    const blockKey = block.msgId + ":" + block.text.slice(0, 50);

    if (i > 0 && i % 50 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = i / elapsed;
      const remaining = (toProcess.length - i) / rate;
      console.log(`[progress] ${i}/${toProcess.length} blocks (${extracted} insights, ${Math.round(remaining)}s remaining)`);

      // Save progress
      writeFileSync(PROGRESS_FILE, JSON.stringify({
        processed: [...processed],
        extracted,
        skipped,
        errors,
        lastBlock: i,
        timestamp: new Date().toISOString(),
      }));
    }

    try {
      // Truncate very long blocks
      const text = block.text.slice(0, 1500);
      const prompt = EXTRACTION_PROMPT + text;
      const response = await ollamaGenerate(prompt);

      if (response.trim() === "NONE" || !response.trim()) {
        skipped++;
        processed.add(blockKey);
        continue;
      }

      // Parse JSON lines
      const lines = response.split("\n").filter((l) => l.trim().startsWith("{"));
      for (const line of lines) {
        try {
          const insight = JSON.parse(line);
          if (!insight.domain || !insight.type || !insight.detail) continue;
          if (insight.detail.length < 10) continue;

          const hash = simpleHash(insight.detail);
          if (memoryExists(hash)) {
            skipped++;
            continue;
          }

          const id = `reason-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            id,
            title: insight.detail.slice(0, 80),
            source: "reasoning-extraction",
            source_section: `session/${block.sessionId.slice(0, 8)}`,
            created: block.timestamp || new Date().toISOString(),
            content_hash: hash,
            activation: 5,  // Start low, let retrieval bump it
            detail: insight.detail,
            domain: insight.domain.toLowerCase().replace(/\s+/g, "-"),
            pattern_type: insight.type,
          };

          const result = insertMemory(entry);
          if (result.changes > 0) {
            extracted++;
            newEntryIds.push(id);
          }
        } catch {
          // Bad JSON line, skip
        }
      }

      processed.add(blockKey);
    } catch (err) {
      errors++;
      if (errors <= 5) console.error(`[error] Block ${i}: ${err.message}`);
      if (errors > 20) {
        console.error("[reasoning-extractor] Too many errors, stopping.");
        break;
      }
    }
  }

  // Save final progress
  writeFileSync(PROGRESS_FILE, JSON.stringify({
    processed: [...processed],
    extracted,
    skipped,
    errors,
    completed: true,
    timestamp: new Date().toISOString(),
  }));

  console.log(`\n[reasoning-extractor] Phase 1 complete:`);
  console.log(`  Blocks processed: ${toProcess.length}`);
  console.log(`  Insights extracted: ${extracted}`);
  console.log(`  Skipped (noise/dupe): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  New entries: ${newEntryIds.length}`);

  // Phase 2: Unload LLM, load embed model, generate embeddings
  if (newEntryIds.length > 0) {
    console.log(`\n[reasoning-extractor] Phase 2: Generating embeddings for ${newEntryIds.length} new entries...`);
    await ollamaUnload(LLM_MODEL);

    // Wait a moment for memory to free
    await new Promise((r) => setTimeout(r, 3000));

    console.log(`[reasoning-extractor] Loading ${EMBED_MODEL}...`);
    await ollamaLoad(EMBED_MODEL);

    // Batch embed
    const getEntry = db.prepare("SELECT * FROM memories WHERE id = ?");
    const setEmbed = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");

    const batchSize = 25;
    let embedded = 0;
    for (let i = 0; i < newEntryIds.length; i += batchSize) {
      const batch = newEntryIds.slice(i, i + batchSize);
      const texts = batch.map((id) => {
        const entry = getEntry.get(id);
        if (!entry) return "";
        const parts = [];
        if (entry.domain) parts.push(`[${entry.domain}]`);
        if (entry.pattern_type) parts.push(`(${entry.pattern_type})`);
        if (entry.title) parts.push(entry.title);
        if (entry.detail && entry.detail !== entry.title) parts.push(entry.detail);
        return parts.join(" ").slice(0, 512);
      });

      try {
        const embeddings = await ollamaEmbed(texts);
        const tx = db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            if (embeddings[j]) {
              const blob = Buffer.from(embeddings[j].buffer, embeddings[j].byteOffset, embeddings[j].byteLength);
              setEmbed.run(blob, batch[j]);
              embedded++;
            }
          }
        });
        tx();
      } catch (err) {
        console.error(`[embedding error] Batch ${i}: ${err.message}`);
      }
    }

    console.log(`[reasoning-extractor] Embedded ${embedded}/${newEntryIds.length} new entries`);
  } else {
    // Still unload the LLM and restore embed model
    await ollamaUnload(LLM_MODEL);
    await new Promise((r) => setTimeout(r, 2000));
    await ollamaLoad(EMBED_MODEL);
  }

  // Final stats
  const total = db.prepare("SELECT COUNT(*) as c FROM memories").get().c;
  const withEmbed = db.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL").get().c;
  console.log(`\n[reasoning-extractor] Done. Total memories: ${total}, with embeddings: ${withEmbed}`);

  db.close();
}

main().catch((err) => {
  console.error("[reasoning-extractor] Fatal:", err);
  process.exit(1);
});
