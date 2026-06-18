#!/usr/bin/env bash

# Build a compact self-contained CoCalc control-plane bundle.
#
# This is shared by launchpad and rocket/systemd bays.  It intentionally
# packages the hub entrypoint once and serves api/v2 handlers from
# http-api-dist instead of creating a second ncc bundle for those handlers.

set -euo pipefail

ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")"
ENTRYPOINT=""
OUT=""
PACKAGE_FILTER=""
INCLUDE_PGLITE=0
COPY_BOOTSTRAP=1
COPY_STATIC=1
STATIC_EXCLUDES=()

usage() {
  cat <<'EOF'
Usage: build-bundle.sh --entrypoint <path> --out <dir> [options]

Options:
  --entrypoint <path>       JS entrypoint to bundle with ncc, relative to src
  --out <dir>               output bundle directory
  --package-filter <name>   optional package to build before common deps
  --include-pglite          externalize and copy @electric-sql/pglite
  --exclude-static <glob>   rsync exclude applied when copying static assets
  --no-static               do not copy frontend/static, public, or webapp assets
  --no-bootstrap            do not copy server/cloud/bootstrap/bootstrap.py
  -h, --help                show help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --entrypoint)
      ENTRYPOINT="$2"
      shift 2
      ;;
    --out)
      OUT="$2"
      shift 2
      ;;
    --package-filter)
      PACKAGE_FILTER="$2"
      shift 2
      ;;
    --include-pglite)
      INCLUDE_PGLITE=1
      shift
      ;;
    --exclude-static)
      STATIC_EXCLUDES+=("$2")
      shift 2
      ;;
    --no-static)
      COPY_STATIC=0
      shift
      ;;
    --no-bootstrap)
      COPY_BOOTSTRAP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$ENTRYPOINT" ]] || die "--entrypoint is required"
[[ -n "$OUT" ]] || die "--out is required"

ENTRYPOINT="$(realpath -m "$ROOT/$ENTRYPOINT")"
OUT="$(realpath -m "$OUT")"
[[ -f "$ENTRYPOINT" ]] || die "entrypoint does not exist: $ENTRYPOINT"

case "${OSTYPE}" in
  linux*) TARGET_OS="linux" ;;
  darwin*) TARGET_OS="darwin" ;;
  *) die "unsupported platform: ${OSTYPE}" ;;
esac

case "$(uname -m)" in
  x86_64) TARGET_ARCH="x64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TARGET_PREBUILDS_DIR="${TARGET_OS}-${TARGET_ARCH}"
export PATH="$ROOT/packages/node_modules/.bin:$ROOT/packages/rocket/node_modules/.bin:$PATH"

