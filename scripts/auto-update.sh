#!/usr/bin/env bash
set -euo pipefail
PATH="/usr/local/bin:/usr/bin:/bin"
APP_DIR="/root/projects/discord-music-bot"
BRANCH="main"
cd "$APP_DIR"

# Fetch latest
if ! git fetch origin "$BRANCH"; then
  echo "[update] git fetch failed" >&2
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/$BRANCH)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] already up to date"
  exit 0
fi

echo "[update] updating to origin/$BRANCH"
# Reset tracked files to remote
git reset --hard "origin/$BRANCH"

# Install production deps
npm install --omit=dev

# Restart bot if running
if pm2 list | grep -q "elevator-fm"; then
  pm2 restart elevator-fm
else
  pm2 start ecosystem.config.js --env production
  pm2 save
fi

echo "[update] done"
