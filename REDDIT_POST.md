# Reddit Post Draft

## Title Options

**Option 1 (Technical):**
I built a Hebbian learning-inspired memory system for AI agents (SQLite + semantic embeddings)

**Option 2 (Problem-focused):**
Giving AI agents actual long-term memory that learns what matters through use

**Option 3 (Show, don't tell):**
My AI assistant remembers 5,000+ patterns and retrieves the relevant ones in <10ms

---

## Post Body

I got frustrated with AI agents that forget everything between sessions, so I built a persistent memory system inspired by how human memory actually works.

**The problem:** Traditional AI agents either have no memory beyond their context window, or they dump everything into a vector database and hope semantic search finds what matters. Neither approach captures the fact that *frequently-used information should stay accessible* while irrelevant stuff fades away.

**What I built:** A hybrid memory system combining:

- **Semantic retrieval** (768-dim embeddings via Ollama's nomic-embed-text)
- **Activation-based ranking** (Hebbian learning: patterns you use frequently get stronger)
- **Co-occurrence learning** (patterns retrieved together form associative links)
- **Automatic extraction** (mines insights from conversations, reasoning blocks, and documents)

The key insight from cognitive science: memory isn't just about *storage*, it's about *retrieval patterns*. If you never retrieve something, it doesn't matter how perfectly it's stored.

**How it works:**

1. Every time the agent runs, it embeds the current query
2. Retrieves semantically similar patterns from SQLite
3. Combines semantic similarity (0.6 weight) + activation score (0.3) + domain match (0.1)
4. Bumps activation for patterns that were used
5. Over time, frequently-used patterns stay strong, unused ones decay

**Example:** My AI assistant has ~5,000 memories spanning peekaboo-web automation rules, TikTok growth patterns, infrastructure setup, debugging solutions. When I ask about browser automation, it retrieves the relevant 15-20 patterns in <10ms. When those patterns get used, they strengthen. Patterns I haven't needed in weeks fade from retrieval (but aren't deleted — they can resurface if relevant again).

**Tech stack:**

- SQLite with WAL mode (ACID guarantees, concurrent-safe)
- better-sqlite3 (synchronous, fast)
- Ollama for embeddings (local, zero cost, 768-dim)
- Pure JS/Node.js, no external services

**What's included:**

- OpenClaw plugin (auto-injects context on every agent turn)
- CLI tools (search, stats, top patterns)
- Extractors (session transcripts, reasoning blocks, markdown knowledge bases)
- Complete documentation and examples

**Performance on M4 Mac mini (16GB):**

- 5,000 entries: ~10MB database
- Semantic search: <10ms
- Embedding generation: ~120/second
- Memory footprint: ~50MB (including loaded model)

**Repo:** https://github.com/avisual/hebbian-memory-system

**MIT licensed.** Built this for my own 24/7 AI assistant (running on a dedicated Mac mini), but figured others might find it useful.

The name comes from Hebb's rule ("cells that fire together, wire together") — patterns retrieved together strengthen their associative links, just like neurons.

Happy to answer questions about the implementation, retrieval algorithm, or how it compares to other approaches like MemGPT/MemOS.

---

## Suggested Subreddits

**Primary targets:**
- r/LocalLLaMA (local AI enthusiasts)
- r/OpenAI (AI developers)
- r/MachineLearning (ML practitioners)
- r/SelfHosted (self-hosting community)

**Secondary:**
- r/opensource
- r/artificial
- r/OpenSourceAI
- r/programming

**Notes:**
- Include code snippets if posting to r/programming
- Emphasize local/offline aspect for r/LocalLLaMA and r/SelfHosted
- Keep technical details for r/MachineLearning
- Focus on practical results for r/OpenAI

---

## Alternative: Short Version (for more casual subreddits)

**Title:** Built a memory system for AI agents that learns what matters through use

**Body:**

Ever notice how AI assistants forget everything you told them last week? I built a solution.

It's a persistent memory system that works like human memory: frequently-used information stays accessible, unused stuff fades away (but isn't deleted — it can resurface if relevant again).

Uses SQLite + semantic embeddings + activation scores. When my AI assistant retrieves a pattern, that pattern gets stronger. Over time, it naturally learns what information actually matters.

~5,000 patterns, <10ms retrieval, runs locally via Ollama (no API costs).

MIT licensed: https://github.com/avisual/hebbian-memory-system

Built for my personal AI assistant but open-sourced in case others find it useful.
