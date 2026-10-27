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
ALLOW_FENCED=0
RESTORE_FENCE="${COCALC_BAY_RESTORE_FENCE:-/etc/cocalc/bay-restore-fence}"
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
NODE_VERSION="26.12.1"
NVM_DIR="/opt/cocalc/nvm"
RETAIN_RELEASES="${COCALC_BAY_RETAIN_RELEASES:-3}"
NEEDRESTART_POLICY_PATH="${COCALC_BAY_NEEDRESTART_POLICY_PATH:-/etc/needrestart/conf.d/cocalc-bay.conf}"
BAY_RUN_PATH="${COCALC_BAY_RUN_PATH:-/usr/local/sbin/cocalc-bay-run}"
PROTECTED_HARDLINKS_PATH="${COCALC_BAY_PROTECTED_HARDLINKS_PATH:-/proc/sys/fs/protected_hardlinks}"

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
  --fenced                 install although the bay is fenced for a restore
                           (RESTORE.md mode B, step 6); never with --start
  --overlay <mode>         overlay mode passed to install-scaffold
                           (default: current-cocalc for --source, rocket-bundle for --bundle)
  --no-daemon-reload       skip daemon-reload during scaffold install
  --node-version <v>       Node.js runtime version for generated bay env (default: 26.12.1)
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

# Root runs install-scaffold.sh, which installs systemd units, sudoers rules
# and root helpers. TARGET_RELEASE belongs to the bay account, which could
# replace anything in it (even files it does not own, by renaming their
# directory), so the installer and everything it installs come from a
# root-owned copy taken straight from the bundle or source tree instead.
SCAFFOLD_STAGE_PARENT="${COCALC_BAY_SCAFFOLD_STAGE_PARENT:-/run}"
TRUSTED_SCAFFOLD_DIR=""

# A static bundle carries only needrestart/ and sbin/cocalc-bay-run; pass
# "static" to stage it.
stage_trusted_scaffold() {
  local stage bundle="${HUB_BUNDLE_PATH:-${BUNDLE_PATH:-$STATIC_BUNDLE_PATH}}"
  local required="${1:-install-scaffold.sh}"
  stage="$(mktemp -d "${SCAFFOLD_STAGE_PARENT}/cocalc-bay-scaffold.XXXXXX")"
  if [[ -n "$bundle" ]]; then
    run tar --no-same-owner -xf "$bundle" -C "$stage" --strip-components=1 \
      --wildcards '*/scripts/bay-systemd/*'
  else
    run mkdir -p "${stage}/scripts"
    run cp -a "${SOURCE_ROOT}/scripts/bay-systemd" "${stage}/scripts/"
  fi
  if [[ "$(id -u)" == 0 ]]; then
    run chown -R root:root "$stage"
  fi
  run chmod -R go-w "$stage"
  # Readable (not writable) by the bay account, which installs bin/ from it.
  run chmod 0755 "$stage"
  TRUSTED_SCAFFOLD_DIR="${stage}/scripts/bay-systemd"
  # Removed by remove_trusted_scaffold; a stage left by a failed bootstrap is
  # root-only (0700) and goes with /run at the next boot.
  if [[ "$required" == static ]]; then
    local file
    for file in needrestart/cocalc-bay.conf sbin/cocalc-bay-run; do
      if [[ ! -f "${TRUSTED_SCAFFOLD_DIR}/${file}" ]]; then
        echo "${bundle:-$SOURCE_ROOT} is missing scripts/bay-systemd/${file}" >&2
        exit 1
      fi
    done
  elif [[ ! -x "${TRUSTED_SCAFFOLD_DIR}/install-scaffold.sh" ]]; then
    echo "${bundle:-$SOURCE_ROOT} is missing scripts/bay-systemd/install-scaffold.sh" >&2
    exit 1
  fi
}

remove_trusted_scaffold() {
  if [[ -n "$TRUSTED_SCAFFOLD_DIR" ]]; then
    rm -rf "$(dirname "$(dirname "$TRUSTED_SCAFFOLD_DIR")")"
    TRUSTED_SCAFFOLD_DIR=""
  fi
}

# The release tree under INSTALL_BASE and the state tree under BAY_ROOT belong
# to the bay account, which can replace anything in them (even files it does
# not own, by renaming their directory). Root therefore never writes, copies
# or executes anything there, and never reads files there into root-owned
# places: that work runs as the bay account. Root only inspects names there
# (resolving current, testing paths, listing releases) to choose what the bay
# account does, changes ownership (only with protected_hardlinks), reads the
# operator's bundle or source, and installs from the trusted scaffold copy
# into root-owned places.
as_bay() {
  if [[ "$(id -u)" == 0 ]]; then
    runuser -u "$BAY_USER" -- "$@"
  else
    "$@"
  fi
}

# A Node script read from stdin resolves require() from the working directory,
# and Node 26.12.1 fails when a package.json there is unreadable (the deploy
# user's home usually is, to the bay user). Run such scripts from /.
as_bay_node() {
  (cd / && as_bay "$@")
}

# Root's recursive chown over the bay-owned trees does not follow symbolic
# links, but a hard link is the file itself: without the kernel's
# protected_hardlinks the bay account could link a root-owned file into its
# tree and have the next deploy give it away. Refuse to deploy in that case.
require_protected_hardlinks() {
  local value=""
  value="$(cat "$PROTECTED_HARDLINKS_PATH" 2>/dev/null)" || true
  if [[ "$value" != 1 ]]; then
    echo "fs.protected_hardlinks is ${value:-unreadable}, not 1; refusing to change ownership of bay-owned trees as root (set it with sysctl -w fs.protected_hardlinks=1)" >&2
    exit 1
  fi
}

