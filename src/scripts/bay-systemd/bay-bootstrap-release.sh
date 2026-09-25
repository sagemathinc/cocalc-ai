#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=""
BUNDLE_PATH=""
STATIC_BUNDLE_PATH=""
HUB_BUNDLE_PATH=""
BAY_ID="bay-0"
BAY_USER="cocalc-bay"
BAY_GROUP="cocalc-bay"
BAY_ROOT_BASE="/mnt/cocalc/bays"
INSTALL_BASE="/opt/cocalc/bay"
RELEASE_ID=""
WORKER_COUNT=""
WORKER_COUNT_EXPLICIT=0
ENABLE_WORKERS=1
START_BAY=0
FORCE_ENV=0
FORCE_OVERLAY=0
OVERLAY_MODE=""
ROUTER_PORT=9102
PERSIST_PORT=9202
HUB_BASE_PORT=9300
PUBLIC_URL=""
PROJECT_HOST_SOFTWARE_BASE_URL=""
DAEMON_RELOAD=1
SITE_MASTER_KEY_PATH="/etc/cocalc/site-master-key"
NODE_VERSION="26.2.0"
NVM_DIR="/opt/cocalc/nvm"
RETAIN_RELEASES="${COCALC_BAY_RETAIN_RELEASES:-3}"
NEEDRESTART_POLICY_PATH="${COCALC_BAY_NEEDRESTART_POLICY_PATH:-/etc/needrestart/conf.d/cocalc-bay.conf}"

usage() {
  cat <<'EOF'
Usage: bay-bootstrap-release.sh (--source <built-src-root> | --bundle <tarball> | --static-bundle <tarball> | --hub-bundle <tarball>) [options]

Stage a built CoCalc src tree as a bay release, install the scaffold, and
write bay env/secrets files.

Options:
  --source <dir>           built src root to stage (required)
  --bundle <tarball>       packaged Rocket bay runtime tarball to stage
  --static-bundle <tarball> packaged frontend/CDN-only update tarball
  --hub-bundle <tarball>   packaged hub/control-plane-only update tarball
  --bay-id <id>            bay id (default: bay-0)
  --bay-user <user>        service user / db user (default: cocalc-bay)
  --bay-group <group>      service group (default: cocalc-bay)
  --bay-root-base <dir>    base dir for bay state (default: /mnt/cocalc/bays)
  --install-base <dir>     install base for releases/current (default: /opt/cocalc/bay)
  --release-id <id>        explicit release id (default: timestamp-gitshort)
  --worker-count <n>       worker count to write into bay-workers.env; default
                           preserves existing value, or 2 on first install
  --router-port <n>        router port (default: 9102)
  --persist-port <n>       persist port (default: 9202)
  --hub-base-port <n>      base port for hub workers (default: 9300)
  --public-url <url>       optional public bay URL
  --project-host-software-base-url <url>
                           software base URL for project-host bootstrap
                           artifacts; default: <public-url>/software
  --force-env              overwrite generated env files
  --force-overlay          overwrite bay-overlay.env only
  --no-enable-workers      do not enable worker units
  --start                  start cocalc-bay.target after install
  --overlay <mode>         overlay mode passed to install-scaffold
                           (default: current-cocalc for --source, rocket-bundle for --bundle)
  --no-daemon-reload       skip daemon-reload during scaffold install
  --node-version <v>       Node.js runtime version for generated bay env (default: 26.2.0)
  --nvm-dir <dir>          nvm directory for generated bay env (default: /opt/cocalc/nvm)
  --retain-releases <n>    keep newest n extracted releases after staging (default: 3)
  -h, --help               show help
EOF
}

run() {
  echo "+ $*"
  "$@"
}

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local configured_node="$NVM_DIR/versions/node/v$NODE_VERSION/bin/node"
  if [[ -x "$configured_node" ]]; then
    printf '%s\n' "$configured_node"
    return 0
  fi
  echo "node runtime not found (checked PATH and $configured_node)" >&2
  return 1
}

make_target_release_accessible() {
  run chown "${BAY_USER}:${BAY_GROUP}" "$TARGET_RELEASE"
  run chmod 0755 "$TARGET_RELEASE"
}

install_needrestart_policy() {
  run install -D -m 0644 \
    "${TARGET_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf" \
    "$NEEDRESTART_POLICY_PATH"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run this script as root" >&2
    exit 1
  fi
}

find_postgres() {
  if command -v postgres >/dev/null 2>&1; then
    command -v postgres
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/postgres' 2>/dev/null | sort | tail -n1
}

find_pg_ctl() {
  if command -v pg_ctl >/dev/null 2>&1; then
    command -v pg_ctl
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/pg_ctl' 2>/dev/null | sort | tail -n1
}

find_psql() {
  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/psql' 2>/dev/null | sort | tail -n1
}

find_createdb() {
  if command -v createdb >/dev/null 2>&1; then
    command -v createdb
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/createdb' 2>/dev/null | sort | tail -n1
}

render_if_missing_or_forced() {
  local target="$1"
  local example="${2:-}"
  if [[ "$FORCE_ENV" -eq 1 || ! -e "$target" ]]; then
    cat >"$target"
  elif [[ -n "$example" && -e "$example" ]] && cmp -s "$target" "$example"; then
    cat >"$target"
  else
    cat >/dev/null
  fi
}

set_env_var() {
  local target="$1"
  local name="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -e "$target" ]]; then
    awk -v name="$name" -v value="$value" '
      BEGIN { written = 0 }
      $0 ~ "^" name "=" {
        if (!written) {
          print name "=" value
          written = 1
        }
        next
      }
      { print }
      END {
        if (!written) print name "=" value
      }
    ' "$target" > "$tmp"
  else
    printf '%s=%s\n' "$name" "$value" > "$tmp"
  fi
  cat "$tmp" > "$target"
  rm -f "$tmp"
}

set_env_var_single_quoted() {
  local target="$1"
  local name="$2"
  local value="$3"
  local quoted
  quoted="'${value//\'/\'\\\'\'}'"
  set_env_var "$target" "$name" "$quoted"
}

random_secret() {
  openssl rand -hex 32
}

ensure_site_master_key_required_env() {
  local secrets_env="${ENV_DIR}/bay-secrets.env"
  if ! grep -q '^COCALC_REQUIRE_SITE_MASTER_KEY=' "$secrets_env"; then
    cat >>"$secrets_env" <<'EOF'
COCALC_REQUIRE_SITE_MASTER_KEY=1
EOF
  fi
}

