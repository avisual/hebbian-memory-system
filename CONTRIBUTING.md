# Contributing to Hebbian Memory System

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/avisual/hebbian-memory-system.git
cd hebbian-memory-system
npm install
```

## Project Structure

```
lib/           Core database layer (shared)
plugin/        OpenClaw plugin integration
cli/           Command-line tools
extractors/    Pattern extraction scripts
examples/      Sample data and configs
docs/          Documentation
```

## Running Tests

```bash
# Initialize test database
node cli/init-db.mjs

# Test extractors
node extractors/atomize.mjs scan examples/
node extractors/session-extractor.mjs --text "Test pattern"

# Test CLI tools
node cli/stats.mjs
node cli/search.mjs "test"
node cli/top.mjs 5
```

## Coding Standards

- ES modules (type: "module")
- Use `better-sqlite3` for database access
- Keep CLI tools simple and focused
- Document configuration options
- Use homedir() for portability

## Key Areas for Contribution

### Extraction Patterns
Improve regex patterns and semantic deduplication in:
- `extractors/session-extractor.mjs`
- `extractors/reasoning-extractor.mjs`
- `extractors/atomize.mjs`

### Scoring Algorithms
Tune retrieval quality in `lib/db.mjs`:
- Semantic vs activation vs domain weights
- Domain-specific bonuses/penalties
- Minimum similarity thresholds

### Performance
Optimize for large databases (50k+ entries):
- Indexing strategies
- Caching embeddings
- Batch operations

### Documentation
- More examples
- Tutorial content
- Integration guides

## Pull Request Process

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Questions?

Open an issue or start a discussion on GitHub.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
