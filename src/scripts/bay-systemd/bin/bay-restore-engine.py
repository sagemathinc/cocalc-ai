#!/usr/bin/env python3
# CoCalc bay restore engine.
#
# One program restores a bay's PostgreSQL (pgBackRest, point in time) and
# Conat SQLite (rustic) from R2, for both callers, so the weekly drill
# rehearses exactly what a production restore runs:
#
#   execution "disposable-gcp" (default): the restore drill. The bay starts a
#     throwaway GCP VM whose startup script runs this file; it installs tools,
#     restores, proves the PITR target with sentinel rows, reports on the
#     serial console and the VM is deleted.
#   execution "local": a production restore on a bay host, run as root by
#     bay-restore. It restores into a fresh work directory next to the live
#     data with the host's own binaries, recovers PostgreSQL (to a target time
#     or the end of the WAL archive), verifies, shuts it down cleanly and
#     writes a result file. bay-restore then swaps the directories into place.
#
# Usage: bay-restore-engine.py [--config FILE]
import base64
import datetime
import glob
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

RESULT_PREFIX = "COCALC_BAY_RESTORE_DRILL_RESULT_V1_"

def config_path():
    if "--config" in sys.argv:
        return sys.argv[sys.argv.index("--config") + 1]
    return os.environ.get("COCALC_BAY_RESTORE_CONFIG", "/root/cocalc-restore-drill.json")

CONFIG_PATH = config_path()
with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
    CONFIG = json.load(handle)
EXECUTION = CONFIG.get("execution", "disposable-gcp")
if EXECUTION not in ("disposable-gcp", "local"):
    raise SystemExit(f"unknown restore execution: {EXECUTION}")
LOCAL = EXECUTION == "local"
ROOT = pathlib.Path(CONFIG.get("work_dir") or "/var/lib/cocalc-restore-drill")
# Where the Conat SQLite snapshot is restored (and, in the drill, PostgreSQL
# below it). A production restore keeps the bay's layout: work/sync and
# work/postgres, swapped into place by bay-restore.
SNAPSHOT = ROOT / ("sync" if LOCAL else "snapshot")
PGBACKREST_BIN = CONFIG.get("pgbackrest_bin") or "/usr/local/bin/pgbackrest"
RUSTIC_BIN = CONFIG.get("rustic_bin") or "rustic"
STARTED = time.time()
STAGE = "bootstrap"
# Seconds spent in each stage, reported with the result so a slow drill shows
# where its time went.
STAGE_SECONDS = {}
_STAGE_ENTERED = time.time()

def enter_stage(name):
    global _STAGE_ENTERED
    now = time.time()
    STAGE_SECONDS[STAGE] = round(STAGE_SECONDS.get(STAGE, 0) + now - _STAGE_ENTERED, 1)
    print(f"restore-drill: stage {STAGE} took {int(now - _STAGE_ENTERED)}s", flush=True)
    _STAGE_ENTERED = now
    return name

def stage_seconds():
    seconds = dict(STAGE_SECONDS)
    seconds[STAGE] = round(seconds.get(STAGE, 0) + time.time() - _STAGE_ENTERED, 1)
    return seconds

REPOSITORY_TYPE = CONFIG.get("repository_type", "legacy-rustic")
if LOCAL and REPOSITORY_TYPE != "pgbackrest":
    raise SystemExit("production restores support pgBackRest repositories only")
ARCHIVE_GET_TIMEOUT_SECONDS = max(30, int(CONFIG.get("archive_get_timeout_seconds", 120)))
ARCHIVE_GET_ATTEMPTS = max(1, min(5, int(CONFIG.get("archive_get_attempts", 3))))
PGBACKREST_PROCESS_MAX = max(2, min(16, 2 * (os.cpu_count() or 1)))
# A quarter of the worker's memory, the usual PostgreSQL guidance.
POSTGRES_SHARED_BUFFERS_MB = max(128, min(16384, (
    os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // (4 * 1024 * 1024)
)))
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
        "stage_seconds": stage_seconds(),
    }
    if error:
        result["error"] = bounded(error)
    if postgres is not None:
        result["postgres"] = postgres
    if conat is not None:
        result["conat"] = conat
    if disk is not None:
        result["disk"] = disk
    if LOCAL:
        path = pathlib.Path(CONFIG["result_path"])
        path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        print("restore-engine: result " + json.dumps(
            {"status": status, "stage": STAGE, "error": result.get("error")}
        ), flush=True)
        return
    encoded = base64.b64encode(json.dumps(result, separators=(",", ":")).encode()).decode()
    marker = RESULT_PREFIX + CONFIG["result_nonce"] + "=" + encoded
    with open("/dev/ttyS0", "w", encoding="utf-8") as serial:
        serial.write("\n" + marker + "\n")
        serial.flush()

