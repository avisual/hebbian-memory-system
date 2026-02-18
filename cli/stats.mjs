#!/usr/bin/env node
/**
 * Hebbian Memory Stats CLI
 *
 * Display database statistics.
 *
 * Usage:
 *   node cli/stats.mjs
 *   hebbian-stats
 */

import { openDb, closeDb, getStats } from "../lib/db.mjs";

const db = openDb();
const stats = getStats(db);

console.log("Hebbian Memory Database Statistics\n");
console.log(`Total memories: ${stats.total}`);
console.log(`Atomic patterns: ${stats.atomic}`);
console.log(`Co-occurrence pairs: ${stats.coOccurrences}`);
console.log(`With embeddings: ${stats.withEmbeddings} (${((stats.withEmbeddings / stats.total) * 100).toFixed(1)}%)`);

console.log("\nBreakdown by domain:");

const domainCounts = db.prepare(`
  SELECT domain, COUNT(*) as count
  FROM memories
  GROUP BY domain
  ORDER BY count DESC
  LIMIT 15
`).all();

domainCounts.forEach((row) => {
  const bar = "█".repeat(Math.ceil((row.count / stats.total) * 40));
  console.log(`  ${row.domain.padEnd(25)} ${row.count.toString().padStart(5)} ${bar}`);
});

console.log("\nBreakdown by pattern type:");

const typeCounts = db.prepare(`
  SELECT pattern_type, COUNT(*) as count
  FROM memories
  GROUP BY pattern_type
  ORDER BY count DESC
`).all();

typeCounts.forEach((row) => {
  const bar = "█".repeat(Math.ceil((row.count / stats.total) * 40));
  console.log(`  ${row.pattern_type.padEnd(25)} ${row.count.toString().padStart(5)} ${bar}`);
});

console.log("\nActivation summary:");

const activationStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    ROUND(AVG(activation), 2) as avg,
    ROUND(MIN(activation), 2) as min,
    ROUND(MAX(activation), 2) as max,
    SUM(CASE WHEN activation > 50 THEN 1 ELSE 0 END) as active,
    SUM(CASE WHEN activation BETWEEN 10 AND 50 THEN 1 ELSE 0 END) as decaying,
    SUM(CASE WHEN activation < 10 THEN 1 ELSE 0 END) as at_risk
  FROM memories
`).get();

console.log(`  Average: ${activationStats.avg}`);
console.log(`  Range: ${activationStats.min} - ${activationStats.max}`);
console.log(`  Active (>50): ${activationStats.active}`);
console.log(`  Decaying (10-50): ${activationStats.decaying}`);
console.log(`  At risk (<10): ${activationStats.at_risk}`);

closeDb();
