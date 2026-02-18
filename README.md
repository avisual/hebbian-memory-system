# Hebbian Memory System

A biologically-inspired persistent memory system for AI agents, combining Hebbian learning principles with modern semantic search.

## What It Does

The Hebbian Memory System gives AI agents long-term memory that actually works like human memory:

- **Semantic retrieval** — finds relevant patterns based on meaning, not just keywords
- **Activation-based ranking** — frequently-used patterns stay accessible, unused ones fade
- **Co-occurrence learning** — patterns retrieved together form associative links
- **Automatic extraction** — mines insights from conversations, reasoning blocks, and documents
- **Self-organizing** — no manual curation required, the system learns what matters through use

**Result:** An AI agent that remembers what it learned, retrieves it when relevant, and builds richer associations over time.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AI Agent Conversation                                  │
│  ↓                                                       │
│  Session Transcript (.jsonl)                            │
└─────────────────────────────────────────────────────────┘
           ↓                          ↓
    ┌──────────────┐         ┌───────────────┐
    │  Reasoning   │         │   Markdown    │
    │  Extractor   │         │   Atomizer    │
    └──────────────┘         └───────────────┘
           ↓                          ↓
    ┌──────────────────────────────────────┐
    │     SQLite Database (hebbian.db)     │
    │  ┌────────────────────────────────┐  │
    │  │ memories: atomic patterns       │  │
    │  │ - semantic embeddings (768dim)  │  │
    │  │ - activation scores             │  │
    │  │ - domain/type tags              │  │
    │  │ co_occurrences: associative links│ │
    │  └────────────────────────────────┘  │
    └──────────────────────────────────────┘
           ↓
    ┌──────────────┐
    │  Retrieval   │
    │  Plugin      │ ← Query from agent
    └──────────────┘
           ↓
    Context injected into AI agent
```

## Core Concepts

### Hebbian Learning
"Cells that fire together, wire together." Patterns retrieved in the same context build associative links. The more often two patterns appear together, the stronger their connection.

### Activation Decay
Every pattern has an activation score. Retrieval boosts activation; time decays it. This mimics human memory — frequently-used information stays accessible, unused information fades.

### Semantic Search
Uses 768-dimensional embeddings (via Ollama's `nomic-embed-text`) for meaning-based retrieval. Finds relevant patterns even when keywords don't match.

### Combined Scoring
```
relevance = (semantic_similarity × 0.6) 
          + (normalized_activation × 0.3) 
          + (domain_match × 0.1)
          + type_bonuses - penalties
