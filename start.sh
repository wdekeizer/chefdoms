#!/usr/bin/env sh
# Chefdoms launcher for Linux and macOS.
#   ./start.sh            host on port 3000 and open the game in your browser
#   ./start.sh --public   also create a free public link (needs cloudflared, see README.md)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Install version 18 or newer from https://nodejs.org"
  echo "  (or with your package manager, e.g.  sudo apt install nodejs ), then run this again."
  echo
  exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"; then
  echo
  echo "  Your Node.js ($(node --version)) is too old. Chefdoms needs Node.js 18 or newer: https://nodejs.org"
  echo
  exit 1
fi
exec node server.js --open "$@"
