#!/usr/bin/env node
/**
 * Hebbian Post-Session Extractor v3.1 — Tighter filters + semantic dedup
 *
 * Extracts atomic learnings from session transcripts → SQLite with embeddings.
 * v3.1 changes:
 *   - Minimum detail length 40 chars (was 10-15)
 *   - Skip low-signal patterns (status checks, routine confirmations, filler)
 *   - Skip "so I'll just..." / "so I should..." thinking-aloud conclusions
 *   - Require specs to contain actionable numbers (not just any digit)
 *   - Semantic dedup: skip if >0.92 cosine similarity with existing entry
 *   - Solutions must describe WHAT worked, not just "✅ thing"
 *
 * Usage:
 *   node hebbian-session-extractor-v2.mjs <session-file.jsonl>
 *   node hebbian-session-extractor-v2.mjs --recent
 *   node hebbian-session-extractor-v2.mjs --text "I discovered that..."
 */

import { readFile as readFileAsync } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  openDb, closeDb, upsertMemory, embeddingText,
  generateEmbeddings, embeddingToBlob, cosineSimilarity,
  semanticSearch, DEFAULT_DB_PATH,
} from "../lib/db.mjs";
import { hashContent } from "./hebbian-manager.mjs";

const SESSION_DIR = join(homedir(), ".openclaw/agents/main/sessions");
const db = openDb(DEFAULT_DB_PATH);

// ─── Low-signal filters ─────────────────────────────────────────────────────

/** Patterns that match routine/filler text — skip these */
const LOW_SIGNAL_PATTERNS = [
  /^✅\s*(Quiet hours|System idle|Swap healthy|Disk space|Video generation complete|Cleaned? old|Cleaned? stale|Archived large)/i,
  /^✅\s*(Ollama|Gateway|Budget Proxy|Disk Space):\s*(Running|Healthy|OK)/i,
  /^✅\s*(Checked|Verified|Reviewed)\s+(improvement|failure|cron|system)/i,
  /^✅\s*(Jobs? Configured|Verification|Documentation Updated|Completion Protocol)/i,
  /^✅\s*Skill audit/i,
  /^✅\s*Integrity manifest/i,
  /^✅\s*No unexpected files/i,
  /^successfully\s+(at \d|restarted|without|with 0)/i,
  /^SIGKILL\)\s*::/,  // Raw SIGKILL log lines without explanation
];

