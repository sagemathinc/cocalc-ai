/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomBytes, randomUUID } from "node:crypto";

import { InstancesClient, ZoneOperationsClient } from "@google-cloud/compute";

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:bay-backup:disposable-gcp");

const RESULT_PREFIX = "COCALC_BAY_RESTORE_DRILL_RESULT_V1_";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

export interface TemporaryR2Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_in_seconds: number;
  prefixes: string[];
}

export interface DisposableRestoreWorkerConfig {
  run_id: string;
  result_nonce: string;
  bay_id: string;
  backup_set_id: string;
  repository_type?: "legacy-rustic" | "pgbackrest";
  snapshot_id: string;
  restore_mode: "snapshot" | "pitr";
  target_time?: string;
  pitr_run_id?: string;
  postgres_major: number;
  postgres_user: string;
  postgres_database: string;
  r2_endpoint: string;
  r2_bucket: string;
  r2_access_key_id: string;
  r2_secret_access_key: string;
  r2_session_token: string;
  rustic_repo_root: string;
  rustic_repo_password: string;
  wal_object_prefix?: string;
  pgbackrest_repo_path?: string;
  pgbackrest_cipher_pass?: string;
  pgbackrest_stanza?: string;
  pgbackrest_version?: string;
  pgbackrest_source_sha256?: string;
  require_conat: boolean;
  minimum_free_bytes: number;
  worker_timeout_seconds?: number;
  archive_get_timeout_seconds?: number;
  archive_get_attempts?: number;
  wal_replay_stall_timeout_seconds?: number;
}

export interface DisposableRestoreWorkerResult {
  version: 1;
  status: "passed" | "failed";
  run_id: string;
  stage: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error?: string;
  postgres?: {
    repository_type?: "legacy-rustic" | "pgbackrest";
    backup_label?: string | null;
    restore_mode: "snapshot" | "pitr";
    pitr_verified: boolean;
    pre_count: number | null;
    post_count: number | null;
    database: string;
    tables_verified: string[];
  };
  conat?: {
    sync_tree_found: boolean;
    database_count: number;
    database_bytes: number;
    quick_check_passed: number;
    catalog_found: boolean;
    catalog_quick_check?: string;
  };
  disk?: {
    total_bytes: number;
    free_bytes_before: number;
    free_bytes_after: number;
  };
}

export interface DisposableGcpRestoreResult {
  worker: DisposableRestoreWorkerResult;
  instance_name: string;
  project_id: string;
  zone: string;
  machine_type: string;
  boot_disk_gb: number;
  cleanup: "deleted" | "already-deleted";
}

export function isRetryableDisposablePitrWalFailure(
  worker: DisposableRestoreWorkerResult,
): boolean {
  return (
    worker.status === "failed" &&
    worker.stage === "postgres-pitr" &&
    /WAL replay stalled|archive-get/i.test(`${worker.error ?? ""}`)
  );
}

export function disposableRestoreInstanceName(run_id: string): string {
  return `cocalc-restore-${run_id.replace(/-/g, "").slice(0, 20)}`;
}

type GcpAuth = {
  projectId: string;
  credentials: {
    client_email: string;
    private_key: string;
  };
};

type GcpClients = {
  instances: Pick<
    InstancesClient,
    "insert" | "delete" | "get" | "getSerialPortOutput"
  >;
  operations: Pick<ZoneOperationsClient, "wait">;
};

function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function boundedError(value: unknown, maxLength = 2_000): string {
  const text = `${value instanceof Error ? value.message : (value ?? "")}`;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function parseGcpServiceAccount(serviceAccountJson: string): GcpAuth {
  let parsed: any;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch (err) {
    throw new Error(`invalid GCP service account JSON: ${boundedError(err)}`);
  }
  const projectId = `${parsed?.project_id ?? ""}`.trim();
  const client_email = `${parsed?.client_email ?? ""}`.trim();
  const private_key = `${parsed?.private_key ?? ""}`.trim();
  if (!projectId || !client_email || !private_key) {
    throw new Error("GCP service account JSON is missing required fields");
  }
  return {
    projectId,
    credentials: { client_email, private_key },
  };
}

export async function createTemporaryR2ReadCredentials({
  account_id,
  api_token,
  bucket,
  parent_access_key_id,
  prefixes,
  ttl_seconds,
  fetch_impl = fetch,
}: {
  account_id: string;
  api_token: string;
  bucket: string;
  parent_access_key_id: string;
  prefixes: string[];
  ttl_seconds: number;
  fetch_impl?: typeof fetch;
}): Promise<TemporaryR2Credentials> {
  const normalizedPrefixes = Array.from(
    new Set(prefixes.map(cleanPrefix).filter(Boolean)),
  ).map((prefix) => `${prefix}/`);
  if (!normalizedPrefixes.length) {
    throw new Error("temporary R2 credentials require at least one prefix");
  }
  const response = await fetch_impl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account_id)}/r2/temp-access-credentials`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bucket,
        parentAccessKeyId: parent_access_key_id,
        permission: "object-read-only",
        ttlSeconds: ttl_seconds,
        prefixes: normalizedPrefixes,
      }),
    },
  );
  const body = (await response.json().catch(() => undefined)) as any;
  const access_key_id = `${body?.result?.accessKeyId ?? ""}`.trim();
  const secret_access_key = `${body?.result?.secretAccessKey ?? ""}`.trim();
  const session_token = `${body?.result?.sessionToken ?? ""}`.trim();
  if (
    !response.ok ||
    body?.success !== true ||
    !access_key_id ||
    !secret_access_key ||
    !session_token
  ) {
    const errors = Array.isArray(body?.errors)
      ? body.errors
          .map((entry: any) => `${entry?.code ?? ""}: ${entry?.message ?? ""}`)
          .join("; ")
      : "";
    throw new Error(
      `failed to create temporary R2 credentials (${response.status}): ${errors || "invalid response"}`,
    );
  }
  return {
    access_key_id,
    secret_access_key,
    session_token,
    expires_in_seconds: ttl_seconds,
    prefixes: normalizedPrefixes,
  };
}

function pythonWorkerSource(): string {
  return String.raw`#!/usr/bin/env python3
