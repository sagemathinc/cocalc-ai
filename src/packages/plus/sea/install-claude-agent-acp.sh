#!/usr/bin/env bash
set -Eeuo pipefail

# Install the pinned Claude Code ACP adapter for CoCalc Plus into <dest>.
#
# The adapter is plain JavaScript, so one copy serves every platform. Unlike
# the project tools bundle (project/sea/install-claude-code.sh), this leaves
# out the Agent SDK's native `claude` binaries (optional dependencies): CoCalc
# Plus runs the user's own installed `claude` (lite/hub/acp/local-harness.ts).
#
# Usage:
#   ./install-claude-agent-acp.sh <dest-dir>

SEA="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(realpath "$SEA/../../..")"
SOURCE="$ROOT/packages/project/managed-harnesses"
DEST="${1:?destination required}"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$DEST/"
npm ci --prefix "$DEST" --ignore-scripts --omit=dev --omit=optional \
  --no-audit --no-fund

# The installed adapter must be exactly the catalog's pin
# (util/ai/qualified-harnesses.ts), as for the project tools bundle.
node - "$DEST" "$ROOT/packages/util/dist/ai/qualified-harnesses.js" <<'NODE'
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const [root, catalog] = process.argv.slice(2);
const { CLAUDE_CODE_QUALIFICATION } = require(catalog);
const pkg = JSON.parse(
  readFileSync(
    join(root, "node_modules/@agentclientprotocol/claude-agent-acp/package.json"),
    "utf8",
  ),
);
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const entry = lock.packages["node_modules/@agentclientprotocol/claude-agent-acp"];
if (
  pkg.version !== CLAUDE_CODE_QUALIFICATION.package.version ||
  entry?.integrity !== CLAUDE_CODE_QUALIFICATION.package.integrity
) {
  throw Error("Claude ACP adapter identity does not match the catalog");
}
const scope = join(root, "node_modules/@anthropic-ai");
const native = existsSync(scope)
  ? readdirSync(scope).filter((name) => name.startsWith("claude-agent-sdk-"))
  : [];
if (native.length) throw Error(`native Claude binaries included: ${native}`);
NODE

# CoCalc's patches to the pinned adapter (see install-claude-code.sh).
ACP_AGENT="$DEST/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js"
node "$SOURCE/patch-claude-agent-acp.cjs" "$ACP_AGENT"
node --check "$ACP_AGENT"
rm -f "$DEST/package.json" "$DEST/package-lock.json"
# Runtime files only: this halves its size (to about 36 MB).
find "$DEST" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' \
  -o -name '*.d.cts' -o -name '*.md' \) -delete