def run(args, *, timeout=1800, env=None, capture=False, input_text=None, log=True):
    if log:
        print("restore-drill:", " ".join(str(arg) for arg in args[:4]), flush=True)
    try:
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
    except subprocess.CalledProcessError as err:
        # Name the program and what it said, not just its exit status.
        detail = (err.stderr or err.stdout or "").strip()
        raise RuntimeError(
            f"{' '.join(str(arg) for arg in args[:6])} exited with status {err.returncode}"
            + (f": {bounded(detail, 1500)}" if detail else "")
        ) from None

QUICK_CHECK_WORKERS = max(2, min(16, 2 * (os.cpu_count() or 1)))

def sqlite_quick_check(path, timeout=120):
    """PRAGMA quick_check on a read-only connection, like sqlite3 -readonly."""
    deadline = time.monotonic() + timeout
    try:
        connection = sqlite3.connect(
            pathlib.Path(path).as_uri() + "?mode=ro", uri=True, timeout=5,
            check_same_thread=False,
        )
    except sqlite3.Error as err:
        return "open failed: " + bounded(err, 300)
    try:
        # Interrupt a check that runs past its deadline, like the old per-file
        # process timeout.
        connection.set_progress_handler(
            lambda: 1 if time.monotonic() > deadline else 0, 100000,
        )
        rows = connection.execute("PRAGMA quick_check;").fetchall()
        return "\n".join(str(row[0]) for row in rows)
    except sqlite3.Error as err:
        return "check failed: " + bounded(err, 300)
    finally:
        connection.close()

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
        "PGBACKREST_REPO1_CIPHER_PASS": CONFIG["pgbackrest_cipher_pass"],
    })
    # The drill uses temporary credentials; a production restore uses the
    # bay's own keys, and pgBackRest rejects an empty token.
    if CONFIG.get("r2_session_token"):
        env["PGBACKREST_REPO1_S3_TOKEN"] = CONFIG["r2_session_token"]
    return env

# A production restore runs the host's PostgreSQL as the bay user on a private
# socket and port, never touching the live cluster's socket or port.
LOCAL_RUN_DIR = ROOT / "run"
LOCAL_POSTGRES_LOG = ROOT / "postgres.log"
LOCAL_ARCHIVE_GET_STATE = LOCAL_RUN_DIR / "archive-get.state"
LOCAL_POSTGRES = None
LOCAL_PG_BIN = None

def as_bay_user(args):
    """Run as the bay's PostgreSQL user, keeping the environment."""
    return [
        "setpriv", "--reuid", CONFIG["bay_user"], "--regid", CONFIG["bay_group"],
        "--init-groups", "--", *[str(arg) for arg in args],
    ]

def psql(container, sql, *, log=True):
    if LOCAL:
        completed = run(as_bay_user([
            LOCAL_PG_BIN / "psql", "-X", "-h", LOCAL_RUN_DIR,
            "-p", str(CONFIG["local_port"]),
            "-U", CONFIG["postgres_user"], "-d", CONFIG["postgres_database"],
            "-tAc", sql,
        ]), timeout=60, capture=True, log=log)
        return completed.stdout.strip()
    completed = run([
        "podman", "exec", container, "psql", "-h", "/tmp",
        "-p", "5432",
        "-U", CONFIG["postgres_user"], "-d", CONFIG["postgres_database"],
        "-tAc", sql,
    ], timeout=60, capture=True, log=log)
    return completed.stdout.strip()

def postgres_running(container):
    if LOCAL:
        return LOCAL_POSTGRES is not None and LOCAL_POSTGRES.poll() is None
    inspected = subprocess.run(
        ["podman", "inspect", "--format={{.State.Running}}", container],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return inspected.returncode == 0 and inspected.stdout.strip() == "true"

def postgres_log_text(container):
    if LOCAL:
        try:
            return "\n".join(LOCAL_POSTGRES_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-400:])
        except OSError as err:
            return f"[postgres log unavailable: {err}]"
    logs = run(["podman", "logs", "--tail", "80", container], timeout=60, capture=True)
    return logs.stdout + "\n" + logs.stderr

