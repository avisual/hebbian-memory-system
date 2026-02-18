#!/usr/bin/env node
/**
 * Hebbian Memory Search CLI
 *
 * Search the memory database for relevant patterns.
 *
 * Usage:
 *   node cli/search.mjs "query text"
 *   hebbian-search "query text"
 */

import { openDb, closeDb, retrieve } from "../lib/db.mjs";

const query = process.argv.slice(2).join(" ");

if (!query) {
  console.log("Usage: hebbian-search \"query text\"");
  process.exit(1);
}

console.log(`Searching for: "${query}"\n`);

const db = openDb();
const results = await retrieve(db, query, {
  maxEntries: 20,
  maxTokens: 2000,
});

closeDb();

if (results.length === 0) {
  console.log("No results found.");
  process.exit(0);
}

console.log(`Found ${results.length} patterns:\n`);

results.forEach((r, i) => {
  console.log(`${i + 1}. [${r.domain}] ${r.title}`);
  console.log(`   Relevance: ${r.relevance.toFixed(3)} | Activation: ${r.activation.toFixed(2)}`);
  if (r.detail && r.detail !== r.title) {
    console.log(`   ${r.detail.substring(0, 150)}${r.detail.length > 150 ? "..." : ""}`);
  }
  console.log();
});
