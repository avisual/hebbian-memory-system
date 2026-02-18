#!/usr/bin/env node
/**
 * Hebbian Atomizer v3.1 — Extract atomic patterns from memory files → SQLite
 *
 * Scans:
 *   - memory/learnings/*.md (curated knowledge)
 *   - memory/core/*.md (system config, John's preferences)
 *   - memory/2026-*.md (daily logs, auto-added since v3.1)
 *
 * Features:
 *   - Change detection via file hashes (only re-process modified files)
 *   - Automatic embedding generation
 *   - Deduplication by content hash
 *
 * Usage:
 *   node hebbian-atomize.mjs scan          # Preview what would be extracted
 *   node hebbian-atomize.mjs extract       # Extract and add to SQLite
 *   node hebbian-atomize.mjs extract --file <path>  # Extract from one file
 *   node hebbian-atomize.mjs extract --force  # Re-process all files (ignore hashes)
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  openDb, closeDb, upsertMemory, embeddingText,
  generateEmbeddings, embeddingToBlob, getMeta, setMeta, DEFAULT_DB_PATH,
} from "../lib/db.mjs";
import { hashContent } from "../cli/manager.mjs";

const LEARNINGS_DIR = join(homedir(), ".openclaw/workspace/memory/learnings");
const CORE_DIR = join(homedir(), ".openclaw/workspace/memory/core");
const MEMORY_DIR = join(homedir(), ".openclaw/workspace/memory");
const db = openDb(DEFAULT_DB_PATH);

// ─── File hash tracking ──────────────────────────────────────────────────────

function fileHash(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getStoredHash(filePath) {
  const key = `atomize_hash:${filePath}`;
  return getMeta(db, key);
}

function storeHash(filePath, hash) {
  const key = `atomize_hash:${filePath}`;
  setMeta(db, key, hash);
}

// ─── Extraction logic (unchanged from v2) ────────────────────────────────────

function extractAtomics(content, filename) {
  const domain = basename(filename, ".md").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const atomics = [];
  const lines = content.split("\n");
  let currentSection = "";
  let currentContent = [];
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    if (line.match(/^#{1,3}\s/)) {
      if (currentContent.length > 0) {
        atomics.push(...parseSection(currentContent.join("\n"), domain, currentSection));
      }
      currentSection = line.replace(/^#+\s*/, "").trim();
      currentContent = [];
      continue;
    }
    currentContent.push(line);
  }
  if (currentContent.length > 0) {
    atomics.push(...parseSection(currentContent.join("\n"), domain, currentSection));
  }
  return atomics;
}