def postgres_diagnostics(container):
    noisy = (
        "FATAL:  the database system is starting up",
        "FATAL:  the database system is in recovery mode",
    )
    lines = postgres_log_text(container).splitlines()
    filtered = [line for line in lines if not any(value in line for value in noisy)]
    suppressed = len(lines) - len(filtered)
    suffix = f"\n[suppressed {suppressed} repeated readiness failures]" if suppressed else ""
    return bounded("\n".join(filtered[-80:]) + suffix, 3000)

def archive_get_state(container):
    if LOCAL:
        try:
            text = LOCAL_ARCHIVE_GET_STATE.read_text(encoding="utf-8")
        except OSError:
            return None
    else:
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
        text = completed.stdout
    state = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            state[key] = value
    return state or None

def parse_time(value):
    """ISO or pgBackRest time ("2026-10-08 03:00:00+00") as an aware datetime."""
    text = str(value).strip().replace(" ", "T", 1)
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)  # rustic reports nanoseconds
    if re.search(r"[+-]\d\d$", text):
        text += ":00"
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f"time without a zone: {value}")
    return parsed

def choose_sqlite_snapshot(snapshot_groups, target_time=None):
    """The newest snapshot at or before the target (or the newest overall)."""
    target = parse_time(target_time) if target_time else None
    best = None
    for group in snapshot_groups:
        for snapshot in group.get("snapshots", []):
            when = parse_time(snapshot["time"])
            if target is not None and when > target:
                continue
            if best is None or when > best[0]:
                best = (when, snapshot["id"])
    if best is None:
        raise RuntimeError(
            "no Conat SQLite snapshot exists" + (f" at or before {target_time}" if target_time else "")
        )
    return best[1], best[0].isoformat()

def write_rustic_profile(profile):
    lines = [
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
    ]
    if CONFIG.get("r2_session_token"):
        lines.append("session_token = " + toml_string(CONFIG["r2_session_token"]))
    profile.write_text("\n".join(lines + [""]), encoding="utf-8")
    os.chmod(profile, 0o600)

def write_pgbackrest_config(path, *, pg1_path, spool_path, lock_path=None):
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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join([
        "[global]",
        "repo1-type=s3",
        "repo1-path=" + CONFIG["pgbackrest_repo_path"],
        "repo1-s3-bucket=" + CONFIG["r2_bucket"],
        "repo1-s3-endpoint=" + endpoint,
        "repo1-s3-region=auto",
        "repo1-s3-uri-style=path",
        "repo1-cipher-type=aes-256-cbc",
        # Parallel transfers for the base restore and for WAL prefetch.
        "process-max=" + str(PGBACKREST_PROCESS_MAX),
        # Fetching each WAL segment only when PostgreSQL asks for it made
        # replay wait about a second on R2 per 16 MB segment. Asynchronous
        # archive-get prefetches the following segments in parallel into
        # the spool; the per-segment wrapper and watchdog are unchanged.
        "archive-async=y",
        "archive-get-queue-max=1GiB",
        "spool-path=" + str(spool_path),
        *(["lock-path=" + str(lock_path)] if lock_path else []),
        "log-level-file=off",
        "io-timeout=" + str(io_timeout),
        "db-timeout=" + str(db_timeout),
        "protocol-timeout=" + str(protocol_timeout),
        "log-level-console=info",
        "",
        "[" + CONFIG["pgbackrest_stanza"] + "]",
        "pg1-path=" + str(pg1_path),
        "",
    ]), encoding="utf-8")
    os.chmod(path, 0o644)