copy_native_pkg() {
  local pkg="$1"
  local dest="$2"
  local dir
  dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  if [[ -n "$dir" ]]; then
    echo "- Copy native module ${pkg}"
    mkdir -p "${dest}/bundle/node_modules/${pkg}"
    cp -a "$dir"/. "${dest}/bundle/node_modules/${pkg}"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

copy_js_pkg() {
  local pkg="$1"
  local dest="$2"
  local dir
  dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  if [[ -n "$dir" ]]; then
    echo "- Copy package ${pkg}"
    mkdir -p "${dest}/bundle/node_modules/${pkg}"
    cp -a "$dir"/. "${dest}/bundle/node_modules/${pkg}"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

copy_webapp_assets() {
  local dest="$1"
  echo "- Copy webapp assets"
  mkdir -p "$dest"/webapp
  local asset
  for asset in \
    favicon.ico \
    favicon-16x16.png \
    favicon-32x32.png \
    safari-pinned-tab.svg \
    cocalc-font-black.svg \
    cocalc-font-dark.svg \
    cocalc-font-white.svg \
    cocalc-icon-white-transparent.svg \
    cocalc-icon-white.svg \
    cocalc-icon.svg \
    cocalc-logo.svg \
    open-cocalc-font-dark.svg \
    serviceWorker.js; do
    if [[ -f "packages/assets/${asset}" ]]; then
      cp "packages/assets/${asset}" "$dest"/webapp/
    fi
  done
}

copy_provider_setup_scripts() {
  local dest="$1"
  echo "- Copy provider setup scripts"
  if [[ -f "packages/server/cloud/gcp/gcp-setup.sh" ]]; then
    mkdir -p "$dest"/bundle/gcp
    cp "packages/server/cloud/gcp/gcp-setup.sh" "$dest"/bundle/gcp/
  fi
  if [[ -f "packages/server/cloud/nebius/nebius-setup.sh" ]]; then
    mkdir -p "$dest"/bundle/nebius
    cp "packages/server/cloud/nebius/nebius-setup.sh" "$dest"/bundle/nebius/
  fi
}

ncc_build() {
  local ncc_bin="$ROOT/packages/rocket/node_modules/.bin/ncc"
  if [[ ! -x "$ncc_bin" ]]; then
    ncc_bin="$ROOT/packages/node_modules/.pnpm/node_modules/.bin/ncc"
  fi
  [[ -x "$ncc_bin" ]] || die "ncc binary not found"
  (
    # Running from src causes ncc/ts-loader to pick up the monorepo tsconfig and
    # type-check source dependencies.  The release bundle should consume built JS.
    cd "$(dirname "$ROOT")"
    "$ncc_bin" build --no-cache "$@"
  )
}

prune_dist_source_maps_for_ncc() {
  echo "- Prune generated dist source maps before ncc"
  node - "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
const packages = ["cloud", "database", "http-api", "hub", "server"];
let deletedMaps = 0;
let strippedComments = 0;

function walk(dir, callback) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, callback);
    } else {
      callback(full);
    }
  }
}

for (const pkg of packages) {
  const dist = path.join(root, "packages", pkg, "dist");
  walk(dist, (file) => {
    if (file.endsWith(".js.map")) {
      fs.rmSync(file);
      deletedMaps += 1;
      return;
    }
    if (!file.endsWith(".js")) {
      return;
    }
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(/\n\/\/# sourceMappingURL=.*\.js\.map\s*$/u, "\n");
    if (after !== before) {
      fs.writeFileSync(file, after);
      strippedComments += 1;
    }
  });
}

console.error(
  `[control-plane-bundle] pruned ${deletedMaps} source maps and ${strippedComments} sourceMappingURL comments`,
);
NODE
}

build_api_v2_routes_bundle() {
  local api_root="$ROOT/packages/http-api/dist/pages/api/v2"
  local entry="$OUT/.api-v2-routes-entry.js"
  local out_dir="$OUT/api-v2-routes"

  echo "- Bundle full api/v2 route table"
  [[ -d "$api_root" ]] || die "missing built api/v2 handlers: $api_root"
  node - "$api_root" "$entry" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const apiRoot = path.resolve(process.argv[2]);
const entry = path.resolve(process.argv[3]);

function collect(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collect(full, out);
      continue;
    }
    if (
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
  "// Generated by scripts/control-plane-bundle/build-bundle.sh.",
  "const routes = [];",
];

files.forEach((file, index) => {
  const relative = path.relative(apiRoot, file).split(path.sep).join("/");
  const requirePath = `./${path
    .relative(path.dirname(entry), file)
    .split(path.sep)
    .join("/")}`;
  lines.push(`const mod${index} = require(${JSON.stringify(requirePath)});`);
  lines.push(
    `routes.push({ path: ${JSON.stringify(routePath(relative))}, handler: mod${index}.default ?? mod${index} });`,
  );
});

lines.push("module.exports = { routes };");
lines.push("");
fs.writeFileSync(entry, lines.join("\n"));
console.error(
  `[control-plane-bundle] generated ${entry} with ${files.length} routes`,
);
NODE

  rm -rf "$out_dir"
  ncc_build "$entry" \
    -o "$out_dir" \
    --external bufferutil \
    --external utf-8-validate
  rm -f "$entry"
}

