#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(uname -s)" != Darwin ]; then
  echo 'This setup script supports macOS. Use setup-ubuntu.sh or setup-windows.ps1 on other systems.' >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
brew install node python@3.12 ffmpeg
if [ ! -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ] &&
   [ ! -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  brew install --cask google-chrome
fi
npm ci
AIRINDIA_PYTHON_BIN="$(brew --prefix python@3.12)/bin/python3.12" ./start.sh
