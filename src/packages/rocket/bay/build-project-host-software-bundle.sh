#!/usr/bin/env bash

# Build a CoCalc Rocket project-host software artifact.
#
# This artifact contains only the payload served by the bay /software endpoint:
# project-host bundle, project bundle, tools bundles, and bootstrap.py.
#
# Usage:
#   ./build-project-host-software-bundle.sh [output-directory] [tarball-path]

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
DEFAULT_OUT="$ROOT/packages/rocket/build/project-host-software"
OUT_ARG="${1:-}"
if [[ -n "$OUT_ARG" && "$OUT_ARG" != --* ]]; then
  OUT="$(realpath -m "$OUT_ARG")"
  shift
else
  OUT="$DEFAULT_OUT"
fi
TARBALL="${1:-}"
if [[ -n "$TARBALL" && "$TARBALL" != --* ]]; then
  TARBALL="$(realpath -m "$TARBALL")"
  shift
else
  case "$(uname -m)" in
    x86_64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) ARCH="$(uname -m)" ;;
  esac
  TARBALL="$ROOT/packages/rocket/build/cocalc-project-host-software-linux-${ARCH}.tar.xz"
fi

if [[ "$#" -gt 0 ]]; then
  echo "ERROR: unknown argument: $1" >&2
  exit 2
fi

FINAL_OUT="$OUT"
FINAL_TARBALL="$TARBALL"
OUT_PARENT="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
LOCKFILE="$OUT_PARENT/.${OUT_NAME}.build.lock"
TMP_ROOT=""
TMP_TARBALL=""

cleanup() {
  if [[ -n "$TMP_TARBALL" ]]; then
    rm -f "$TMP_TARBALL" || true
  fi
  if [[ -n "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT" || true
  fi
}

validate_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: project-host software validation failed; missing file: $path" >&2
    exit 1
  fi
}

mkdir -p "$OUT_PARENT"
if [[ -d "$LOCKFILE" ]]; then
  rmdir "$LOCKFILE" 2>/dev/null || {
    echo "ERROR: stale bundle lock directory exists at $LOCKFILE" >&2
    exit 1
  }
fi
exec 9>"$LOCKFILE"
flock 9
trap cleanup EXIT

TMP_ROOT="$(mktemp -d "$OUT_PARENT/.${OUT_NAME}.tmp.XXXXXX")"
OUT="$TMP_ROOT/$OUT_NAME"

echo "Building CoCalc Rocket project-host software bundle..."
echo "  root:    $ROOT"
echo "  out:     $OUT"
echo "  tarball: $FINAL_TARBALL"

cd "$ROOT"

echo "- Build project-host bundle"
pnpm --filter @cocalc/project-host run build:bundle

echo "- Build project bundle"
pnpm --filter @cocalc/project run build:bundle

echo "- Build tools bundle"
pnpm --filter @cocalc/project run build:tools

echo "- Copy project-host software artifacts"
mkdir -p \
  "$OUT/runtime/packages/project-host/build/bundle" \
  "$OUT/runtime/packages/project/build" \
  "$OUT/runtime/packages/server/cloud/bootstrap"
cp "$ROOT/packages/project-host/build/bundle-linux.tar.xz" \
  "$OUT/runtime/packages/project-host/build/"
if [[ -f "$ROOT/packages/project-host/build/bundle/build-identity.json" ]]; then
  cp "$ROOT/packages/project-host/build/bundle/build-identity.json" \
    "$OUT/runtime/packages/project-host/build/bundle/"
fi
cp "$ROOT/packages/project/build/bundle-linux.tar.xz" \
  "$OUT/runtime/packages/project/build/"
cp "$ROOT/packages/project/build"/tools-linux-*.tar.xz \
  "$OUT/runtime/packages/project/build/"
cp "$ROOT/packages/server/cloud/bootstrap/bootstrap.py" \
  "$OUT/runtime/packages/server/cloud/bootstrap/"

echo "- Write project-host software manifest"
node - "$OUT/project-host-software-manifest.json" "$ROOT" <<'NODE'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [out, root] = process.argv.slice(2);

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const manifest = {
  kind: "cocalc-project-host-software",
  version: 1,
  created: new Date().toISOString(),
  git: {
    commit: run("git", ["rev-parse", "HEAD"]),
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: run("git", ["status", "--porcelain"]).length > 0,
  },
  payload: {
    packagesRoot: "runtime/packages",
    projectHost: "runtime/packages/project-host/build/bundle-linux.tar.xz",
    project: "runtime/packages/project/build/bundle-linux.tar.xz",
    tools: "runtime/packages/project/build/tools-linux-*.tar.xz",
    bootstrap: "runtime/packages/server/cloud/bootstrap/bootstrap.py",
  },
};

fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
NODE

echo "- Validate project-host software bundle"
validate_file "$OUT/runtime/packages/project-host/build/bundle-linux.tar.xz"
validate_file "$OUT/runtime/packages/project/build/bundle-linux.tar.xz"
validate_file "$OUT/runtime/packages/server/cloud/bootstrap/bootstrap.py"
validate_file "$OUT/project-host-software-manifest.json"

echo "- Publish output directory"
rm -rf "$FINAL_OUT"
mkdir -p "$(dirname "$FINAL_OUT")"
mv "$OUT" "$FINAL_OUT"
OUT="$FINAL_OUT"
TMP_ROOT=""

echo "- Create tarball"
mkdir -p "$(dirname "$FINAL_TARBALL")"
TMP_TARBALL="${FINAL_TARBALL}.tmp.$$"
tar -C "$(dirname "$FINAL_OUT")" -cJf "$TMP_TARBALL" "$(basename "$FINAL_OUT")"
mv "$TMP_TARBALL" "$FINAL_TARBALL"
TMP_TARBALL=""

echo "Project-host software bundle ready:"
echo "  directory: $FINAL_OUT"
echo "  tarball:   $FINAL_TARBALL"
