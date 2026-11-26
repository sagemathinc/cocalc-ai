def apt_update_install(cfg: BootstrapConfig) -> None:
    reconcile_gce_ubuntu_apt_sources(cfg)
    log_line(cfg, "bootstrap: updating apt package lists")
    apt_opts = [
        "-y",
        "-o",
        "Acquire::ForceIPv4=true",
        "-o",
        f"Acquire::Retries={APT_RETRIES}",
        "-o",
        f"Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S}",
    ]
    apt_run(
        cfg,
        ["apt-get", *apt_opts, "update"],
        "apt-get update",
        retries=APT_RETRIES,
        timeout=APT_UPDATE_TIMEOUT_S,
    )
    log_line(cfg, "bootstrap: installing base packages")
    apt_install_opts = (
        apt_opts
        + ["--no-install-recommends", "install"]
        + effective_apt_packages(cfg)
    )
    apt_run(
        cfg,
        ["apt-get", *apt_install_opts],
        "apt-get install",
        retries=APT_RETRIES,
        timeout=APT_INSTALL_TIMEOUT_S,
    )


def ensure_automatic_security_updates(
    cfg: BootstrapConfig,
    *,
    config_path: Path = Path("/etc/apt/apt.conf.d/52cocalc-periodic"),
    helper_path: Path = Path("/usr/local/sbin/cocalc-security-update"),
    service_path: Path = Path(
        "/etc/systemd/system/cocalc-security-updates.service"
    ),
    timer_path: Path = Path("/etc/systemd/system/cocalc-security-updates.timer"),
    status_dir: Path = Path("/var/lib/cocalc/security-updates"),
) -> None:
    log_line(cfg, "bootstrap: configuring automatic security updates")
    reconcile_gce_ubuntu_apt_sources(cfg)
    apt_opts = [
        "-y",
        "-o",
        "Acquire::ForceIPv4=true",
        "-o",
        f"Acquire::Retries={APT_RETRIES}",
        "-o",
        f"Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S}",
    ]
    apt_run(
        cfg,
        ["apt-get", *apt_opts, "update"],
        "apt-get update for automatic security updates",
        retries=APT_RETRIES,
        timeout=APT_UPDATE_TIMEOUT_S,
    )
    apt_run(
        cfg,
        [
            "apt-get",
            *apt_opts,
            "--no-install-recommends",
            "install",
            "unattended-upgrades",
        ],
        "install unattended-upgrades",
        retries=APT_RETRIES,
        timeout=APT_INSTALL_TIMEOUT_S,
    )
    if shutil.which("unattended-upgrade") is None:
        raise RuntimeError("unattended-upgrade executable is missing after install")
    text_write_atomic(config_path, AUTOMATIC_SECURITY_UPDATES_CONFIG)
    status_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(status_dir, 0o755)
    status_dir_shell = shlex.quote(str(status_dir))
    helper = f"""#!/usr/bin/env bash
set -euo pipefail
umask 022

STATUS_DIR={status_dir_shell}
STATUS_FILE="$STATUS_DIR/status.json"
LOCK_FILE=/run/lock/cocalc-security-updates.lock

mkdir -p "$STATUS_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status() {{
  local result="$1" exit_code="$2" finished_at tmp
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp "$STATUS_DIR/.status.XXXXXX")"
  printf '{{\n  "schema": "cocalc-security-updates-v1",\n  "result": "%s",\n  "exit_code": %s,\n  "started_at": "%s",\n  "finished_at": "%s"\n}}\n' \
    "$result" "$exit_code" "$STARTED_AT" "$finished_at" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}}
record_failure() {{
  local exit_code="$?"
  set +e
  write_status failed "$exit_code"
}}
trap record_failure EXIT

write_status running 0
export DEBIAN_FRONTEND=noninteractive
apt-get -y \
  -o Acquire::ForceIPv4=true \
  -o Acquire::Retries={APT_RETRIES} \
  -o Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S} \
  update
unattended-upgrade --verbose
write_status ok 0
trap - EXIT
"""
    text_write_atomic(helper_path, helper, default_mode=0o755)
    os.chmod(helper_path, 0o755)
    service = f"""[Unit]
Description=Install CoCalc project-host security updates
Wants=network-online.target
After=network-online.target
ConditionPathIsExecutable={helper_path}

[Service]
Type=oneshot
ExecStart={helper_path}
TimeoutStartSec=45min
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=10
IOWeight=10
UMask=0022
"""
    timer = """[Unit]
Description=Daily CoCalc project-host security updates

[Timer]
OnCalendar=*-*-* 05:00:00 UTC
RandomizedDelaySec=3h
FixedRandomDelay=true
Persistent=true
AccuracySec=1min
Unit=cocalc-security-updates.service

[Install]
WantedBy=timers.target
"""
    text_write_atomic(service_path, service)
    text_write_atomic(timer_path, timer)
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd security update units",
        timeout=30,
    )
    run_cmd(
        cfg,
        [
            "systemctl",
            "disable",
            "--now",
            "apt-daily.timer",
            "apt-daily-upgrade.timer",
        ],
        "disable distro automatic apt timers",
        timeout=APT_LOCK_TIMEOUT_S,
    )
    run_cmd(
        cfg,
        [
            "systemctl",
            "enable",
            "--now",
            "cocalc-security-updates.timer",
        ],
        "enable managed security update timer",
        timeout=APT_LOCK_TIMEOUT_S,
    )
    for timer in ("cocalc-security-updates.timer",):
        run_cmd(
            cfg,
            ["systemctl", "is-enabled", timer],
            f"verify {timer} enabled",
            timeout=30,
        )
        run_cmd(
            cfg,
            ["systemctl", "is-active", timer],
            f"verify {timer} active",
            timeout=30,
        )


