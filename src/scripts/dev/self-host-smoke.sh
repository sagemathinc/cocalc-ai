#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HUB_DAEMON="$SCRIPT_DIR/hub-daemon.sh"
CONFIG_FILE="${COCALC_HUB_DAEMON_CONFIG:-$SRC_DIR/.local/hub-daemon.env}"

if [ ! -x "$HUB_DAEMON" ]; then
  echo "missing executable: $HUB_DAEMON" >&2
  exit 1
fi

SMOKE_REQUIRE_EXISTING_CONFIG="${SMOKE_REQUIRE_EXISTING_CONFIG:-0}"
if [ ! -f "$CONFIG_FILE" ]; then
  "$HUB_DAEMON" init
  if [ "$SMOKE_REQUIRE_EXISTING_CONFIG" = "1" ]; then
    echo "edit config first: $CONFIG_FILE" >&2
    exit 1
  fi
  echo "using generated config: $CONFIG_FILE"
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

SMOKE_BUILD_BUNDLES="${SMOKE_BUILD_BUNDLES:-1}"
SMOKE_BUILD_SERVER="${SMOKE_BUILD_SERVER:-1}"
SMOKE_BUILD_HUB="${SMOKE_BUILD_HUB:-1}"
SMOKE_BUILD_CLI="${SMOKE_BUILD_CLI:-1}"
SMOKE_CLEANUP_SUCCESS="${SMOKE_CLEANUP_SUCCESS:-1}"
SMOKE_CLEANUP_FAILURE="${SMOKE_CLEANUP_FAILURE:-1}"
SMOKE_VERIFY_INDEX="${SMOKE_VERIFY_INDEX:-1}"
SMOKE_VERIFY_COPY_BETWEEN_PROJECTS="${SMOKE_VERIFY_COPY_BETWEEN_PROJECTS:-1}"
SMOKE_VERIFY_DEPROVISION="${SMOKE_VERIFY_DEPROVISION:-1}"
SMOKE_VERIFY_WORKSPACE_SSH="${SMOKE_VERIFY_WORKSPACE_SSH:-1}"
SMOKE_VERIFY_WORKSPACE_PROXY="${SMOKE_VERIFY_WORKSPACE_PROXY:-1}"
SMOKE_STRICT_MOVE_FILE_CHECK="${SMOKE_STRICT_MOVE_FILE_CHECK:-0}"
SMOKE_RESTART_HUB="${SMOKE_RESTART_HUB:-1}"
SMOKE_RESET_BACKUP_QUEUE="${SMOKE_RESET_BACKUP_QUEUE:-1}"
SMOKE_RESET_HOST_QUEUE="${SMOKE_RESET_HOST_QUEUE:-1}"
SMOKE_PRUNE_STALE_SMOKE_HOSTS="${SMOKE_PRUNE_STALE_SMOKE_HOSTS:-1}"
SMOKE_AUTO_SSHD_PORT="${SMOKE_AUTO_SSHD_PORT:-1}"
SMOKE_HUB_READY_TIMEOUT_SEC="${SMOKE_HUB_READY_TIMEOUT_SEC:-30}"
SMOKE_HUB_READY_INTERVAL_SEC="${SMOKE_HUB_READY_INTERVAL_SEC:-1}"
SMOKE_ACCOUNT_ID="${SMOKE_ACCOUNT_ID:-}"
SMOKE_VM_NAME="${SMOKE_VM_NAME:-}"

if [ "$SMOKE_AUTO_SSHD_PORT" = "1" ] && [ -z "${COCALC_SSHD_PORT:-}" ]; then
  COCALC_SSHD_PORT="$(
    node -e '
      const net = require("node:net");
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (!addr || typeof addr !== "object") process.exit(1);
        process.stdout.write(String(addr.port));
        s.close();
      });
    '
  )"
  export COCALC_SSHD_PORT
  echo "smoke: using dynamic local sshd port $COCALC_SSHD_PORT"
fi

