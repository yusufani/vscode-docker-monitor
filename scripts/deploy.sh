#!/usr/bin/env bash
# DevPulse Monitor — compile + package + install on the LIVE Stable server.
# Usage: ./scripts/deploy.sh
#
# - Installs the version that is in package.json AS IS. It never bumps, so the
#   working tree stays in sync with git and release-please keeps owning the version
#   number. (The old auto-bump wrote a new patch version on every run, and since
#   those bumps were never committed, the installed copy drifted far ahead of the
#   repo — 1.21.x installed vs 1.17.0 in git — after which VS Code refused every
#   new build as "older than what is installed".)
# - Uninstalls first, so reinstalling the SAME version still replaces the code.
# - Auto-detects the *currently running* code-server binary instead of a hardcoded
#   commit hash (VS Code self-updates, so the commit in the path changes over time).
set -euo pipefail
cd "$(dirname "$0")/.."

AGENT_FOLDER="/tier01/data/labhome/yani/vscode-server-fix/.vscode-server"
EXT_ID="anisoft.devpulse-monitor"

# Detect the live code-server binary from the running process; fall back to the
# most-recently-modified server build under the agent folder.
detect_code_server() {
  local pid args bin
  for pid in $(pgrep -f 'cli/servers/Stable.*/server/bin/code-server' 2>/dev/null || true); do
    args="$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -m1 'bin/code-server$' || true)"
    if [ -n "$args" ] && [[ "$args" == "$AGENT_FOLDER"* ]] && [ -x "$args" ]; then
      echo "$args"; return 0
    fi
  done
  # Fallback: newest server bin in the cli/servers tree
  bin="$(ls -dt "$AGENT_FOLDER"/cli/servers/Stable-*/server/bin/code-server 2>/dev/null | grep -v '\.staging/' | head -1 || true)"
  [ -n "$bin" ] && echo "$bin"
}

CODE_SERVER="$(detect_code_server)"
if [ -z "$CODE_SERVER" ]; then
  echo "✗ Could not locate a running code-server binary under $AGENT_FOLDER" >&2
  exit 1
fi
echo "→ Using live server: $CODE_SERVER"

run_cli() { VSCODE_AGENT_FOLDER="$AGENT_FOLDER" "$CODE_SERVER" "$@"; }

VERSION="$(node -p "require('./package.json').version")"
echo "→ Deploying version $VERSION (from package.json — not bumped)"

# 1. Compile
npm run compile

# 2. Package
VSIX="devpulse-monitor-${VERSION}.vsix"
npx vsce package --no-dependencies -o "$VSIX"

# 3. Uninstall whatever is installed (any version). Without this, installing the
#    same version is a no-op and installing a lower one is refused outright.
INSTALLED="$(run_cli --list-extensions --show-versions 2>/dev/null | grep -i "^${EXT_ID}@" || true)"
if [ -n "$INSTALLED" ]; then
  echo "→ Removing installed copy: $INSTALLED"
  run_cli --uninstall-extension "$EXT_ID" >/dev/null || true
fi
# Belt and braces: drop any leftover extension directories the CLI missed.
for d in "$AGENT_FOLDER"/extensions/${EXT_ID}-*; do
  [ -d "$d" ] && rm -rf "$d" && echo "→ Removed leftover directory: $(basename "$d")"
done

# 4. Install the fresh build
run_cli --install-extension "$VSIX"

echo
echo "✓ Installed devpulse-monitor ${VERSION}"
echo "  In VS Code run: Ctrl+Shift+P → 'Developer: Restart Extension Host'"
echo "  (a plain 'Reload Window' sometimes keeps the old extension host warm)"
