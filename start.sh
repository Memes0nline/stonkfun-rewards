#!/bin/sh
# Starts the StonkFun rewards dashboard on Mac or Linux: sh start.sh, or sh start.sh --check to check this computer only.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is not installed on this computer."
  echo "Install the LTS version from https://nodejs.org (24.15 or newer), then run sh start.sh again."
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)"; then
  echo
  echo "This needs Node.js 24.15 or newer, and this computer has $(node --version)."
  echo "Install the LTS version from https://nodejs.org, then run sh start.sh again."
  exit 1
fi
exec node scripts/launch.mjs "$@"
