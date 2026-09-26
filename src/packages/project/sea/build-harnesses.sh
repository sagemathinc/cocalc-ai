#!/usr/bin/env bash
set -Eeuo pipefail

# Build architecture-specific managed ACP harness artifacts. These are kept
# separate from universal project tools because provider SDK payloads are large.

ROOT="$(realpath "$(dirname "$0")/../../..")"
SOURCE="$ROOT/packages/project/managed-harnesses"
OUT_DIR="${1:-$ROOT/packages/project/build}"
WORK_ROOT="$OUT_DIR/managed-harnesses"
OS="linux"
ARCHES=("amd64" "arm64")
CLAUDE_VERSION="0.81.1"
CLAUDE_INTEGRITY="sha512-I+7tUPsrYnI0nBmdUonoRmdCi7ohyzZ0SeCpeIUFuVZ7a8ZxDyUNO6zBJpaeAIwuPXCk8aw+7t+QiwXS6FwskQ=="

mkdir -p "$OUT_DIR"
rm -rf "$WORK_ROOT"

for ARCH in "${ARCHES[@]}"; do
  case "$ARCH" in
    amd64) NPM_CPU="x64" ;;
    arm64) NPM_CPU="arm64" ;;
    *) echo "Unsupported harness architecture: $ARCH" >&2; exit 1 ;;
  esac
  echo "- Building managed ACP harnesses for ${OS}/${ARCH}"
  WORK="$WORK_ROOT/$ARCH"
  INSTALL="$WORK/claude-code/$CLAUDE_VERSION"
  mkdir -p "$INSTALL/bin" "$INSTALL/app"
  cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$INSTALL/app/"
  npm ci \
    --prefix "$INSTALL/app" \
    --ignore-scripts \
    --omit=dev \
    --os="$OS" \
    --cpu="$NPM_CPU"

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

  cat >"$INSTALL/bin/claude-agent-acp" <<'EOF'
#!/usr/bin/env sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$HERE/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" "$@"
EOF
  chmod 0755 "$INSTALL/bin/claude-agent-acp"
  cp "$SOURCE/package-lock.json" "$INSTALL/package-lock.json"

  TARGET="$OUT_DIR/harnesses-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET"
  tar -C "$WORK" -Jcf "$TARGET" claude-code
  sha256sum "$TARGET" >"$TARGET.sha256"
  echo "  - Managed harness artifact created at $TARGET"
done