import base64
import glob
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import traceback

CONFIG_PATH = "/root/cocalc-restore-drill.json"
ROOT = pathlib.Path("/var/lib/cocalc-restore-drill")
SNAPSHOT = ROOT / "snapshot"
STARTED = time.time()
STAGE = "bootstrap"

with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
    CONFIG = json.load(handle)
REPOSITORY_TYPE = CONFIG.get("repository_type", "legacy-rustic")
ARCHIVE_GET_TIMEOUT_SECONDS = max(30, int(CONFIG.get("archive_get_timeout_seconds", 120)))
ARCHIVE_GET_ATTEMPTS = max(1, min(5, int(CONFIG.get("archive_get_attempts", 3))))
WAL_REPLAY_STALL_TIMEOUT_SECONDS = max(
    ARCHIVE_GET_TIMEOUT_SECONDS * ARCHIVE_GET_ATTEMPTS + 30,
    int(CONFIG.get("wal_replay_stall_timeout_seconds", 600)),
)

def bounded(value, limit=2000):
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."

def report(status, *, error=None, postgres=None, conat=None, disk=None):
    result = {
        "version": 1,
        "status": status,
        "run_id": CONFIG["run_id"],
        "stage": STAGE,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(STARTED)),
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_ms": int((time.time() - STARTED) * 1000),
    }
    if error:
        result["error"] = bounded(error)
    if postgres is not None:
        result["postgres"] = postgres
    if conat is not None:
        result["conat"] = conat
    if disk is not None:
        result["disk"] = disk
    encoded = base64.b64encode(json.dumps(result, separators=(",", ":")).encode()).decode()
    marker = "${RESULT_PREFIX}" + CONFIG["result_nonce"] + "=" + encoded
    with open("/dev/ttyS0", "w", encoding="utf-8") as serial:
        serial.write("\n" + marker + "\n")
        serial.flush()

def run(args, *, timeout=1800, env=None, capture=False, input_text=None, log=True):
    if log:
        print("restore-drill:", " ".join(str(arg) for arg in args[:4]), flush=True)
    return subprocess.run(
        [str(arg) for arg in args],
        check=True,
        timeout=timeout,
        env=env,
        text=True,
        input=input_text,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )

def toml_string(value):
    return json.dumps(str(value))

def sql_quote(value):
    return "'" + str(value).replace("'", "''") + "'"

def locate_one(pattern):
    matches = sorted(SNAPSHOT.glob(pattern))
    if len(matches) != 1:
        raise RuntimeError(f"expected one {pattern}, found {len(matches)}")
    return matches[0]

def pgbackrest_env():
    env = os.environ.copy()
    env.update({
        "PGBACKREST_REPO1_S3_KEY": CONFIG["r2_access_key_id"],
        "PGBACKREST_REPO1_S3_KEY_SECRET": CONFIG["r2_secret_access_key"],
        "PGBACKREST_REPO1_S3_TOKEN": CONFIG["r2_session_token"],
        "PGBACKREST_REPO1_CIPHER_PASS": CONFIG["pgbackrest_cipher_pass"],
    })
    return env

def psql(container, sql, *, log=True):
    completed = run([
        "podman", "exec", container, "psql", "-h", "/tmp",
        "-p", "5432",
        "-U", CONFIG["postgres_user"], "-d", CONFIG["postgres_database"],
        "-tAc", sql,
    ], timeout=60, capture=True, log=log)
    return completed.stdout.strip()

def postgres_diagnostics(container):
    logs = run(["podman", "logs", "--tail", "80", container], timeout=60, capture=True)
    noisy = (
        "FATAL:  the database system is starting up",
        "FATAL:  the database system is in recovery mode",
    )
    lines = (logs.stdout + "\n" + logs.stderr).splitlines()
    filtered = [line for line in lines if not any(value in line for value in noisy)]
    suppressed = len(lines) - len(filtered)
    suffix = f"\n[suppressed {suppressed} repeated readiness failures]" if suppressed else ""
    return bounded("\n".join(filtered[-80:]) + suffix, 3000)

