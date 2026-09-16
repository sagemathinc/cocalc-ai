#!/usr/bin/env bash

# Build a compact self-contained CoCalc control-plane bundle.
#
# This is shared by launchpad and rocket/systemd bays.  It intentionally
# packages the hub entrypoint once and serves api/v2 handlers from
# http-api-dist instead of creating a second ncc bundle for those handlers.

set -euo pipefail

# Package-local TypeScript builds can exceed Node's 2 GB default heap while
# assembling release bundles. Preserve an explicit operator-provided limit.
case " ${NODE_OPTIONS:-} " in
  *" --max-old-space-size="* | *" --max_old_space_size="* | *" --max-old-space-size "* | *" --max_old_space_size "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=8192" ;;
esac

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
  --no-static               do not copy frontend, CDN, public, or webapp assets
  --no-bootstrap            do not copy server/cloud/bootstrap/bootstrap.py
  -h, --help                show help
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_path() {
  node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1"
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

ENTRYPOINT="$(resolve_path "$ROOT/$ENTRYPOINT")"
OUT="$(resolve_path "$OUT")"
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

copy_openat2_binary() {
  local dest="$1"
  if [[ "$TARGET_OS" != "linux" ]]; then
    return
  fi

  local triple="linux-${TARGET_ARCH}-gnu"
  local pkg="@cocalc/openat2-${triple}"
  local filename="cocalc_openat2.${triple}.node"
  local dir
  dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  [[ -n "$dir" ]] || die "missing native module ${pkg}"
  [[ -f "$dir/$filename" ]] || die "${pkg} does not contain ${filename}"

  echo "- Copy openat2 native binary ${filename}"
  cp "$dir/$filename" "$dest/bundle/$filename"
}

validate_workspace_imports() {
  local bundle="$1"
  node - "$bundle" <<'NODE'
const fs = require("node:fs");

const filename = process.argv[2];
const source = fs.readFileSync(filename, "utf8");
const unresolved = [
  ...source.matchAll(/eval\("require"\)\("(@cocalc\/[^"\\]+)"\)/gu),
].map((match) => match[1]);
const allowed = /^@cocalc\/openat2-(?:android|darwin|freebsd|linux|win32)-[a-z0-9-]+$/u;
const invalid = [...new Set(unresolved.filter((pkg) => !allowed.test(pkg)))];

if (invalid.length > 0) {
  console.error(invalid.join("\n"));
  process.exit(1);
}
NODE
}

validate_dynamic_node_imports() {
  local bundle="$1"
  node - "$bundle" <<'NODE'
const fs = require("node:fs");

const filename = process.argv[2];
const source = fs.readFileSync(filename, "utf8");
const dynamicNodeImports = [
  ...source.matchAll(/\b__require\(["'](node:[^"']+)["']\)/gu),
].map((match) => match[1]);

if (dynamicNodeImports.length > 0) {
  console.error([...new Set(dynamicNodeImports)].join("\n"));
  process.exit(1);
}
NODE
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
  if [[ -f "packages/server/cloud/gcp/compute-vm-setup.sh" ]]; then
    mkdir -p "$dest"/bundle/gcp
    cp "packages/server/cloud/gcp/compute-vm-setup.sh" "$dest"/bundle/gcp/
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
    "$ROOT/scripts/ncc.sh" "$ncc_bin" build --no-cache "$@"
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

generate_embedded_api_v2_routes() {
  local api_root="$ROOT/packages/http-api/dist/pages/api/v2"
  local control_plane_entry="$OUT/.control-plane-entry.js"
  local out_dir="$OUT/api-v2-routes"

  echo "- Generate embedded api/v2 route table"
  [[ -d "$api_root" ]] || die "missing built api/v2 handlers: $api_root"
  node - "$api_root" "$control_plane_entry" "$ENTRYPOINT" "$out_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const apiRoot = path.resolve(process.argv[2]);
const entry = path.resolve(process.argv[3]);
const controlPlaneEntrypoint = path.resolve(process.argv[4]);
const outDir = path.resolve(process.argv[5]);
const loaderSymbol = "cocalc.api-v2-routes-loader";

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
  "let routes;",
  `globalThis[Symbol.for(${JSON.stringify(loaderSymbol)})] = () => {`,
  "  if (routes != null) return routes;",
  "  const loadedRoutes = [];",
];

files.forEach((file, index) => {
  const relative = path.relative(apiRoot, file).split(path.sep).join("/");
  lines.push(`  const mod${index} = require(${JSON.stringify(file)});`);
  lines.push(
    `  const handler${index} = mod${index}.default ?? mod${index};`,
  );
  lines.push(
    `  if (typeof handler${index} === "function") loadedRoutes.push({ path: ${JSON.stringify(routePath(relative))}, handler: handler${index} });`,
  );
});

lines.push("  routes = loadedRoutes;");
lines.push("  return routes;");
lines.push("};");
lines.push(`require(${JSON.stringify(controlPlaneEntrypoint)});`);
lines.push("");
fs.writeFileSync(entry, lines.join("\n"));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "index.js"),
  [
    '"use strict";',
    `const loader = globalThis[Symbol.for(${JSON.stringify(loaderSymbol)})];`,
    'if (typeof loader !== "function") {',
    '  throw new Error("embedded api v2 route loader is unavailable");',
    '}',
    "module.exports = { routes: loader() };",
    "",
  ].join("\n"),
);
console.error(
  `[control-plane-bundle] generated ${entry} with ${files.length} embedded routes`,
);
NODE
  GENERATED_CONTROL_PLANE_ENTRY="$control_plane_entry"
}