# Create INSTALL_BASE and BAY_ROOT for the bay account if missing (their
# parents are root's), then normalise ownership of the release tree so the bay
# account can hard-link and prune everything in it. chown -R walks physically
# and does not follow symbolic links, not even the argument itself.
ensure_install_dirs() {
  local dir
  for dir in "$INSTALL_BASE" "$BAY_ROOT"; do
    if [[ ! -e "$dir" ]]; then
      if [[ "$(id -u)" == 0 ]]; then
        run install -d -o "$BAY_USER" -g "$BAY_GROUP" -m 0755 "$dir"
      else
        run mkdir -p "$dir"
      fi
    fi
  done
  run as_bay mkdir -p "$RELEASES_DIR"
  if [[ "$(id -u)" == 0 ]]; then
    require_protected_hardlinks
    run chown -R "${BAY_USER}:${BAY_GROUP}" "$RELEASES_DIR"
  fi
}

# Unpack an operator-supplied tarball into a bay-owned directory: root reads
# the bundle (which the bay account may not be able to read), the bay account
# writes the files.
extract_as_bay() {
  local bundle="$1" destination="$2"
  shift 2
  local decompress=(cat) magic
  magic="$(head -c 6 "$bundle" | od -An -tx1 | tr -d ' \n')"
  case "$magic" in
    fd377a585a00) decompress=(xz -dc) ;;
    1f8b*) decompress=(gzip -dc) ;;
    28b52ffd*) decompress=(zstd -dc) ;;
  esac
  echo "+ ${decompress[*]} ${bundle} | as_bay tar -xf - -C ${destination} $*"
  "${decompress[@]}" "$bundle" | as_bay tar --no-same-owner -xf - -C "$destination" "$@"
}

# needrestart evaluates this policy as root, so it comes from the trusted
# scaffold copy, not the bay-owned release.
install_needrestart_policy() {
  run install -D -m 0644 \
    "${TRUSTED_SCAFFOLD_DIR}/needrestart/cocalc-bay.conf" \
    "$NEEDRESTART_POLICY_PATH"
}