def pgbackrest_backup_size(config_path):
    """Size of the backup set a restore will use (by label or target time)."""
    # pgBackRest refuses to run info as root.
    info = json.loads(run(as_bay_user([
        PGBACKREST_BIN, "--config=" + str(config_path),
        "--stanza=" + CONFIG["pgbackrest_stanza"], "--output=json", "info",
    ]), timeout=600, capture=True, env=pgbackrest_env(), log=False).stdout)
    backups = [backup for stanza in info for backup in stanza.get("backup", [])]
    if not backups:
        raise RuntimeError("the pgBackRest repository has no backups")
    if CONFIG.get("backup_set_id"):
        chosen = [b for b in backups if b.get("label") == CONFIG["backup_set_id"]]
    elif CONFIG.get("target_time"):
        target = parse_time(CONFIG["target_time"]).timestamp()
        chosen = [b for b in backups if b.get("timestamp", {}).get("stop", 0) <= target]
    else:
        chosen = backups
    if not chosen:
        raise RuntimeError("no pgBackRest backup set matches the requested label or target time")
    backup = chosen[-1]
    return backup.get("label"), int(backup.get("info", {}).get("size", 0))

def recovered_to(log_text):
    """What PostgreSQL logged about where recovery stopped."""
    for pattern in (
        r"recovery stopping (?:before|after) [^\n]*",
        r"last completed transaction was at log time [^\n]*",
    ):
        found = re.findall(pattern, log_text)
        if found:
            return found[-1].strip()
    return None

def start_local_postgres(pgdata):
    global LOCAL_POSTGRES
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "PGBACKREST_REPO1_S3_KEY": CONFIG["r2_access_key_id"],
        "PGBACKREST_REPO1_S3_KEY_SECRET": CONFIG["r2_secret_access_key"],
        "PGBACKREST_REPO1_CIPHER_PASS": CONFIG["pgbackrest_cipher_pass"],
        "COCALC_PGBACKREST_BIN": PGBACKREST_BIN,
        "COCALC_PGBACKREST_CONFIG": str(ROOT / "pgbackrest.conf"),
        "COCALC_PGBACKREST_STANZA": CONFIG["pgbackrest_stanza"],
        "COCALC_ARCHIVE_GET_STATE_FILE": str(LOCAL_ARCHIVE_GET_STATE),
        "COCALC_ARCHIVE_GET_TIMEOUT_SECONDS": str(ARCHIVE_GET_TIMEOUT_SECONDS),
        "COCALC_ARCHIVE_GET_ATTEMPTS": str(ARCHIVE_GET_ATTEMPTS),
    }
    if CONFIG.get("r2_session_token"):
        env["PGBACKREST_REPO1_S3_TOKEN"] = CONFIG["r2_session_token"]
    log = open(LOCAL_POSTGRES_LOG, "ab")
    # Production data keeps fsync on. Archiving stays off until bay-restore
    # starts the bay's own PostgreSQL service on the restored cluster.
    LOCAL_POSTGRES = subprocess.Popen(
        as_bay_user([
            LOCAL_PG_BIN / "postgres", "-D", pgdata,
            "-k", LOCAL_RUN_DIR, "-p", str(CONFIG["local_port"]),
            "-c", "listen_addresses=", "-c", "shared_preload_libraries=",
            "-c", "archive_mode=off", "-c", "archive_command=/bin/false",
            "-c", "shared_buffers=" + str(POSTGRES_SHARED_BUFFERS_MB) + "MB",
            "-c", "max_wal_size=16GB",
        ]),
        env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )

def stop_local_postgres(timeout=900):
    """Fast shutdown (SIGINT): a clean checkpoint, then exit."""
    if LOCAL_POSTGRES is None or LOCAL_POSTGRES.poll() is not None:
        return
    LOCAL_POSTGRES.send_signal(signal.SIGINT)
    try:
        LOCAL_POSTGRES.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        LOCAL_POSTGRES.kill()
        LOCAL_POSTGRES.wait()
        raise RuntimeError("restored PostgreSQL did not shut down cleanly")

def strip_recovery_settings(text):
    """postgresql.auto.conf without what pgBackRest and this engine added."""
    kept = []
    skipping = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# cocalc disposable restore drill") or stripped.startswith("# cocalc bay restore"):
            skipping = True
            continue
        if skipping and stripped and not stripped.startswith("#"):
            if re.match(r"(archive_mode|archive_command|restore_command)\s*=", stripped):
                continue
            skipping = False
        if re.match(r"(restore_command|recovery_target\w*|recovery_end_command)\s*=", stripped):
            continue
        if stripped.startswith("# Recovery settings generated by pgBackRest"):
            continue
        kept.append(line)
    return "\n".join(kept).rstrip("\n") + "\n"

postgres_result = None
conat_result = None
disk_result = None
container = "cocalc-bay-restore-drill"