/** Conclusion prefixes that are just thinking-aloud, not real conclusions */
const FILLER_CONCLUSION_PREFIXES = [
  /^so I('ll| should| need to| can| will| just|'m going)/i,
  /^so I actually/i,
  /^so there('s| are| is| was| were)/i,
  /^so the (script|queue|system|video|prompt|pipeline|total|real|current|earlier|completed|key|next|sequence)/i,
  /^so if /i,
  /^so it /i,
  /^so we /i,
  /^so includes? /i,
  /^so include /i,
  /^this means (the script|it's|I need|the|we)/i,
  /^So I have a question/i,
];

/** Check if a pattern is low-signal noise */
function isLowSignal(text, type) {
  const trimmed = text.trim();

  // Global minimum length
  if (trimmed.length < 40) return true;

  // Check explicit low-signal patterns
  for (const pat of LOW_SIGNAL_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }

  // Conclusion-specific: skip thinking-aloud filler
  if (type === "conclusion") {
    for (const pat of FILLER_CONCLUSION_PREFIXES) {
      if (pat.test(trimmed)) return true;
    }
    // Also skip very short conclusions (likely fragments)
    if (trimmed.length < 60) return true;
  }

  // Correction-specific: skip trivial self-corrections
  if (type === "correction") {
    if (/^CORRECTION:\s*(Actually,?\s*)?(I('m| think| should|'ll)|the|wait|no,)/i.test(trimmed) && trimmed.length < 80) return true;
  }

  // Solution-specific: require substance beyond just a checkmark
  if (type === "solution") {
    // Skip bare status lines
    if (/^✅\s*\S+(\s+\S+){0,3}$/.test(trimmed)) return true;
    // Skip if it's just a filename/path
    if (/^✅\s*\//.test(trimmed)) return true;
    // Require at least some explanation
    if (trimmed.startsWith("✅") && trimmed.length < 60) return true;
  }

  // Spec-specific: require meaningful measurements, not just "X frames" fragments
  if (type === "spec") {
    // Must contain a comparison, threshold, or actionable context
    if (trimmed.length < 50) return true;
    // Skip bare frame/timing counts without context
    if (/^\d+[\d.,]*\s*(frames?|seconds?|minutes?|MB|GB)\s*$/.test(trimmed)) return true;
  }

  // Failure-specific: require explanation, not just "oom" fragments
  if (type === "failure") {
    if (/^FAILURE:\s*oom\b/i.test(trimmed) && trimmed.length < 80) return true;
    if (/^FAILURE:\s*SIGKILL\)\s*::/.test(trimmed) && trimmed.length < 80) return true;
  }

  return false;
}

// ─── Extraction from conversation ───────────────────────────────────────────

function extractFromTranscript(messages) {
  const atomics = [];
  for (const msg of messages) {
    const content = msg.content || msg.text || "";
    if (!content || content.length < 40) continue;

    // Discoveries — genuine "aha" moments
    const discoveries = content.match(/(?:I (?:found|discovered|learned|realised|noticed) (?:that )?|Turns out |The (?:fix|solution|issue|problem) (?:was|is) |Key (?:insight|learning|takeaway):? )[^.!?\n]{30,200}[.!?]/gi) || [];
    for (const d of discoveries) {
      if (!isLowSignal(d, "discovery")) {
        atomics.push({ summary: d.trim().slice(0, 120), detail: d.trim(), type: "discovery", confidence: 0.9 });
      }
    }

    // Failures — with explanation of what went wrong
    const failures = content.match(/(?:(?:Failed|Broke|Crashed|Error) because |didn't work (?:because|due to)|the error (?:was|is) )[^.!?\n]{20,200}[.!?]?/gi) || [];
    for (const f of failures) {
      if (!isLowSignal(f, "failure")) {
        atomics.push({ summary: `FAILURE: ${f.trim().slice(0, 100)}`, detail: f.trim(), type: "failure", confidence: 1.0 });
      }
    }

    // Solutions — must explain WHAT worked
    const solutions = content.match(/(?:This works|Fixed (?:by|with)|The (?:solution|workaround) (?:is|was))[^.!?\n]{20,200}[.!?]?/gi) || [];
    for (const s of solutions) {
      if (!isLowSignal(s, "solution")) {
        atomics.push({ summary: s.trim().slice(0, 120), detail: s.trim(), type: "solution", confidence: 1.0 });
      }
    }

    // Configs — specific settings changes
    const configs = content.match(/(?:Set \S+ to |Use \S+ instead of |Changed? \S+ from \S+ to |The (?:correct|right|optimal) \S+ is )[^.!?\n]{15,150}[.!?]?/gi) || [];
    for (const c of configs) {
      if (!isLowSignal(c, "config")) {
        atomics.push({ summary: c.trim().slice(0, 120), detail: c.trim(), type: "config", confidence: 0.8 });
      }
    }

    // Benchmarks — specific performance data with context
    const perf = content.match(/(?:Takes? |Runs? in |Speed: |Duration: |Memory: |Size: |Peak: )\d+[\d.,]*\s*(?:seconds?|minutes?|min|ms|MB|GB|fps|s\/step)[^.!?\n]{10,100}[.!?]?/gi) || [];
    for (const p of perf) {
      if (!isLowSignal(p, "benchmark")) {
        atomics.push({ summary: p.trim().slice(0, 120), detail: p.trim(), type: "benchmark", confidence: 0.7 });
      }
    }
  }

  return dedup(atomics);
}

// ─── Extraction from reasoning blocks ───────────────────────────────────────

function extractFromReasoning(reasonings) {
  const atomics = [];
  for (const r of reasonings) {
    const content = r.content || "";
    if (content.length < 100) continue;  // Reasoning blocks need more content to be useful

    // Bug insights — root cause analysis
    const bugs = content.match(/(?:the (?:problem|issue|bug|error) (?:is|was) (?:that )?|this (?:fails|breaks|crashes) because |the reason (?:is|was) (?:that )?|root cause:?\s)[^.!?\n]{25,250}[.!?]/gi) || [];
    for (const b of bugs) {
      if (!isLowSignal(b, "bug-insight")) {
        atomics.push({ summary: b.trim().slice(0, 120), detail: b.trim(), type: "bug-insight", confidence: 0.9, source: "reasoning" });
      }
    }

    // Decisions — architectural/approach choices with rationale
    const decisions = content.match(/(?:better (?:approach|way|method) is |the (?:right|correct|proper) (?:way|approach) is |instead of .{5,50}, (?:we should |use |do |try ))[^.!?\n]{20,200}[.!?]/gi) || [];
    for (const d of decisions) {
      if (!isLowSignal(d, "decision")) {
        atomics.push({ summary: d.trim().slice(0, 120), detail: d.trim(), type: "decision", confidence: 0.8, source: "reasoning" });
      }
    }

    // Specs — meaningful measurements with context (not bare numbers)
    const specs = content.match(/\d+[\d.,]*\s*(?:frames?|fps|seconds?|minutes?|MB|GB|px|×|x)\s[^.!?\n]{15,150}[.!?]?/gi) || [];
    for (const s of specs) {
      if (s.length > 50 && !isLowSignal(s, "spec")) {
        atomics.push({ summary: s.trim().slice(0, 120), detail: s.trim(), type: "spec", confidence: 0.7, source: "reasoning" });
      }
    }

    // Corrections — genuine "I was wrong about X, actually Y"
    const corrections = content.match(/(?:actually,? (?:the|this|that) (?:is|was|isn't|wasn't|means|requires)|I was wrong about |correction:\s)[^.!?\n]{30,200}[.!?]/gi) || [];
    for (const c of corrections) {
      if (!isLowSignal(c, "correction")) {
        atomics.push({ summary: `CORRECTION: ${c.trim().slice(0, 100)}`, detail: c.trim(), type: "correction", confidence: 1.0, source: "reasoning" });
      }
    }

    // Conclusions — only substantive insights, not thinking-aloud
    const conclusions = content.match(/(?:this means (?:that )?|therefore,? |the (?:conclusion|implication|takeaway|key insight) is )[^.!?\n]{30,200}[.!?]/gi) || [];
    for (const c of conclusions) {
      if (!isLowSignal(c, "conclusion")) {
        atomics.push({ summary: c.trim().slice(0, 120), detail: c.trim(), type: "conclusion", confidence: 0.85, source: "reasoning" });
      }
    }
  }

  return dedup(atomics);
}

// ─── Deduplication ──────────────────────────────────────────────────────────

function dedup(atomics) {
  const seen = new Set();
  return atomics.filter(a => {
    const key = a.summary.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Semantic dedup against existing DB entries ─────────────────────────────

async function semanticDedup(entries, threshold = 0.92) {
  if (entries.length === 0) return entries;

  // Generate embeddings for new entries
  const texts = entries.map(e => embeddingText(e));
  let embeddings;
  try {
    embeddings = await generateEmbeddings(texts);
  } catch {
    // If embedding fails, skip dedup (still insert without embeddings)
    return entries.map(e => ({ ...e, _embedding: null }));
  }

  const kept = [];
  for (let i = 0; i < entries.length; i++) {
    const qEmb = embeddings[i];

    // Check against existing DB entries
    const similar = semanticSearch(db, qEmb, 3);
    const tooSimilar = similar.some(s => s.similarity > threshold);

    if (tooSimilar) {
      continue; // Skip — already have a very similar memory
    }

    // Also check against other new entries in this batch
    let dupInBatch = false;
    for (const k of kept) {
      if (k._embedding && cosineSimilarity(qEmb, k._embedding) > threshold) {
        dupInBatch = true;
        break;
      }
    }

    if (!dupInBatch) {
      kept.push({ ...entries[i], _embedding: qEmb });
    }
  }

  return kept;
}

// ─── Domain inference ───────────────────────────────────────────────────────

function inferDomain(text) {
  const lower = text.toLowerCase();
  const map = {
    peekaboo: "peekaboo-web", safari: "peekaboo-web", browser: "peekaboo-web",
    comfyui: "comfyui", dreamshaper: "comfyui", animatediff: "comfyui",
    tiktok: "tiktok", ffmpeg: "video-pipeline", qwen: "tts", voice: "tts",
    podcast: "podcast", fiverr: "fiverr", etsy: "etsy", telegram: "telegram",
    openclaw: "openclaw", hebbian: "hebbian", memory: "hebbian",
    ollama: "ollama", deepseek: "deepseek", n8n: "n8n",
    applescript: "macos", keychain: "macos", sqlite: "infrastructure",
    esrgan: "video-pipeline", "ken burns": "video-pipeline",
    alpaca: "trading", trading: "trading", stock: "trading",
    patreon: "business", fiverr: "business", etsy: "business",
  };
  for (const [kw, dom] of Object.entries(map)) {
    if (lower.includes(kw)) return dom;
  }
  return "general";
}

// ─── Session file parser ────────────────────────────────────────────────────

async function parseSessionFile(filePath) {
  const content = await readFileAsync(filePath, "utf-8");
  const messages = [];
  const reasonings = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const msg = entry.message || entry;
      if (msg.role === "assistant" || msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "thinking" && (block.thinking || block.text)) {
              reasonings.push({ role: "reasoning", content: block.thinking || block.text });
            } else if (block.type === "text" && block.text) {
              messages.push({ role: msg.role, content: block.text });
            }
          }
        }
      }
    } catch {}
  }
  return { messages, reasonings };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.log("Hebbian Post-Session Extractor v3.1 (SQLite + semantic dedup)\n\nUsage:\n  node hebbian-session-extractor-v2.mjs <session.jsonl>\n  node hebbian-session-extractor-v2.mjs --recent\n  node hebbian-session-extractor-v2.mjs --all\n  node hebbian-session-extractor-v2.mjs --text \"I discovered that...\"");
    return;
  }

  let allAtomics = [];

  if (arg === "--text") {
    const text = process.argv.slice(3).join(" ");
    allAtomics = extractFromTranscript([{ content: text }]);
  } else if (arg === "--recent" || arg === "--all") {
    if (!existsSync(SESSION_DIR)) { console.error("Session directory not found"); process.exit(1); }
    const { readdir: readdirAsync } = await import("node:fs/promises");
    const allFiles = await readdirAsync(SESSION_DIR);
    const cutoff = arg === "--all" ? 0 : Date.now() - 24 * 60 * 60 * 1000;
    const totalFiles = allFiles.filter(f => f.endsWith(".jsonl")).length;
    let processed = 0;

    for (const f of allFiles.filter(f => f.endsWith(".jsonl"))) {
      const filePath = join(SESSION_DIR, f);
      processed++;
      if (processed % 50 === 0) console.log(`  [progress] ${processed}/${totalFiles} sessions scanned...`);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) continue;
        const { messages, reasonings } = await parseSessionFile(filePath);
        const msgA = extractFromTranscript(messages);
        const resA = extractFromReasoning(reasonings);
        allAtomics.push(
          ...msgA.map(a => ({ ...a, source_file: f })),
          ...resA.map(a => ({ ...a, source_file: f }))
        );
        if (msgA.length + resA.length > 0) {
          console.log(`  ${f}: ${messages.length} msgs, ${reasonings.length} reasoning → ${msgA.length + resA.length} patterns`);
        }
      } catch {}
    }
  } else {
    const { messages, reasonings } = await parseSessionFile(arg);
    const msgA = extractFromTranscript(messages);
    const resA = extractFromReasoning(reasonings);
    allAtomics = [
      ...msgA.map(a => ({ ...a, source_file: basename(arg) })),
      ...resA.map(a => ({ ...a, source_file: basename(arg) })),
    ];
    console.log(`Parsed: ${messages.length} messages, ${reasonings.length} reasoning blocks`);
  }

  console.log(`Regex-extracted ${allAtomics.length} candidate patterns`);
  if (allAtomics.length === 0) { console.log("No patterns found."); return; }

  // ─── Build entries and check DB duplicates ─────────────────────────────

  const newEntries = [];
  let skippedById = 0;

  for (const atomic of allAtomics) {
    const domain = inferDomain(atomic.detail);
    const id = `${domain}:session:${hashContent(atomic.summary)}`;

    // Skip exact ID duplicates
    if (db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)) {
      skippedById++;
      continue;
    }

    newEntries.push({
      id,
      title: atomic.summary,
      source: "session-extraction",
      source_section: `${domain}/session`,
      created: new Date().toISOString(),
      last_retrieved: new Date().toISOString(),
      retrieval_count: 1,
      content_hash: hashContent(atomic.detail),
      activation: 0.5,
      detail: atomic.detail,
      domain,
      pattern_type: atomic.type,
      tags: [domain, atomic.type, "session-learned"],
    });
  }

  console.log(`After ID dedup: ${newEntries.length} new (${skippedById} already in DB)`);

  if (newEntries.length === 0) {
    console.log("All patterns already exist in store.");
    return;
  }

  // ─── Semantic dedup against existing entries ───────────────────────────

  console.log("Running semantic dedup (threshold: 0.92)...");
  const dedupedEntries = await semanticDedup(newEntries, 0.92);
  const skippedBySemantic = newEntries.length - dedupedEntries.length;
  console.log(`After semantic dedup: ${dedupedEntries.length} kept (${skippedBySemantic} too similar to existing)`);

  if (dedupedEntries.length === 0) {
    console.log("All patterns are semantically similar to existing memories.");
    return;
  }

  // Show what's being added
  for (const e of dedupedEntries) {
    console.log(`  [${e.pattern_type}] ${e.title.slice(0, 80)}`);
  }

  // ─── Insert into SQLite ────────────────────────────────────────────────

  let added = 0;
  const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");

  const insertTx = db.transaction((entries) => {
    for (const entry of entries) {
      const { _embedding, ...record } = entry;
      upsertMemory(db, record);

      // Store pre-computed embedding
      if (_embedding) {
        update.run(embeddingToBlob(_embedding), record.id);
      }
      added++;
    }
  });

  insertTx(dedupedEntries);

  // Generate embeddings for any entries that didn't get them during dedup
  const missingEmb = dedupedEntries.filter(e => !e._embedding);
  if (missingEmb.length > 0) {
    console.log(`Generating embeddings for ${missingEmb.length} entries without them...`);
    const batchSize = 25;
    for (let i = 0; i < missingEmb.length; i += batchSize) {
      const batch = missingEmb.slice(i, i + batchSize);
      const texts = batch.map(e => embeddingText(e));
      try {
        const embeddings = await generateEmbeddings(texts);
        const tx = db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            update.run(embeddingToBlob(embeddings[j]), batch[j].id);
          }
        });
        tx();
      } catch (err) {
        console.error(`  Embedding batch failed: ${err.message}`);
      }
    }
  }

  const total = db.prepare("SELECT COUNT(*) AS cnt FROM memories").get().cnt;
  console.log(`\n✅ Added ${added} new patterns to Hebbian store (total: ${total})`);
}

main().catch(console.error).finally(() => closeDb());
