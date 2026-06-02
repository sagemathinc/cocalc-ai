#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
OUTPUT="${1:-${STAR_RUNTIME_TARBALL:-/tmp/cocalc-star-runtime.tar.gz}}"
STAR_RUNTIME_BUILD="${STAR_RUNTIME_BUILD:-1}"
COCALC_STAR_RELEASE_ARCH="${COCALC_STAR_RELEASE_ARCH:-}"
STAR_HELPER_BUILD_DIR=""

log() {
  printf '[star-runtime-build] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-star-runtime-tarball.sh [output.tar.gz]

Build a CoCalc Star runtime tarball. The archive extracts to src/ and includes
only Star installer scripts plus compressed ncc/runtime artifacts needed by the
installer. It intentionally does not include the workspace node_modules tree.

Set STAR_RUNTIME_BUILD=0 to skip the local build step and package the current
workspace state.

Set COCALC_STAR_RELEASE_ARCH=x64 or arm64 to choose the matching project tools
bundle. Defaults from uname -m.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

use_node_26() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 26 >/dev/null
  fi
}

build_runtime() {
  if [ "$STAR_RUNTIME_BUILD" = "0" ]; then
    log "skipping local build because STAR_RUNTIME_BUILD=0"
    return
  fi

  log "building workspace runtime artifacts"
  (
    cd "$SRC_ROOT"
    use_node_26
    export COCALC_SETUP_PROFILE=star
    if command -v corepack >/dev/null 2>&1; then
      corepack enable
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
      npm install -g pnpm@10.33.0
    fi
    ./workspaces.py install
    pnpm --filter @cocalc/app-notebook build
    ./workspaces.py build --dev
    pnpm python-api
    pnpm --filter @cocalc/launchpad build:tarball
    pnpm --filter @cocalc/cli build:bundle
    pnpm --filter @cocalc/project-host build:bundle
    pnpm --dir packages/project build:bundle
    pnpm --dir packages/project build:tools
  )
}

runtime_tools_arch() {
  local arch="${COCALC_STAR_RELEASE_ARCH}"
  if [ -z "$arch" ]; then
    case "$(uname -m)" in
      x86_64 | amd64) arch="x64" ;;
      aarch64 | arm64) arch="arm64" ;;
      *) die "unsupported architecture $(uname -m); set COCALC_STAR_RELEASE_ARCH=x64 or arm64" ;;
    esac
  fi
  case "$arch" in
    x64) printf 'amd64\n' ;;
    arm64) printf 'arm64\n' ;;
    *) die "unsupported COCALC_STAR_RELEASE_ARCH=$arch; expected x64 or arm64" ;;
  esac
}

build_star_helper_bundles() {
  [ -n "$STAR_HELPER_BUILD_DIR" ] || die "STAR_HELPER_BUILD_DIR is not set"
  log "building Star bootstrap helper ncc bundles"
  (
    cd "$SRC_ROOT"
    use_node_26
    mkdir -p \
      packages/server/build/star-helper-entrypoints \
      packages/project-host/build/star-helper-entrypoints \
      "$STAR_HELPER_BUILD_DIR"
    cp scripts/star-poc/seed-star-poc.cjs \
      packages/server/build/star-helper-entrypoints/seed-star-poc.cjs
    cp scripts/star-poc/ensure-rootfs-cache.cjs \
      packages/project-host/build/star-helper-entrypoints/ensure-rootfs-cache.cjs
    rm -rf \
      "$STAR_HELPER_BUILD_DIR/seed-star-poc" \
      "$STAR_HELPER_BUILD_DIR/ensure-rootfs-cache"
    pnpm --filter @cocalc/launchpad exec ncc build \
      "$SRC_ROOT/packages/server/build/star-helper-entrypoints/seed-star-poc.cjs" \
      -o "$STAR_HELPER_BUILD_DIR/seed-star-poc" \
      --external bufferutil \
      --external utf-8-validate \
      --license licenses.txt
    pnpm --filter @cocalc/project-host exec ncc build \
      "$SRC_ROOT/packages/project-host/build/star-helper-entrypoints/ensure-rootfs-cache.cjs" \
      -o "$STAR_HELPER_BUILD_DIR/ensure-rootfs-cache" \
      --external bufferutil \
      --external utf-8-validate \
      --license licenses.txt
    local node_pty_dir ensure_out
    node_pty_dir="$(find "$SRC_ROOT/packages/node_modules/.pnpm" -path '*/node_modules/node-pty/package.json' -print -quit)"
    [ -n "$node_pty_dir" ] || die "unable to find node-pty package for rootfs helper bundle"
    node_pty_dir="$(dirname "$node_pty_dir")"
    ensure_out="$STAR_HELPER_BUILD_DIR/ensure-rootfs-cache"
    mkdir -p "$ensure_out/prebuilds/linux-x64" "$ensure_out/prebuilds/linux-arm64"
    cp "$node_pty_dir/prebuilds/linux-x64/pty.node" "$ensure_out/prebuilds/linux-x64/"
    cp "$node_pty_dir/prebuilds/linux-arm64/pty.node" "$ensure_out/prebuilds/linux-arm64/"
  )
}