# The deploy's health checks run release commands through this root helper.
# Full and hub deploys install it with the rest of the scaffold; a static
# deploy installs it here, so a host's first static deploy has it too.
install_bay_runner() {
  run install -D -m 0755 \
    "${TRUSTED_SCAFFOLD_DIR}/sbin/cocalc-bay-run" \
    "$BAY_RUN_PATH"
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

# Bay services log errors and warnings to journald, which bay-bootstrap-host.sh
# caps. Without DEBUG the logger writes nothing at all; without
# NODE_ENV=production it would also append to an unrotated $LOGS/log, so pin it
# to the console. Override DEBUG in bay-local.env. Called by both full and
# hub-only releases, since both restart the services that read it.
configure_bay_logging_env() {
  local env_file="${ENV_DIR}/bay.env"
  if [[ ! -e "$env_file" ]]; then
    return 0
  fi
  set_env_var "$env_file" "DEBUG" "cocalc:error:*,cocalc:warn:*"
  set_env_var "$env_file" "DEBUG_CONSOLE" "yes"
  set_env_var "$env_file" "DEBUG_FILE" ""
  if [[ ! -e "${JOURNALD_CAP_FILE:-/etc/systemd/journald.conf.d/99-cocalc-bay.conf}" ]]; then
    echo "WARNING: journald has no CoCalc size cap on this VM; bay logs are unbounded until bay-bootstrap-host.sh installs /etc/systemd/journald.conf.d/99-cocalc-bay.conf" >&2
  fi
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
  local mode keyring="${SITE_MASTER_KEY_PATH}.keyring"
  mode="$(stat -c '%a' "$SITE_MASTER_KEY_PATH")"
  if (( (8#$mode & 0077) != 0 )); then
    echo "site master key must not be readable or writable by group/other users: ${SITE_MASTER_KEY_PATH} mode ${mode}" >&2
    exit 1
  fi
  # The services load the rotation keyring as a credential; it must exist.
  if [[ ! -e "$keyring" ]]; then
    run install -o root -g root -m 0600 /dev/null "$keyring"
  fi
  mode="$(stat -c '%a' "$keyring")"
  if (( (8#$mode & 0077) != 0 )); then
    echo "site master keyring must not be readable or writable by group/other users: ${keyring} mode ${mode}" >&2
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

  run as_bay mkdir -p "$postgres_socket_dir" "$(dirname "$postgres_log")"

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

  run as_bay rm -rf "$TARGET_RELEASE"
  run as_bay mkdir -p "$TARGET_RELEASE"
  # Root reads the operator's tree; the bay account writes the release.
  echo "+ tar -C ${SOURCE_ROOT} -cf - . | as_bay tar -xf - -C ${TARGET_RELEASE}"
  tar -C "$SOURCE_ROOT" \
    --exclude=./.git --exclude=./.local --exclude=./data --exclude=./.build-home \
    -cf - . | as_bay tar --no-same-owner -xf - -C "$TARGET_RELEASE"
  record_source_hub_version
  # Like a bundle deploy: inherited chunks of builds still in retention must be
  # present, or the retention step would find them missing.
  preserve_previous_static_assets
}

stage_bundle_release() {
  if [[ ! -f "$BUNDLE_PATH" ]]; then
    echo "bundle does not exist: $BUNDLE_PATH" >&2
    exit 1
  fi

  run as_bay rm -rf "$TARGET_RELEASE"
  run as_bay mkdir -p "$TARGET_RELEASE"
  extract_as_bay "$BUNDLE_PATH" "$TARGET_RELEASE" --strip-components=1
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

  run as_bay rm -rf "$TARGET_RELEASE"
  run as_bay mkdir -p "$TARGET_RELEASE"
  run as_bay cp -al "${current_release}/." "$TARGET_RELEASE/"

  local extract_dir
  extract_dir="$(as_bay mktemp -d "${TARGET_RELEASE}.static-bundle.XXXXXX")"
  trap 'as_bay rm -rf "$extract_dir"' RETURN
  extract_as_bay "$STATIC_BUNDLE_PATH" "$extract_dir" --strip-components=1

  run as_bay rm -rf \
    "${TARGET_RELEASE}/runtime/control-plane/public" \
    "${TARGET_RELEASE}/runtime/control-plane/cdn" \
    "${TARGET_RELEASE}/runtime/control-plane/webapp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/gcp" \
    "${TARGET_RELEASE}/runtime/control-plane/bundle/nebius" \
    "${TARGET_RELEASE}/bay-static-manifest.json"
  run as_bay rsync -a "${extract_dir}/" "$TARGET_RELEASE/"
  preserve_previous_static_assets
  preserve_previous_cdn_assets "$current_release"
  as_bay rm -rf "$extract_dir"
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

  run as_bay rm -rf "$TARGET_RELEASE"
  run as_bay mkdir -p "$TARGET_RELEASE"
  run as_bay cp -al "${current_release}/." "$TARGET_RELEASE/"

  local extract_dir
  extract_dir="$(as_bay mktemp -d "${TARGET_RELEASE}.hub-bundle.XXXXXX")"
  trap 'as_bay rm -rf "$extract_dir"' RETURN
  extract_as_bay "$HUB_BUNDLE_PATH" "$extract_dir" --strip-components=1

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

  run as_bay rm -rf \
    "${TARGET_RELEASE}/runtime/control-plane/bundle" \
    "${TARGET_RELEASE}/runtime/control-plane/api-v2-routes" \
    "${TARGET_RELEASE}/runtime/control-plane/http-api-dist" \
    "${TARGET_RELEASE}/runtime/migrate-schema" \
    "${TARGET_RELEASE}/scripts/bay-systemd" \
    "${TARGET_RELEASE}/runtime/control-plane/hub-version.json" \
    "${TARGET_RELEASE}/bay-hub-manifest.json"
  run as_bay rsync -a "${extract_dir}/" "$TARGET_RELEASE/"
  as_bay rm -rf "$extract_dir"
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
  run as_bay rsync -a --ignore-existing --exclude='._*' \
    "${previous_static}/" "${target_static}/"
}

# The raw version_min_browser and version_recommended_browser site settings,
# as "MIN REC" ("-" for one that is unset). Prints nothing when they cannot be
# read.
read_browser_version_settings() {
  [[ -n "${PSQL_BIN:-}" && -d "${BAY_ROOT}/run/postgres" ]] || return 0
  local rows
  rows="$(
    runuser -u "$BAY_USER" -- env \
      PGHOST="${BAY_ROOT}/run/postgres" \
      PGPORT=5432 \
      PGUSER="$BAY_USER" \
      PGCONNECT_TIMEOUT=5 \
      timeout 15 "$PSQL_BIN" -d "$BAY_USER" -XAtq -F ' ' -c \
      "SELECT name, value FROM server_settings WHERE name IN ('version_min_browser', 'version_recommended_browser')" \
      2>/dev/null
  )" || return 0
  local name value min="-" recommended="-"
  while read -r name value; do
    value="${value//[[:space:]]/}"
    case "$name" in
      version_min_browser) min="${value:--}" ;;
      version_recommended_browser) recommended="${value:--}" ;;
    esac
  done <<<"$rows"
  echo "$min $recommended"
}

# A raw browser version setting, clamped without arithmetic until it is known
# to be in the past (so an oversized typo cannot wrap around): 0 when it is
# not a number of seconds, NOW when it is not in the past, else the value.
clamp_browser_version() {
  local value="$1" now="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || {
    echo 0
    return
  }
  value="${value#"${value%%[!0]*}"}"
  if [[ -z "$value" ]]; then
    echo 0
  elif ((${#value} > ${#now})) || [[ ${#value} -eq ${#now} && ! "$value" < "$now" ]]; then
    echo "$now"
  else
    echo "$value"
  fi
}

# A browser version as the hub reads it (normalizeVersionValue in
# util/db-schema/site-settings-public.ts): 0 unless it is a number of seconds
# in the past.
normalize_browser_version() {
  local value
  value="$(clamp_browser_version "$1" "$2")"
  if [[ "$value" == "$2" ]]; then
    echo 0
  else
    echo "$value"
  fi
}

# The required browser version the hub enforces, given the raw settings, the
# time and the version of the frontend it serves (server-settings.ts, then
# buildPublicSiteSettings): min(required, recommended) normalized, bounded by
# the normalized recommended version, itself bounded by the frontend version.
# Prints nothing when the hub enforces no version (0).
effective_required_browser_version() {
  local min="$1" recommended="$2" now="$3" frontend="$4"
  # server-settings.ts: Math.min(min || 0, recommended || 0), on values
  # clamped to at most NOW, which keeps their order relative to past ones.
  local raw_min raw_recommended combined
  raw_min="$(clamp_browser_version "$min" "$now")"
  raw_recommended="$(clamp_browser_version "$recommended" "$now")"
  combined=$((raw_min < raw_recommended ? raw_min : raw_recommended))
  local bounded_recommended bounded
  bounded_recommended="$(normalize_browser_version "$recommended" "$now")"
  frontend="$(normalize_browser_version "$frontend" "$now")"
  if ((frontend > 0 && frontend < bounded_recommended)); then
    bounded_recommended="$frontend"
  fi
  bounded="$(normalize_browser_version "$combined" "$now")"
  if ((bounded_recommended < bounded)); then
    bounded="$bounded_recommended"
  fi
  if ((bounded > 0)); then
    echo "$bounded"
  fi
}

# The required browser version the hub will enforce for this release; "none"
# when the settings were read but the hub enforces no version; nothing when
# they could not be read.
read_required_browser_version() {
  local frontend="${1:-0}" settings version
  settings="$(read_browser_version_settings)"
  [[ -n "$settings" ]] || return 0
  # shellcheck disable=SC2086
  version="$(effective_required_browser_version $settings "$(date +%s)" "$frontend")"
  echo "${version:-none}"
}

# Inherited frontend chunks are kept only for builds a browser may still run:
# those at or after the required browser version (older clients are
# disconnected). Without a version the hub enforces, a fixed window applies,
# never everything.
FRONTEND_ASSET_FALLBACK_DAYS="${FRONTEND_ASSET_FALLBACK_DAYS:-14}"
# The version is set from a build's smc-version, written around the frontend
# build; a day of slack keeps a build whose bundle was stamped a little earlier.
FRONTEND_ASSET_VERSION_SLACK_MS=$((24 * 3600 * 1000))

# The smc-version compiled into the hub a release runs, as recorded in its
# runtime/control-plane/hub-version.json, or nothing. Full and hub bundles
# carry the file, a source deploy writes it from the tree it stages, a hub
# bundle overlay drops the inherited one, and a static-only release keeps the
# current one with its hub; a release without it predates all of that.
release_hub_smc_version() {
  local release="$1" node_bin="$2"
  # As the bay account: root never reads files in the bay-owned release tree.
  as_bay_node "$node_bin" -e '
const fs = require("node:fs");
const recorded = process.argv[1];
const version = fs.existsSync(recorded)
  ? Number(JSON.parse(fs.readFileSync(recorded, "utf8")).smc_version)
  : undefined;
console.log(Number.isSafeInteger(version) && version > 0 ? version : "");
' "${release}/runtime/control-plane/hub-version.json" 2>/dev/null || true
}

# A source deploy runs the hub built from the tree it stages: record that
# tree's smc-version as the release's hub version (nothing when it has none).
record_source_hub_version() {
  local node_bin
  node_bin="$(find_node)"
  as_bay_node "$node_bin" -e '
const fs = require("node:fs");
const [source, out] = process.argv.slice(1);
fs.rmSync(out, { force: true });
if (!fs.existsSync(source)) process.exit(0);
const version = Number(/exports\.version\s*=\s*(\d+)/.exec(fs.readFileSync(source, "utf8"))?.[1]);
if (Number.isSafeInteger(version) && version > 0) {
  fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ smc_version: version })}\n`);
}
' "${TARGET_RELEASE}/packages/util/smc-version.js" \
    "${TARGET_RELEASE}/runtime/control-plane/hub-version.json"
}

# The cutoff for a release whose hub was built with smc-version HUB (unix
# seconds; the hub bounds the required version by it).
frontend_asset_retention_cutoff() {
  local frontend="${1:-}"
  if [[ -n "${FRONTEND_ASSET_RETENTION_CUTOFF_MS:-}" ]]; then
    echo "${FRONTEND_ASSET_RETENTION_CUTOFF_MS} override"
    return
  fi
  local fallback="$((($(date +%s) - FRONTEND_ASSET_FALLBACK_DAYS * 86400) * 1000))"
  if [[ ! "$frontend" =~ ^[0-9]+$ ]]; then
    # A release that does not record its hub's smc-version (built before it
    # was): the version the hub enforces cannot be bounded.
    echo "${fallback} fallback-${FRONTEND_ASSET_FALLBACK_DAYS}d:unknown-hub-version"
    return
  fi
  local version
  version="$(read_required_browser_version "$frontend")"
  case "$version" in
    "")
      echo "${fallback} fallback-${FRONTEND_ASSET_FALLBACK_DAYS}d:unreadable"
      ;;
    none)
      # The hub disconnects no browser, by setting: a fixed window, as with an
      # unreadable setting (the two are reported apart).
      echo "${fallback} fallback-${FRONTEND_ASSET_FALLBACK_DAYS}d:no-enforced-version"
      ;;
    *)
      echo "$((version * 1000 - FRONTEND_ASSET_VERSION_SLACK_MS)) required-browser-version=${version}"
      ;;
  esac
}

# A deploy that installs a frontend keeps "Required browser version" (and the
# recommended version, since the hub enforces the smaller of the two) at most
# this many days old, so browsers older than that are disconnected and a later
# deploy can drop their chunks. 0 turns this off. Hub-only deploys leave it.
FRONTEND_MAX_BROWSER_AGE_DAYS="${FRONTEND_MAX_BROWSER_AGE_DAYS:-30}"

# The value a browser version setting is raised to so it is at least FLOOR,
# or nothing when it stays: raise only, so a recent value, or one in the
# future (which the hub ignores, and replacing would lower), is left alone.
browser_version_raise_target() {
  local value="$1" now="$2" floor="$3" clamped
  clamped="$(clamp_browser_version "$value" "$now")"
  if [[ "$clamped" != "$now" ]] && ((clamped < floor)); then
    echo "$floor"
  fi
}

# Raises one browser version setting to VALUE as the bay account, atomically
# and only while the stored value is not a number (missing, empty, "-",
# anything else) or is numerically below VALUE: a value an admin raised in
# between, or one in the future, is never lowered. Bumps _last_update so
# running hubs reload. Returns 0 when it was raised, 2 when it was left, 1 on
# error.
write_browser_version_setting() {
  local name="$1" value="$2"
  [[ "$name" =~ ^version_(min|recommended)_browser$ && "$value" =~ ^[0-9]+$ ]] || return 1
  local updated
  updated="$(
    runuser -u "$BAY_USER" -- env \
      PGHOST="${BAY_ROOT}/run/postgres" \
      PGPORT=5432 \
      PGUSER="$BAY_USER" \
      PGCONNECT_TIMEOUT=5 \
      timeout 15 "$PSQL_BIN" -d "$BAY_USER" -XAtq -v ON_ERROR_STOP=1 \
      -v name="$name" -v value="$value" <<'SQL'
WITH up AS (
  INSERT INTO server_settings (name, value) VALUES (:'name', :'value')
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value
  -- CASE, not OR: only CASE fixes the order, so the cast never sees text.
  WHERE CASE
    WHEN server_settings.value IS NULL
      OR btrim(server_settings.value) !~ '^[0-9]+$' THEN true
    ELSE btrim(server_settings.value)::numeric < (:'value')::numeric
  END
  RETURNING 1
), touched AS (
  INSERT INTO server_settings (name, value)
  SELECT '_last_update', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE EXISTS (SELECT 1 FROM up)
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value
  RETURNING 1
)
SELECT count(*) FROM up;
SQL
  )" || return 1
  [[ "$updated" == 1 ]] || return 2
}

# Raises the required and recommended browser versions to at most
# FRONTEND_MAX_BROWSER_AGE_DAYS old, logging each change. Does nothing when
# the settings cannot be read (the retention step reports that).
ensure_recent_browser_version() {
  local days="$FRONTEND_MAX_BROWSER_AGE_DAYS"
  if [[ ! "$days" =~ ^[0-9]{1,5}$ ]]; then
    echo "WARNING: FRONTEND_MAX_BROWSER_AGE_DAYS='${days}' is not a number of days (at most 5 digits); not changing browser versions" >&2
    return 0
  fi
  days=$((10#$days))
  ((days > 0)) || return 0
  local settings
  settings="$(read_browser_version_settings)"
  [[ -n "$settings" ]] || return 0
  local now floor
  now="$(date +%s)"
  floor=$((now - days * 86400))
  local name value target status
  # shellcheck disable=SC2086
  set -- $settings
  for name in version_min_browser version_recommended_browser; do
    value="$1"
    shift
    target="$(browser_version_raise_target "$value" "$now" "$floor")"
    [[ -n "$target" ]] || continue
    status=0
    write_browser_version_setting "$name" "$target" || status=$?
    case "$status" in
      0) echo "browser version: raised ${name} from ${value} to ${target} (at most ${days} days old)" ;;
      2) echo "browser version: ${name} is already at least ${target} (changed meanwhile); left as is" ;;
      *) echo "WARNING: could not raise ${name} from ${value} to ${target}" >&2 ;;
    esac
  done
}

prepare_frontend_asset_history() {
  local target_static="${TARGET_RELEASE}/runtime/control-plane/static"
  local current_manifest="${target_static}/frontend-build.json"
  if [[ ! -f "$current_manifest" ]]; then
    echo "release is missing frontend asset manifest: ${current_manifest}" >&2
    exit 1
  fi

  local previous_static="" previous_ledger=""
  if [[ -L "$CURRENT_LINK" ]]; then
    local current_release
    current_release="$(readlink -f "$CURRENT_LINK")"
    if [[ -n "$current_release" && "$current_release" != "$TARGET_RELEASE" ]]; then
      previous_static="${current_release}/runtime/control-plane/static"
      previous_ledger="${current_release}/runtime/control-plane/frontend-asset-ledger.json"
    fi
  fi
  local target_ledger="${TARGET_RELEASE}/runtime/control-plane/frontend-asset-ledger.json"

  local node_bin
  node_bin="$(find_node)"
  # The hub's own smc-version bounds the version it enforces: the hub this
  # release runs (a static-only release keeps the current one). Until every
  # worker is rolled, the hubs of the current release keep serving this
  # release's static tree too, so the lower of the two applies, and an
  # unknown one makes it unknown.
  local hub_version current_hub_version
  hub_version="$(release_hub_smc_version "$TARGET_RELEASE" "$node_bin")"
  if [[ -L "$CURRENT_LINK" ]]; then
    local serving_release
    serving_release="$(readlink -f "$CURRENT_LINK")"
    if [[ -n "$serving_release" && -d "$serving_release" && "$serving_release" != "$TARGET_RELEASE" ]]; then
      current_hub_version="$(release_hub_smc_version "$serving_release" "$node_bin")"
      if [[ -z "$current_hub_version" ]]; then
        hub_version=""
      elif [[ -n "$hub_version" ]] && ((current_hub_version < hub_version)); then
        hub_version="$current_hub_version"
      fi
    fi
  fi
  local cutoff cutoff_ms cutoff_source
  cutoff="$(frontend_asset_retention_cutoff "$hub_version")"
  cutoff_ms="${cutoff%% *}"
  cutoff_source="${cutoff#* }"

  as_bay_node "$node_bin" - "$target_static" "$previous_static" \
    "$previous_ledger" "$target_ledger" "$cutoff_ms" "$cutoff_source" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [
  targetRoot,
  previousRoot,
  previousLedgerPath,
  targetLedgerPath,
  cutoffArg,
  cutoffSource,
] = process.argv.slice(2);
const cutoffMs = Number(cutoffArg);
if (!Number.isFinite(cutoffMs)) {
  throw new Error(`invalid frontend asset retention cutoff: ${cutoffArg}`);
}
// The union of the current build and the inherited builds still kept: the
// hub monitor and `software smoke static` check the same cap.
const MAX_ASSETS = 11_000;
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

function smcVersion(value) {
  const version = Number(value?.smc_version);
  return Number.isSafeInteger(version) && version > 0
    ? { smc_version: version }
    : {};
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
  const assets = [...new Set(rawAssets.map(safeAsset))].sort();
  if (assets.length > MAX_ASSETS) {
    throw new Error(`frontend asset manifest exceeds ${MAX_ASSETS} files`);
  }
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
    ...smcVersion(manifest),
    build_date: `${manifest.build_date ?? ""}`,
    fingerprint: `${manifest.fingerprint ?? ""}`,
    assets,
  };
}

function readLedger(filename) {
  if (!filename || !fs.existsSync(filename)) return;
  const ledger = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (ledger?.schema !== 1 || !Array.isArray(ledger.builds)) {
    throw new Error(`frontend asset ledger has an unsupported schema: ${filename}`);
  }
  return ledger.builds;
}

// Every hashed file under the target static root, however many there are.
function hashedFiles(root, directory = root, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      hashedFiles(root, absolute, files);
    } else if (entry.isFile() && HASHED_ASSET.test(entry.name)) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files;
}

const exists = (asset) =>
  !!fs.statSync(path.resolve(targetRoot, asset), { throwIfNoEntry: false })?.isFile();

const current = normalizeBuild(readManifest(targetRoot), targetRoot, false);

// The inherited builds, each with its own assets: from the previous release's
// ledger, or, for a release that predates the ledger, its own build with every
// hashed file it carried (their builds are unknown, so they age with it).
let inherited = [];
let missing = 0;
const ledgerBuilds = readLedger(previousLedgerPath);
if (ledgerBuilds) {
  for (const build of ledgerBuilds) {
    const assets = [...new Set((build.assets ?? []).map(safeAsset))];
    const present = assets.filter(exists);
    missing += assets.length - present.length;
    inherited.push({
      git_revision: `${build.git_revision ?? ""}`,
      build_timestamp: Number(build.build_timestamp) || 0,
      ...smcVersion(build),
      build_date: `${build.build_date ?? ""}`,
      fingerprint: `${build.fingerprint ?? ""}`,
      assets: present.sort(),
    });
  }
} else {
  const previous = normalizeBuild(readManifest(previousRoot), previousRoot, true);
  if (previous) inherited.push(previous);
}
// (A rebuilt or redeployed current build retains nothing extra: retained
// assets never include the current build's own.)
inherited = inherited.filter((build) => build.assets.length > 0);

// A browser on a build reports that build's smc-version, and the hub admits it
// when that is at least the required version: keep a build by the same test
// when both are known. Otherwise by build time, which is never earlier than
// the build's smc-version (so this never drops a build the hub admits).
const requiredVersion =
  Number(/^required-browser-version=(\d+)$/.exec(cutoffSource)?.[1]) || null;
const retain = (build) =>
  requiredVersion != null && build.smc_version != null
    ? build.smc_version >= requiredVersion
    : build.build_timestamp >= cutoffMs;
const kept = inherited.filter(retain);
const dropped = inherited.filter((build) => !retain(build));
const currentAssets = new Set(current.assets);
const retained = new Set();
for (const build of kept) {
  for (const asset of build.assets) {
    if (!currentAssets.has(asset)) retained.add(asset);
  }
}
// Files listed only by dropped builds are removed from this release. The
// current build's own assets are never removed, and neither is a hashed file
// no build lists: it is kept, counted, and counts toward the cap.
const removable = new Set();
for (const build of dropped) {
  for (const asset of build.assets) {
    if (!currentAssets.has(asset) && !retained.has(asset)) removable.add(asset);
  }
}
const toRemove = [];
const unlistedAssets = [];
for (const asset of hashedFiles(targetRoot)) {
  if (removable.has(asset)) {
    toRemove.push(asset);
  } else if (!currentAssets.has(asset) && !retained.has(asset)) {
    unlistedAssets.push(asset);
  }
}
unlistedAssets.sort();
const unlisted = unlistedAssets.length;
// Every hashed file this release keeps: the hub monitor and `software smoke
// static` check the listed ones against the same cap.
const unionSize = currentAssets.size + retained.size + unlisted;
if (unionSize > MAX_ASSETS) {
  throw new Error(
    `frontend asset history exceeds ${MAX_ASSETS} files (${unionSize} from ${kept.length + 1} builds back to ${new Date(cutoffMs).toISOString()}, ${cutoffSource}${unlisted ? `, ${unlisted} unlisted` : ""}); raise the required browser version`,
  );
}
for (const asset of toRemove) {
  fs.rmSync(path.resolve(targetRoot, asset), { force: true });
}
const removed = toRemove.length;

// Unlisted files are recorded as a build of their own, dated with this
// release's build: from the next deploy on they are listed, and they age out
// with it.
const unlistedBuild =
  unlisted > 0
    ? {
        git_revision: "",
        build_timestamp: current.build_timestamp,
        build_date: current.build_date,
        fingerprint: "unlisted",
        assets: unlistedAssets,
      }
    : undefined;

// The served history keeps the shape the hub monitor and smoke test read: the
// current build and, as one entry, everything else this release keeps.
const builds = [current];
if (retained.size + unlisted > 0) {
  const newest =
    kept.length > 0
      ? kept.reduce((a, b) => (b.build_timestamp > a.build_timestamp ? b : a))
      : unlistedBuild;
  builds.push({
    ...newest,
    assets: [...new Set([...retained, ...unlistedAssets])].sort(),
  });
}
const requiredBrowserVersion = requiredVersion;
const history = {
  schema: 1,
  generated_at: new Date().toISOString(),
  builds,
  // Read by `software smoke static` to name the setting in its warning.
  retention: {
    cutoff: new Date(cutoffMs).toISOString(),
    source: cutoffSource,
    required_browser_version: requiredBrowserVersion,
    max_assets: MAX_ASSETS,
  },
};
// One ledger entry per build (fingerprint and timestamp), so redeploying the
// same bundle does not append a copy each time: entries for one build are
// merged, and one that is the current build adds only assets it lacks.
function mergeLedgerBuilds(current, others) {
  const key = (build) => `${build.fingerprint}\u0000${build.build_timestamp}`;
  const currentKey = key(current);
  const merged = new Map();
  for (const build of others) {
    const extra =
      key(build) === currentKey
        ? build.assets.filter((asset) => !currentAssets.has(asset))
        : build.assets;
    if (key(build) === currentKey && extra.length === 0) continue;
    const existing = merged.get(key(build));
    if (existing) {
      existing.assets = [...new Set([...existing.assets, ...extra])].sort();
    } else {
      merged.set(key(build), { ...build, assets: [...extra].sort() });
    }
  }
  return [current, ...merged.values()];
}

function writeJson(output, value) {
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, output);
}
writeJson(path.join(targetRoot, "frontend-build-history.json"), history);
writeJson(targetLedgerPath, {
  schema: 1,
  generated_at: history.generated_at,
  builds: mergeLedgerBuilds(current, [
    ...kept,
    ...(unlistedBuild ? [unlistedBuild] : []),
  ]),
});
console.log(
  `frontend asset retention: cutoff=${new Date(cutoffMs).toISOString()} (${cutoffSource}) builds kept=${kept.length} dropped=${dropped.length} inherited files kept=${retained.size} removed=${removed} unlisted=${unlisted}${missing ? ` missing=${missing}` : ""}`,
);
if (removed > 0) {
  // Accepted limitation (@ops0, 10-27): a hub-only rollback keeps this
  // release's pruned static tree.
  console.log(
    "note: rolling the hub back does not restore pruned frontend chunks; old tabs may need a reload",
  );
}
console.log(
  `validated frontend assets: builds=${builds.length} files=${unionSize}`,
);
// History only shrinks when the required browser version is raised: say so a
// release or two before the cap blocks a deploy.
if (unionSize >= Math.floor(MAX_ASSETS * 0.8)) {
  console.log(
    `WARNING: frontend asset history has ${unionSize} of ${MAX_ASSETS} files (${Math.floor((unionSize / MAX_ASSETS) * 100)}%), back to ${new Date(cutoffMs).toISOString()} (${requiredBrowserVersion ? `required browser version ${requiredBrowserVersion}` : cutoffSource}). Raise "Required browser version" in the admin site settings so older builds' chunks are dropped before a deploy is refused at ${MAX_ASSETS}.`,
  );
}
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

  # As the bay account: require() runs index.js and cp -L follows links.
  local node_bin package_names
  node_bin="$(find_node)"
  package_names="$(as_bay_node "$node_bin" - "${previous_cdn}/index.js" "${target_cdn}/index.js" <<'NODE'
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
      run as_bay cp -aL "$previous_path" "${target_cdn}/${versioned_name}"
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
    as_bay cat "${BAY_ROOT}/state/current-version"
    return 0
  fi
  return 1
}

set_current_release() {
  local previous=""
  previous="$(current_release_id || true)"
  run as_bay mkdir -p "${BAY_ROOT}/state"
  if [[ -n "$previous" && "$previous" != "$RELEASE_ID" ]]; then
    printf '%s\n' "$previous" | as_bay tee "${BAY_ROOT}/state/previous-version" >/dev/null
  fi
  run as_bay ln -sfn "$TARGET_RELEASE" "$CURRENT_LINK"
  printf '%s\n' "$RELEASE_ID" | as_bay tee "${BAY_ROOT}/state/current-version" >/dev/null
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
    previous="$(as_bay cat "${BAY_ROOT}/state/previous-version")"
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
    run as_bay rm -rf "${RELEASES_DIR}/${release}"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
}

# A bay fenced for a restore (RESTORE.md) takes no deploy until the cutover,
# which bay-restore runs on the release it has: checked before anything is
# staged or changed. Only a rebuild's release install (mode B step 6) runs
# fenced, with --fenced, and it never starts the bay.
check_restore_fence() {
  if [[ "$ALLOW_FENCED" -eq 1 && "$START_BAY" -eq 1 ]]; then
    echo "--fenced and --start exclude each other: a fenced bay is started only by bay-restore's cutover" >&2
    exit 2
  fi
  [[ -e "$RESTORE_FENCE" ]] || return 0
  if [[ "$ALLOW_FENCED" -ne 1 ]]; then
    echo "refusing: the bay is fenced for a restore (${RESTORE_FENCE}); deploy after bay-restore's cutover (a mode B rebuild installs with --fenced)" >&2
    exit 1
  fi
  if [[ "$START_BAY" -eq 1 ]]; then
    echo "refusing --start: the bay is fenced for a restore (${RESTORE_FENCE}); bay-restore's cutover starts it" >&2
    exit 1
  fi
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
      --fenced)
        ALLOW_FENCED=1
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
  check_restore_fence

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
  # Absolute, so paths derived from it stay valid in helpers that run from /
  # (as_bay_node) and in the generated bay env.
  INSTALL_BASE="$(realpath -m -- "$INSTALL_BASE")"
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

  ensure_install_dirs
  if [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    stage_static_bundle_release
  elif [[ -n "$HUB_BUNDLE_PATH" ]]; then
    stage_hub_bundle_release
  elif [[ -n "$BUNDLE_PATH" ]]; then
    stage_bundle_release
  else
    stage_source_release
  fi
  local frontend_prepared=0
  if [[ -n "$STATIC_BUNDLE_PATH" || -n "$BUNDLE_PATH" ]]; then
    prepare_frontend_asset_history
    frontend_prepared=1
  elif [[
    -z "$HUB_BUNDLE_PATH" &&
      -f "${TARGET_RELEASE}/runtime/control-plane/static/frontend-build.json"
  ]]; then
    prepare_frontend_asset_history
    frontend_prepared=1
  fi
  validate_release
  if [[ -n "$STATIC_BUNDLE_PATH" ]]; then
    stage_trusted_scaffold static
    install_needrestart_policy
    install_bay_runner
    remove_trusted_scaffold
  fi
  set_current_release
  # Only once the new frontend is live: a failed deploy never leaves the old
  # one serving under a raised floor. This deploy kept chunks by the setting
  # as it was; the next one prunes to it. Failures here only warn.
  if ((frontend_prepared)); then
    ensure_recent_browser_version
  fi

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
    configure_bay_logging_env
    stage_trusted_scaffold
    INSTALL_CMD=(
      "${TRUSTED_SCAFFOLD_DIR}/install-scaffold.sh"
      "--overlay"
      "$OVERLAY_MODE"
      "--bin-user"
      "$BAY_USER"
    )
    if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
      INSTALL_CMD+=("--daemon-reload")
    fi
    run "${INSTALL_CMD[@]}"
    remove_trusted_scaffold
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

  stage_trusted_scaffold
  INSTALL_CMD=("${TRUSTED_SCAFFOLD_DIR}/install-scaffold.sh" "--overlay" "$OVERLAY_MODE" "--bin-user" "$BAY_USER")
  if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
    INSTALL_CMD+=("--daemon-reload")
  fi
  run "${INSTALL_CMD[@]}"
  # The trusted copy stays until the overlay environment is written below.

  # Normalise ownership of older installs (physical walk, never following
  # links), then create anything missing as the bay account.
  require_protected_hardlinks
  run chown -R "${BAY_USER}:${BAY_GROUP}" "$BAY_ROOT" "${INSTALL_BASE}"
  run as_bay mkdir -p "${BAY_ROOT}/secrets" "${BAY_ROOT}/projects" "${BAY_ROOT}/bin"

  if ! as_bay test -e "${BAY_ROOT}/secrets/conat-password"; then
    (umask 077; random_secret | as_bay tee "${BAY_ROOT}/secrets/conat-password" >/dev/null)
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

DEBUG=cocalc:error:*,cocalc:warn:*
DEBUG_CONSOLE=yes
DEBUG_FILE=

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
  configure_bay_logging_env
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
      cat "${TRUSTED_SCAFFOLD_DIR}/env/bay-${OVERLAY_MODE}-overlay.env.example" \
        > "${ENV_DIR}/bay-overlay.env"
    else
      render_if_missing_or_forced "${ENV_DIR}/bay-overlay.env" "$BAY_OVERLAY_ENV_EXAMPLE" \
        < "${TRUSTED_SCAFFOLD_DIR}/env/bay-${OVERLAY_MODE}-overlay.env.example"
    fi
  fi
  # Root-run units load the overlay and root scripts source it, so it came
  # from the trusted copy too; that copy is no longer needed.
  remove_trusted_scaffold

  run systemctl enable cocalc-bay.target
  run systemctl enable cocalc-bay-frontdoor.service
  run systemctl enable cocalc-bay-cloudflared.service
  run systemctl enable cocalc-bay-hub-watchdog.timer
  run systemctl enable cocalc-bay-cloudflared-watchdog.timer
  if [[ "$ENABLE_WORKERS" -eq 1 ]]; then
    for worker_id in $(seq 1 "$WORKER_COUNT"); do
      run systemctl enable "cocalc-bay-hub@${worker_id}.service"
    done
  fi

  if [[ "$START_BAY" -eq 1 ]]; then
    # Checked at the start too; the deploy lock keeps a restore from fencing
    # the bay since, so this is defense in depth.
    if [[ -e "$RESTORE_FENCE" ]]; then
      echo "refusing --start: the bay is fenced for a restore (${RESTORE_FENCE})" >&2
      exit 1
    fi
    validate_site_master_key
    run systemctl start cocalc-bay.target
    run systemctl start cocalc-bay-frontdoor.service
    run systemctl start cocalc-bay-cloudflared.service
    run systemctl start cocalc-bay-hub-watchdog.timer
    run systemctl start cocalc-bay-cloudflared-watchdog.timer
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

# One deploy or restore at a time: as root, the whole run holds the bay's
# deploy lock, which bay-restore holds for a whole restore too, so a restore
# cannot fence and stop the bay while this changes the release or starts
# PostgreSQL, nor this run during a restore. Under "flock -o" the lock stays
# with the flock process: nothing this run starts inherits it.
DEPLOY_LOCK="${COCALC_BAY_DEPLOY_LOCK:-/etc/cocalc/bay-deploy.lock}"
run_locked_main() {
  if [[ "$(id -u)" != 0 || "${COCALC_BAY_DEPLOY_LOCKED:-}" == 1 ]]; then
    main "$@"
    return
  fi
  install -d -m 0755 "$(dirname "$DEPLOY_LOCK")"
  local rc=0
  COCALC_BAY_DEPLOY_LOCKED=1 flock -n -o -E 75 "$DEPLOY_LOCK" "$(readlink -f "$0")" "$@" || rc=$?
  if [[ "$rc" == 75 ]]; then
    echo "refusing: a bay restore or another deploy is running (it holds ${DEPLOY_LOCK}); nothing was changed" >&2
  fi
  exit "$rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_locked_main "$@"
fi