```

Rules and corrections rank higher; vague "general" entries rank lower.

## Quick Start

### Prerequisites
- Node.js 18+
- SQLite 3
- Ollama with `nomic-embed-text` model (for embeddings)

### Installation

```bash
git clone https://github.com/avisual/hebbian-memory-system.git
cd hebbian-memory-system
npm install
```

### Initialize Database

```bash
node cli/init-db.mjs
```

This creates `~/.hebbian/hebbian.db` with the schema.

### Extract from Markdown Files

```bash
# Scan your knowledge base
node extractors/atomize.mjs scan ~/my-notes/*.md

# Extract patterns into database
node extractors/atomize.mjs extract ~/my-notes/*.md
```

### Retrieve Patterns

```bash
# Search for relevant patterns
node cli/search.mjs "how to handle forms"

# View activation stats
node cli/stats.mjs
```

## Usage Patterns

### For OpenClaw Users

The plugin automatically injects relevant memories into your agent's context on every request.

1. Copy `plugin/` contents to `~/.openclaw/extensions/hebbian-hook/`
2. Enable in `openclaw.json`:
```json
{
  "plugins": {
    "allow": ["hebbian-hook"],
    "entries": {
      "hebbian-hook": { "enabled": true }
    }
  }
}
```
3. Restart gateway

### Standalone Usage

Use the CLI tools to build and query your memory base:

```bash
# Add patterns from session logs
node extractors/session-extractor.mjs path/to/session.jsonl

# Add patterns from reasoning blocks (requires LLM)
node extractors/reasoning-extractor.mjs path/to/sessions/

# Query the database
node cli/search.mjs "debugging peekaboo"

# View top patterns by activation
node cli/top.mjs 20
```

### Cron Automation

Run maintenance tasks periodically:

```bash
# Daily: decay all activations (0.9995x multiplicative)
0 3 * * * node cli/decay.mjs

# Weekly: prune low-activation entries and verify embeddings
30 3 * * 0 node cli/prune.mjs
```

## File Structure

```
hebbian-memory-system/
├── lib/
│   └── db.mjs              # Core database layer (shared)
├── plugin/
│   ├── index.mjs           # OpenClaw plugin integration
│   ├── openclaw.plugin.json
│   └── package.json
├── extractors/
│   ├── session-extractor.mjs    # Extracts from session transcripts
│   ├── reasoning-extractor.mjs  # Mines thinking blocks via LLM
│   └── atomize.mjs             # Parses markdown into atomic patterns
├── cli/
│   ├── init-db.mjs        # Initialize schema
│   ├── search.mjs         # Query patterns
│   ├── stats.mjs          # View statistics
│   ├── top.mjs            # Top patterns by activation
│   ├── decay.mjs          # Apply time-based decay
│   └── prune.mjs          # Maintenance
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SCHEMA.md
│   └── TUNING.md
├── examples/
│   ├── sample-memories.json
│   └── config.example.json
└── README.md
```

## Configuration

### Database Location

By default, the database is stored at `~/.hebbian/hebbian.db`. You can override this by setting the `HEBBIAN_DB_PATH` environment variable:

```bash
export HEBBIAN_DB_PATH=/path/to/your/hebbian.db
```

### OpenClaw Integration

The extractors expect the standard OpenClaw directory structure:
- Session transcripts: `~/.openclaw/agents/main/sessions/`
- Memory files: `~/.openclaw/workspace/memory/`

If your OpenClaw is in a different location, you can customize the extractor paths in the scripts.

### Config File

Create `~/.hebbian/config.json`:

```json
{
  "dbPath": "~/.hebbian/hebbian.db",
  "embedModel": "nomic-embed-text",
  "ollamaUrl": "http://127.0.0.1:11434",
  "retrieval": {
    "maxContextTokens": 800,
    "semanticWeight": 0.6,
    "activationWeight": 0.3,
    "domainWeight": 0.1
  },
  "decay": {
    "dailyFactor": 0.9995,
    "pruneThreshold": 0.1
  }
}
```

## Advanced Topics

### Reasoning Extraction

The `reasoning-extractor` uses a local LLM (qwen2.5-coder:7b via Ollama) to extract insights from AI assistant thinking blocks:

```bash
node extractors/reasoning-extractor.mjs \
  --sessions ~/.openclaw/agents/main/sessions/ \
  --limit 1000
```

This processes internal reasoning and extracts:
- Bug insights
- Corrections
- Solutions
- Architectural decisions
- Performance benchmarks

### Session Extraction

Extracts patterns from conversation transcripts using regex and semantic analysis:

```bash
node extractors/session-extractor.mjs \
  --file path/to/session.jsonl \
  --recent 7  # or process all sessions from last 7 days
```

### Markdown Atomization

Breaks down knowledge base files into atomic, retrievable patterns:

```bash
# Scan what would be extracted
node extractors/atomize.mjs scan ~/docs/learnings/*.md

# Extract and store
node extractors/atomize.mjs extract ~/docs/learnings/*.md

# Force re-process all files (ignores change detection)
node extractors/atomize.mjs extract --force ~/docs/learnings/*.md
```

### Tuning Retrieval Quality

See `docs/TUNING.md` for guidance on:
- Adjusting scoring weights
- Domain-specific bonuses/penalties
- Minimum similarity thresholds
- Diversity constraints

## Performance

On a 16GB M4 Mac mini:
- **Database**: 4,000-10,000 entries typical, scales to 50k+
- **Retrieval**: <10ms for semantic search across 10k entries
- **Embeddings**: ~120 embeddings/second (Ollama nomic-embed-text)
- **Storage**: ~3-5MB per 1,000 entries (including embeddings)

## Troubleshooting

**Embeddings failing:**
```bash
# Verify Ollama is running and model is loaded
ollama ps
ollama pull nomic-embed-text
```

**Low retrieval quality:**
```bash
# Check embedding coverage
node cli/stats.mjs

# Re-embed missing entries
node cli/embed-missing.mjs
```

**Database locked:**
- Enable WAL mode (done automatically by init-db)
- Check no stale processes holding locks: `lsof ~/.hebbian/hebbian.db`

## Roadmap

- [ ] Visualization dashboard (activation heatmap, co-occurrence graph)
- [ ] Distributed deployment (sync across devices)
- [ ] Alternative embedding models (BERT, MPNet)
- [ ] Telegram/Discord message mining
- [ ] Automatic conflict resolution (contradictory patterns)

## Contributing

Contributions welcome! Key areas:
- Extraction patterns (better regex, new sources)
- Scoring algorithms (improve relevance)
- Performance optimizations (indexing, caching)
- Documentation and examples

## Sponsor This Project

If you find this useful, consider sponsoring development:

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-pink.svg)](https://github.com/sponsors/avisual)

Sponsor tiers:
- **$3/month** — Supporter badge
- **$10/month** — Name in README contributors
- **$25/month** — Priority bug reports and feature requests
- **$100/month** — Private consultation on memory system design

All proceeds go toward:
- Hosting costs for demo instances
- Development of new extractors and visualizations
- Documentation and tutorial content

## License

MIT

## Credits

Inspired by:
- ACT-R cognitive architecture (activation-based retrieval)
- Hopfield networks (Hebbian weight updates)
- MemGPT/MemOS (persistent agent memory)
- LanceDB/Qdrant (vector search systems)

Built by [Your Name] for autonomous AI agents with real long-term memory.