def archive_get_state(container):
    try:
        completed = subprocess.run(
            ["podman", "exec", container, "cat", "/tmp/cocalc-pgbackrest-archive-get.state"],
            check=False,
            timeout=10,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return None
    if completed.returncode != 0:
        return None
    state = {}
    for line in completed.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            state[key] = value
    return state or None

postgres_result = None
conat_result = None
disk_result = None
container = "cocalc-bay-restore-drill"

try:
    STAGE = "install-tools"
    os.environ["DEBIAN_FRONTEND"] = "noninteractive"
    run(["apt-get", "update"], timeout=900)
    packages = [
        "apt-get", "install", "-y", "--no-install-recommends",
        "ca-certificates", "curl", "podman", "sqlite3", "zstd",
    ]
    if REPOSITORY_TYPE == "pgbackrest":
        packages.extend([
            "build-essential", "meson", "ninja-build", "pkg-config",
            "libbz2-dev", "liblz4-dev", "libpq-dev", "libssh2-1-dev",
            "libssl-dev", "libsystemd-dev", "libxml2-dev", "libz-dev",
            "libzstd-dev",
        ])
    run(packages, timeout=1200)
    arch = subprocess.check_output(["uname", "-m"], text=True).strip()
    rustic_arch = "x86_64" if arch in ("x86_64", "amd64") else "arm64"
    rustic_url = f"https://github.com/sagemathinc/rustic/releases/download/v0.11.1/rustic-v0.11.1-linux-{rustic_arch}.tar.gz"
    run(["bash", "-lc", f"curl -fsSL {rustic_url} | tar -xz -C /usr/local/bin rustic"], timeout=600)
    os.chmod("/usr/local/bin/rustic", 0o755)

    if REPOSITORY_TYPE == "pgbackrest":
        STAGE = "build-pgbackrest"
        ROOT.mkdir(parents=True, exist_ok=True)
        version = CONFIG["pgbackrest_version"]
        source_sha256 = CONFIG["pgbackrest_source_sha256"]
        source = ROOT / f"pgbackrest-{version}.tar.gz"
        source_url = f"https://github.com/pgbackrest/pgbackrest/releases/download/release%2F{version}/pgbackrest-{version}.tar.gz"
        run(["curl", "-fsSL", source_url, "-o", str(source)], timeout=600)
        checked = run(["sha256sum", str(source)], timeout=60, capture=True).stdout.split()[0]
        if checked != source_sha256:
            raise RuntimeError(f"pgBackRest source checksum mismatch: {checked}")
        source_dir = ROOT / f"pgbackrest-{version}"
        build_dir = ROOT / "pgbackrest-build"
        run(["tar", "-xzf", str(source), "-C", str(ROOT)], timeout=300)
        run(["meson", "setup", str(build_dir), str(source_dir)], timeout=600)
        run(["ninja", "-C", str(build_dir)], timeout=1200)
        shutil.copy2(build_dir / "src" / "pgbackrest", "/usr/local/bin/pgbackrest")
        os.chmod("/usr/local/bin/pgbackrest", 0o755)
        run(["/usr/local/bin/pgbackrest", "version"], timeout=60)

    STAGE = "disk-preflight"
    ROOT.mkdir(parents=True, exist_ok=True)
    usage_before = shutil.disk_usage(ROOT)
    if usage_before.free < int(CONFIG["minimum_free_bytes"]):
        raise RuntimeError(
            f"insufficient worker disk: free={usage_before.free} required={CONFIG['minimum_free_bytes']}"
        )

    STAGE = "restore-rustic"
    profile = pathlib.Path("/root/cocalc-restore-repo.toml")
    profile.write_text("\n".join([
        "[repository]",
        'repository = "opendal:s3"',
        "password = " + toml_string(CONFIG["rustic_repo_password"]),
        "",
        "[repository.options]",
        "endpoint = " + toml_string(CONFIG["r2_endpoint"]),
        'region = "auto"',
        "bucket = " + toml_string(CONFIG["r2_bucket"]),
        "root = " + toml_string(CONFIG["rustic_repo_root"]),
        "access_key_id = " + toml_string(CONFIG["r2_access_key_id"]),
        "secret_access_key = " + toml_string(CONFIG["r2_secret_access_key"]),
        "session_token = " + toml_string(CONFIG["r2_session_token"]),
        "",
    ]), encoding="utf-8")
    os.chmod(profile, 0o600)
    SNAPSHOT.mkdir(parents=True, exist_ok=True)
    run([
        "rustic", "-P", str(profile.with_suffix("")), "restore",
        CONFIG["snapshot_id"], str(SNAPSHOT),
    ], timeout=3600)

    STAGE = "validate-conat"
    if REPOSITORY_TYPE == "pgbackrest":
        sync_dir = SNAPSHOT
    else:
        sync_dirs = [path for path in SNAPSHOT.glob("**/sync") if path.is_dir()]
        sync_dir = sync_dirs[0] if sync_dirs else None
    db_files = sorted(sync_dir.rglob("*.db")) if sync_dir else []
    database_bytes = sum(path.stat().st_size for path in db_files)
    quick_passed = 0
    for path in db_files:
        checked = run(
            ["sqlite3", "-readonly", str(path), "PRAGMA quick_check;"],
            timeout=120,
            capture=True,
            log=False,
        ).stdout.strip()
        if checked != "ok":
            raise RuntimeError(f"Conat SQLite quick_check failed for {path.name}: {bounded(checked, 500)}")
        quick_passed += 1
        if quick_passed % 1000 == 0 or quick_passed == len(db_files):
            print(
                f"restore-drill: SQLite quick_check progress {quick_passed}/{len(db_files)}",
                flush=True,
            )
    catalogs = sorted(sync_dir.rglob("catalog.sqlite")) if sync_dir else []
    catalog_status = None
    if catalogs:
        try:
            catalog_status = run(
                ["sqlite3", "-readonly", str(catalogs[0]), "PRAGMA quick_check;"],
                timeout=120,
                capture=True,
            ).stdout.strip()
        except Exception as err:
            # The maintenance catalog is rebuildable and is not authoritative data.
            catalog_status = "rebuildable-catalog-check-failed: " + bounded(err, 500)
    conat_result = {
        "sync_tree_found": sync_dir is not None,
        "database_count": len(db_files),
        "database_bytes": database_bytes,
        "quick_check_passed": quick_passed,
        "catalog_found": bool(catalogs),
        "catalog_quick_check": catalog_status,
    }
    if CONFIG["require_conat"] and (sync_dir is None or not db_files):
        raise RuntimeError("backup requires Conat validation but no restored .db files were found")

    STAGE = "prepare-postgres"
    pgbackrest_config = None
    if REPOSITORY_TYPE == "pgbackrest":
        required = (
            "target_time", "pitr_run_id", "pgbackrest_repo_path",
            "pgbackrest_cipher_pass", "pgbackrest_stanza",
        )
        missing = [name for name in required if not CONFIG.get(name)]
        if missing:
            raise RuntimeError("pgBackRest PITR config is missing: " + ", ".join(missing))
        pgdata = SNAPSHOT / "postgres" / "base"
        pgdata.mkdir(parents=True, exist_ok=True)
        pgbackrest_config = pathlib.Path("/etc/pgbackrest/pgbackrest.conf")
        pgbackrest_config.parent.mkdir(parents=True, exist_ok=True)
        endpoint = CONFIG["r2_endpoint"].removeprefix("https://").removeprefix("http://").rstrip("/")
        # pgBackRest's own I/O timeout only bounds individual socket operations.
        # The restore_command wrapper below also bounds the complete archive-get
        # process, which protects recovery from a wedged protocol state.
        io_timeout = max(10, min(60, ARCHIVE_GET_TIMEOUT_SECONDS // 2))
        # Keep the documented pgBackRest database/protocol relationship
        # explicit without shortening the large base-restore budget. The
        # restore_command wrapper supplies the stricter per-WAL process bound.
        db_timeout = 1800
        protocol_timeout = 1830
        pgbackrest_config.write_text("\n".join([
            "[global]",
            "repo1-type=s3",
            "repo1-path=" + CONFIG["pgbackrest_repo_path"],
            "repo1-s3-bucket=" + CONFIG["r2_bucket"],
            "repo1-s3-endpoint=" + endpoint,
            "repo1-s3-region=auto",
            "repo1-s3-uri-style=path",
            "repo1-cipher-type=aes-256-cbc",
            "process-max=2",
            "io-timeout=" + str(io_timeout),
            "db-timeout=" + str(db_timeout),
            "protocol-timeout=" + str(protocol_timeout),
            "log-level-console=info",
            "",
            "[" + CONFIG["pgbackrest_stanza"] + "]",
            "pg1-path=/var/lib/postgresql/data",
            "",
        ]), encoding="utf-8")
        os.chmod(pgbackrest_config, 0o644)
        STAGE = "restore-pgbackrest"
        run([
            "/usr/local/bin/pgbackrest",
            "--config=" + str(pgbackrest_config),
            "--stanza=" + CONFIG["pgbackrest_stanza"],
            "--pg1-path=" + str(pgdata),
            "--set=" + CONFIG["backup_set_id"],
            "--type=time",
            "--target=" + CONFIG["target_time"],
            "--target-action=promote",
            "restore",
        ], timeout=7200, env=pgbackrest_env())
    pg_versions = sorted(SNAPSHOT.glob("**/postgres/base/PG_VERSION"))
    if len(pg_versions) != 1:
        raise RuntimeError(f"expected one restored PostgreSQL PG_VERSION, found {len(pg_versions)}")
    pgdata = pg_versions[0].parent
    bundled_wal_dirs = sorted(SNAPSHOT.glob("**/postgres/pg_wal"))
    if bundled_wal_dirs:
        target_wal = pgdata / "pg_wal"
        target_wal.mkdir(parents=True, exist_ok=True)
        for source in bundled_wal_dirs[0].iterdir():
            if source.is_file():
                shutil.copy2(source, target_wal / source.name)
    # pgBackRest creates recovery.signal and recovery settings for PITR. Only
    # remove stale runtime state here; deleting the signal would boot the base
    # backup without replaying archived WAL.
    for stale in ("postmaster.pid", "postmaster.opts"):
        (pgdata / stale).unlink(missing_ok=True)
    if REPOSITORY_TYPE != "pgbackrest":
        for stale in ("recovery.signal", "standby.signal"):
            (pgdata / stale).unlink(missing_ok=True)

    hba = pgdata / "pg_hba.conf"
    hba.write_text("local all all trust\n" + hba.read_text(encoding="utf-8"), encoding="utf-8")
    restore_script = ROOT / "restore-wal.sh"
    restore_script.write_text(r'''#!/bin/bash
set -euo pipefail
segment="$1"
destination="$2"
base="${"$"}{R2_ENDPOINT%/}/${"$"}{R2_BUCKET}/${"$"}{WAL_PREFIX}/${"$"}{segment}"
common=(--silent --show-error --aws-sigv4 "aws:amz:auto:s3" --user "${"$"}{R2_ACCESS_KEY_ID}:${"$"}{R2_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${"$"}{R2_SESSION_TOKEN}")
if curl "${"$"}{common[@]}" --fail "${"$"}{base}.zst" | zstd -dc > "${"$"}{destination}.tmp"; then
  mv "${"$"}{destination}.tmp" "$destination"
  exit 0
fi
rm -f "${"$"}{destination}.tmp"
curl "${"$"}{common[@]}" --fail "$base" -o "$destination"
''', encoding="utf-8")
    os.chmod(restore_script, 0o700)
    pgbackrest_archive_get_script = ROOT / "cocalc-pgbackrest-archive-get"
    pgbackrest_archive_get_script.write_text(r'''#!/bin/bash
set -uo pipefail

segment="$1"
destination="$2"
timeout_seconds="${"$"}{COCALC_ARCHIVE_GET_TIMEOUT_SECONDS:-120}"
max_attempts="${"$"}{COCALC_ARCHIVE_GET_ATTEMPTS:-3}"
state_file=/tmp/cocalc-pgbackrest-archive-get.state

write_state() {
  local status="$1"
  local attempt="$2"
  local exit_code="$3"
  local temporary="${"$"}{state_file}.$$"
  printf 'segment=%s\nstatus=%s\nattempt=%s\nupdated_epoch=%s\nexit_code=%s\n' \
    "$segment" "$status" "$attempt" "$(date +%s)" "$exit_code" > "$temporary"
  mv -f "$temporary" "$state_file"
}

last_exit=1
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  write_state running "$attempt" 0
  echo "restore-drill: archive-get begin segment=$segment attempt=$attempt/$max_attempts timeout_seconds=$timeout_seconds" >&2
  timeout --foreground --signal=TERM --kill-after=10s "$timeout_seconds" \
    /usr/local/bin/pgbackrest \
    --config=/etc/pgbackrest/pgbackrest.conf \
    --stanza="${"$"}{COCALC_PGBACKREST_STANZA}" \
    archive-get "$segment" "$destination"
  last_exit=$?
  if [[ "$last_exit" -eq 0 && -e "$destination" ]]; then
    write_state succeeded "$attempt" 0
    echo "restore-drill: archive-get succeeded segment=$segment attempt=$attempt/$max_attempts" >&2
    exit 0
  fi
  if [[ "$last_exit" -eq 0 ]]; then
    last_exit=70
  fi
  rm -f "$destination"
  write_state failed "$attempt" "$last_exit"
  echo "restore-drill: archive-get failed segment=$segment attempt=$attempt/$max_attempts exit_code=$last_exit" >&2
  if (( attempt < max_attempts )); then
    sleep "$attempt"
  fi
done

exit "$last_exit"
''', encoding="utf-8")
    os.chmod(pgbackrest_archive_get_script, 0o700)
    auto_conf = pgdata / "postgresql.auto.conf"
    if REPOSITORY_TYPE == "pgbackrest":
        auto_conf_text = auto_conf.read_text(encoding="utf-8")
        if "restore_command" not in auto_conf_text:
            raise RuntimeError("pgBackRest restore did not configure restore_command")
    with auto_conf.open("a", encoding="utf-8") as handle:
        handle.write("\n# cocalc disposable restore drill\n")
        handle.write("archive_mode = 'off'\n")
        handle.write("archive_command = '/bin/false'\n")
        if REPOSITORY_TYPE == "pgbackrest":
            # Override pgBackRest's generated command with a bounded wrapper.
            # PostgreSQL retries a nonzero restore_command, while the worker's
            # replay watchdog escalates a repeatedly failing segment.
            handle.write("restore_command = '/usr/local/bin/cocalc-pgbackrest-archive-get %f %p'\n")
        if CONFIG["restore_mode"] == "pitr" and REPOSITORY_TYPE != "pgbackrest":
            if not CONFIG.get("target_time") or not CONFIG.get("pitr_run_id") or not CONFIG.get("wal_object_prefix"):
                raise RuntimeError("PITR mode requires target time, sentinel run, and WAL prefix")
            handle.write("restore_command = '/usr/local/bin/restore-wal.sh %f %p'\n")
            handle.write("recovery_target_time = " + sql_quote(CONFIG["target_time"]) + "\n")
            handle.write("recovery_target_inclusive = 'true'\n")
            handle.write("recovery_target_timeline = 'current'\n")
            handle.write("recovery_target_action = 'promote'\n")
    if CONFIG["restore_mode"] == "pitr" and REPOSITORY_TYPE != "pgbackrest":
        (pgdata / "standby.signal").write_text("", encoding="utf-8")

    context = ROOT / "postgres-image"
    context.mkdir(parents=True, exist_ok=True)
    shutil.copy2(restore_script, context / "restore-wal.sh")
    containerfile = [
        f"FROM docker.io/library/postgres:{CONFIG['postgres_major']}-bookworm",
    ]
    if REPOSITORY_TYPE == "pgbackrest":
        shutil.copy2("/usr/local/bin/pgbackrest", context / "pgbackrest")
        shutil.copy2(pgbackrest_config, context / "pgbackrest.conf")
        shutil.copy2(pgbackrest_archive_get_script, context / "cocalc-pgbackrest-archive-get")
        containerfile.extend([
            "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates coreutils libbz2-1.0 liblz4-1 libpq5 libssh2-1 libssl3 libsystemd0 libxml2 libzstd1 zlib1g && rm -rf /var/lib/apt/lists/*",
            "COPY pgbackrest /usr/local/bin/pgbackrest",
            "COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf",
            "COPY cocalc-pgbackrest-archive-get /usr/local/bin/cocalc-pgbackrest-archive-get",
            "RUN chmod 755 /usr/local/bin/pgbackrest /usr/local/bin/cocalc-pgbackrest-archive-get && chmod 644 /etc/pgbackrest/pgbackrest.conf",
        ])
    else:
        containerfile.extend([
            "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl zstd && rm -rf /var/lib/apt/lists/*",
            "COPY restore-wal.sh /usr/local/bin/restore-wal.sh",
            "RUN chmod 700 /usr/local/bin/restore-wal.sh",
        ])
    (context / "Containerfile").write_text("\n".join(containerfile) + "\n", encoding="utf-8")
    run(["podman", "build", "-t", "cocalc-restore-postgres", str(context)], timeout=1800)
    run(["chown", "-R", "999:999", str(pgdata)], timeout=600)

    if CONFIG["restore_mode"] == "snapshot":
        STAGE = "postgres-snapshot-recovery"
        # Single-user PostgreSQL performs the end-of-recovery checkpoint in the
        # startup process itself. This avoids Podman denying a signal to a
        # separate checkpointer while still exercising redo and checkpointing.
        run([
            "podman", "run", "--rm",
            "--security-opt=no-new-privileges",
            "--user", "999:999",
            "--volume", f"{pgdata}:/var/lib/postgresql/data:rw",
            "cocalc-restore-postgres", "postgres", "--single",
            "-D", "/var/lib/postgresql/data",
            "-c", "shared_preload_libraries=",
            "-c", "fsync=off",
            "-c", "full_page_writes=off",
            CONFIG["postgres_database"],
        ], timeout=600, capture=True, input_text="SELECT 1;\n")

    STAGE = "postgres-" + CONFIG["restore_mode"]
    postgres_args = [
        "podman", "run", "--detach", "--name", container,
        "--security-opt=no-new-privileges",
        "--security-opt=apparmor=unconfined",
        "--user", "999:999",
        "--volume", f"{pgdata}:/var/lib/postgresql/data:rw",
        "--env", "R2_ENDPOINT=" + CONFIG["r2_endpoint"],
        "--env", "R2_BUCKET=" + CONFIG["r2_bucket"],
        "--env", "R2_ACCESS_KEY_ID=" + CONFIG["r2_access_key_id"],
        "--env", "R2_SECRET_ACCESS_KEY=" + CONFIG["r2_secret_access_key"],
        "--env", "R2_SESSION_TOKEN=" + CONFIG["r2_session_token"],
        "--env", "WAL_PREFIX=" + CONFIG.get("wal_object_prefix", ""),
        "cocalc-restore-postgres", "postgres", "-D", "/var/lib/postgresql/data",
        "-c", "listen_addresses=", "-c", "unix_socket_directories=/tmp",
        "-c", "port=5432", "-c", "shared_preload_libraries=",
    ]
    if REPOSITORY_TYPE == "pgbackrest":
        postgres_args[postgres_args.index("cocalc-restore-postgres"):postgres_args.index("cocalc-restore-postgres")] = [
            "--env", "PGBACKREST_REPO1_S3_KEY=" + CONFIG["r2_access_key_id"],
            "--env", "PGBACKREST_REPO1_S3_KEY_SECRET=" + CONFIG["r2_secret_access_key"],
            "--env", "PGBACKREST_REPO1_S3_TOKEN=" + CONFIG["r2_session_token"],
            "--env", "PGBACKREST_REPO1_CIPHER_PASS=" + CONFIG["pgbackrest_cipher_pass"],
            "--env", "COCALC_PGBACKREST_STANZA=" + CONFIG["pgbackrest_stanza"],
            "--env", "COCALC_ARCHIVE_GET_TIMEOUT_SECONDS=" + str(ARCHIVE_GET_TIMEOUT_SECONDS),
            "--env", "COCALC_ARCHIVE_GET_ATTEMPTS=" + str(ARCHIVE_GET_ATTEMPTS),
        ]
        postgres_args.extend(["-c", "archive_mode=off", "-c", "archive_command=/bin/false"])
    if CONFIG["restore_mode"] == "snapshot":
        # This VM is destroyed after validation. Avoid making the restore drill's
        # result depend on an end-of-recovery fsync of the entire restored tree;
        # redo, page reads, schema checks, and promotion are still required.
        postgres_args.extend([
            "-c", "fsync=off",
            "-c", "full_page_writes=off",
            "-c", "synchronous_commit=off",
        ])
    run(postgres_args, timeout=300)

    counts = None
    postgres_ready = False
    next_recovery_diagnostic = time.time() + 300
    next_archive_get_check = time.time()
    stalled_wal_segment = None
    stalled_wal_since = None
    last_archive_get = None
    if CONFIG["restore_mode"] == "snapshot":
        deadline = time.time() + 600
    else:
        # WAL replay time depends on the age of the latest full backup. Give
        # PITR the remainder of the worker's overall budget while reserving
        # enough time to report the result and let the controller delete the VM.
        worker_timeout = max(900, int(CONFIG.get("worker_timeout_seconds", 7200)))
        deadline = STARTED + worker_timeout - 300
    last_error = "PostgreSQL unavailable"
    while time.time() < deadline:
        try:
            if CONFIG["restore_mode"] == "pitr":
                value = psql(container,
                    "SELECT count(*) FILTER (WHERE phase='pre')::text || ',' || "
                    "count(*) FILTER (WHERE phase='post')::text || ',' || "
                    "pg_is_in_recovery()::text "
                    "FROM public.bay_restore_test_pitr_events WHERE run_id = " +
                    sql_quote(CONFIG["pitr_run_id"]), log=False)
                pre_text, post_text, recovery_text = value.split(",")
                pre, post = int(pre_text), int(post_text)
                if recovery_text not in ("true", "false"):
                    raise RuntimeError("invalid pg_is_in_recovery result: " + recovery_text)
                counts = (pre, post)
                if counts == (1, 0) and recovery_text == "false":
                    postgres_ready = True
                    break
                if counts == (1, 1):
                    raise RuntimeError("PITR crossed the requested target transaction")
            elif psql(container, "SELECT 1", log=False) == "1":
                postgres_ready = True
                break
        except Exception as err:
            last_error = bounded(err, 1000)
            inspected = subprocess.run(
                ["podman", "inspect", "--format={{.State.Running}}", container],
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            if inspected.returncode != 0 or inspected.stdout.strip() != "true":
                raise RuntimeError(
                    "PostgreSQL container exited before readiness: " +
                    last_error + " logs=" + postgres_diagnostics(container)
                )
        if (
            CONFIG["restore_mode"] == "pitr" and
            REPOSITORY_TYPE == "pgbackrest" and
            time.time() >= next_archive_get_check
        ):
            next_archive_get_check = time.time() + 10
            archive_state = archive_get_state(container)
            if archive_state:
                last_archive_get = archive_state
                segment = archive_state.get("segment")
                status = archive_state.get("status")
                if status == "succeeded":
                    stalled_wal_segment = None
                    stalled_wal_since = None
                elif segment:
                    if segment != stalled_wal_segment:
                        stalled_wal_segment = segment
                        stalled_wal_since = time.time()
                    elif (
                        stalled_wal_since is not None and
                        time.time() - stalled_wal_since >= WAL_REPLAY_STALL_TIMEOUT_SECONDS
                    ):
                        raise RuntimeError(
                            "WAL replay stalled on segment " + segment +
                            " for " + str(int(time.time() - stalled_wal_since)) +
                            " seconds; archive-get status=" + str(status) +
                            " attempt=" + str(archive_state.get("attempt")) +
                            " exit_code=" + str(archive_state.get("exit_code"))
                        )
        if time.time() >= next_recovery_diagnostic:
            print(
                "restore-drill: PostgreSQL recovery still in progress " +
                "elapsed_seconds=" + str(int(time.time() - STARTED)) +
                " sentinel_counts=" + str(counts),
                " archive_get=" + str(last_archive_get),
                flush=True,
            )
            print(postgres_diagnostics(container), flush=True)
            next_recovery_diagnostic = time.time() + 300
        time.sleep(2)
    if CONFIG["restore_mode"] == "pitr" and counts != (1, 0):
        raise RuntimeError("PITR verification timed out: " + last_error + " logs=" + postgres_diagnostics(container))
    if CONFIG["restore_mode"] == "snapshot" and not postgres_ready:
        raise RuntimeError("snapshot PostgreSQL startup timed out: " + last_error + " logs=" + postgres_diagnostics(container))

    tables = ["accounts", "projects", "server_settings"]
    for table in tables:
        value = psql(container, "SELECT to_regclass('public." + table + "')::text")
        if value != table:
            raise RuntimeError(f"missing restored table {table}")
    if psql(container, "SELECT pg_is_in_recovery()::text") != "false":
        raise RuntimeError("restored PostgreSQL did not promote after PITR target")
    postgres_result = {
        "repository_type": REPOSITORY_TYPE,
        "backup_label": CONFIG["backup_set_id"] if REPOSITORY_TYPE == "pgbackrest" else None,
        "restore_mode": CONFIG["restore_mode"],
        "durability": "fsync-disabled-disposable-validation" if CONFIG["restore_mode"] == "snapshot" else "normal",
        "pitr_verified": CONFIG["restore_mode"] == "pitr",
        "pre_count": counts[0] if counts is not None else None,
        "post_count": counts[1] if counts is not None else None,
        "database": CONFIG["postgres_database"],
        "tables_verified": tables,
    }

    STAGE = "complete"
    usage_after = shutil.disk_usage(ROOT)
    disk_result = {
        "total_bytes": usage_after.total,
        "free_bytes_before": usage_before.free,
        "free_bytes_after": usage_after.free,
    }
    report("passed", postgres=postgres_result, conat=conat_result, disk=disk_result)
except Exception as err:
    try:
        report(
            "failed",
            error=bounded(err),
            postgres=postgres_result,
            conat=conat_result,
            disk=disk_result,
        )
    finally:
        traceback.print_exc()
finally:
    subprocess.run(["podman", "rm", "-f", container], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`;
}

export function buildDisposableRestoreStartupScript(
  config: DisposableRestoreWorkerConfig,
): string {
  const workerConfig = { ...config };
  if (workerConfig.restore_mode === "pitr" && workerConfig.target_time) {
    const target = new Date(workerConfig.target_time);
    if (Number.isNaN(target.getTime())) {
      throw new Error(
        `invalid disposable PITR target '${workerConfig.target_time}'`,
      );
    }
    workerConfig.target_time = target
      .toISOString()
      .replace("T", " ")
      .replace("Z", "+00");
  }
  const encodedConfig = Buffer.from(JSON.stringify(workerConfig)).toString(
    "base64",
  );
  const encodedWorker = Buffer.from(pythonWorkerSource()).toString("base64");
  return `#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The VM has no listening service. Drop unsolicited ingress before installing tools.
iptables -P INPUT DROP || true
iptables -A INPUT -i lo -j ACCEPT || true
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
ip6tables -P INPUT DROP || true
ip6tables -A INPUT -i lo -j ACCEPT || true
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true

printf '%s' '${encodedConfig}' | base64 -d > /root/cocalc-restore-drill.json
printf '%s' '${encodedWorker}' | base64 -d > /root/cocalc-restore-worker.py
chmod 600 /root/cocalc-restore-drill.json /root/cocalc-restore-worker.py
python3 /root/cocalc-restore-worker.py
`;
}

async function waitForOperation({
  response,
  project,
  zone,
  operations,
}: {
  response: any;
  project: string;
  zone: string;
  operations: GcpClients["operations"];
}): Promise<void> {
  let operation = response?.latestResponse ?? response;
  if (!operation?.name) return;
  while (`${operation.status ?? ""}` !== "DONE") {
    [operation] = await operations.wait({
      operation: operation.name,
      project,
      zone,
    });
  }
  const errors = Array.isArray(operation?.error?.errors)
    ? operation.error.errors
    : [];
  if (errors.length) {
    throw new Error(
      errors
        .map((entry: any) => `${entry?.code ?? ""}: ${entry?.message ?? ""}`)
        .join("; "),
    );
  }
}

function isNotFound(err: unknown): boolean {
  const value = err as any;
  return (
    value?.code === 404 ||
    value?.code === 5 ||
    /not found/i.test(`${value?.message ?? ""}`)
  );
}

function parseWorkerResult({
  contents,
  nonce,
}: {
  contents: string;
  nonce: string;
}): DisposableRestoreWorkerResult | undefined {
  const marker = `${RESULT_PREFIX}${nonce}=`;
  const index = contents.lastIndexOf(marker);
  if (index < 0) return;
  const payloadStart = index + marker.length;
  const payloadEnd = contents.indexOf("\n", payloadStart);
  // Serial output is chunked arbitrarily. Do not decode a marker until its
  // newline terminator proves that the complete base64 payload has arrived.
  if (payloadEnd < 0) return;
  const encoded = contents.slice(payloadStart, payloadEnd).trim();
  if (!encoded) return;
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  ) as DisposableRestoreWorkerResult;
  if (parsed.version !== 1 || !parsed.run_id || !parsed.status) {
    throw new Error("invalid disposable restore worker result");
  }
  return parsed;
}

function defaultClients(auth: GcpAuth): GcpClients {
  return {
    instances: new InstancesClient(auth),
    operations: new ZoneOperationsClient(auth),
  };
}

export async function runDisposableGcpRestoreWorker({
  service_account_json,
  zone,
  machine_type = "n2-standard-4",
  boot_disk_gb,
  config,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  clients: providedClients,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  service_account_json: string;
  zone: string;
  machine_type?: string;
  boot_disk_gb: number;
  config: DisposableRestoreWorkerConfig;
  timeout_ms?: number;
  clients?: GcpClients;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DisposableGcpRestoreResult> {
  const auth = parseGcpServiceAccount(service_account_json);
  const clients = providedClients ?? defaultClients(auth);
  const instance_name = disposableRestoreInstanceName(config.run_id);
  const region = zone.replace(/-[a-z]$/, "");
  const startupScript = buildDisposableRestoreStartupScript({
    ...config,
    worker_timeout_seconds: Math.ceil(timeout_ms / 1000),
  });
  const timeoutSeconds = Math.max(900, Math.ceil(timeout_ms / 1000) + 600);
  let created = false;
  let cleanup: DisposableGcpRestoreResult["cleanup"] = "already-deleted";
  let result: DisposableGcpRestoreResult | undefined;
  let runError: unknown;
  try {
    // The insert may succeed server-side even if the client times out. From this
    // point onward, always attempt deletion by the deterministic instance name.
    created = true;
    const [insertResponse] = await clients.instances.insert({
      project: auth.projectId,
      zone,
      instanceResource: {
        name: instance_name,
        machineType: `zones/${zone}/machineTypes/${machine_type}`,
        canIpForward: false,
        deletionProtection: false,
        disks: [
          {
            autoDelete: true,
            boot: true,
            initializeParams: {
              diskSizeGb: `${boot_disk_gb}`,
              diskType: `projects/${auth.projectId}/zones/${zone}/diskTypes/pd-balanced`,
              sourceImage:
                "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
            },
          },
        ],
        labels: {
          "cocalc-role": "bay-restore-drill",
          "cocalc-bay": config.bay_id
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .slice(0, 63),
        },
        metadata: {
          items: [
            { key: "startup-script", value: startupScript },
            { key: "serial-port-enable", value: "TRUE" },
            { key: "block-project-ssh-keys", value: "TRUE" },
            { key: "enable-oslogin", value: "FALSE" },
          ],
        },
        networkInterfaces: [
          {
            accessConfigs: [{ name: "External NAT", networkTier: "STANDARD" }],
            stackType: "IPV4_ONLY",
            subnetwork: `projects/${auth.projectId}/regions/${region}/subnetworks/default`,
          },
        ],
        scheduling: {
          automaticRestart: false,
          onHostMaintenance: "TERMINATE",
          preemptible: false,
          provisioningModel: "STANDARD",
          maxRunDuration: { seconds: `${timeoutSeconds}` },
          instanceTerminationAction: "DELETE",
        },
        serviceAccounts: [],
        shieldedInstanceConfig: {
          enableIntegrityMonitoring: true,
          enableSecureBoot: true,
          enableVtpm: true,
        },
      },
    } as any);
    await waitForOperation({
      response: insertResponse,
      project: auth.projectId,
      zone,
      operations: clients.operations,
    });
    logger.info("created disposable GCP restore drill worker", {
      instance_name,
      project_id: auth.projectId,
      zone,
      machine_type,
      boot_disk_gb,
      run_id: config.run_id,
    });

    const deadline = Date.now() + timeout_ms;
    let cursor = "0";
    let serial = "";
    while (Date.now() < deadline) {
      try {
        const [output] = await clients.instances.getSerialPortOutput({
          project: auth.projectId,
          zone,
          instance: instance_name,
          port: 1,
          start: cursor,
        } as any);
        const contents = `${(output as any)?.contents ?? ""}`;
        cursor = `${(output as any)?.next ?? cursor}`;
        if (contents) {
          serial = `${serial}${contents}`.slice(-256 * 1024);
          const worker = parseWorkerResult({
            contents: serial,
            nonce: config.result_nonce,
          });
          if (worker) {
            if (worker.run_id !== config.run_id) {
              throw new Error("restore worker result run_id mismatch");
            }
            result = {
              worker,
              instance_name,
              project_id: auth.projectId,
              zone,
              machine_type,
              boot_disk_gb,
              cleanup: "deleted",
            };
            break;
          }
        }
      } catch (err) {
        if (isNotFound(err)) {
          throw new Error(
            "disposable restore VM disappeared before reporting a result",
          );
        }
        throw err;
      }
      if (result) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!result) {
      throw new Error(
        `disposable restore VM timed out after ${Math.round(timeout_ms / 1000)} seconds`,
      );
    }
  } catch (err) {
    runError = err;
  }

  let cleanupError: unknown;
  if (created) {
    try {
      const [deleteResponse] = await clients.instances.delete({
        project: auth.projectId,
        zone,
        instance: instance_name,
      });
      await waitForOperation({
        response: deleteResponse,
        project: auth.projectId,
        zone,
        operations: clients.operations,
      });
      cleanup = "deleted";
    } catch (err) {
      if (!isNotFound(err)) {
        cleanupError = err;
        logger.error("failed deleting disposable GCP restore drill worker", {
          instance_name,
          project_id: auth.projectId,
          zone,
          err,
        });
      }
    }
  }
  logger.info("disposed GCP restore drill worker", {
    instance_name,
    project_id: auth.projectId,
    zone,
    cleanup,
  });
  if (cleanupError) throw cleanupError;
  if (runError) throw runError;
  if (!result) throw new Error("disposable restore worker returned no result");
  result.cleanup = cleanup;
  return result;
}

export function newDisposableRestoreWorkerIdentity(): {
  run_id: string;
  result_nonce: string;
} {
  return {
    run_id: randomUUID(),
    result_nonce: randomBytes(16).toString("hex"),
  };
}
