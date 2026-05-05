#!/usr/bin/env bash
set -euo pipefail

REPO_SOURCE="git:https://github.com/ishaan-ghosh/pi-dev-setup"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
LOCAL_READ_POLICY="$PI_DIR/extensions/read-policy.ts"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d%H%M%S)"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi not found; installing globally with npm..."
  npm install -g @mariozechner/pi-coding-agent
fi

mkdir -p "$PI_DIR"

if [ -f "$LOCAL_READ_POLICY" ]; then
  mkdir -p "$PI_DIR/extensions/.local-backup"
  moved_to="$PI_DIR/extensions/.local-backup/read-policy.ts.$STAMP"
  mv "$LOCAL_READ_POLICY" "$moved_to"
  echo "Moved local read-policy extension to $moved_to to avoid loading it twice."
fi

if [ ! -f "$SETTINGS" ]; then
  cp "$ROOT/settings.example.json" "$SETTINGS"
  chmod 600 "$SETTINGS" 2>/dev/null || true
  echo "Wrote $SETTINGS from settings.example.json"
else
  backup="$SETTINGS.backup.$STAMP"
  cp "$SETTINGS" "$backup"
  echo "Existing settings found; backed up to $backup"
  echo "Installing this pi package into current settings instead of overwriting settings.json"
  pi install "$REPO_SOURCE"
fi

cat <<'MSG'

Next steps:
  1. Start pi and authenticate: /login
     Or configure API keys via environment variables / secret manager.
  2. If pi is already running, use /reload.
  3. Update later with: pi update --extensions

MSG
