def set_root_node_bind_service_capability(cfg: BootstrapConfig) -> None:
    # NODE_ROOT is root's, so resolving its "current" link is safe; bin/ and the
    # binary are then opened without following a symlink and must be root's own regular,
    # not group/other-writable file, and the capability is set on that
    # descriptor (setcap takes only a path).
    root = NODE_ROOT.resolve()
    release = (NODE_ROOT / "current").resolve()  # only the "current" link is followed
    if not release.is_relative_to(root) or release == root:
        raise RuntimeError("unable to resolve the project-host node binary")
    node_path = release / "bin" / "node"
    dirfd = open_dir_nofollow(str(release / "bin"))
    try:
        try:
            fd = os.open(
                "node",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                dir_fd=dirfd,
            )
        except OSError as err:
            if err.errno == errno.ELOOP:
                raise UnsafeRuntimePath(f"{node_path} is a symlink") from err
            raise
    finally:
        os.close(dirfd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise UnsafeRuntimePath(f"{node_path} is not a regular file")
        if st.st_uid != 0:
            raise UnsafeRuntimePath(f"{node_path} is owned by uid {st.st_uid}")
        if st.st_mode & 0o022:
            raise UnsafeRuntimePath(f"{node_path} is group/other-writable")
        log_line(cfg, f"bootstrap: allow project-host node to bind HTTPS port 443: {node_path}")
        os.setxattr(fd, "security.capability", NODE_BIND_SERVICE_CAPABILITY)
    finally:
        os.close(fd)


def set_nvm_node_bind_service_capability(cfg: BootstrapConfig) -> None:
    # Fallback when the root-owned node isn't installed (the wrapper falls back to nvm too).
    nvm_dir = Path(runtime_home(cfg)) / ".nvm"
    result = run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            f'export NVM_DIR="{nvm_dir}"; . "$NVM_DIR/nvm.sh"; nvm which default',
        ],
        "resolve project-host node binary",
        timeout=120,
        as_user=cfg.ssh_user,
    )
    output_lines = [line.strip() for line in (result.stdout or "").splitlines()]
    node_path = os.path.normpath(output_lines[-1]) if output_lines else ""
    versions_root = str(nvm_dir / "versions" / "node")
    if not node_path.startswith(versions_root + "/"):
        raise RuntimeError("unable to resolve the project-host nvm node binary")
    # The runtime user owns everything under its home, so the binary is opened
    # without following a symlink anywhere on its path, and the capability is
    # set on that descriptor (setcap takes only a path).
    dirfd = open_dir_nofollow(os.path.dirname(node_path))
    try:
        try:
            fd = os.open(
                os.path.basename(node_path),
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                dir_fd=dirfd,
            )
        except OSError as err:
            if err.errno == errno.ELOOP:
                raise UnsafeRuntimePath(f"{node_path} is a symlink") from err
            raise
    finally:
        os.close(dirfd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise UnsafeRuntimePath(f"{node_path} is not a regular file")
        if st.st_uid != pwd.getpwnam(cfg.ssh_user).pw_uid:
            raise UnsafeRuntimePath(f"{node_path} is owned by uid {st.st_uid}")
        log_line(cfg, f"bootstrap: allow project-host node to bind HTTPS port 443: {node_path}")
        os.setxattr(fd, "security.capability", NODE_BIND_SERVICE_CAPABILITY)
    finally:
        os.close(fd)


def write_wrapper(cfg: BootstrapConfig) -> None:
    host_dir = project_host_runtime_root(cfg)
    bundle_root = cfg.project_host_bundle.current
    if not bundle_root:
        bundle_root = str(host_dir / "bundles" / "current")
    bundle_entry = f"{bundle_root}/bundle/index.js"
    runtime_home_dir = runtime_home(cfg)
    node_glob = f'$NVM_DIR/versions/node/v{cfg.node_version}*/bin/node'
    root_node = NODE_ROOT / "current" / "bin" / "node"
    wrapper = f"""#!/usr/bin/env bash
set -euo pipefail
# Node installed and owned by root (bootstrap); nvm only as a fallback.
NODE_BIN="{root_node}"
if [ ! -x "$NODE_BIN" ]; then
  RUNTIME_HOME="{runtime_home_dir}"
  export NVM_DIR="$RUNTIME_HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    nvm use --silent default >/dev/null 2>&1 || true
  fi
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    shopt -s nullglob
    NODE_CANDIDATES=( {node_glob} )
    shopt -u nullglob
    if [ "${{#NODE_CANDIDATES[@]}}" -gt 0 ] && [ -x "${{NODE_CANDIDATES[0]}}" ]; then
      NODE_BIN="${{NODE_CANDIDATES[0]}}"
    else
      echo "node not found for project-host wrapper (looked in {root_node}, PATH and {node_glob})" >&2
      exit 127
    fi
  fi
fi
# project-host serves every project's filesystem API from one process on the
# shared libuv worker pool (default 4). Give it ample headroom so a few slow
# or large native copy/removal operations cannot starve unrelated fs/dns/zlib
# work for other projects. The sandbox layer additionally caps how many native
# async operations run at once. Honor an operator override if already set.
export UV_THREADPOOL_SIZE="${{UV_THREADPOOL_SIZE:-64}}"
exec "$NODE_BIN" "{bundle_entry}" "$@"
"""
    try:
        with runtime_bin_dir(cfg) as bin_fd:
            write_file_at(bin_fd, "project-host", wrapper, 0o755, runtime_file_owner(cfg))
    except UnsafeRuntimePath as err:
        # Skip only this write; the running services are left alone.
        log_line(cfg, f"bootstrap: refusing to write the project-host wrapper: {err}")


def write_helpers(cfg: BootstrapConfig) -> None:
    runtime_root = project_host_runtime_root(cfg)
    rootctl_path = project_host_rootctl_path(cfg)
    core_handler_path = rootctl_path.with_name("cocalc-project-host-core-handler")
    ctl = """
@@bootstrap-include embedded/ctl.sh@@
"""
    ctl = ctl.replace("__RUNTIME_ROOT__", str(runtime_root))
    ctl = ctl.replace("__ROOTCTL__", str(rootctl_path))
    start_ph = """#!/usr/bin/env bash
set -euo pipefail
RUNTIME_ROOT="__RUNTIME_ROOT__"
CTL="$RUNTIME_ROOT/bin/ctl"
WATCHDOG_LOG="/mnt/cocalc/data/logs/project-host-watchdog.log"
for attempt in $(seq 1 60); do
  if mountpoint -q /mnt/cocalc; then
    mkdir -p "$(dirname "$WATCHDOG_LOG")"
    exec >>"$WATCHDOG_LOG" 2>&1
    if [ -x /usr/local/sbin/cocalc-runtime-storage ]; then
      sudo -n /usr/local/sbin/cocalc-runtime-storage grow-btrfs || true
    fi
    exec "$CTL" ensure
  fi
  echo "waiting for /mnt/cocalc mount (attempt $attempt/60)"
  sudo -n /usr/local/sbin/cocalc-mount-data || true
  sleep 5
done
echo "timeout waiting for /mnt/cocalc mount"
exit 1
"""
    logs_script = """#!/usr/bin/env bash
set -euo pipefail
lines="${1:-200}"
log_file="/mnt/cocalc/data/log"
if [ -r "$log_file" ]; then
  exec tail -n "$lines" -f "$log_file"
fi
if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$log_file" >/dev/null 2>&1; then
  exec sudo -n tail -n "$lines" -f "$log_file"
fi
if [ -e "$log_file" ]; then
  echo "project-host log exists but is not readable: $log_file" >&2
else
  echo "project-host log not found at $log_file" >&2
fi
exit 1
"""
    acp_status_script = """
@@bootstrap-include embedded/acp-status.sh.pystr@@
"""
    acp_logs_script = """#!/usr/bin/env bash
set -euo pipefail
data_dir="${DATA:-${COCALC_DATA:-/mnt/cocalc/data}}"
log_file="$data_dir/logs/acp-worker.log"
lines="${1:-80}"
if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "usage: ${0} [lines]" >&2
  exit 1
fi
if [ -f "$log_file" ]; then
  exec tail -n "$lines" -f "$log_file"
fi
echo "ACP worker log not found: $log_file" >&2
exit 1
"""
    logs_cf_script = """#!/usr/bin/env bash
set -euo pipefail
service="cocalc-cloudflared.service"
if ! command -v journalctl >/dev/null 2>&1; then
  echo "journalctl not found" >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/cocalc-cloudflared-ctl status >/dev/null 2>&1; then
  echo "cloudflared service not enabled on this host ($service)" >&2
  exit 1
fi
exec sudo -n /usr/local/sbin/cocalc-cloudflared-logs 200 follow
"""
    ctl_cf_script = """#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
service="cocalc-cloudflared.service"
case "$cmd" in
  start|stop|restart|status)
    exec sudo -n /usr/local/sbin/cocalc-cloudflared-ctl "$cmd"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
"""
    core_handler = """
@@bootstrap-include embedded/core-handler.sh.pystr@@
"""
    core_handler = core_handler.replace("__RUNTIME_USER__", cfg.ssh_user)
    rootctl = """
@@bootstrap-include embedded/rootctl.sh.pystr@@
"""
    start_ph = start_ph.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_USER__", cfg.ssh_user)
    rootctl = rootctl.replace("__BOOTSTRAP_USER__", cfg.bootstrap_user)
    rootctl = rootctl.replace(
        "__BOOTSTRAP_LIFECYCLE_LOCK__", str(bootstrap_lock_path(cfg))
    )
    rootctl = rootctl.replace(
        "__OOM_ADJ_LITERAL__", f"--{abs(HOST_CRITICAL_OOM_SCORE_ADJ)}"
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CGROUP__", DEFAULT_PROJECT_POOL_CGROUP
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_MB__",
        str(DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB),
    )
    rootctl = rootctl.replace(
        "__MIN_PROJECT_POOL_MEMORY_MB__",
        str(MIN_PROJECT_POOL_MEMORY_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_CORES__",
        str(DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_MIN_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_MAX_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_DIVISOR),
    )
    rootctl = rootctl.replace(
        "__MIN_PROJECT_POOL_CPU_CORES__",
        str(MIN_PROJECT_POOL_CPU_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_PERIOD_US__",
        str(PROJECT_POOL_CPU_PERIOD_US),
    )
    rootctl = rootctl.replace("__HELPER_SCHEMA_VERSION__", HELPER_SCHEMA_VERSION)
    rootctl = rootctl.replace(
        "__HOST_INTRUSION_SNAPSHOT_HELPER__", HOST_INTRUSION_SNAPSHOT_HELPER
    )
    runtime_scripts = {
        "ctl": ctl,
        "start-project-host": start_ph,
        "logs": logs_script,
        "acp-status": acp_status_script,
        "acp-logs": acp_logs_script,
        "logs-cf": logs_cf_script,
        "ctl-cf": ctl_cf_script,
    }
    rootctl_path.parent.mkdir(parents=True, exist_ok=True)
    rootctl_path.write_text(rootctl, encoding="utf-8")
    core_handler_path.parent.mkdir(parents=True, exist_ok=True)
    core_handler_path.write_text(core_handler, encoding="utf-8")
    rootctl_path.chmod(0o755)
    core_handler_path.chmod(0o755)

    # The fetch-*.sh tools run bootstrap.py, which is root's: they are admin
    # wrappers only (below), never runtime-owned scripts that root might run.
    bootstrap_dir = Path(cfg.bootstrap_dir)
    bootstrap_py = bootstrap_dir / "bootstrap.py"
    fetch_scripts = {
        f"fetch-{label}.sh": f"""#!/usr/bin/env bash
set -euo pipefail
# bootstrap.py and its state are root's: run as root
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n "$0" "$@"
fi
cd /
exec python3 -I "{bootstrap_py}" --bootstrap-dir "{bootstrap_dir}" --only {only}
"""
        for label, only in (
            ("project-bundle", "project_bundle"),
            ("project-host", "project_host_bundle"),
            ("tools", "tools_bundle"),
        )
    }
    owner = runtime_file_owner(cfg)
    try:
        with runtime_bin_dir(cfg) as bin_fd:
            for name, script in runtime_scripts.items():
                write_file_at(bin_fd, name, script, 0o755, owner)
            for name in fetch_scripts:
                # copies from older bootstraps (runtime-owned)
                try:
                    os.unlink(name, dir_fd=bin_fd)
                except FileNotFoundError:
                    pass
    except UnsafeRuntimePath as err:
        # Skip only these writes; the running services are left alone.
        log_line(cfg, f"bootstrap: refusing to write runtime helper scripts: {err}")

    admin_root = Path(cfg.bootstrap_root)
    if admin_root != runtime_root:
        admin_bin = admin_root / "bin"
        admin_bin.mkdir(parents=True, exist_ok=True)
        for name in [
            "ctl",
            "start-project-host",
            "logs",
            "acp-status",
            "acp-logs",
            "logs-cf",
            "ctl-cf",
        ]:
            script = (
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f'RUNTIME_USER="{cfg.ssh_user}"\n'
                f'RUNTIME_SCRIPT="{runtime_root / "bin" / name}"\n'
                'if [ "$(id -un)" = "$RUNTIME_USER" ]; then\n'
                '  exec "$RUNTIME_SCRIPT" "$@"\n'
                "fi\n"
                "cd /\n"
                'exec sudo -n -u "$RUNTIME_USER" -H "$RUNTIME_SCRIPT" "$@"\n'
            )
            target = admin_bin / name
            target.write_text(script, encoding="utf-8")
            target.chmod(0o755)
        for name, script in fetch_scripts.items():
            target = admin_bin / name
            target.write_text(script, encoding="utf-8")
            target.chmod(0o755)
        if cfg.bootstrap_user and cfg.bootstrap_user != "root":
            admin_paths = [
                admin_bin / "ctl",
                admin_bin / "start-project-host",
                admin_bin / "logs",
                admin_bin / "acp-status",
                admin_bin / "acp-logs",
                admin_bin / "logs-cf",
                admin_bin / "ctl-cf",
                admin_bin / "fetch-project-bundle.sh",
                admin_bin / "fetch-project-host.sh",
                admin_bin / "fetch-tools.sh",
            ]
            chown_paths_best_effort(
                cfg,
                cfg.bootstrap_user,
                [admin_bin, *admin_paths],
                "chown admin helper scripts",
            )


PERSIST_TMPFILES_CONF = "/etc/tmpfiles.d/cocalc-persist.conf"


def persist_tmpfiles_conf(user: str) -> str:
    """tmpfiles.d line for /run/cocalc-persist (finding 028 B-3a)."""
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
        raise ValueError(f"unexpected account name for tmpfiles.d: {user!r}")
    return f"d /run/cocalc-persist 0700 {user} {user} -\n"


def configure_autostart(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring project-host autostart")
    runtime_root = project_host_runtime_root(cfg)
    rootctl = project_host_rootctl_path(cfg)
    watchdog_log = "/mnt/cocalc/data/logs/project-host-watchdog.log"
    watchdog_lock = "/mnt/cocalc/data/tmp/project-host-watchdog.lock"
    watchdog_command = (
        "mkdir -p /mnt/cocalc/data/logs /mnt/cocalc/data/tmp; "
        f"flock -n -E 0 {watchdog_lock} {runtime_root}/bin/ctl ensure "
        f">> {watchdog_log} 2>&1"
    )
    watchdog_service = f"""[Unit]
Description=CoCalc project-host watchdog
After=network-online.target
Wants=network-online.target
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart=/bin/bash -lc "{watchdog_command}"
KillMode=process
# ensure may retry a failed boot preparation (see the rootctl).
TimeoutStartSec=600
"""
    watchdog_timer = """[Unit]
Description=Run CoCalc project-host watchdog every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=15s
Persistent=true
Unit=cocalc-project-host-watchdog.service

[Install]
WantedBy=timers.target
"""
    prepare_service = f"""[Unit]
Description=Prepare CoCalc Podman runtime after boot
After=mnt-cocalc.mount
Before=cocalc-project-host-start.service podman-restart.service
Before=google-startup-scripts.service
Conflicts=podman-restart.service
RequiresMountsFor=/mnt/cocalc

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/
ExecStart={rootctl} prepare-podman-boot
TimeoutStartSec=600
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    boot_service = f"""[Unit]
Description=Start CoCalc project-host after boot
After=network-online.target cocalc-project-host-prepare.service
Wants=network-online.target
Requires=cocalc-project-host-prepare.service
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart={runtime_root}/bin/start-project-host
ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"
TimeoutStartSec=360
TimeoutStopSec=25
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    shutdown_service = f"""[Unit]
Description=Notify CoCalc before project host shutdown
After=network-online.target cocalc-project-host-start.service
Wants=network-online.target
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart=/bin/true
ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"
TimeoutStopSec=25
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/cocalc-project-host-watchdog.service").write_text(
        watchdog_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-watchdog.timer").write_text(
        watchdog_timer, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-prepare.service").write_text(
        prepare_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-start.service").write_text(
        boot_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-shutdown.service").write_text(
        shutdown_service, encoding="utf-8"
    )
    os.chmod("/etc/systemd/system/cocalc-project-host-watchdog.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-watchdog.timer", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-prepare.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-start.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-shutdown.service", 0o644)
    # The persist server's durability records (finding 028): a per-boot tmpfs
    # directory that only the project-host account can write, provisioned by
    # tmpfiles.d (never a unit's RuntimeDirectory=, which a restart removes).
    # The persist server refuses disk streams (and pages) if it is missing or
    # unsafe, so a failure here is caught there.
    Path("/etc/tmpfiles.d").mkdir(parents=True, exist_ok=True)
    Path(PERSIST_TMPFILES_CONF).write_text(
        persist_tmpfiles_conf(cfg.ssh_user), encoding="utf-8"
    )
    os.chmod(PERSIST_TMPFILES_CONF, 0o644)
    run_best_effort(
        cfg,
        ["systemd-tmpfiles", "--create", PERSIST_TMPFILES_CONF],
        "create the persist records directory",
    )
    run_best_effort(cfg, ["systemctl", "daemon-reload"], "reload systemd")
    # The distribution unit manages rootful containers and races with CoCalc's
    # dedicated rootless runtime during boot. Managed hosts must never use it.
    run_best_effort(
        cfg,
        ["systemctl", "disable", "podman-restart.service"],
        "disable system Podman container restart service",
    )
    run_best_effort(
        cfg,
        ["systemctl", "mask", "podman-restart.service"],
        "mask system Podman container restart service",
    )
    run_best_effort(
        cfg,
        [
            "systemctl",
            "reset-failed",
            "podman-restart.service",
            "cocalc-project-host-prepare.service",
        ],
        "clear stale Podman boot preparation failures",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "cocalc-project-host-prepare.service"],
        "enable Podman boot preparation service",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "cocalc-project-host-start.service"],
        "enable project-host boot service",
    )
    run_best_effort(
        cfg,
        [
            "systemctl",
            "enable",
            "--now",
            "cocalc-project-host-shutdown.service",
        ],
        "enable project-host shutdown notifier",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "--now", "cocalc-project-host-watchdog.timer"],
        "enable project-host watchdog timer",
    )
    run_best_effort(
        cfg,
        ["rm", "-f", "/etc/cron.d/cocalc-project-host"],
        "remove legacy project-host cron watchdog",
    )