def install_drill_tools():
    """Disposable drill VM: install podman, rustic and a verified pgBackRest."""
    global STAGE
    STAGE = enter_stage("install-tools")
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
        STAGE = enter_stage("build-pgbackrest")
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

def local_prepare():
    """Production restore: host tools, an empty work directory, disk space."""
    global STAGE
    STAGE = enter_stage("check-tools")
    run([PGBACKREST_BIN, "version"], timeout=60)
    run([RUSTIC_BIN, "--version"], timeout=60)
    run(["setpriv", "--version"], timeout=60, capture=True)
    for name in ("bay_user", "bay_group", "local_port", "result_path", "postgres_user", "postgres_database"):
        if not CONFIG.get(name):
            raise RuntimeError(f"restore config is missing {name}")
    ROOT.mkdir(parents=True, exist_ok=True)
    # The bay user runs PostgreSQL and the archive-get wrapper below ROOT; no
    # secret is stored in a file it can read.
    os.chmod(ROOT, 0o711)
    for path in (SNAPSHOT, ROOT / "postgres"):
        if path.exists() and any(path.iterdir()):
            raise RuntimeError(f"restore target is not empty: {path}")
    # pgBackRest runs as root for the restore and as the bay user for
    # archive-get during recovery; both need its lock directory.
    for path in (ROOT / "lock", ROOT / "spool", LOCAL_RUN_DIR):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, 0o700)
    run(["chown", f"{CONFIG['bay_user']}:{CONFIG['bay_group']}",
         str(ROOT / "lock"), str(ROOT / "spool"), str(LOCAL_RUN_DIR)], timeout=60)
    write_pgbackrest_config(
        ROOT / "pgbackrest.conf", pg1_path=ROOT / "postgres", spool_path=ROOT / "spool",
        lock_path=ROOT / "lock",
    )
    STAGE = enter_stage("disk-preflight")
    label, size = pgbackrest_backup_size(ROOT / "pgbackrest.conf")
    required = int(size * 1.1) + int(CONFIG.get("sqlite_bytes_estimate", 20 * 1024**3))
    free = shutil.disk_usage(ROOT).free
    if free < required:
        raise RuntimeError(
            f"insufficient disk at {ROOT}: free={free} required~{required} "
            f"(backup {label} is {size} bytes); free space or pass --work-dir on another directory of the same filesystem"
        )
    return label

ARCHIVE_GET_WRAPPER = r'''#!/bin/bash
set -uo pipefail

segment="$1"
destination="$2"
timeout_seconds="${COCALC_ARCHIVE_GET_TIMEOUT_SECONDS:-120}"
max_attempts="${COCALC_ARCHIVE_GET_ATTEMPTS:-3}"
state_file="${COCALC_ARCHIVE_GET_STATE_FILE:-/tmp/cocalc-pgbackrest-archive-get.state}"
pgbackrest="${COCALC_PGBACKREST_BIN:-/usr/local/bin/pgbackrest}"
config="${COCALC_PGBACKREST_CONFIG:-/etc/pgbackrest/pgbackrest.conf}"

write_state() {
  local status="$1"
  local attempt="$2"
  local exit_code="$3"
  local temporary="${state_file}.$$"
  printf 'segment=%s\nstatus=%s\nattempt=%s\nupdated_epoch=%s\nexit_code=%s\n' \
    "$segment" "$status" "$attempt" "$(date +%s)" "$exit_code" > "$temporary"
  mv -f "$temporary" "$state_file"
}

last_exit=1
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  write_state running "$attempt" 0
  echo "restore-drill: archive-get begin segment=$segment attempt=$attempt/$max_attempts timeout_seconds=$timeout_seconds" >&2
  timeout --foreground --signal=TERM --kill-after=10s "$timeout_seconds" \
    "$pgbackrest" \
    --config="$config" \
    --stanza="${COCALC_PGBACKREST_STANZA}" \
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
'''

