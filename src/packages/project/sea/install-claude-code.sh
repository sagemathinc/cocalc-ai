#!/usr/bin/env bash
set -Eeuo pipefail

# Install pinned Claude Code (the ACP adapter, the Claude Agent SDK and its
# native `claude` binary) for one architecture into <dest>/claude-code. This
# is part of the project tools bundle, like codex: every project host has it
# and every project gets `claude` on its PATH via /opt/cocalc/bin2.
#
# Usage:
#   ./install-claude-code.sh <amd64|arm64> <dest-dir>

SEA="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SEA/../managed-harnesses"
ARCH="${1:?architecture required}"
DEST="${2:?destination required}"
OS="linux"
CLAUDE_VERSION="0.81.1"
CLAUDE_INTEGRITY="sha512-I+7tUPsrYnI0nBmdUonoRmdCi7ohyzZ0SeCpeIUFuVZ7a8ZxDyUNO6zBJpaeAIwuPXCk8aw+7t+QiwXS6FwskQ=="

case "$ARCH" in
  amd64) NPM_CPU="x64" ;;
  arm64) NPM_CPU="arm64" ;;
  *) echo "Unsupported Claude Code architecture: $ARCH" >&2; exit 1 ;;
esac

INSTALL="$DEST/claude-code"
rm -rf "$INSTALL"
mkdir -p "$INSTALL/bin" "$INSTALL/app"
cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$INSTALL/app/"
# Project images are glibc-based; pin the libc so the result does not depend
# on the machine that builds the bundle.
npm ci \
  --prefix "$INSTALL/app" \
  --ignore-scripts \
  --omit=dev \
  --os="$OS" \
  --cpu="$NPM_CPU" \
  --libc=glibc

node - "$INSTALL/app" "$CLAUDE_VERSION" "$CLAUDE_INTEGRITY" <<'NODE'
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, expectedVersion, expectedIntegrity] = process.argv.slice(2);
const pkg = JSON.parse(
  readFileSync(
    join(root, "node_modules/@agentclientprotocol/claude-agent-acp/package.json"),
    "utf8",
  ),
);
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const entry = lock.packages["node_modules/@agentclientprotocol/claude-agent-acp"];
if (pkg.version !== expectedVersion || entry?.integrity !== expectedIntegrity) {
  throw Error("managed Claude ACP package identity does not match catalog");
}
NODE

# CoCalc's patch to the pinned adapter (managed-harnesses/patch-claude-agent-acp.cjs):
# forward subscription rate limits even before the first assistant message.
ACP_AGENT="$INSTALL/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js"
node "$SOURCE/patch-claude-agent-acp.cjs" "$ACP_AGENT"
node --check "$ACP_AGENT"

cat >"$INSTALL/bin/claude-agent-acp" <<'EOF'
#!/usr/bin/env sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$HERE/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" "$@"
EOF
chmod 0755 "$INSTALL/bin/claude-agent-acp"

# The native CLI: used for subscription sign-in and available to users.
CLI="app/node_modules/@anthropic-ai/claude-agent-sdk-${OS}-${NPM_CPU}/claude"
if [ ! -x "$INSTALL/$CLI" ]; then
  echo "Claude native binary missing for ${OS}/${ARCH}: $CLI" >&2
  exit 1
fi
ln -s "../$CLI" "$INSTALL/bin/claude"
cp "$SOURCE/package-lock.json" "$INSTALL/package-lock.json"
echo "  - Claude Code ${CLAUDE_VERSION} installed for ${OS}/${ARCH}"