function parseSection(text, domain, section) {
  const atomics = [];

  // Strategy 1: Bold bullet points → rules
  const bulletLines = text.match(/^[-*]\s+\*\*[^*]+\*\*[^$]*/gm) || [];
  for (const bullet of bulletLines) {
    const cleaned = bullet.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();
    if (cleaned.length > 20 && cleaned.length < 500) {
      atomics.push({ domain, section, summary: cleaned.slice(0, 120), detail: cleaned, type: "rule" });
    }
  }

  // Strategy 2: Action patterns → directives
  const actionPatterns = text.match(/(?:^|\n)[-*]?\s*(?:\*\*)?(?:Always|Never|Use|Avoid|Don't|Do not|Must|Should|Set|Keep|Prefer|Remember)[^.\n]{10,150}[.!]/gi) || [];
  for (const p of actionPatterns) {
    const cleaned = p.replace(/^[-*\s]+/, "").replace(/\*\*/g, "").trim();
    if (cleaned.length > 15 && !atomics.some(a => a.summary.includes(cleaned.slice(0, 40)))) {
      atomics.push({ domain, section, summary: cleaned.slice(0, 120), detail: cleaned, type: "directive" });
    }
  }

  // Strategy 3: Key-value facts
  const factPatterns = text.match(/(?:^|\n)[-*]?\s*(?:\*\*)?[A-Z][^:]{3,40}(?:\*\*)?:\s*[^\n]{10,200}/gm) || [];
  for (const fact of factPatterns) {
    const cleaned = fact.replace(/^[-*\s]+/, "").replace(/\*\*/g, "").trim();
    if (cleaned.length > 20 && cleaned.length < 300 && !cleaned.startsWith("#")) {
      if (!atomics.some(a => a.detail.includes(cleaned.slice(0, 40)))) {
        atomics.push({ domain, section, summary: cleaned.slice(0, 120), detail: cleaned, type: "fact" });
      }
    }
  }

  // Strategy 4: Code/commands
  const codeBlocks = text.match(/`([^`]{10,100})`/g) || [];
  for (const code of codeBlocks) {
    const cmd = code.replace(/`/g, "");
    if (cmd.includes(" ") && !cmd.includes("\n") && cmd.length > 15) {
      const contextLine = text.split("\n").find(l => l.includes(code));
      if (contextLine && !atomics.some(a => a.detail.includes(cmd))) {
        const context = contextLine.replace(/`/g, "").replace(/^[-*\s]+/, "").trim();
        atomics.push({ domain, section, summary: `Command: ${cmd.slice(0, 80)}`, detail: context.slice(0, 250), type: "command" });
      }
    }
  }

  return atomics;
}

function atomicId(domain, summary) {
  const clean = summary.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 50);
  return `${domain}:${clean}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  const specificFile = process.argv.indexOf("--file") > -1
    ? process.argv[process.argv.indexOf("--file") + 1]
    : null;

  let files = [];
  if (specificFile) {
    files = [specificFile];
  } else {
    // Scan learnings/ directory
    if (existsSync(LEARNINGS_DIR)) {
      const entries = await readdir(LEARNINGS_DIR);
      files.push(...entries.filter(f => f.endsWith(".md")).map(f => join(LEARNINGS_DIR, f)));
    }
    // Scan core/ directory
    if (existsSync(CORE_DIR)) {
      const entries = await readdir(CORE_DIR);
      files.push(...entries.filter(f => f.endsWith(".md")).map(f => join(CORE_DIR, f)));
    }
    // Scan daily logs (2026-*.md in memory/)
    if (existsSync(MEMORY_DIR)) {
      const entries = await readdir(MEMORY_DIR);
      const dailyLogs = entries.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
      files.push(...dailyLogs.map(f => join(MEMORY_DIR, f)));
    }
  }

  const forceReprocess = process.argv.includes("--force");
  console.log(`Scanning ${files.length} files${forceReprocess ? " (force reprocess)" : ""}...`);

  let allAtomics = [];
  let skippedUnchanged = 0;

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const currentHash = fileHash(content);
      const storedHash = getStoredHash(filePath);

      // Skip unchanged files (unless force or scan mode)
      if (!forceReprocess && command === "extract" && storedHash === currentHash) {
        skippedUnchanged++;
        continue;
      }

      const atomics = extractAtomics(content, basename(filePath));
      allAtomics.push(...atomics.map(a => ({ ...a, source_file: filePath, file_hash: currentHash })));

      if (command === "scan" && atomics.length > 0) {
        console.log(`\n📄 ${basename(filePath)}: ${atomics.length} patterns`);
        for (const a of atomics.slice(0, 5)) console.log(`  [${a.type}] ${a.summary.slice(0, 80)}`);
        if (atomics.length > 5) console.log(`  ... and ${atomics.length - 5} more`);
      }
    } catch (err) {
      console.error(`Error reading ${filePath}: ${err.message}`);
    }
  }

  if (skippedUnchanged > 0) {
    console.log(`Skipped ${skippedUnchanged} unchanged files`);
  }

  console.log(`\nTotal: ${allAtomics.length} atomic patterns from ${files.length} files`);

  const byType = {};
  for (const a of allAtomics) byType[a.type] = (byType[a.type] || 0) + 1;
  console.log("By type:", JSON.stringify(byType));

  if (command === "extract") {
    let added = 0;
    let skipped = 0;
    const toEmbed = [];

    for (const atomic of allAtomics) {
      const id = atomicId(atomic.domain, atomic.summary);

      if (db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)) {
        skipped++;
        continue;
      }

      const tags = [atomic.domain, atomic.type];
      if (atomic.section) {
        tags.push(...atomic.section.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 3));
      }

      const entry = {
        id,
        title: atomic.summary,
        source: "atomic",
        source_section: `${atomic.domain}/${atomic.section || "general"}`,
        created: new Date().toISOString(),
        last_retrieved: new Date().toISOString(),
        retrieval_count: 1,
        content_hash: hashContent(atomic.detail),
        activation: 0.5,
        detail: atomic.detail,
        domain: atomic.domain,
        pattern_type: atomic.type,
        tags: [...new Set(tags)],
      };

      upsertMemory(db, entry);
      toEmbed.push(entry);
      added++;
    }

    // Batch-generate embeddings
    if (toEmbed.length > 0) {
      console.log(`\nGenerating embeddings for ${toEmbed.length} new entries...`);
      const batchSize = 25;
      const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
      let embedded = 0;

      for (let i = 0; i < toEmbed.length; i += batchSize) {
        const batch = toEmbed.slice(i, i + batchSize);
        const texts = batch.map(e => embeddingText(e));
        try {
          const embeddings = await generateEmbeddings(texts);
          const tx = db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              update.run(embeddingToBlob(embeddings[j]), batch[j].id);
            }
          });
          tx();
          embedded += batch.length;
          process.stdout.write(`  ${embedded}/${toEmbed.length}\r`);
        } catch (err) {
          console.error(`  Batch failed: ${err.message}`);
        }
      }
      console.log(`  Embedded ${embedded}/${toEmbed.length}`);
    }

    // Store file hashes for change detection
    const processedFiles = new Set(allAtomics.map(a => a.source_file));
    for (const filePath of processedFiles) {
      const atomic = allAtomics.find(a => a.source_file === filePath);
      if (atomic?.file_hash) {
        storeHash(filePath, atomic.file_hash);
      }
    }

    const total = db.prepare("SELECT COUNT(*) AS cnt FROM memories").get().cnt;
    console.log(`\n✅ Added ${added} atomic entries, skipped ${skipped} duplicates (total: ${total})`);
    console.log(`📝 Stored file hashes for ${processedFiles.size} files`);
  }
}

main().catch(console.error).finally(() => closeDb());
