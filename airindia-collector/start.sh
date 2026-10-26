#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo 'Node.js and npm are required. Run the setup script for your operating system.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then npm ci; fi
exec npm run web
