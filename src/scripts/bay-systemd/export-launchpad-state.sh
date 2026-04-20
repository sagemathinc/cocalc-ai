#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR=""
DATA_DIR="${DATA:-${COCALC_DATA_DIR:-}}"
SECRETS_DIR=""
SYNC_DIR=""
EXTRA_SECRETS_DIR=""
PGHOST_VALUE="${PGHOST:-}"
PGPORT_VALUE="${PGPORT:-}"
PGUSER_VALUE="${PGUSER:-}"
PGDATABASE_VALUE="${PGDATABASE:-}"
INCLUDE_CLOUDFLARE=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: export-launchpad-state.sh --output <dir> [options]

Export a launchpad-style control-plane state bundle for import into a bay VM.

Included artifacts:
  - postgres.dump      pg_dump custom-format dump
  - sync.tar.gz        DATA/sync tree, if present
  - secrets.tar.gz     DATA/secrets tree, if present
  - manifest.json      export metadata

Options:
  --output <dir>             destination directory (required)
  --data-dir <dir>           source DATA / COCALC_DATA_DIR
  --sync-dir <dir>           source sync dir (default: <data-dir>/sync)
  --secrets-dir <dir>        source secrets dir (default: <data-dir>/secrets)
  --extra-secrets-dir <dir>  additional secrets dir to archive separately
  --pg-host <path>           PGHOST for pg_dump
  --pg-port <n>              PGPORT for pg_dump
  --pg-user <name>           PGUSER for pg_dump
  --pg-database <name>       PGDATABASE for pg_dump
  --include-cloudflare       include launchpad-cloudflare tunnel credentials
  --force                    overwrite an existing output directory
  -h, --help                 show help
EOF
}

run() {
  echo "+ $*"
  "$@"
}

find_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then
    command -v pg_dump
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/pg_dump' 2>/dev/null | sort | tail -n1
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --data-dir)
        DATA_DIR="$2"
        shift 2
        ;;
      --sync-dir)
        SYNC_DIR="$2"
        shift 2
        ;;
      --secrets-dir)
        SECRETS_DIR="$2"
        shift 2
        ;;
      --extra-secrets-dir)
        EXTRA_SECRETS_DIR="$2"
        shift 2
        ;;
      --pg-host)
        PGHOST_VALUE="$2"
        shift 2
        ;;
      --pg-port)
        PGPORT_VALUE="$2"
        shift 2
        ;;
      --pg-user)
        PGUSER_VALUE="$2"
        shift 2
        ;;
      --pg-database)
        PGDATABASE_VALUE="$2"
        shift 2
        ;;
      --include-cloudflare)
        INCLUDE_CLOUDFLARE=1
        shift
        ;;
      --force)
        FORCE=1
        shift
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

  if [[ -z "$OUTPUT_DIR" ]]; then
    echo "--output is required" >&2
    exit 2
  fi

  if [[ -z "$DATA_DIR" ]]; then
    echo "--data-dir is required when DATA / COCALC_DATA_DIR is not set" >&2
    exit 2
  fi
  if [[ ! -d "$DATA_DIR" ]]; then
    echo "data dir does not exist: $DATA_DIR" >&2
    exit 1
  fi

  if [[ -z "$SYNC_DIR" ]]; then
    SYNC_DIR="${DATA_DIR}/sync"
  fi
  if [[ -z "$SECRETS_DIR" ]]; then
    SECRETS_DIR="${DATA_DIR}/secrets"
  fi

  if [[ -z "$PGUSER_VALUE" || -z "$PGDATABASE_VALUE" ]]; then
    echo "PGUSER / PGDATABASE are required; pass --pg-user / --pg-database or export them in the environment" >&2
    exit 2
  fi

  local pg_dump_bin
  pg_dump_bin="$(find_pg_dump)"
  if [[ -z "$pg_dump_bin" ]]; then
    echo "could not find pg_dump" >&2
    exit 1
  fi

  if [[ -e "$OUTPUT_DIR" ]]; then
    if [[ "$FORCE" -ne 1 ]]; then
      echo "output dir already exists: $OUTPUT_DIR (use --force to overwrite)" >&2
      exit 1
    fi
    run rm -rf "$OUTPUT_DIR"
  fi
  run mkdir -p "$OUTPUT_DIR"

  run env \
    PGHOST="${PGHOST_VALUE}" \
    PGPORT="${PGPORT_VALUE}" \
    PGUSER="${PGUSER_VALUE}" \
    PGDATABASE="${PGDATABASE_VALUE}" \
    "$pg_dump_bin" \
      --format=custom \
      --file "${OUTPUT_DIR}/postgres.dump" \
      "${PGDATABASE_VALUE}"

  if [[ -d "$SYNC_DIR" ]]; then
    run tar -C "$(dirname "$SYNC_DIR")" -czf "${OUTPUT_DIR}/sync.tar.gz" "$(basename "$SYNC_DIR")"
  fi

  if [[ -d "$SECRETS_DIR" ]]; then
    if [[ "$INCLUDE_CLOUDFLARE" -eq 1 ]]; then
      run tar -C "$(dirname "$SECRETS_DIR")" -czf "${OUTPUT_DIR}/secrets.tar.gz" "$(basename "$SECRETS_DIR")"
    else
      run tar -C "$(dirname "$SECRETS_DIR")" \
        --exclude "$(basename "$SECRETS_DIR")/launchpad-cloudflare" \
        -czf "${OUTPUT_DIR}/secrets.tar.gz" \
        "$(basename "$SECRETS_DIR")"
    fi
  fi

  if [[ -n "$EXTRA_SECRETS_DIR" && -d "$EXTRA_SECRETS_DIR" ]]; then
    run tar -C "$(dirname "$EXTRA_SECRETS_DIR")" -czf "${OUTPUT_DIR}/extra-secrets.tar.gz" "$(basename "$EXTRA_SECRETS_DIR")"
  fi

  python3 - "$OUTPUT_DIR" "$DATA_DIR" "$SYNC_DIR" "$SECRETS_DIR" "$EXTRA_SECRETS_DIR" "$PGHOST_VALUE" "$PGPORT_VALUE" "$PGUSER_VALUE" "$PGDATABASE_VALUE" "$INCLUDE_CLOUDFLARE" <<'PY'
import json
import os
import socket
import sys
from datetime import datetime, timezone

(
    output_dir,
    data_dir,
    sync_dir,
    secrets_dir,
    extra_secrets_dir,
    pg_host,
    pg_port,
    pg_user,
    pg_database,
    include_cloudflare,
) = sys.argv[1:]

manifest = {
    "exported_at": datetime.now(timezone.utc).isoformat(),
    "hostname": socket.gethostname(),
    "data_dir": data_dir,
    "sync_dir": sync_dir if os.path.isdir(sync_dir) else None,
    "secrets_dir": secrets_dir if os.path.isdir(secrets_dir) else None,
    "extra_secrets_dir": extra_secrets_dir if extra_secrets_dir and os.path.isdir(extra_secrets_dir) else None,
    "pg_host": pg_host or None,
    "pg_port": pg_port or None,
    "pg_user": pg_user,
    "pg_database": pg_database,
    "included_cloudflare": include_cloudflare == "1",
}

with open(os.path.join(output_dir, "manifest.json"), "w", encoding="utf-8") as out:
    json.dump(manifest, out, indent=2, sort_keys=True)
    out.write("\n")
PY

  echo "launchpad state export complete: ${OUTPUT_DIR}"
}

main "$@"