if [ "$SMOKE_BUILD_BUNDLES" = "1" ]; then
  echo "building local project-host and project bundles..."
  pnpm --dir "$SRC_DIR/packages/project-host" build:bundle
  pnpm --dir "$SRC_DIR/packages/project" build:bundle
  if [ ! -f "$SRC_DIR/packages/project/build/tools-linux-x64.tar.xz" ] \
    && [ ! -f "$SRC_DIR/packages/project/build/tools-linux-amd64.tar.xz" ]; then
    echo "building full project tools bundle (required for project ssh/dropbear)..."
    pnpm --dir "$SRC_DIR/packages/project" build:tools
  fi
fi

if [ "$SMOKE_BUILD_SERVER" = "1" ]; then
  echo "building server package..."
  pnpm --dir "$SRC_DIR/packages/server" build
fi

if [ "$SMOKE_BUILD_HUB" = "1" ]; then
  echo "building hub package..."
  pnpm --dir "$SRC_DIR/packages/hub" build
fi

if [ "$SMOKE_BUILD_CLI" = "1" ]; then
  echo "building cli package..."
  pnpm --dir "$SRC_DIR/packages/cli" build
fi

if [ "$SMOKE_RESTART_HUB" = "1" ]; then
  "$HUB_DAEMON" restart
else
  "$HUB_DAEMON" start
fi
"$HUB_DAEMON" status

hub_base_url="http://127.0.0.1:${HUB_PORT}"
hub_ready_deadline=$(( $(date +%s) + SMOKE_HUB_READY_TIMEOUT_SEC ))
echo "smoke: waiting for hub readiness at ${hub_base_url} (timeout ${SMOKE_HUB_READY_TIMEOUT_SEC}s)"
while true; do
  if HUB_BASE_URL="$hub_base_url" node -e '
    const u = new URL(process.env.HUB_BASE_URL);
    const http = require(u.protocol === "https:" ? "https" : "http");
    const req = http.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port, path: "/", method: "GET", timeout: 3000 },
      (res) => { res.resume(); process.exit(0); },
    );
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", () => process.exit(1));
    req.end();
  ' >/dev/null 2>&1; then
    break
  fi
  if [ "$(date +%s)" -ge "$hub_ready_deadline" ]; then
    echo "smoke preflight: hub endpoint did not become reachable at ${hub_base_url}" >&2
    exit 1
  fi
  sleep "$SMOKE_HUB_READY_INTERVAL_SEC"
done

# Avoid leaking PG* from other repos/sessions into smoke-runner DB clients.
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
LOCAL_PG_ENV="${SMOKE_LOCAL_PG_ENV:-$SRC_DIR/data/app/postgres/local-postgres.env}"
if [ -f "$LOCAL_PG_ENV" ]; then
  # shellcheck source=/dev/null
  source "$LOCAL_PG_ENV"
else
  echo "missing local postgres env file: $LOCAL_PG_ENV" >&2
  exit 1
fi

if [ -z "${COCALC_HUB_PASSWORD:-}" ] && [ -n "${SECRETS:-}" ] && [ -f "$SECRETS/conat-password" ]; then
  export COCALC_HUB_PASSWORD="$SECRETS/conat-password"
fi

if [ -n "${COCALC_HUB_PASSWORD:-}" ]; then
  cli_ready_deadline=$(( $(date +%s) + SMOKE_HUB_READY_TIMEOUT_SEC ))
  echo "smoke: waiting for CLI auth path against ${hub_base_url}"
  while true; do
    if node "$SRC_DIR/packages/cli/dist/bin/cocalc.js" \
      --json \
      --api "$hub_base_url" \
      --hub-password "$COCALC_HUB_PASSWORD" \
      --timeout 15s \
      ws list --limit 1 >/dev/null 2>&1; then
      break
    fi
    if [ "$(date +%s)" -ge "$cli_ready_deadline" ]; then
      echo "smoke preflight: CLI could not authenticate to ${hub_base_url}; check HUB_PORT and hub password" >&2
      exit 1
    fi
    sleep "$SMOKE_HUB_READY_INTERVAL_SEC"
  done
fi