validate_site_master_key() {
  if [[ ! -f "$SITE_MASTER_KEY_PATH" || ! -s "$SITE_MASTER_KEY_PATH" ]]; then
    cat >&2 <<EOF
missing required site master key at ${SITE_MASTER_KEY_PATH}

Install the same 32-byte base64 site master key on every bay before starting:
  install -o root -g root -m 0600 /path/to/site-master-key ${SITE_MASTER_KEY_PATH}
EOF
    exit 1
  fi
  local mode
  mode="$(stat -c '%a' "$SITE_MASTER_KEY_PATH")"
  if (( (8#$mode & 0077) != 0 )); then
    echo "site master key must not be readable or writable by group/other users: ${SITE_MASTER_KEY_PATH} mode ${mode}" >&2
    exit 1
  fi
}

postgres_ready() {
  local psql_bin="$1"
  local socket_dir="$2"
  local db_user="$3"
  local db_port="$4"
  runuser -u "$BAY_USER" -- env \
    PGHOST="$socket_dir" \
    PGPORT="$db_port" \
    PGUSER="$db_user" \
    "$psql_bin" -d postgres -Atqc "SELECT 1" >/dev/null 2>&1
}

ensure_bay_database() {
  local pg_ctl_bin="$1"
  local psql_bin="$2"
  local createdb_bin="$3"
  local postgres_data_dir="$4"
  local postgres_socket_dir="$5"
  local postgres_port="$6"
  local postgres_log="$7"
  local db_user="$8"
  local db_name="$9"
  local started_here=0

  mkdir -p "$postgres_socket_dir" "$(dirname "$postgres_log")"
  chown "${BAY_USER}:${BAY_GROUP}" "$postgres_socket_dir" "$(dirname "$postgres_log")"

  if ! postgres_ready "$psql_bin" "$postgres_socket_dir" "$db_user" "$postgres_port"; then
    run runuser -u "$BAY_USER" -- "$pg_ctl_bin" \
      -D "$postgres_data_dir" \
      -l "$postgres_log" \
      -o "-k ${postgres_socket_dir} -h 127.0.0.1 -p ${postgres_port}" \
      -w start
    started_here=1
  fi

  local db_exists
  db_exists="$(
    runuser -u "$BAY_USER" -- env \
      PGHOST="$postgres_socket_dir" \
      PGPORT="$postgres_port" \
      PGUSER="$db_user" \
      "$psql_bin" -d postgres -Atqc \
        "SELECT 1 FROM pg_database WHERE datname = '$db_name'"
  )"
  if [[ "$db_exists" != "1" ]]; then
    run runuser -u "$BAY_USER" -- env \
      PGHOST="$postgres_socket_dir" \
      PGPORT="$postgres_port" \
      PGUSER="$db_user" \
      "$createdb_bin" -O "$db_user" "$db_name"
  fi

  if [[ "$started_here" -eq 1 ]]; then
    run runuser -u "$BAY_USER" -- "$pg_ctl_bin" -D "$postgres_data_dir" -m fast -w stop
  fi
}

derive_release_id() {
  local git_short
  if [[ -n "$SOURCE_ROOT" ]]; then
    git_short="$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  elif [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    git_short="static"
  elif [[ -n "$HUB_BUNDLE_PATH" ]]; then
    git_short="hub"
  else
    git_short="bundle"
  fi
  printf '%s-%s\n' "$(date +%Y%m%d%H%M%S)" "$git_short"
}

stage_source_release() {
  if [[ ! -d "$SOURCE_ROOT/packages" ]]; then
    echo "source root must look like a built src tree: missing packages/" >&2
    exit 1
  fi

  run mkdir -p "$TARGET_RELEASE"
  make_target_release_accessible
  run rsync -a --delete \
    --exclude '/.git' \
    --exclude '/.local' \
    --exclude '/data' \
    --exclude '/.build-home' \
    "${SOURCE_ROOT}/" "${TARGET_RELEASE}/"
}

stage_bundle_release() {
  if [[ ! -f "$BUNDLE_PATH" ]]; then
    echo "bundle does not exist: $BUNDLE_PATH" >&2
    exit 1
  fi

  run rm -rf "$TARGET_RELEASE"
  run mkdir -p "$TARGET_RELEASE"
  make_target_release_accessible
  run tar -xf "$BUNDLE_PATH" -C "$TARGET_RELEASE" --strip-components=1
  make_target_release_accessible
  preserve_previous_static_assets
  preserve_previous_cdn_assets
}

stage_static_bundle_release() {
  if [[ ! -f "$STATIC_BUNDLE_PATH" ]]; then
    echo "static bundle does not exist: $STATIC_BUNDLE_PATH" >&2
    exit 1
  fi
  if [[ ! -L "$CURRENT_LINK" ]]; then
    echo "static bundle deploy requires an existing current release at ${CURRENT_LINK}" >&2
    exit 1
  fi

  local current_release
  current_release="$(readlink -f "$CURRENT_LINK")"
  if [[ -z "$current_release" || ! -d "$current_release" ]]; then
    echo "current release does not resolve to a directory: ${CURRENT_LINK}" >&2
    exit 1
  fi

  run rm -rf "$TARGET_RELEASE"
  run mkdir -p "$TARGET_RELEASE"
  make_target_release_accessible
  run cp -al "${current_release}/." "$TARGET_RELEASE/"
  make_target_release_accessible

  local extract_dir
  extract_dir="$(mktemp -d "${TARGET_RELEASE}.static-bundle.XXXXXX")"
  trap 'rm -rf "$extract_dir"' RETURN
  run tar --no-same-owner -xf "$STATIC_BUNDLE_PATH" -C "$extract_dir" --strip-components=1

  run rm -rf \
    "${TARGET_RELEASE}/runtime/control-plane/public" \
    "${TARGET_RELEASE}/runtime/control-plane/cdn" \
    "${TARGET_RELEASE}/runtime/control-plane/webapp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/gcp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/nebius" \
    "${TARGET_RELEASE}/bay-static-manifest.json"
  run rsync -a "${extract_dir}/" "$TARGET_RELEASE/"
  preserve_previous_static_assets
  preserve_previous_cdn_assets "$current_release"
  make_target_release_accessible
  run chown -R "${BAY_USER}:${BAY_GROUP}" \
    "${TARGET_RELEASE}/runtime/control-plane/static" \
    "${TARGET_RELEASE}/runtime/control-plane/public" \
    "${TARGET_RELEASE}/runtime/control-plane/cdn" \
    "${TARGET_RELEASE}/runtime/control-plane/webapp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/gcp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/nebius" \
    "${TARGET_RELEASE}/bay-static-manifest.json"
  rm -rf "$extract_dir"
  trap - RETURN
}

stage_hub_bundle_release() {
  if [[ ! -f "$HUB_BUNDLE_PATH" ]]; then
    echo "hub bundle does not exist: $HUB_BUNDLE_PATH" >&2
    exit 1
  fi
  if [[ ! -L "$CURRENT_LINK" ]]; then
    echo "hub bundle deploy requires an existing current release at ${CURRENT_LINK}" >&2
    exit 1
  fi

  local current_release
  current_release="$(readlink -f "$CURRENT_LINK")"
  if [[ -z "$current_release" || ! -d "$current_release" ]]; then
    echo "current release does not resolve to a directory: ${CURRENT_LINK}" >&2
    exit 1
  fi

  run rm -rf "$TARGET_RELEASE"
  run mkdir -p "$TARGET_RELEASE"
  make_target_release_accessible
  run cp -al "${current_release}/." "$TARGET_RELEASE/"
  make_target_release_accessible

  local extract_dir
  extract_dir="$(mktemp -d "${TARGET_RELEASE}.hub-bundle.XXXXXX")"
  trap 'rm -rf "$extract_dir"' RETURN
  run tar --no-same-owner -xf "$HUB_BUNDLE_PATH" -C "$extract_dir" --strip-components=1

  for required_file in \
    "${extract_dir}/bay-hub-manifest.json" \
    "${extract_dir}/runtime/control-plane/bundle/index.js" \
    "${extract_dir}/runtime/control-plane/api-v2-routes/index.js" \
    "${extract_dir}/runtime/control-plane/http-api-dist/pages/api/v2/index.js" \
    "${extract_dir}/runtime/migrate-schema/index.js" \
    "${extract_dir}/scripts/bay-systemd/install-scaffold.sh" \
    "${extract_dir}/scripts/bay-systemd/needrestart/cocalc-bay.conf" \
    "${extract_dir}/scripts/bay-systemd/systemd/cocalc-bay-hub@.service"; do
    if [[ ! -f "$required_file" ]]; then
      echo "hub bundle is missing required file: $required_file" >&2
      exit 1
    fi
  done

  run rm -rf \
    "${TARGET_RELEASE}/runtime/control-plane/bundle" \
    "${TARGET_RELEASE}/runtime/control-plane/api-v2-routes" \
    "${TARGET_RELEASE}/runtime/control-plane/http-api-dist" \
    "${TARGET_RELEASE}/runtime/migrate-schema" \
    "${TARGET_RELEASE}/scripts/bay-systemd" \
    "${TARGET_RELEASE}/bay-hub-manifest.json"
  run rsync -a "${extract_dir}/" "$TARGET_RELEASE/"
  make_target_release_accessible
  run chown -R "${BAY_USER}:${BAY_GROUP}" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle" \
    "${TARGET_RELEASE}/runtime/control-plane/api-v2-routes" \
    "${TARGET_RELEASE}/runtime/control-plane/http-api-dist" \
    "${TARGET_RELEASE}/runtime/migrate-schema" \
    "${TARGET_RELEASE}/bay-hub-manifest.json"
  rm -rf "$extract_dir"
  trap - RETURN
}

preserve_previous_static_assets() {
  if [[ ! -L "$CURRENT_LINK" ]]; then
    return
  fi

  local current_release
  current_release="$(readlink -f "$CURRENT_LINK")"
  if [[ -z "$current_release" || ! -d "$current_release" || "$current_release" == "$TARGET_RELEASE" ]]; then
    return
  fi

  local previous_static="${current_release}/runtime/control-plane/static"
  local target_static="${TARGET_RELEASE}/runtime/control-plane/static"
  if [[ ! -d "$previous_static" || ! -d "$target_static" ]]; then
    return
  fi

  # Rspack chunks are hash-named and lazy-loaded by already-open clients.  When a
  # release flips /static to new HTML and entrypoints, keep old chunk filenames
  # available until the retained release ages out instead of stranding clients
  # that navigate after the deploy.
  run rsync -a --ignore-existing --exclude='._*' \
    "${previous_static}/" "${target_static}/"
}

prepare_frontend_asset_history() {
  local target_static="${TARGET_RELEASE}/runtime/control-plane/static"
  local current_manifest="${target_static}/frontend-build.json"
  if [[ ! -f "$current_manifest" ]]; then
    echo "release is missing frontend asset manifest: ${current_manifest}" >&2
    exit 1
  fi

  local previous_static=""
  if [[ -L "$CURRENT_LINK" ]]; then
    local current_release
    current_release="$(readlink -f "$CURRENT_LINK")"
    if [[ -n "$current_release" && "$current_release" != "$TARGET_RELEASE" ]]; then
      previous_static="${current_release}/runtime/control-plane/static"
    fi
  fi

  local node_bin
  node_bin="$(find_node)"
  "$node_bin" - "$target_static" "$previous_static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [targetRoot, previousRoot] = process.argv.slice(2);
const MAX_ASSETS = 10_000;
const HASHED_ASSET = /(?:^|[-.])[0-9a-f]{16,}(?=[-.]|$)/i;

function safeAsset(value) {
  const asset = `${value ?? ""}`.replaceAll("\\", "/");
  if (!asset || asset.startsWith("/") || asset.split("/").includes("..")) {
    throw new Error(`unsafe frontend asset path: ${asset}`);
  }
  if (!HASHED_ASSET.test(path.posix.basename(asset))) {
    throw new Error(`frontend asset is not content-addressed: ${asset}`);
  }
  return asset;
}

function readManifest(root) {
  if (!root) return;
  const filename = path.join(root, "frontend-build.json");
  if (!fs.existsSync(filename)) return;
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function scanAssets(root, directory = root) {
  if (!root || !fs.existsSync(directory)) return [];
  const assets = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("._")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...scanAssets(root, absolute));
    } else if (entry.isFile() && HASHED_ASSET.test(entry.name)) {
      assets.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
    if (assets.length > MAX_ASSETS) {
      throw new Error(`frontend asset manifest exceeds ${MAX_ASSETS} files`);
    }
  }
  return assets;
}

function normalizeBuild(manifest, root, allowScan) {
  if (!manifest) return;
  const manifestAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const rawAssets = allowScan
    ? [...manifestAssets, ...scanAssets(root)]
    : manifestAssets;
  if (!rawAssets?.length) {
    throw new Error(`frontend manifest in ${root} has no asset inventory`);
  }
  if (rawAssets.length > MAX_ASSETS) {
    throw new Error(`frontend asset manifest exceeds ${MAX_ASSETS} files`);
  }
  const assets = [...new Set(rawAssets.map(safeAsset))].sort();
  for (const asset of assets) {
    const filename = path.resolve(targetRoot, asset);
    if (!filename.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) {
      throw new Error(`frontend asset escapes static root: ${asset}`);
    }
    if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`retained frontend asset is missing: ${asset}`);
    }
  }
  return {
    git_revision: `${manifest.git_revision ?? ""}`,
    build_timestamp: Number(manifest.build_timestamp) || 0,
    build_date: `${manifest.build_date ?? ""}`,
    fingerprint: `${manifest.fingerprint ?? ""}`,
    assets,
  };
}

