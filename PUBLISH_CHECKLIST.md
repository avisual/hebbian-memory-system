# Publication Checklist

## Pre-Publication

- [x] Remove all hardcoded paths
- [x] Update all GitHub username references to "avisual"
- [x] Add environment variable support (HEBBIAN_DB_PATH, OLLAMA_URL)
- [x] Create CLI tools (search, stats, top)
- [x] Add comprehensive README with installation instructions
- [x] Add CONTRIBUTING.md
- [x] Configure package.json for npm publication
- [x] All commits pushed to private repo

## To Publish

### 1. Make Repository Public

```bash
cd ~/hebbian-memory-system
gh repo edit --visibility public --accept-visibility-change-consequences
```

### 2. Create GitHub Release

```bash
gh release create v1.0.0 \
  --title "Hebbian Memory System v1.0.0" \
  --notes "Initial public release

Biologically-inspired persistent memory for AI agents with:
- Semantic retrieval via embeddings
- Activation-based ranking (Hebbian learning)
- Co-occurrence learning (associative memory)
- OpenClaw plugin integration
- Automatic extraction from conversations and documents

See README for installation and usage instructions."
```

### 3. Publish to npm (Optional)

```bash
cd ~/hebbian-memory-system

# Login to npm (if not already logged in)
npm login

# Publish
npm publish --access public

# Or dry-run first
npm publish --dry-run
```

### 4. Test Installation

Test both installation methods:

```bash
# Method 1: From GitHub
git clone https://github.com/avisual/hebbian-memory-system.git
cd hebbian-memory-system
npm install
node cli/init-db.mjs

# Method 2: From npm (after publishing)
npm install -g hebbian-memory-system
hebbian-init
hebbian-stats
```

### 5. Verify Plugin Integration

```bash
openclaw plugin add ./plugin
# or
openclaw plugin add hebbian-memory-system/plugin
```

Check `openclaw.json` config and restart gateway.

## Post-Publication

### Community

- [ ] Share on Discord/Twitter/Reddit
- [ ] Submit to OpenClaw plugin registry (if exists)
- [ ] Write blog post or tutorial

### Documentation

- [ ] Add usage examples
- [ ] Create video walkthrough
- [ ] Write integration guide for other AI frameworks

### Enhancements

- [ ] Visualization dashboard (activation heatmap, co-occurrence graph)
- [ ] Alternative embedding models
- [ ] Telegram/Discord message mining
- [ ] Conflict resolution for contradictory patterns

## Rollback Plan

If issues are found after publication:

1. Unpublish from npm: `npm unpublish hebbian-memory-system@1.0.0`
2. Make repo private: `gh repo edit --visibility private`
3. Fix issues
4. Re-publish when ready

## Support

- GitHub Issues: https://github.com/avisual/hebbian-memory-system/issues
- GitHub Sponsors: https://github.com/sponsors/avisual
