#!/bin/bash
set -e

echo "OAuthRouter Reinstall"
echo ""

# Remove old extension folder (best-effort)
echo "→ Removing plugin files..."
rm -rf ~/.openclaw/extensions/oauthrouter || true

# Clean config entries (best-effort)
echo "→ Cleaning config entries..."
node -e "
const f = require('os').homedir() + '/.openclaw/openclaw.json';
const fs = require('fs');
if (fs.existsSync(f)) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.plugins?.entries?.oauthrouter) delete c.plugins.entries.oauthrouter;
  if (c.plugins?.installs?.oauthrouter) delete c.plugins.installs.oauthrouter;
  if (Array.isArray(c.plugins?.allow)) {
    c.plugins.allow = c.plugins.allow.filter(p => p !== 'oauthrouter' && p !== '@marcus-clawdbot/oauthrouter');
  }
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}
" || true

# Reinstall
echo "→ Installing OAuthRouter..."
openclaw plugins install @marcus-clawdbot/oauthrouter

echo ""
echo "✓ Done! Run: openclaw gateway restart"
