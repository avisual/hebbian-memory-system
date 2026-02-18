#!/usr/bin/env node
/**
 * Hebbian Memory Top Patterns CLI
 *
 * Display top patterns by activation score.
 *
 * Usage:
 *   node cli/top.mjs [limit]
 *   hebbian-top 20
 */

import { openDb, closeDb } from "../lib/db.mjs";

const limit = parseInt(process.argv[2]) || 20;

const db = openDb();

const topPatterns = db.prepare(`
  SELECT id, domain, pattern_type, title, detail, activation,
         datetime(last_retrieved) as last_used
  FROM memories
  ORDER BY activation DESC
  LIMIT ?
`).all(limit);

closeDb();

console.log(`Top ${limit} patterns by activation:\n`);

topPatterns.forEach((p, i) => {
  console.log(`${(i + 1).toString().padStart(2)}. [${p.activation.toFixed(2).padStart(6)}] ${p.title}`);
  console.log(`    Domain: ${p.domain} | Type: ${p.pattern_type}`);
  if (p.last_used) {
    console.log(`    Last used: ${p.last_used}`);
  }
  if (p.detail && p.detail !== p.title) {
    console.log(`    ${p.detail.substring(0, 120)}${p.detail.length > 120 ? "..." : ""}`);
  }
  console.log();
});
