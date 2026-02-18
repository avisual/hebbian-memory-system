# Publishing to npm

## One-Time Setup

If you don't have an npm account yet:

1. Go to https://www.npmjs.com/signup
2. Create an account
3. Verify your email

## Login to npm

Run this in your terminal (requires interaction):

```bash
cd ~/hebbian-memory-system
npm login
```

It will prompt for:
- Username
- Password
- Email
- One-time password (if you have 2FA enabled)

## Publish

Once logged in:

```bash
cd ~/hebbian-memory-system

# Dry run first (see what would be published)
npm publish --dry-run

# Actually publish
npm publish --access public
```

## After Publishing

The package will be available at:
- npm: https://www.npmjs.com/package/hebbian-memory-system
- Install: `npm install hebbian-memory-system`

## Updating Versions

For future releases:

```bash
# Update version in package.json
npm version patch  # 1.0.0 -> 1.0.1
# or
npm version minor  # 1.0.0 -> 1.1.0
# or
npm version major  # 1.0.0 -> 2.0.0

# This creates a git tag automatically
git push --follow-tags

# Publish the new version
npm publish --access public

# Create GitHub release
gh release create v1.0.1 --repo avisual/hebbian-memory-system --notes "..."
```

## Unpublishing (Emergency Only)

If you need to remove a broken version within 72 hours:

```bash
npm unpublish hebbian-memory-system@1.0.0
```

After 72 hours, unpublishing is not allowed (npm policy).

## Check Publication Status

```bash
# View package info
npm view hebbian-memory-system

# Check downloads
npm view hebbian-memory-system downloads

# List all versions
npm view hebbian-memory-system versions
```

## Troubleshooting

**"Package name too similar"**
- Choose a different name in package.json
- Try: hebbian-memory, hebbian-agent-memory, etc.

**"You need to upgrade your package"**
- Update version: `npm version patch`

**"You do not have permission"**
- Make sure you're logged in: `npm whoami`
- Package name might be taken (check: https://www.npmjs.com/package/hebbian-memory-system)

## Current Status

✅ GitHub Release: v1.0.0 created at https://github.com/avisual/hebbian-memory-system/releases/tag/v1.0.0
⏳ npm: Waiting for login and publish