build_api_v2_routes_bundle() {
  [ -n "$STAR_HELPER_BUILD_DIR" ] || die "STAR_HELPER_BUILD_DIR is not set"
  log "building bundled api/v2 route manifest"
  (
    cd "$SRC_ROOT"
    use_node_26
    local api_root entry out_dir
    api_root="$SRC_ROOT/packages/http-api/dist/pages/api/v2"
    entry="$SRC_ROOT/packages/http-api/build/star-api-v2-routes.cjs"
    out_dir="$STAR_HELPER_BUILD_DIR/api-v2-routes"
    [ -d "$api_root" ] || die "missing built api/v2 handlers: $api_root"
    mkdir -p "$(dirname "$entry")"
    node - "$api_root" "$entry" <<'NODE'
const fs = require("fs");
const path = require("path");

const apiRoot = path.resolve(process.argv[2]);
const entry = path.resolve(process.argv[3]);

function collect(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collect(full, out);
    } else if (
      name.endsWith(".js") &&
      !name.endsWith(".test.js") &&
      !name.endsWith(".spec.js")
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

function routePath(relative) {
  const withoutExt = relative.slice(0, -".js".length);
  return withoutExt === "index" ? "/" : `/${withoutExt}`;
}

const files = collect(apiRoot).filter(
  (file) => path.relative(apiRoot, file).split(path.sep).join("/") !== "index.js",
);

const lines = [
  '"use strict";',
  "// Generated by scripts/star/build-star-runtime-tarball.sh.",
  "const routes = [];",
];

files.forEach((file, index) => {
  const relative = path.relative(apiRoot, file).split(path.sep).join("/");
  const requirePath = `./${path.relative(path.dirname(entry), file).split(path.sep).join("/")}`;
  lines.push(`const mod${index} = require(${JSON.stringify(requirePath)});`);
  lines.push(
    `routes.push({ path: ${JSON.stringify(routePath(relative))}, handler: mod${index}.default ?? mod${index} });`,
  );
});

lines.push("module.exports = { routes };");
lines.push("");
fs.writeFileSync(entry, lines.join("\n"));
console.error(`[star-runtime-build] generated ${entry} with ${files.length} routes`);
NODE
    rm -rf "$out_dir"
    pnpm --filter @cocalc/launchpad exec ncc build \
      "$entry" \
      -o "$out_dir" \
      --external bufferutil \
      --external utf-8-validate \
      --license licenses.txt
  )
}

copy_runtime_payload() {
  local staging="$1"
  local runtime_src="${staging}/src"
  mkdir -p \
    "$runtime_src/scripts" \
    "$runtime_src/packages/cli/build" \
    "$runtime_src/packages/launchpad/build" \
    "$runtime_src/packages/project-host/build" \
    "$runtime_src/packages/project/build" \
    "$runtime_src/packages/server/cloud/bootstrap"

  cp -a "$SRC_ROOT/scripts/star" "$runtime_src/scripts/"
  mkdir -p "$runtime_src/scripts/star-poc"
  (
    cd "$SRC_ROOT/scripts/star-poc"
    tar --exclude='./build' -cf - .
  ) | tar -C "$runtime_src/scripts/star-poc" -xf -
  mkdir -p "$runtime_src/scripts/star-poc/build"
  cp -a "$STAR_HELPER_BUILD_DIR/seed-star-poc" \
    "$STAR_HELPER_BUILD_DIR/ensure-rootfs-cache" \
    "$runtime_src/scripts/star-poc/build/"
  cp "$SRC_ROOT/packages/launchpad/build/bundle.tar.xz" \
    "$runtime_src/packages/launchpad/build/"
  cp -a "$SRC_ROOT/packages/cli/build/bundle" \
    "$runtime_src/packages/cli/build/"
  cp -a "$STAR_HELPER_BUILD_DIR/api-v2-routes" \
    "$runtime_src/scripts/star-poc/build/api-v2-routes-bundle"
  cp "$SRC_ROOT/packages/project-host/build/bundle-linux.tar.xz" \
    "$runtime_src/packages/project-host/build/"
  cp "$SRC_ROOT/packages/project/build/bundle-linux.tar.xz" \
    "$runtime_src/packages/project/build/"
  local tools_arch
  tools_arch="$(runtime_tools_arch)"
  cp "$SRC_ROOT/packages/project/build/tools-linux-${tools_arch}.tar.xz" \
    "$runtime_src/packages/project/build/"
  cp "$SRC_ROOT/packages/server/cloud/bootstrap/bootstrap.py" \
    "$runtime_src/packages/server/cloud/bootstrap/"
}

mkdir -p "$(dirname "$OUTPUT")"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
STAR_HELPER_BUILD_DIR="$tmp_dir/helper-build"

build_runtime
build_star_helper_bundles
build_api_v2_routes_bundle

[ -f "$SRC_ROOT/packages/launchpad/build/bundle.tar.xz" ] || die "missing launchpad bundle tarball"
[ -f "$SRC_ROOT/packages/cli/build/bundle/index.js" ] || die "missing cli bundle"
[ -f "$SRC_ROOT/packages/project-host/build/bundle-linux.tar.xz" ] || die "missing project-host bundle tarball"
[ -f "$SRC_ROOT/packages/project/build/bundle-linux.tar.xz" ] || die "missing project bundle tarball"
[ -f "$SRC_ROOT/packages/project/build/tools-linux-$(runtime_tools_arch).tar.xz" ] || die "missing $(runtime_tools_arch) tools bundle"
[ -f "$STAR_HELPER_BUILD_DIR/seed-star-poc/index.cjs" ] || die "missing bundled seed helper"
[ -f "$STAR_HELPER_BUILD_DIR/ensure-rootfs-cache/index.cjs" ] || die "missing bundled rootfs cache helper"
[ -f "$STAR_HELPER_BUILD_DIR/api-v2-routes/index.cjs" ] || die "missing bundled api/v2 route manifest"

copy_runtime_payload "$tmp_dir"
log "creating $OUTPUT"
tar -czf "$OUTPUT" -C "$tmp_dir" src

log "wrote $OUTPUT"
