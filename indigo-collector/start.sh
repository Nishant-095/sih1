#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20+ and npm are required. See README.md for Ubuntu setup." >&2
  exit 1
fi

if [[ ! -d node_modules/playwright ]]; then
  echo "Installing project packages..."
  npm ci
fi

PORT="${INDIGO_WEB_PORT:-8787}"
if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/api/config" >/dev/null; then
  echo "A collector server is already running at http://127.0.0.1:${PORT}/"
  exit 0
fi

echo "Starting IndiGo Collector at http://127.0.0.1:${PORT}/"
echo "Keep this terminal open; press Ctrl+C to stop the server."
exec npm run web