const current = normalizeBuild(readManifest(targetRoot), targetRoot, false);
const previous = normalizeBuild(readManifest(previousRoot), previousRoot, true);
const builds = [current];
if (
  previous &&
  (previous.fingerprint !== current.fingerprint ||
    previous.build_timestamp !== current.build_timestamp ||
    previous.assets.some((asset) => !current.assets.includes(asset)))
) {
  builds.push(previous);
}
const history = {
  schema: 1,
  generated_at: new Date().toISOString(),
  builds,
};
const output = path.join(targetRoot, "frontend-build-history.json");
const temporary = `${output}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
fs.renameSync(temporary, output);
console.log(
  `validated frontend assets: builds=${builds.length} files=${builds.reduce((sum, build) => sum + build.assets.length, 0)}`,
);
NODE
}

preserve_previous_cdn_assets() {
  local current_release="${1:-}"
  if [[ -z "$current_release" ]]; then
    if [[ ! -L "$CURRENT_LINK" ]]; then
      return
    fi
    current_release="$(readlink -f "$CURRENT_LINK")"
  fi
  if [[ -z "$current_release" || ! -d "$current_release" || "$current_release" == "$TARGET_RELEASE" ]]; then
    return
  fi

  local previous_cdn="${current_release}/runtime/control-plane/cdn"
  local target_cdn="${TARGET_RELEASE}/runtime/control-plane/cdn"
  if [[ ! -f "${previous_cdn}/index.js" || ! -f "${target_cdn}/index.js" ]]; then
    return
  fi

  local node_bin package_names
  node_bin="$(find_node)"
  package_names="$("$node_bin" - "${previous_cdn}/index.js" "${target_cdn}/index.js" <<'NODE'
const [previous, target] = process.argv.slice(2);
const names = new Set([
  ...Object.keys(require(previous).versions ?? {}),
  ...Object.keys(require(target).versions ?? {}),
]);
process.stdout.write([...names].join("\n"));
NODE
)"

  local package_name previous_path versioned_name
  while IFS= read -r package_name; do
    [[ -n "$package_name" ]] || continue
    for previous_path in "${previous_cdn}/${package_name}-"*; do
      if [[ ! -e "$previous_path" && ! -L "$previous_path" ]]; then
        continue
      fi
      versioned_name="$(basename "$previous_path")"
      if [[ -e "${target_cdn}/${versioned_name}" || -L "${target_cdn}/${versioned_name}" ]]; then
        continue
      fi
      # The CDN build uses versioned symlinks. Dereference old aliases so they
      # remain pinned to their old contents after the unversioned tree changes.
      run cp -aL "$previous_path" "${target_cdn}/${versioned_name}"
    done
  done <<<"$package_names"
}

validate_release() {
  if [[ ! -x "${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh" ]]; then
    echo "release is missing scripts/bay-systemd/install-scaffold.sh" >&2
    exit 1
  fi
  if [[ ! -f "${TARGET_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf" ]]; then
    echo "release is missing scripts/bay-systemd/needrestart/cocalc-bay.conf" >&2
    exit 1
  fi
  if [[ "$OVERLAY_MODE" != "none" && ! -f "${TARGET_RELEASE}/scripts/bay-systemd/env/bay-${OVERLAY_MODE}-overlay.env.example" ]]; then
    echo "release is missing overlay for mode ${OVERLAY_MODE}" >&2
    exit 1
  fi
  if [[ "$OVERLAY_MODE" == "rocket-bundle" ]]; then
    local required_file
    for required_file in \
      "${TARGET_RELEASE}/runtime/project-host/index.js" \
      "${TARGET_RELEASE}/runtime/control-plane/bundle/index.js" \
      "${TARGET_RELEASE}/runtime/control-plane/http-api-dist/pages/api/v2/index.js" \
      "${TARGET_RELEASE}/runtime/migrate-schema/index.js"; do
      if [[ ! -f "$required_file" ]]; then
        echo "Rocket bay bundle is missing runtime file: $required_file" >&2
        exit 1
      fi
    done
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/static/public.html" ]]; then
      echo "release is missing static frontend assets" >&2
      exit 1
    fi
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/public/cocalc-content.css" ]]; then
      echo "release is missing public frontend assets" >&2
      exit 1
    fi
    # A hub-only release inherits the currently deployed static tree. Older
    # static releases predate the bundled CDN, so do not make a hub rollout
    # depend on first upgrading an unrelated component.
    if [[
      -z "$HUB_BUNDLE_PATH" &&
        ! -f "${TARGET_RELEASE}/runtime/control-plane/cdn/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap"
    ]]; then
      echo "release is missing CDN frontend assets" >&2
      exit 1
    fi
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/webapp/favicon.ico" ]]; then
      echo "release is missing webapp frontend assets" >&2
      exit 1
    fi
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/bundle/gcp/gcp-setup.sh" ]]; then
      echo "release is missing GCP provider setup script" >&2
      exit 1
    fi
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/bundle/gcp/compute-vm-setup.sh" ]]; then
      echo "release is missing managed compute VM setup script" >&2
      exit 1
    fi
    if [[ ! -f "${TARGET_RELEASE}/runtime/control-plane/bundle/nebius/nebius-setup.sh" ]]; then
      echo "release is missing Nebius provider setup script" >&2
      exit 1
    fi
  fi
}

current_release_id() {
  if [[ -L "$CURRENT_LINK" ]]; then
    basename "$(readlink -f "$CURRENT_LINK")"
    return 0
  fi
  if [[ -r "${BAY_ROOT}/state/current-version" ]]; then
    cat "${BAY_ROOT}/state/current-version"
    return 0
  fi
  return 1
}

set_current_release() {
  local previous=""
  previous="$(current_release_id || true)"
  run mkdir -p "${BAY_ROOT}/state"
  if [[ -n "$previous" && "$previous" != "$RELEASE_ID" ]]; then
    printf '%s\n' "$previous" > "${BAY_ROOT}/state/previous-version"
  fi
  run ln -sfn "$TARGET_RELEASE" "$CURRENT_LINK"
  printf '%s\n' "$RELEASE_ID" > "${BAY_ROOT}/state/current-version"
}

prune_old_releases() {
  if [[ ! "$RETAIN_RELEASES" =~ ^[0-9]+$ ]]; then
    echo "retain release count must be a nonnegative integer: $RETAIN_RELEASES" >&2
    exit 2
  fi
  if (( RETAIN_RELEASES == 0 )); then
    return
  fi
  if [[ ! -d "$RELEASES_DIR" ]]; then
    return
  fi

  local -A keep=()
  local current previous release count process_ref process_path
  current="$(current_release_id || true)"
  previous=""
  if [[ -r "${BAY_ROOT}/state/previous-version" ]]; then
    previous="$(cat "${BAY_ROOT}/state/previous-version")"
  fi
  [[ -n "$current" ]] && keep["$current"]=1
  [[ -n "$previous" ]] && keep["$previous"]=1

  # Static-only deploys intentionally leave hub workers running.  Their
  # WorkingDirectory resolves through /opt/cocalc/bay/current at process
  # start, so lazy ncc chunks continue loading from that original release even
  # after current moves.  Never prune a release that a live process still
  # references through its cwd, root, or executable.
  for process_ref in "${COCALC_BAY_PROC_ROOT:-/proc}"/[0-9]*/{cwd,root,exe}; do
    process_path="$(readlink -f "$process_ref" 2>/dev/null || true)"
    case "$process_path" in
      "${RELEASES_DIR}"/*)
        release="${process_path#"${RELEASES_DIR}"/}"
        release="${release%%/*}"
        if [[ -d "${RELEASES_DIR}/${release}" ]]; then
          keep["$release"]=1
        fi
        ;;
    esac
  done

  count=0
  while IFS= read -r release; do
    [[ -z "$release" ]] && continue
    keep["$release"]=1
    count=$((count + 1))
    if (( count >= RETAIN_RELEASES )); then
      break
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)

  while IFS= read -r release; do
    [[ -n "${keep[$release]:-}" ]] && continue
    run rm -rf "${RELEASES_DIR}/${release}"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)
        SOURCE_ROOT="$2"
        shift 2
        ;;
      --bundle)
        BUNDLE_PATH="$2"
        shift 2
        ;;
      --static-bundle)
        STATIC_BUNDLE_PATH="$2"
        shift 2
        ;;
      --hub-bundle)
        HUB_BUNDLE_PATH="$2"
        shift 2
        ;;
      --bay-id)
        BAY_ID="$2"
        shift 2
        ;;
      --bay-user)
        BAY_USER="$2"
        shift 2
        ;;
      --bay-group)
        BAY_GROUP="$2"
        shift 2
        ;;
      --bay-root-base)
        BAY_ROOT_BASE="$2"
        shift 2
        ;;
      --install-base)
        INSTALL_BASE="$2"
        shift 2
        ;;
      --release-id)
        RELEASE_ID="$2"
        shift 2
        ;;
      --worker-count)
        WORKER_COUNT="$2"
        WORKER_COUNT_EXPLICIT=1
        shift 2
        ;;
      --router-port)
        ROUTER_PORT="$2"
        shift 2
        ;;
      --persist-port)
        PERSIST_PORT="$2"
        shift 2
        ;;
      --hub-base-port)
        HUB_BASE_PORT="$2"
        shift 2
        ;;
      --public-url)
        PUBLIC_URL="$2"
        shift 2
        ;;
      --project-host-software-base-url)
        PROJECT_HOST_SOFTWARE_BASE_URL="$2"
        shift 2
        ;;
      --force-env)
        FORCE_ENV=1
        shift
        ;;
      --force-overlay)
        FORCE_OVERLAY=1
        shift
        ;;
      --no-enable-workers)
        ENABLE_WORKERS=0
        shift
        ;;
      --start)
        START_BAY=1
        shift
        ;;
      --overlay)
        OVERLAY_MODE="$2"
        shift 2
        ;;
      --no-daemon-reload)
        DAEMON_RELOAD=0
        shift
        ;;
      --node-version)
        NODE_VERSION="$2"
        shift 2
        ;;
      --nvm-dir)
        NVM_DIR="$2"
        shift 2
        ;;
      --retain-releases)
        RETAIN_RELEASES="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  require_root

  local input_count=0
  [[ -n "$SOURCE_ROOT" ]] && input_count=$((input_count + 1))
  [[ -n "$BUNDLE_PATH" ]] && input_count=$((input_count + 1))
  [[ -n "$STATIC_BUNDLE_PATH" ]] && input_count=$((input_count + 1))
  [[ -n "$HUB_BUNDLE_PATH" ]] && input_count=$((input_count + 1))
  if [[ "$input_count" -ne 1 ]]; then
    echo "exactly one of --source, --bundle, --static-bundle, or --hub-bundle is required" >&2
    usage >&2
    exit 2
  fi
  if [[ -z "$OVERLAY_MODE" ]]; then
    if [[ -n "$BUNDLE_PATH" || -n "$STATIC_BUNDLE_PATH" || -n "$HUB_BUNDLE_PATH" ]]; then
      OVERLAY_MODE="rocket-bundle"
    else
      OVERLAY_MODE="current-cocalc"
    fi
  fi

  if [[ -z "$RELEASE_ID" ]]; then
    RELEASE_ID="$(derive_release_id)"
  fi

  BAY_ROOT="${BAY_ROOT_BASE}/${BAY_ID}"
  RELEASES_DIR="${INSTALL_BASE}/releases"
  CURRENT_LINK="${INSTALL_BASE}/current"
  TARGET_RELEASE="${RELEASES_DIR}/${RELEASE_ID}"
  ENV_DIR="/etc/cocalc"
  BAY_ENV_EXAMPLE="${ENV_DIR}/bay.env.example"
  BAY_WORKERS_ENV_EXAMPLE="${ENV_DIR}/bay-workers.env.example"
  BAY_SECRETS_ENV_EXAMPLE="${ENV_DIR}/bay-secrets.env.example"
  BAY_TOPOLOGY_ENV_EXAMPLE="${ENV_DIR}/bay-topology.env.example"
  BAY_OVERLAY_ENV_EXAMPLE="${ENV_DIR}/bay-${OVERLAY_MODE}-overlay.env.example"
  if [[ -z "$WORKER_COUNT" && -f "${ENV_DIR}/bay-workers.env" ]]; then
    WORKER_COUNT="$(
      sed -n 's/^COCALC_BAY_WORKER_COUNT=//p' "${ENV_DIR}/bay-workers.env" \
        | tail -n1
    )"
  fi
  if [[ -z "$WORKER_COUNT" ]]; then
    WORKER_COUNT=1
  fi
  if [[ ! "$WORKER_COUNT" =~ ^[0-9]+$ || "$WORKER_COUNT" -lt 1 ]]; then
    echo "--worker-count must be a positive integer; got '${WORKER_COUNT}'" >&2
    exit 2
  fi
  POSTGRES_BIN="$(find_postgres)"
  PG_CTL_BIN="$(find_pg_ctl)"
  PSQL_BIN="$(find_psql)"
  CREATEDB_BIN="$(find_createdb)"
  if [[ -z "$POSTGRES_BIN" ]]; then
    echo "could not find postgres binary" >&2
    exit 1
  fi
  if [[ -z "$PG_CTL_BIN" || -z "$PSQL_BIN" || -z "$CREATEDB_BIN" ]]; then
    echo "could not find required postgres client tools (pg_ctl/psql/createdb)" >&2
    exit 1
  fi

  if [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    stage_static_bundle_release
  elif [[ -n "$HUB_BUNDLE_PATH" ]]; then
    stage_hub_bundle_release
  elif [[ -n "$BUNDLE_PATH" ]]; then
    stage_bundle_release
  else
    stage_source_release
  fi
  if [[ -n "$STATIC_BUNDLE_PATH" || -n "$BUNDLE_PATH" ]]; then
    prepare_frontend_asset_history
  elif [[
    -z "$HUB_BUNDLE_PATH" &&
      -f "${TARGET_RELEASE}/runtime/control-plane/static/frontend-build.json"
  ]]; then
    prepare_frontend_asset_history
  fi
  validate_release
  if [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    install_needrestart_policy
  fi
  set_current_release

  if [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    prune_old_releases
    cat <<EOF
Static release bootstrap complete.

Static bundle:    ${STATIC_BUNDLE_PATH}
Release id:       ${RELEASE_ID}
Target release:   ${TARGET_RELEASE}
Current link:     ${CURRENT_LINK}
Bay root:         ${BAY_ROOT}

Static assets are served through /opt/cocalc/bay/current; no service restart is required.
Already-open browser sessions may keep using cached chunks until refresh.
EOF
    exit 0
  fi

  if [[ -n "$HUB_BUNDLE_PATH" ]]; then
    INSTALL_CMD=(
      "${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh"
      "--overlay"
      "$OVERLAY_MODE"
    )
    if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
      INSTALL_CMD+=("--daemon-reload")
    fi
    run "${INSTALL_CMD[@]}"
    prune_old_releases
    cat <<EOF
Hub release bootstrap complete.

Hub bundle:       ${HUB_BUNDLE_PATH}
Release id:       ${RELEASE_ID}
Target release:   ${TARGET_RELEASE}
Current link:     ${CURRENT_LINK}
Bay root:         ${BAY_ROOT}

Run migrations and roll hub workers to activate the updated hub/control-plane code.
EOF
    exit 0
  fi

  INSTALL_CMD=("${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh" "--overlay" "$OVERLAY_MODE")
  if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
    INSTALL_CMD+=("--daemon-reload")
  fi
  run "${INSTALL_CMD[@]}"

  run mkdir -p "${BAY_ROOT}/secrets" "${BAY_ROOT}/projects"
  run mkdir -p "${BAY_ROOT}/bin"
  run chown -R "${BAY_USER}:${BAY_GROUP}" "$BAY_ROOT" "${INSTALL_BASE}"

  if [[ ! -f "${BAY_ROOT}/secrets/conat-password" ]]; then
    random_secret > "${BAY_ROOT}/secrets/conat-password"
    chmod 0600 "${BAY_ROOT}/secrets/conat-password"
    chown "${BAY_USER}:${BAY_GROUP}" "${BAY_ROOT}/secrets/conat-password"
  fi

  ensure_bay_database \
    "$PG_CTL_BIN" \
    "$PSQL_BIN" \
    "$CREATEDB_BIN" \
    "${BAY_ROOT}/postgres" \
    "${BAY_ROOT}/run/postgres" \
    "5432" \
    "${BAY_ROOT}/logs/postgres-bootstrap.log" \
    "$BAY_USER" \
    "$BAY_USER"

  render_if_missing_or_forced "${ENV_DIR}/bay.env" "$BAY_ENV_EXAMPLE" <<EOF
COCALC_BAY_ID=${BAY_ID}
COCALC_BAY_ROOT=${BAY_ROOT}
COCALC_BAY_RELEASES_DIR=${RELEASES_DIR}
COCALC_BAY_CURRENT_LINK=${CURRENT_LINK}
COCALC_BAY_NODE_VERSION=${NODE_VERSION}
COCALC_BAY_NODE_BIN=${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node
COCALC_BAY_STATE_DIR=${BAY_ROOT}/state
COCALC_BAY_RUN_DIR=${BAY_ROOT}/run
COCALC_BAY_LOG_DIR=${BAY_ROOT}/logs
COCALC_BAY_BACKUP_DIR=${BAY_ROOT}/backups
COCALC_BACKUP_ROOT=${BAY_ROOT}/backups
COCALC_BAY_BACKUP_REQUIRE_SEPARATE_FILESYSTEM=0
COCALC_BAY_BACKUP_MIN_FREE_BYTES=68719476736
COCALC_BAY_BACKUP_RETRY_MAX_MS=21600000
COCALC_BIN_PATH=${BAY_ROOT}/bin
COCALC_BAY_PGBACKREST_ENABLED=0
COCALC_BAY_PGBACKREST_BIN=/usr/local/bin/pgbackrest
COCALC_BAY_PGBACKREST_CONFIG=\${COCALC_BACKUP_ROOT}/pgbackrest/pgbackrest.conf
COCALC_BAY_PGBACKREST_SPOOL_PATH=\${COCALC_BACKUP_ROOT}/pgbackrest/spool
COCALC_BAY_PGBACKREST_LOCK_PATH=${BAY_ROOT}/run/pgbackrest
COCALC_BAY_PGBACKREST_LOG_PATH=${BAY_ROOT}/logs/pgbackrest
COCALC_BAY_PGBACKREST_REPO_PATH=/pgbackrest/${BAY_ID}
COCALC_BAY_PGBACKREST_PROCESS_MAX=1
COCALC_BAY_PGBACKREST_RETENTION_FULL=2
COCALC_BAY_PGBACKREST_RETENTION_DIFF=14
COCALC_BAY_PGBACKREST_STATUS_FILE=${BAY_ROOT}/state/pgbackrest-status.json
COCALC_BAY_PGBACKREST_RESTORE_STATUS_FILE=${BAY_ROOT}/state/pgbackrest-restore-test-status.json
COCALC_BAY_PGBACKREST_MAX_BACKUP_AGE_S=129600
COCALC_BAY_PGBACKREST_MAX_SPOOL_AGE_S=600
COCALC_BAY_PGBACKREST_MAX_WAL_BACKLOG_BYTES=8589934592
COCALC_BAY_SQLITE_BACKUP_ENABLED=0
COCALC_BAY_SQLITE_SOURCE_DIR=${BAY_ROOT}/sync
COCALC_BAY_SQLITE_MIRROR_DIR=\${COCALC_BACKUP_ROOT}/sqlite-mirror/sync
COCALC_BAY_SQLITE_MIRROR_CATALOG=\${COCALC_BACKUP_ROOT}/sqlite-mirror/catalog.json
COCALC_BAY_SQLITE_MIRROR_ENTRY=/opt/cocalc/bay/current/runtime/sqlite-mirror/index.js
COCALC_BAY_SQLITE_MIRROR_CONCURRENCY=2
COCALC_BAY_SQLITE_RUSTIC_BIN=/usr/local/bin/rustic
COCALC_BAY_SQLITE_RUSTIC_PROFILE=\${COCALC_BACKUP_ROOT}/sqlite-mirror/rustic.toml
COCALC_BAY_SQLITE_RUSTIC_ROOT=rustic/bay-sqlite/${BAY_ID}
COCALC_BAY_SQLITE_BACKUP_STATUS_FILE=${BAY_ROOT}/state/sqlite-backup-status.json
COCALC_BAY_SQLITE_RETENTION_HOURLY=24
COCALC_BAY_SQLITE_RETENTION_DAILY=14
COCALC_BAY_SQLITE_RETENTION_WEEKLY=8
COCALC_BAY_SQLITE_RETENTION_MONTHLY=12

COCALC_BAY_POSTGRES_HOST=127.0.0.1
COCALC_BAY_POSTGRES_PORT=5432
COCALC_BAY_POSTGRES_DATA_DIR=${BAY_ROOT}/postgres
COCALC_BAY_POSTGRES_SOCKET_DIR=${BAY_ROOT}/run/postgres
COCALC_BAY_POSTGRES_DB=${BAY_USER}
COCALC_BAY_POSTGRES_USER=${BAY_USER}
COCALC_BAY_POSTGRES_MAX_WAL_SIZE=8GB
COCALC_BAY_POSTGRES_SHARED_BUFFERS=1GB
COCALC_BAY_POSTGRES_EFFECTIVE_CACHE_SIZE=8GB

COCALC_BAY_PERSIST_HOST=127.0.0.1
COCALC_BAY_PERSIST_PORT=${PERSIST_PORT}
COCALC_BAY_PERSIST_HEALTH_PATH=/healthz

COCALC_BAY_ROUTER_HOST=127.0.0.1
COCALC_BAY_ROUTER_PORT=${ROUTER_PORT}
COCALC_BAY_ROUTER_HEALTH_PATH=/healthz

COCALC_BAY_HUB_BIND_HOST=127.0.0.1
COCALC_BAY_HUB_BASE_PORT=${HUB_BASE_PORT}
COCALC_BAY_HUB_HEALTH_PATH=/ready

COCALC_BAY_FRONTDOOR_HOST=127.0.0.1
COCALC_BAY_FRONTDOOR_PORT=9400
COCALC_BAY_FRONTDOOR_HEALTH_PATH=/_cocalc/frontdoor/healthz
COCALC_BAY_FRONTDOOR_DRAIN_FILE=${BAY_ROOT}/state/frontdoor-drain-workers
COCALC_BAY_FRONTDOOR_UNHEALTHY_THRESHOLD=3
COCALC_BAY_FRONTDOOR_HEALTH_ERROR_MAX_BYTES=2048

COCALC_BAY_HUB_WATCHDOG_FAILURE_THRESHOLD=2
COCALC_BAY_HUB_WATCHDOG_RESTART_TIMEOUT_S=90
COCALC_BAY_HUB_WATCHDOG_RESTART_COOLDOWN_S=300
COCALC_BAY_HUB_DIAGNOSTIC_TIMEOUT_S=8
COCALC_BAY_HUB_DIAGNOSTIC_DIR=/var/log/cocalc-bay/hub-watchdog-incidents
COCALC_BAY_HUB_DIAGNOSTIC_RETENTION_DAYS=14
COCALC_BAY_HUB_DIAGNOSTIC_MAX_FILES=100

COCALC_BAY_MIN_HEALTHY_WORKERS=1
COCALC_BAY_HEALTH_TIMEOUT_S=15
COCALC_BAY_WORKER_START_TIMEOUT_S=90
COCALC_BAY_MIN_FREE_MB=1024
COCALC_BAY_CLOUDFLARED_SYSTEMD=1

COCALC_PRODUCT=launchpad
COCALC_ENABLE_ANALYTICS=0
COCALC_CLUSTER_ROLE=standalone
COCALC_CLUSTER_BAY_IDS=${BAY_ID}
COCALC_BAY_PUBLIC_URL=${PUBLIC_URL}
COCALC_DISABLE_NEXT=1

DATA=${BAY_ROOT}
COCALC_DATA_DIR=${BAY_ROOT}
PROJECTS=${BAY_ROOT}/projects/[project_id]
LOGS=${BAY_ROOT}/logs
SECRETS=${BAY_ROOT}/secrets
PGHOST=${BAY_ROOT}/run/postgres
PGPORT=5432
PGUSER=${BAY_USER}
PGDATABASE=${BAY_USER}
COCALC_DB=postgres
CONAT_SERVER=http://127.0.0.1:${ROUTER_PORT}

COCALC_BAY_POSTGRES_CMD='${POSTGRES_BIN} -D "\$COCALC_BAY_POSTGRES_DATA_DIR" -k "\$COCALC_BAY_POSTGRES_SOCKET_DIR" -h "\$COCALC_BAY_POSTGRES_HOST" -p "\$COCALC_BAY_POSTGRES_PORT" -c max_wal_size="\$COCALC_BAY_POSTGRES_MAX_WAL_SIZE" -c shared_buffers="\$COCALC_BAY_POSTGRES_SHARED_BUFFERS" -c effective_cache_size="\$COCALC_BAY_POSTGRES_EFFECTIVE_CACHE_SIZE"'
EOF
  if [[ -n "$PUBLIC_URL" ]]; then
    set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_PUBLIC_URL" "$PUBLIC_URL"
  fi
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BUNDLE_DIR" "/opt/cocalc/bay/current/runtime/control-plane"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_API_V2_ROOT" "/opt/cocalc/bay/current/runtime/control-plane/http-api-dist/pages/api/v2"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_API_V2_ROUTES_BUNDLE" "/opt/cocalc/bay/current/runtime/control-plane/api-v2-routes/index.js"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_HOST" "127.0.0.1"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_PORT" "9400"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_HEALTH_PATH" "/_cocalc/frontdoor/healthz"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_DRAIN_FILE" "${BAY_ROOT}/state/frontdoor-drain-workers"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_HEALTH_PATH" "/ready"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_UNHEALTHY_THRESHOLD" "3"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_FRONTDOOR_HEALTH_ERROR_MAX_BYTES" "2048"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_WATCHDOG_FAILURE_THRESHOLD" "2"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_WATCHDOG_RESTART_TIMEOUT_S" "90"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_WATCHDOG_RESTART_COOLDOWN_S" "300"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_DIAGNOSTIC_TIMEOUT_S" "8"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_DIAGNOSTIC_DIR" "/var/log/cocalc-bay/hub-watchdog-incidents"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_DIAGNOSTIC_RETENTION_DAYS" "14"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_HUB_DIAGNOSTIC_MAX_FILES" "100"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_POSTGRES_MAX_WAL_SIZE" "8GB"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_POSTGRES_SHARED_BUFFERS" "1GB"
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_POSTGRES_EFFECTIVE_CACHE_SIZE" "8GB"
  set_env_var_single_quoted "${ENV_DIR}/bay.env" "COCALC_BAY_POSTGRES_CMD" "${POSTGRES_BIN} -D \"\$COCALC_BAY_POSTGRES_DATA_DIR\" -k \"\$COCALC_BAY_POSTGRES_SOCKET_DIR\" -h \"\$COCALC_BAY_POSTGRES_HOST\" -p \"\$COCALC_BAY_POSTGRES_PORT\" -c max_wal_size=\"\$COCALC_BAY_POSTGRES_MAX_WAL_SIZE\" -c shared_buffers=\"\$COCALC_BAY_POSTGRES_SHARED_BUFFERS\" -c effective_cache_size=\"\$COCALC_BAY_POSTGRES_EFFECTIVE_CACHE_SIZE\""
  if [[ -z "$PROJECT_HOST_SOFTWARE_BASE_URL" && -n "$PUBLIC_URL" ]]; then
    PROJECT_HOST_SOFTWARE_BASE_URL="${PUBLIC_URL%/}/software"
  fi
  if [[ -n "$PROJECT_HOST_SOFTWARE_BASE_URL" ]]; then
    set_env_var "${ENV_DIR}/bay.env" "COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE" "${PROJECT_HOST_SOFTWARE_BASE_URL%/}"
  fi
  set_env_var "${ENV_DIR}/bay.env" "COCALC_BAY_CLOUDFLARED_SYSTEMD" "1"

  render_if_missing_or_forced "${ENV_DIR}/bay-workers.env" "$BAY_WORKERS_ENV_EXAMPLE" <<EOF
COCALC_BAY_WORKER_COUNT=${WORKER_COUNT}
COCALC_BAY_WORKER_NODE_OPTIONS=
COCALC_BAY_WORKER_EXTRA_ENV=
EOF
  if [[ "$WORKER_COUNT_EXPLICIT" -eq 1 ]]; then
    set_env_var "${ENV_DIR}/bay-workers.env" "COCALC_BAY_WORKER_COUNT" "$WORKER_COUNT"
  fi

  render_if_missing_or_forced "${ENV_DIR}/bay-topology.env" "$BAY_TOPOLOGY_ENV_EXAMPLE" <<EOF
COCALC_CLUSTER_ID=standalone
COCALC_CLUSTER_ROLE=standalone
COCALC_CLUSTER_SEED_BAY_ID=${BAY_ID}
COCALC_CLUSTER_BAY_IDS=${BAY_ID}
COCALC_CLUSTER_TOPOLOGY_EPOCH=0
COCALC_CLUSTER_SEED_CONAT_SERVER=
COCALC_INTER_BAY_CONAT_SERVER=
COCALC_BAY_PEER_HEALTH_HOST=127.0.0.1
COCALC_BAY_PEER_HEALTH_PORT=9402
COCALC_BAY_PEER_HEALTH_PATH=/peer-health
COCALC_BAY_PEER_HEALTH_TIMEOUT_S=5
COCALC_BAY_PEER_LOCAL_HEALTH_TIMEOUT_S=3
COCALC_CLUSTER_PEER_HEALTH_URLS=
EOF

  render_if_missing_or_forced "${ENV_DIR}/bay-secrets.env" "$BAY_SECRETS_ENV_EXAMPLE" <<EOF
COCALC_SESSION_SECRET=$(random_secret)
COCALC_COOKIE_SECRET=$(random_secret)
COCALC_CONAT_SHARED_SECRET=$(random_secret)
COCALC_CLUSTER_SHARED_SECRET=$(random_secret)
COCALC_REQUIRE_SITE_MASTER_KEY=1
EOF
  ensure_site_master_key_required_env
  chmod 0600 "${ENV_DIR}/bay-secrets.env"

  if [[ "$OVERLAY_MODE" != "none" ]]; then
    if [[ "$FORCE_OVERLAY" -eq 1 && "$FORCE_ENV" -eq 0 ]]; then
      cat "${TARGET_RELEASE}/scripts/bay-systemd/env/bay-${OVERLAY_MODE}-overlay.env.example" \
        > "${ENV_DIR}/bay-overlay.env"
    else
      render_if_missing_or_forced "${ENV_DIR}/bay-overlay.env" "$BAY_OVERLAY_ENV_EXAMPLE" \
        < "${TARGET_RELEASE}/scripts/bay-systemd/env/bay-${OVERLAY_MODE}-overlay.env.example"
    fi
  fi

  run systemctl enable cocalc-bay.target
  run systemctl enable cocalc-bay-frontdoor.service
  run systemctl enable cocalc-bay-cloudflared.service
  run systemctl enable cocalc-bay-hub-watchdog.timer
  if [[ "$ENABLE_WORKERS" -eq 1 ]]; then
    for worker_id in $(seq 1 "$WORKER_COUNT"); do
      run systemctl enable "cocalc-bay-hub@${worker_id}.service"
    done
  fi

  if [[ "$START_BAY" -eq 1 ]]; then
    validate_site_master_key
    run systemctl start cocalc-bay.target
    run systemctl start cocalc-bay-frontdoor.service
    run systemctl start cocalc-bay-cloudflared.service
    run systemctl start cocalc-bay-hub-watchdog.timer
  fi
  prune_old_releases

  cat <<EOF
Release bootstrap complete.

Source root:      ${SOURCE_ROOT:-}
Bundle:           ${BUNDLE_PATH:-}
Static bundle:    ${STATIC_BUNDLE_PATH:-}
Release id:       ${RELEASE_ID}
Target release:   ${TARGET_RELEASE}
Current link:     ${CURRENT_LINK}
Bay root:         ${BAY_ROOT}

Generated files:
  /etc/cocalc/bay.env
  /etc/cocalc/bay-workers.env
  /etc/cocalc/bay-topology.env
  /etc/cocalc/bay-secrets.env
  ${BAY_ROOT}/secrets/conat-password

Required pre-provisioned file:
  ${SITE_MASTER_KEY_PATH}

Next steps:
  1. Review /etc/cocalc/bay.env
  2. Review /etc/cocalc/bay-topology.env
  3. Review /etc/cocalc/bay-overlay.env
  4. Install the same site master key on every bay before starting:
     install -o root -g root -m 0600 /path/to/site-master-key ${SITE_MASTER_KEY_PATH}
  5. Verify migrations manually:
     ${CURRENT_LINK}/bin/bay-migrate
  6. Start the bay if not already started:
     systemctl start cocalc-bay.target
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
