#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm ci; fi
export AIX_PORT="${AIX_PORT:-8791}"
echo "Starting Air India Express collector at http://127.0.0.1:${AIX_PORT}/"
exec npm run web
