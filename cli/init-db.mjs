#!/usr/bin/env node
/**
 * Initialize Hebbian Memory Database
 *
 * Creates the SQLite database with schema if it doesn't exist.
 * Safe to run multiple times.
 */

import { openDb, closeDb, getStats } from "../lib/db.mjs";

console.log("[init-db] Initializing Hebbian memory database...");

const db = openDb();
const stats = getStats(db);

console.log(`[init-db] ✅ Database ready`);
console.log(`  Total memories: ${stats.total}`);
console.log(`  Atomic patterns: ${stats.atomic}`);
console.log(`  Co-occurrence pairs: ${stats.coOccurrences}`);

if (stats.total === 0) {
  console.log(`\n[init-db] Database is empty. Use extractors to populate it:`);
  console.log(`  node extractors/atomize.mjs scan path/to/notes/*.md`);
  console.log(`  node extractors/atomize.mjs extract path/to/notes/*.md`);
}

closeDb();