try:
    if LOCAL:
        local_backup_label = local_prepare()
    else:
        local_backup_label = None
        install_drill_tools()
        STAGE = enter_stage("disk-preflight")
        ROOT.mkdir(parents=True, exist_ok=True)
    usage_before = shutil.disk_usage(ROOT)
    if not LOCAL and usage_before.free < int(CONFIG["minimum_free_bytes"]):
        raise RuntimeError(
            f"insufficient worker disk: free={usage_before.free} required={CONFIG['minimum_free_bytes']}"
        )

    STAGE = enter_stage("restore-rustic")
    profile = (ROOT / "rustic-repo.toml") if LOCAL else pathlib.Path("/root/cocalc-restore-repo.toml")
    write_rustic_profile(profile)
    snapshot_id = CONFIG.get("snapshot_id")
    snapshot_time = None
    if LOCAL and not snapshot_id:
        listed = run([
            RUSTIC_BIN, "-P", str(profile.with_suffix("")), "snapshots", "--json",
        ], timeout=600, capture=True, log=False).stdout
        snapshot_id, snapshot_time = choose_sqlite_snapshot(
            json.loads(listed), CONFIG.get("target_time"),
        )
        print(f"restore-drill: Conat SQLite snapshot {snapshot_id} from {snapshot_time}", flush=True)
    SNAPSHOT.mkdir(parents=True, exist_ok=True)
    run([
        RUSTIC_BIN, "-P", str(profile.with_suffix("")), "restore",
        snapshot_id, str(SNAPSHOT),
    ], timeout=3600)

    STAGE = enter_stage("validate-conat")
    if REPOSITORY_TYPE == "pgbackrest":
        sync_dir = SNAPSHOT
    else:
        sync_dirs = [path for path in SNAPSHOT.glob("**/sync") if path.is_dir()]
        sync_dir = sync_dirs[0] if sync_dirs else None
    db_files = sorted(sync_dir.rglob("*.db")) if sync_dir else []
    database_bytes = sum(path.stat().st_size for path in db_files)
    quick_passed = 0
    if CONFIG.get("sqlite_quick_check", True):
        # Hundreds of thousands of small databases: starting a sqlite3 process for
        # each one dominated this stage. Check them in-process, several at a time
        # (sqlite releases the GIL while it reads).
        with ThreadPoolExecutor(max_workers=QUICK_CHECK_WORKERS) as pool:
            for path, checked in zip(db_files, pool.map(sqlite_quick_check, db_files)):
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
        checked = sqlite_quick_check(catalogs[0])
        # The maintenance catalog is rebuildable and is not authoritative data.
        catalog_status = checked if checked == "ok" else "rebuildable-catalog-check-failed: " + bounded(checked, 500)
    conat_result = {
        "sync_tree_found": sync_dir is not None,
        "database_count": len(db_files),
        "database_bytes": database_bytes,
        "quick_check_passed": quick_passed,
        "quick_check_skipped": not CONFIG.get("sqlite_quick_check", True),
        "catalog_found": bool(catalogs),
        "catalog_quick_check": catalog_status,
        "snapshot_id": snapshot_id,
        "snapshot_time": snapshot_time,
    }
    if CONFIG["require_conat"] and (sync_dir is None or not db_files):
        raise RuntimeError("backup requires Conat validation but no restored .db files were found")

    STAGE = enter_stage("prepare-postgres")
    pgbackrest_config = None
    if REPOSITORY_TYPE == "pgbackrest":
        required = ["pgbackrest_repo_path", "pgbackrest_cipher_pass", "pgbackrest_stanza"]
        if not LOCAL:
            # The drill always proves a point in time with sentinel rows.
            required += ["target_time", "pitr_run_id"]
        missing = [name for name in required if not CONFIG.get(name)]
        if missing:
            raise RuntimeError("pgBackRest PITR config is missing: " + ", ".join(missing))
        if LOCAL:
            pgdata = ROOT / "postgres"
            pgbackrest_config = ROOT / "pgbackrest.conf"
        else:
            pgdata = SNAPSHOT / "postgres" / "base"
            pgbackrest_config = pathlib.Path("/etc/pgbackrest/pgbackrest.conf")
            write_pgbackrest_config(
                pgbackrest_config,
                pg1_path="/var/lib/postgresql/data",
                spool_path="/var/spool/pgbackrest",
            )
        pgdata.mkdir(parents=True, exist_ok=True)
        os.chmod(pgdata, 0o700)
        STAGE = enter_stage("restore-pgbackrest")
        restore_args = [
            PGBACKREST_BIN,
            "--config=" + str(pgbackrest_config),
            "--stanza=" + CONFIG["pgbackrest_stanza"],
            "--pg1-path=" + str(pgdata),
        ]
        if CONFIG.get("backup_set_id"):
            restore_args.append("--set=" + CONFIG["backup_set_id"])
        if CONFIG.get("target_time"):
            restore_args += [
                "--type=time",
                "--target=" + CONFIG["target_time"],
                "--target-action=promote",
            ]
        # Without a target, recovery replays every archived WAL segment and
        # then promotes: the latest state the backups hold.
        run(restore_args + ["restore"], timeout=7200, env=pgbackrest_env())
    if LOCAL:
        pgdata = ROOT / "postgres"
        major = (pgdata / "PG_VERSION").read_text(encoding="utf-8").strip()
        LOCAL_PG_BIN = pathlib.Path(CONFIG.get("postgres_bin_dir") or f"/usr/lib/postgresql/{major}/bin")
        if not (LOCAL_PG_BIN / "postgres").exists():
            raise RuntimeError(f"PostgreSQL {major} is not installed at {LOCAL_PG_BIN}")
    else:
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
    original_hba = hba.read_text(encoding="utf-8")
    hba.write_text("local all all trust\n" + original_hba, encoding="utf-8")
    restore_script = ROOT / "restore-wal.sh"
    restore_script.write_text(r'''#!/bin/bash
set -euo pipefail
segment="$1"
destination="$2"
base="${R2_ENDPOINT%/}/${R2_BUCKET}/${WAL_PREFIX}/${segment}"
common=(--silent --show-error --aws-sigv4 "aws:amz:auto:s3" --user "${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}" -H "x-amz-security-token: ${R2_SESSION_TOKEN}")
if curl "${common[@]}" --fail "${base}.zst" | zstd -dc > "${destination}.tmp"; then
  mv "${destination}.tmp" "$destination"
  exit 0
fi
rm -f "${destination}.tmp"
curl "${common[@]}" --fail "$base" -o "$destination"
''', encoding="utf-8")
    os.chmod(restore_script, 0o700)
    pgbackrest_archive_get_script = ROOT / "cocalc-pgbackrest-archive-get"
    pgbackrest_archive_get_script.write_text(ARCHIVE_GET_WRAPPER, encoding="utf-8")
    # Executed by the PostgreSQL user; it holds no secrets (they are in the
    # server's environment).
    os.chmod(pgbackrest_archive_get_script, 0o755 if LOCAL else 0o700)
    auto_conf = pgdata / "postgresql.auto.conf"
    if REPOSITORY_TYPE == "pgbackrest":
        auto_conf_text = auto_conf.read_text(encoding="utf-8")
        if "restore_command" not in auto_conf_text:
            raise RuntimeError("pgBackRest restore did not configure restore_command")
    with auto_conf.open("a", encoding="utf-8") as handle:
        handle.write("\n# cocalc bay restore\n" if LOCAL else "\n# cocalc disposable restore drill\n")
        handle.write("archive_mode = 'off'\n")
        handle.write("archive_command = '/bin/false'\n")
        if REPOSITORY_TYPE == "pgbackrest":
            # Override pgBackRest's generated command with a bounded wrapper.
            # PostgreSQL retries a nonzero restore_command, while the worker's
            # replay watchdog escalates a repeatedly failing segment.
            if LOCAL:
                handle.write("restore_command = " + sql_quote(str(pgbackrest_archive_get_script) + " %f %p") + "\n")
            else:
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

    if LOCAL:
        owner = f"{CONFIG['bay_user']}:{CONFIG['bay_group']}"
        for path in (LOCAL_RUN_DIR, ROOT / "spool"):
            path.mkdir(parents=True, exist_ok=True)
            os.chmod(path, 0o700)
        run(["chown", "-R", owner, str(pgdata), str(LOCAL_RUN_DIR), str(ROOT / "spool")], timeout=1800)
    else:
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
                # The asynchronous archive-get spool, written by the postgres user.
                "RUN mkdir -p /var/spool/pgbackrest && chown 999:999 /var/spool/pgbackrest",
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
        STAGE = enter_stage("postgres-snapshot-recovery")
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

    STAGE = enter_stage("postgres-" + CONFIG["restore_mode"])
    if LOCAL:
        start_local_postgres(pgdata)
    else:
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
        if CONFIG["restore_mode"] == "pitr":
            # Replay throughput only: the VM is destroyed after validation, and the
            # proof is the pre/post sentinel transactions, not on-disk durability.
            # The image default of 128 MB shared_buffers makes redo of a large
            # database re-read the same pages; restartpoint fsyncs add nothing.
            postgres_args.extend([
                "-c", "shared_buffers=" + str(POSTGRES_SHARED_BUFFERS_MB) + "MB",
                "-c", "fsync=off",
                "-c", "synchronous_commit=off",
                "-c", "max_wal_size=16GB",
            ])
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

    # The drill proves the target with sentinel rows written just before and
    # after it. A production restore has none: it waits for promotion.
    use_sentinels = CONFIG["restore_mode"] == "pitr" and bool(CONFIG.get("pitr_run_id"))
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
            if use_sentinels:
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
            elif CONFIG["restore_mode"] == "pitr":
                if psql(container, "SELECT pg_is_in_recovery()::text", log=False) == "false":
                    postgres_ready = True
                    break
            elif psql(container, "SELECT 1", log=False) == "1":
                postgres_ready = True
                break
        except Exception as err:
            last_error = bounded(err, 1000)
            if not postgres_running(container):
                raise RuntimeError(
                    "PostgreSQL exited before readiness: " +
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
                # PostgreSQL can legitimately fail timeline-history probes,
                # including 00000001.history. They do not measure WAL progress;
                # keep the overall recovery deadline and sentinel checks as the
                # recovery gates instead of timing out on a stale history probe.
                is_wal_segment = re.fullmatch(r"[0-9A-F]{24}", segment or "") is not None
                if status == "succeeded" or not is_wal_segment:
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
    if use_sentinels and counts != (1, 0):
        raise RuntimeError("PITR verification timed out: " + last_error + " logs=" + postgres_diagnostics(container))
    if not postgres_ready:
        raise RuntimeError("PostgreSQL recovery timed out: " + last_error + " logs=" + postgres_diagnostics(container))

    tables = ["accounts", "projects", "server_settings"]
    for table in tables:
        value = psql(container, "SELECT to_regclass('public." + table + "')::text")
        if value != table:
            raise RuntimeError(f"missing restored table {table}")
    if psql(container, "SELECT pg_is_in_recovery()::text") != "false":
        raise RuntimeError("restored PostgreSQL did not promote after PITR target")
    postgres_result = {
        "repository_type": REPOSITORY_TYPE,
        "backup_label": (
            CONFIG.get("backup_set_id") or local_backup_label
        ) if REPOSITORY_TYPE == "pgbackrest" else None,
        "restore_mode": CONFIG["restore_mode"],
        "durability": "fsync-disabled-disposable-validation" if CONFIG["restore_mode"] == "snapshot" else "normal",
        "pitr_verified": use_sentinels,
        "pre_count": counts[0] if counts is not None else None,
        "post_count": counts[1] if counts is not None else None,
        "database": CONFIG["postgres_database"],
        "tables_verified": tables,
        "target_time": CONFIG.get("target_time"),
        "recovered_to": recovered_to(postgres_log_text(container)),
    }

    if LOCAL:
        # Leave a cluster the bay's own service can start: shut down cleanly,
        # then drop the temporary trust rule and the recovery settings.
        STAGE = enter_stage("finalize")
        psql(container, "CHECKPOINT")
        stop_local_postgres()
        hba.write_text(original_hba, encoding="utf-8")
        auto_conf.write_text(strip_recovery_settings(auto_conf.read_text(encoding="utf-8")), encoding="utf-8")
        for stale in ("recovery.signal", "standby.signal"):
            (pgdata / stale).unlink(missing_ok=True)
        state = run([LOCAL_PG_BIN / "pg_controldata", pgdata], timeout=60, capture=True).stdout
        if "Database cluster state:               shut down" not in state:
            raise RuntimeError("restored cluster is not cleanly shut down: " + bounded(state, 800))
        run(["chown", "-R", f"{CONFIG['bay_user']}:{CONFIG['bay_group']}", str(pgdata), str(SNAPSHOT)], timeout=1800)
        postgres_result["cluster_state"] = "shut down"

    STAGE = enter_stage("complete")
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
    if LOCAL:
        try:
            stop_local_postgres(timeout=120)
        except Exception:
            traceback.print_exc()
    else:
        subprocess.run(["podman", "rm", "-f", container], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