echo "Building CoCalc control-plane bundle..."
echo "  root:       $ROOT"
echo "  entrypoint: $ENTRYPOINT"
echo "  out:        $OUT"
echo "  target:     $TARGET_PREBUILDS_DIR"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

if [[ -n "$PACKAGE_FILTER" ]]; then
  echo "- Build package ${PACKAGE_FILTER}"
  pnpm --filter "$PACKAGE_FILTER" run build
fi

echo "- Build common control-plane runtime dependencies"
pnpm --filter @cocalc/database run build
pnpm --filter @cocalc/server run build
pnpm --filter @cocalc/http-api run build
pnpm --filter @cocalc/hub run build

prune_dist_source_maps_for_ncc

echo "- Bundle control-plane entry point with @vercel/ncc"
NCC_ARGS=(
  "$ENTRYPOINT"
  -o "$OUT"/bundle
  --external bufferutil
  --external utf-8-validate
)
if [[ "$INCLUDE_PGLITE" -eq 1 ]]; then
  NCC_ARGS+=(--external @electric-sql/pglite)
fi
ncc_build "${NCC_ARGS[@]}"

copy_native_pkg "bufferutil" "$OUT"
copy_native_pkg "utf-8-validate" "$OUT"

build_api_v2_routes_bundle

echo "- Prune native prebuilds to target"
for pkg in bufferutil utf-8-validate; do
  prebuilds="$OUT/bundle/node_modules/$pkg/prebuilds"
  if [[ -d "$prebuilds" ]]; then
    find "$prebuilds" -mindepth 1 -maxdepth 1 -type d \
      ! -name "$TARGET_PREBUILDS_DIR" -exec rm -rf {} +
  fi
done

if [[ "$INCLUDE_PGLITE" -eq 1 ]]; then
  copy_js_pkg "@electric-sql/pglite" "$OUT"

  echo "- Prune pglite package"
  PGLITE_DIR="$OUT/bundle/node_modules/@electric-sql/pglite"
  if [[ -d "$PGLITE_DIR" ]]; then
    find "$PGLITE_DIR" -mindepth 1 -maxdepth 1 \
      ! -name dist \
      ! -name package.json \
      ! -name LICENSE \
      ! -name README.md \
      -exec rm -rf {} +
    find "$PGLITE_DIR/dist" -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' \) \
      -delete
  fi
fi

if [[ "$COPY_STATIC" -eq 1 ]]; then
  echo "- Copy static frontend assets"
  mkdir -p "$OUT"/static
  RSYNC_EXCLUDES=(--exclude '*.map')
  for pattern in "${STATIC_EXCLUDES[@]}"; do
    RSYNC_EXCLUDES+=(--exclude "$pattern")
  done
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" \
    packages/static/dist/ "$OUT/static/"

  echo "- Copy public assets"
  mkdir -p "$OUT"/public
  rsync -a --delete packages/assets/public/ "$OUT/public/"

  copy_webapp_assets "$OUT"
fi

echo "- Copy http-api handlers"
mkdir -p "$OUT"/http-api-dist
rsync -a --delete --exclude '*.map' \
  packages/http-api/dist/ "$OUT/http-api-dist/"

if [[ "$COPY_BOOTSTRAP" -eq 1 ]]; then
  echo "- Copy bootstrap.py"
  BOOTSTRAP_PY="$ROOT/packages/server/cloud/bootstrap/bootstrap.py"
  if [[ -f "$BOOTSTRAP_PY" ]]; then
    mkdir -p "$OUT"/bundle/bootstrap
    cp "$BOOTSTRAP_PY" "$OUT"/bundle/bootstrap/bootstrap.py
  else
    echo "bootstrap.py not found at $BOOTSTRAP_PY"
  fi
fi

copy_provider_setup_scripts "$OUT"

echo "- Control-plane bundle created at $OUT"
