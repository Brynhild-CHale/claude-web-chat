#!/bin/sh
# claude-web-chat installer — https://github.com/Brynhild-CHale/claude-web-chat
#
# Installs the `claude-web-chat` command globally from the public repo, then
# prints the two remaining steps. It does nothing but what you see here — read
# it before piping to a shell.
set -eu

REPO="git+https://github.com/Brynhild-CHale/claude-web-chat.git"

# 1. Require Node 18+.
if ! command -v node >/dev/null 2>&1; then
  echo "claude-web-chat needs Node.js (18 or newer), which isn't installed."
  echo "Get it from https://nodejs.org/ and run this again."
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 18 ]; then
  echo "claude-web-chat needs Node 18 or newer — you have $(node -v)."
  echo "Upgrade from https://nodejs.org/ and run this again."
  exit 1
fi

# 2. Install globally, straight from the public repo (no npm registry involved).
echo "Installing claude-web-chat from the public repo..."
npm i -g "$REPO"

# 3. Next steps.
echo ""
echo "Installed. To wire it into a project:"
echo ""
echo "  cd your-project"
echo "  claude-web-chat init"
echo ""
echo "init walks you through setup, shows you what it is about to write, and leaves"
echo "a short tour on the surface. In a project that already has web-chat it checks"
echo "and tidies the install instead."