echo "Building CoCalc control-plane bundle..."
echo "  root:       $ROOT"
echo "  entrypoint: $ENTRYPOINT"
echo "  out:        $OUT"
echo "  target:     $TARGET_PREBUILDS_DIR"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

if [[ "$COPY_STATIC" -eq 1 ]]; then
  echo "- Build CDN assets"
  pnpm --filter @cocalc/cdn run build
fi

if [[ -n "$PACKAGE_FILTER" ]]; then
  echo "- Build package ${PACKAGE_FILTER}"
  pnpm --filter "$PACKAGE_FILTER" run build
fi

echo "- Build common control-plane runtime dependencies"
pnpm --filter @cocalc/database run build
pnpm --filter @cocalc/ai run build
pnpm --filter @cocalc/server run build
echo "- Clean HTTP API build output"
rm -rf packages/http-api/dist packages/http-api/dist-types
pnpm --filter @cocalc/http-api run build
pnpm --filter @cocalc/hub run build

prune_dist_source_maps_for_ncc

GENERATED_CONTROL_PLANE_ENTRY=""
generate_embedded_api_v2_routes

echo "- Bundle control-plane entry point with @vercel/ncc"
NCC_ARGS=(
  "$GENERATED_CONTROL_PLANE_ENTRY"
  -o "$OUT"/bundle
  --external bufferutil
  --external mediabunny
  --external utf-8-validate
)
if [[ "$INCLUDE_PGLITE" -eq 1 ]]; then
  NCC_ARGS+=(--external @electric-sql/pglite)
fi
ncc_build "${NCC_ARGS[@]}"
rm -f "$GENERATED_CONTROL_PLANE_ENTRY"

# The hub serves this compiled browser script through /analytics.js. It is read
# relative to the bundled entrypoint at runtime, so ncc cannot infer the asset.
ANALYTICS_SCRIPT="$ROOT/packages/hub/dist/analytics-script.js"
[[ -f "$ANALYTICS_SCRIPT" ]] || die "missing built analytics script: $ANALYTICS_SCRIPT"
cp "$ANALYTICS_SCRIPT" "$OUT/bundle/analytics-script.js"

# Workspace packages must be part of the self-contained bundle. ncc can
# silently leave them as runtime requires when their dist output was missing
# as dependency analysis started, which only fails after a hub worker starts.
# The generated openat2 loader probes optional packages for every platform;
# the matching target binary is copied beside the bundle below.
if ! validate_workspace_imports "$OUT/bundle/index.js"; then
  die "control-plane bundle contains unresolved @cocalc workspace imports"
fi
if ! validate_dynamic_node_imports "$OUT/bundle/index.js"; then
  die "control-plane bundle contains dynamic Node.js built-in imports"
fi

copy_openat2_binary "$OUT"

copy_native_pkg "bufferutil" "$OUT"
copy_native_pkg "utf-8-validate" "$OUT"
copy_js_pkg "mediabunny" "$OUT"

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

  echo "- Copy CDN assets"
  mkdir -p "$OUT/cdn"
  rsync -a --delete packages/cdn/dist/ "$OUT/cdn/"

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
