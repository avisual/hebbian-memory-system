# Development Workflow

This repo has two remotes for managing private development and public releases:

- **origin** (private): `https://github.com/avisual/hebbian-memory-dev`
- **public**: `https://github.com/avisual/hebbian-memory-system`

## Daily Development

Work normally, all commits go to the private repo by default:

```bash
# Make changes
git add .
git commit -m "Experimental feature"
git push  # Goes to origin (private dev repo)
```

## Testing & Experimentation

The private repo is your sandbox:

```bash
# Try risky changes
git checkout -b experimental-feature
# ... make changes ...
git push origin experimental-feature

# If it works, merge to main
git checkout main
git merge experimental-feature
git push
```

## Publishing to Public Repo

When you have a stable release ready:

```bash
# 1. Make sure private repo is clean
git status

# 2. Push to public repo
git push public main

# 3. Create a release on the public repo
gh repo set-default avisual/hebbian-memory-system
gh release create v1.0.1 --title "v1.0.1" --notes "Release notes..."

# 4. Switch back to private as default
gh repo set-default avisual/hebbian-memory-dev
```

## Syncing Between Repos

If you accidentally push to public and want to sync back:

```bash
# Pull from public to private
git pull public main
git push origin main
```

Or vice versa:

```bash
# Push from private to public
git push public main
```

## Quick Commands

```bash
# Check which repos you have
git remote -v

# See which remote you're tracking
git branch -vv

# Push to both remotes at once
git push origin main && git push public main

# Fetch from both
git fetch --all
```

## Branch Strategy

- **main** — Stable code, synced between private and public
- **dev** — Active development (private only)
- **feature/** — Experimental features (private only)
- **hotfix/** — Urgent fixes (can be pushed directly to public)

## Keeping Public Repo Updated

Don't let the public repo get too stale. Aim to push stable updates monthly:

1. Test thoroughly in private repo
2. Update version in package.json
3. Update CHANGELOG.md
4. Push to public
5. Create GitHub release
6. Update npm (if published): `npm publish`

## Emergency Rollback

If you push something broken to public:

```bash
# Revert the last commit
git revert HEAD
git push public main

# Or hard reset (dangerous, breaks history)
git reset --hard HEAD~1
git push public main --force
```

## Checking Status

```bash
# See what's different between private and public
git fetch public
git log public/main..origin/main  # Commits in private but not public
git log origin/main..public/main  # Commits in public but not private
```

---

**Current Setup:**

- Private (origin): https://github.com/avisual/hebbian-memory-dev
- Public: https://github.com/avisual/hebbian-memory-system (currently private, ready to go public)

**Default behavior:** `git push` goes to the private dev repo.