if [ "$SMOKE_RESET_BACKUP_QUEUE" = "1" ]; then
  psql_target=()
  if [ -n "${DATABASE_URL:-}" ]; then
    psql_target=("$DATABASE_URL")
  fi
  canceled_backup_lros="$(
    psql "${psql_target[@]}" -Atc "
      WITH updated AS (
        UPDATE long_running_operations
        SET
          status='canceled',
          error=COALESCE(error, 'canceled by self-host smoke preflight'),
          finished_at=COALESCE(finished_at, now()),
          owner_type=NULL,
          owner_id=NULL,
          heartbeat_at=NULL,
          updated_at=now()
        WHERE kind='project-backup' AND status IN ('queued', 'running')
        RETURNING op_id
      )
      SELECT COUNT(*) FROM updated;
    " 2>/dev/null || echo ""
  )"
  if [ -n "$canceled_backup_lros" ]; then
    echo "smoke preflight: canceled $canceled_backup_lros stale project-backup LRO(s)"
  fi
fi

if [ "$SMOKE_RESET_HOST_QUEUE" = "1" ]; then
  psql_target=()
  if [ -n "${DATABASE_URL:-}" ]; then
    psql_target=("$DATABASE_URL")
  fi
  canceled_host_lros="$(
    psql "${psql_target[@]}" -Atc "
      WITH updated AS (
        UPDATE long_running_operations
        SET
          status='canceled',
          error=COALESCE(error, 'canceled by self-host smoke preflight'),
          finished_at=COALESCE(finished_at, now()),
          owner_type=NULL,
          owner_id=NULL,
          heartbeat_at=NULL,
          updated_at=now()
        WHERE kind LIKE 'host-%' AND status IN ('queued', 'running')
        RETURNING op_id
      )
      SELECT COUNT(*) FROM updated;
    " 2>/dev/null || echo ""
  )"
  if [ -n "$canceled_host_lros" ]; then
    echo "smoke preflight: canceled $canceled_host_lros stale host LRO(s)"
  fi
fi

if [ "$SMOKE_PRUNE_STALE_SMOKE_HOSTS" = "1" ]; then
  psql_target=()
  if [ -n "${DATABASE_URL:-}" ]; then
    psql_target=("$DATABASE_URL")
  fi
  stale_hosts_summary="$(
    psql "${psql_target[@]}" -Atc "
      WITH stale_hosts AS (
        SELECT id
        FROM project_hosts
        WHERE deleted IS NULL
          AND (
            name ILIKE 'Self-host smoke %'
            OR name ILIKE 'self-host backup smoke %'
            OR name ILIKE 'self-host copy smoke %'
          )
      ),
      marked_hosts AS (
        UPDATE project_hosts
        SET
          status='deprovisioned',
          deleted=COALESCE(deleted, now()),
          updated=now()
        WHERE id IN (SELECT id FROM stale_hosts)
        RETURNING id
      ),
      revoked_connectors AS (
        UPDATE self_host_connectors
        SET revoked=TRUE
        WHERE host_id IN (SELECT id FROM marked_hosts)
        RETURNING connector_id
      ),
      revoked_tokens AS (
        UPDATE self_host_connector_tokens
        SET revoked=TRUE
        WHERE host_id IN (SELECT id FROM marked_hosts)
          AND COALESCE(revoked, FALSE) = FALSE
        RETURNING token_id
      ),
      canceled_lros AS (
        UPDATE long_running_operations
        SET
          status='canceled',
          error=COALESCE(error, 'canceled by self-host smoke preflight'),
          finished_at=COALESCE(finished_at, now()),
          owner_type=NULL,
          owner_id=NULL,
          heartbeat_at=NULL,
          updated_at=now()
        WHERE scope_type='host'
          AND scope_id IN (SELECT id FROM marked_hosts)
          AND status IN ('queued', 'running')
        RETURNING op_id
      )
      SELECT CONCAT(
        'hosts=', (SELECT COUNT(*) FROM marked_hosts),
        ', connectors=', (SELECT COUNT(*) FROM revoked_connectors),
        ', tokens=', (SELECT COUNT(*) FROM revoked_tokens),
        ', host_lros=', (SELECT COUNT(*) FROM canceled_lros)
      );
    " 2>/dev/null || echo ""
  )"
  if [ -n "$stale_hosts_summary" ]; then
    echo "smoke preflight: pruned stale smoke hosts (${stale_hosts_summary})"
  fi