def node_major_version(node_version: str) -> int:
    match = re.match(r"^v?(\d+)(?:\.|$)", node_version.strip())
    if not match:
        return 0
    return int(match.group(1))


def effective_apt_packages(cfg: BootstrapConfig) -> list[str]:
    packages = list(cfg.apt_packages)
    if node_major_version(cfg.node_version) >= 26:
        existing = set(packages)
        for package in NODE_RUNTIME_APT_PACKAGES:
            if package not in existing:
                packages.append(package)
                existing.add(package)
    return packages


def configure_chrony(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring time sync")
    run_best_effort(cfg, ["systemctl", "disable", "--now", "systemd-timesyncd"], "disable timesyncd")
    run_best_effort(cfg, ["systemctl", "enable", "--now", "chrony"], "enable chrony")
    chrony_conf = "pool pool.ntp.org iburst maxsources 4\nmakestep 1.0 -1\nrtcsync\n"
    Path("/etc/chrony/chrony.conf").write_text(chrony_conf, encoding="utf-8")
    run_best_effort(cfg, ["systemctl", "restart", "chrony"], "restart chrony")


def configure_journald_limits(
    cfg: BootstrapConfig,
    *,
    dropin_dir: Path = Path("/etc/systemd/journald.conf.d"),
) -> None:
    if shutil.which("systemctl") is None:
        return
    log_line(cfg, "bootstrap: configuring journald disk limits")
    dropin_dir.mkdir(parents=True, exist_ok=True)
    dropin = dropin_dir / "90-cocalc-root-disk.conf"
    content = "[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=100M\n"
    try:
        changed = dropin.read_text(encoding="utf-8") != content
    except OSError:
        changed = True
    if not changed:
        log_line(cfg, "bootstrap: journald disk limits already current")
        return
    dropin.write_text(content, encoding="utf-8")
    run_best_effort(
        cfg,
        ["systemctl", "restart", "--no-block", "systemd-journald"],
        "queue systemd-journald restart",
        timeout=15,
    )
    if shutil.which("journalctl") is not None:
        run_best_effort(
            cfg,
            ["journalctl", "--vacuum-size=200M"],
            "vacuum systemd journal",
            timeout=60,
        )


def configure_daily_root_cleanup(
    cfg: BootstrapConfig,
    *,
    helper_path: Path = Path("/usr/local/sbin/cocalc-root-cleanup"),
    service_path: Path = Path(
        "/etc/systemd/system/cocalc-root-cleanup.service"
    ),
    timer_path: Path = Path("/etc/systemd/system/cocalc-root-cleanup.timer"),
    status_dir: Path = Path("/var/lib/cocalc/root-cleanup"),
) -> None:
    log_line(cfg, "bootstrap: configuring daily safe root cleanup")
    if status_dir.is_symlink():
        raise RuntimeError(
            f"root cleanup status directory is a symlink: {status_dir}"
        )
    status_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(status_dir, 0o755)
    helper = f"""#!/usr/bin/env bash
set -uo pipefail
umask 022

STATUS_DIR={shlex.quote(str(status_dir))}
STATUS_FILE="$STATUS_DIR/status.json"
LOCK_FILE="$STATUS_DIR/cleanup.lock"
MIN_FREE_BYTES=$((5 * 1024 * 1024 * 1024))
DRY_RUN=0

case "${{1:-}}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

mkdir -p "$STATUS_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

dir_bytes() {{
  local total=0 path value
  for path in "$@"; do
    [ -e "$path" ] || continue
    value="$(du -sx -B1 -- "$path" 2>/dev/null | cut -f1)"
    if echo "$value" | grep -Eq '^[0-9]+$'; then
      total=$((total + value))
    fi
  done
  echo "$total"
}}

freed_bytes() {{
  local before="$1" after="$2"
  if [ "$before" -gt "$after" ]; then
    echo $((before - after))
  else
    echo 0
  fi
}}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ROOT_FREE_BEFORE="$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')"
SNAP_BEFORE="$(dir_bytes /var/lib/snapd/cache)"
APT_BEFORE="$(dir_bytes /var/cache/apt)"
JOURNAL_BEFORE="$(dir_bytes /var/log/journal /run/log/journal)"
RUSTIC_BEFORE="$(dir_bytes /root/.cache/rustic)"

# Every path below is an explicit cache or bounded log location. Do not add
# release directories or project data without a separate retention design.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -d /var/lib/snapd/cache ] && [ ! -L /var/lib/snapd/cache ]; then
    find /var/lib/snapd/cache -xdev -type f -delete 2>/dev/null || true
  fi
  if command -v apt-get >/dev/null 2>&1; then
    flock -n /run/lock/cocalc-security-updates.lock \
      timeout 10m apt-get clean >/dev/null 2>&1 || true
  fi
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  fi
  if [ -d /root/.cache/rustic ] && [ ! -L /root/.cache/rustic ]; then
    flock -n /run/lock/cocalc-privileged-rustic-cache.lock \
      bash -c 'if ! pgrep -x rustic >/dev/null 2>&1; then
        find /root/.cache/rustic -mindepth 1 -maxdepth 1 \
          ! -name CACHEDIR.TAG -exec rm -rf --one-file-system -- {{}} +
      fi' >/dev/null 2>&1 || true
  fi
fi

SNAP_AFTER="$(dir_bytes /var/lib/snapd/cache)"
APT_AFTER="$(dir_bytes /var/cache/apt)"
JOURNAL_AFTER="$(dir_bytes /var/log/journal /run/log/journal)"
RUSTIC_AFTER="$(dir_bytes /root/.cache/rustic)"
ROOT_FREE_AFTER="$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')"
RESULT=ok
if [ "$DRY_RUN" -eq 1 ]; then
  RESULT=dry-run
elif ! echo "$ROOT_FREE_AFTER" | grep -Eq '^[0-9]+$' || \
   [ "$ROOT_FREE_AFTER" -lt "$MIN_FREE_BYTES" ]; then
  RESULT=insufficient
fi
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp "$STATUS_DIR/.status.XXXXXX")"
printf '{{\n  "schema": "cocalc-root-cleanup-v1",\n  "result": "%s",\n  "started_at": "%s",\n  "finished_at": "%s",\n  "root_free_before_bytes": %s,\n  "root_free_after_bytes": %s,\n  "snap_freed_bytes": %s,\n  "apt_freed_bytes": %s,\n  "journal_freed_bytes": %s,\n  "privileged_rustic_freed_bytes": %s\n}}\n' \
  "$RESULT" "$STARTED_AT" "$FINISHED_AT" \
  "${{ROOT_FREE_BEFORE:-0}}" "${{ROOT_FREE_AFTER:-0}}" \
  "$(freed_bytes "$SNAP_BEFORE" "$SNAP_AFTER")" \
  "$(freed_bytes "$APT_BEFORE" "$APT_AFTER")" \
  "$(freed_bytes "$JOURNAL_BEFORE" "$JOURNAL_AFTER")" \
  "$(freed_bytes "$RUSTIC_BEFORE" "$RUSTIC_AFTER")" >"$TMP"
chmod 0644 "$TMP"
mv -f "$TMP" "$STATUS_FILE"
logger -t cocalc-root-cleanup \
  "result=$RESULT root_free_before=${{ROOT_FREE_BEFORE:-unknown}} root_free_after=${{ROOT_FREE_AFTER:-unknown}}"
"""
    text_write_atomic(helper_path, helper, default_mode=0o755)
    os.chmod(helper_path, 0o755)
    service = f"""[Unit]
Description=Reclaim safe CoCalc project-host root caches
ConditionPathIsExecutable={helper_path}

[Service]
Type=oneshot
ExecStart={helper_path}
TimeoutStartSec=30min
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=5
IOWeight=5
UMask=0022
"""
    timer = """[Unit]
Description=Daily safe CoCalc project-host root cleanup

[Timer]
OnCalendar=*-*-* 10:00:00 UTC
RandomizedDelaySec=2h
FixedRandomDelay=true
Persistent=true
AccuracySec=5min
Unit=cocalc-root-cleanup.service

[Install]
WantedBy=timers.target
"""
    text_write_atomic(service_path, service)
    text_write_atomic(timer_path, timer)
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd root cleanup units",
        timeout=30,
    )
    run_cmd(
        cfg,
        ["systemctl", "enable", "--now", "cocalc-root-cleanup.timer"],
        "enable safe root cleanup timer",
        timeout=30,
    )
    for check in ("is-enabled", "is-active"):
        run_cmd(
            cfg,
            ["systemctl", check, "cocalc-root-cleanup.timer"],
            f"verify root cleanup timer {check}",
            timeout=30,
        )


HOST_INTEGRITY_WATCH_SCRIPT = r'''
@@bootstrap-include embedded/host-integrity-watch.py@@
'''


