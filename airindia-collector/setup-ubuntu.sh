#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(uname -s)" != Linux ] || ! command -v apt-get >/dev/null 2>&1; then
  echo 'This setup script supports Ubuntu with apt. Use setup-macos.sh or setup-windows.ps1 on other systems.' >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ]; then
  echo 'The automatic Google Chrome install currently supports Ubuntu x86-64. Install a compatible Chrome browser and set AIRINDIA_CHROME_PATH on this architecture.' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl ffmpeg
if command -v python3.12 >/dev/null 2>&1; then
  if ! python3.12 -m ensurepip --version >/dev/null 2>&1; then
    sudo apt-get install -y python3.12-venv
  fi
  python_bin=python3.12
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  uv_bin="$HOME/.local/bin/uv"
  "$uv_bin" python install 3.12
  python_bin="$("$uv_bin" python find 3.12)"
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  setup_file="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$setup_file"
  sudo -E bash "$setup_file"
  rm -f "$setup_file"
  sudo apt-get install -y nodejs
fi
if ! command -v google-chrome >/dev/null 2>&1; then
  chrome_deb="$(mktemp --suffix=.deb)"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$chrome_deb"
  sudo apt-get install -y "$chrome_deb"
  rm -f "$chrome_deb"
fi
npm ci
AIRINDIA_PYTHON_BIN="$python_bin" ./start.sh