fi

# Ensure pairing callbacks from temporary local sshd hit this local hub.
if [ -n "${HUB_SELF_HOST_PAIR_URL:-}" ]; then
  export COCALC_SELF_HOST_PAIR_URL="$HUB_SELF_HOST_PAIR_URL"
else
  export COCALC_SELF_HOST_PAIR_URL="http://127.0.0.1:${HUB_PORT}"
fi

# Smoke runner executes in its own process; pin all hub/conat URLs so it
# never falls back to default localhost:5000 values from backend/data.
export PORT="${HUB_PORT}"
export CONAT_SERVER="http://127.0.0.1:${HUB_PORT}"
export BASE_URL="${BASE_URL:-http://127.0.0.1:${HUB_PORT}}"

cleanup_success_bool="true"
cleanup_failure_bool="false"
verify_index_bool="true"
verify_copy_between_projects_bool="true"
verify_deprovision_bool="true"
verify_workspace_ssh_bool="true"
verify_workspace_proxy_bool="true"
strict_move_file_check_bool="false"

[ "$SMOKE_CLEANUP_SUCCESS" = "1" ] || cleanup_success_bool="false"
[ "$SMOKE_CLEANUP_FAILURE" = "1" ] && cleanup_failure_bool="true"
[ "$SMOKE_VERIFY_INDEX" = "1" ] || verify_index_bool="false"
[ "$SMOKE_VERIFY_COPY_BETWEEN_PROJECTS" = "1" ] || verify_copy_between_projects_bool="false"
[ "$SMOKE_VERIFY_DEPROVISION" = "1" ] || verify_deprovision_bool="false"
[ "$SMOKE_VERIFY_WORKSPACE_SSH" = "1" ] || verify_workspace_ssh_bool="false"
[ "$SMOKE_VERIFY_WORKSPACE_PROXY" = "1" ] || verify_workspace_proxy_bool="false"
[ "$SMOKE_STRICT_MOVE_FILE_CHECK" = "1" ] && strict_move_file_check_bool="true"

export SMOKE_ACCOUNT_ID SMOKE_VM_NAME cleanup_success_bool cleanup_failure_bool
export verify_index_bool verify_copy_between_projects_bool verify_deprovision_bool
export verify_workspace_ssh_bool verify_workspace_proxy_bool
export strict_move_file_check_bool

cd "$SRC_DIR"
node - <<'NODE'
const fn = async () => {
  const mod = require("./packages/server/dist/cloud/smoke-runner/self-host.js");
  const opts = {
    cleanup_on_success: process.env.cleanup_success_bool === "true",
    cleanup_on_failure: process.env.cleanup_failure_bool === "true",
    verify_backup_index_contents: process.env.verify_index_bool === "true",
    verify_copy_between_projects:
      process.env.verify_copy_between_projects_bool === "true",
    verify_deprovision: process.env.verify_deprovision_bool === "true",
    verify_workspace_ssh: process.env.verify_workspace_ssh_bool === "true",
    verify_workspace_proxy: process.env.verify_workspace_proxy_bool === "true",
    strict_move_file_check: process.env.strict_move_file_check_bool === "true",
  };
  if (process.env.SMOKE_ACCOUNT_ID) {
    opts.account_id = process.env.SMOKE_ACCOUNT_ID;
  }
  if (process.env.SMOKE_VM_NAME) {
    opts.vm_name = process.env.SMOKE_VM_NAME;
  }
  opts.log = (event) => {
    const extra = event.message ? ` ${event.message}` : "";
    process.stderr.write(`[smoke-step] ${event.step} ${event.status}${extra}\n`);
  };
  const result = await mod.runSelfHostMultipassBackupSmoke(opts);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
};
fn().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
