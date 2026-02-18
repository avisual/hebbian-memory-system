#!/usr/bin/env node
/**
 * Hebbian Correction Tool
 *
 * Manage deprecation and correction of memory entries.
 *
 * Usage:
 *   node hebbian-correct.mjs deprecate <old_id> <new_id>  # Mark old entry as deprecated
 *   node hebbian-correct.mjs correct <correction_id> <corrected_id>  # Mark as correction
 *   node hebbian-correct.mjs list-deprecated [limit]  # Show deprecated entries
 *   node hebbian-correct.mjs search <query>  # Find entries to deprecate/correct
 */

import { homedir } from "node:os";
import { join } from "node:path";

const bsqlite3Path = join(homedir(), "hebbian-memory-system/node_modules/better-sqlite3/lib/index.js");
const { default: Database } = await import(bsqlite3Path);

const DB_PATH = join(homedir(), ".openclaw/workspace/memory/hebbian.db");
const db = new Database(DB_PATH);

const [,, command, ...args] = process.argv;

if (!command) {
  console.log(`Usage:
  hebbian-correct deprecate <old_id> <new_id>
  hebbian-correct correct <correction_id> <corrected_id>
  hebbian-correct list-deprecated [limit]
  hebbian-correct search <query>
`);
  process.exit(1);
}

switch (command) {
  case 'deprecate': {
    const [oldId, newId] = args;
    if (!oldId || !newId) {
      console.error("Error: deprecate requires old_id and new_id");
      process.exit(1);
    }
    
    const update = db.prepare("UPDATE memories SET status = 'deprecated', superseded_by = ? WHERE id = ?");
    const result = update.run(newId, oldId);
    
    if (result.changes > 0) {
      const old = db.prepare("SELECT domain, pattern_type, detail FROM memories WHERE id = ?").get(oldId);
      const newer = db.prepare("SELECT domain, pattern_type, detail FROM memories WHERE id = ?").get(newId);
      console.log(`✅ Deprecated: [${old.domain}/${old.pattern_type}] ${old.detail.slice(0, 60)}...`);
      console.log(`   Superseded by: [${newer.domain}/${newer.pattern_type}] ${newer.detail.slice(0, 60)}...`);
    } else {
      console.error(`❌ Entry ${oldId} not found`);
    }
    break;
  }

  case 'correct': {
    const [correctionId, correctedId] = args;
    if (!correctionId || !correctedId) {
      console.error("Error: correct requires correction_id and corrected_id");
      process.exit(1);
    }
    
    const update = db.prepare("UPDATE memories SET corrects = ? WHERE id = ?");
    const result = update.run(correctedId, correctionId);
    
    if (result.changes > 0) {
      const correction = db.prepare("SELECT domain, pattern_type, detail FROM memories WHERE id = ?").get(correctionId);
      const corrected = db.prepare("SELECT domain, pattern_type, detail FROM memories WHERE id = ?").get(correctedId);
      console.log(`✅ Marked as correction: [${correction.domain}/${correction.pattern_type}] ${correction.detail.slice(0, 60)}...`);
      console.log(`   Corrects: [${corrected.domain}/${corrected.pattern_type}] ${corrected.detail.slice(0, 60)}...`);
    } else {
      console.error(`❌ Entry ${correctionId} not found`);
    }
    break;
  }

  case 'list-deprecated': {
    const limit = parseInt(args[0]) || 20;
    const stmt = db.prepare(`
      SELECT m.id, m.domain, m.pattern_type, m.detail,
             newer.detail as superseded_by_detail
      FROM memories m
      LEFT JOIN memories newer ON m.superseded_by = newer.id
      WHERE m.status = 'deprecated'
      ORDER BY m.last_retrieved DESC NULLS LAST
      LIMIT ?
    `);
    const deprecated = stmt.all(limit);
    
    if (deprecated.length === 0) {
      console.log("No deprecated entries found.");
    } else {
      console.log(`Deprecated entries (${deprecated.length}):\n`);
      for (const entry of deprecated) {
        console.log(`ID: ${entry.id}`);
        console.log(`  [${entry.domain}/${entry.pattern_type}] ${entry.detail.slice(0, 80)}`);
        if (entry.superseded_by_detail) {
          console.log(`  → Superseded by: ${entry.superseded_by_detail.slice(0, 80)}`);
        }
        console.log();
      }
    }
    break;
  }

  case 'search': {
    const query = args.join(' ');
    if (!query) {
      console.error("Error: search requires a query string");
      process.exit(1);
    }
    
    const stmt = db.prepare(`
      SELECT id, domain, pattern_type, detail, status, activation
      FROM memories
      WHERE detail LIKE ? OR title LIKE ?
      ORDER BY activation DESC
      LIMIT 20
    `);
    const results = stmt.all(`%${query}%`, `%${query}%`);
    
    if (results.length === 0) {
      console.log(`No matches found for: ${query}`);
    } else {
      console.log(`Found ${results.length} matches for: ${query}\n`);
      for (const entry of results) {
        const statusBadge = entry.status === 'deprecated' ? '[DEPRECATED]' : '';
        console.log(`${entry.id} ${statusBadge}`);
        console.log(`  [${entry.domain}/${entry.pattern_type}] activation:${entry.activation.toFixed(1)}`);
        console.log(`  ${entry.detail.slice(0, 100)}`);
        console.log();
      }
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

db.close();
