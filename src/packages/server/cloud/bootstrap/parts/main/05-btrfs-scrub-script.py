BTRFS_SCRUB_SCRIPT = r'''
@@bootstrap-include embedded/btrfs-scrub.py@@
'''


def configure_btrfs_scrub(
    cfg: BootstrapConfig,
    *,
    script_path: Path = Path("/usr/local/libexec/cocalc-btrfs-scrub"),
    service_path: Path = Path("/etc/systemd/system/cocalc-btrfs-scrub.service"),
    timer_path: Path = Path("/etc/systemd/system/cocalc-btrfs-scrub.timer"),
) -> None:
    """An hourly root check that scrubs the project data filesystem once a
    period, throttled, while the host is quiet (BTRFS_SCRUB_SCRIPT). It only
    scrubs where /etc/cocalc/btrfs-scrub.json enables it; its status (which
    names files with errors) is readable by the runtime user's group only."""
    log_line(cfg, "bootstrap: configuring btrfs scrub")

    def current(path: Path) -> str | None:
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return None

    if current(script_path) != BTRFS_SCRUB_SCRIPT:
        text_write_atomic(script_path, BTRFS_SCRUB_SCRIPT, default_mode=0o755)
    os.chmod(script_path, 0o755)
    status_group = shlex.quote(cfg.ssh_user or "root")
    service = f"""[Unit]
Description=CoCalc btrfs scrub of the project data filesystem
ConditionPathIsExecutable={script_path}
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/python3 -I {script_path} --mount /mnt/cocalc --status-dir /var/lib/cocalc-btrfs-scrub --status-group {status_group}
UMask=0027
Nice=10
# the script bounds a run (its daily budget and night window, 24 h at most,
# counted as it goes); a stop or timeout sends SIGTERM, on which it cancels
# the scrub it is watching
TimeoutStartSec=25h
NoNewPrivileges=yes
PrivateTmp=yes
# not strict: btrfs scrub writes /var/lib/btrfs
ProtectSystem=full
ProtectHome=yes
ProtectKernelModules=yes
RestrictSUIDSGID=yes
"""
    timer = """[Unit]
Description=Hourly check for a due btrfs scrub

[Timer]
OnCalendar=hourly
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
"""
    for path, text in ((service_path, service), (timer_path, timer)):
        if current(path) != text:
            text_write_atomic(path, text)
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd btrfs scrub units",
        timeout=30,
    )
    run_cmd(
        cfg,
        ["systemctl", "enable", "--now", "cocalc-btrfs-scrub.timer"],
        "enable btrfs scrub timer",
        timeout=30,
    )


def configure_host_integrity_watch(
    cfg: BootstrapConfig,
    *,
    script_path: Path = Path("/usr/local/libexec/cocalc-host-integrity"),
    service_path: Path = Path(
        "/etc/systemd/system/cocalc-host-integrity.service"
    ),
) -> None:
    """A root service that reports where the runtime user's processes and its
    container uid ranges run, and changes to host configuration. The status
    lives in a root-owned directory (StateDirectory) that the project host
    reads into its heartbeat."""
    log_line(cfg, "bootstrap: configuring host integrity watcher")

    def current(path: Path) -> str | None:
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return None

    changed = current(script_path) != HOST_INTEGRITY_WATCH_SCRIPT
    if changed:
        text_write_atomic(
            script_path, HOST_INTEGRITY_WATCH_SCRIPT, default_mode=0o755
        )
    os.chmod(script_path, 0o755)
    args = " ".join(
        shlex.quote(part)
        for part in [
            "/usr/bin/python3",
            "-I",
            str(script_path),
            "--runtime-user",
            cfg.ssh_user,
            "--status-dir",
            "/var/lib/cocalc-host-integrity",
            "--bootstrap-state",
            str(bootstrap_state_path(cfg)),
        ]
    )
    service = f"""[Unit]
Description=CoCalc project-host integrity watcher
ConditionPathIsExecutable={script_path}

[Service]
Type=simple
ExecStart={args}
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
StateDirectory=cocalc-host-integrity
StateDirectoryMode=0755
UMask=0022
Nice=10
CPUQuota=10%
MemoryMax=128M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
"""
    if current(service_path) != service:
        text_write_atomic(service_path, service)
        changed = True
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd host integrity unit",
        timeout=30,
    )
    # A changed script or unit takes effect now; an unchanged running watcher
    # keeps its findings and inventory.
    run_cmd(
        cfg,
        [
            "systemctl",
            "restart" if changed else "start",
            "cocalc-host-integrity.service",
        ],
        "start host integrity watcher",
        timeout=30,
    )
    run_cmd(
        cfg,
        ["systemctl", "enable", "cocalc-host-integrity.service"],
        "enable host integrity watcher",
        timeout=30,
    )


RSYSLOG_LOGROTATE_CONTENT = """/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
    daily
    rotate 3
    maxsize 256M
    missingok
    notifempty
    compress
    sharedscripts
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}
"""

RSYSLOG_EMERGENCY_WALL_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<rule>\*\.emerg[ \t]+:omusrmsg:\*[ \t]*(?:#.*)?)$",
    re.MULTILINE,
)
RSYSLOG_CONSOLE_OUTPUT_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<rule>[^#\s][^\n]*[ \t]+-?/dev/console[ \t]*(?:#.*)?)$",
    re.MULTILINE,
)
RSYSLOG_HEADLESS_OUTPUT_COMMENT = (
    "# CoCalc headless hosts retain emergency messages in syslog and journald."
)


def disable_rsyslog_headless_outputs(config_dir: Path) -> bool:
    changed = False
    for config_path in sorted(config_dir.glob("*.conf")):
        changed = disable_rsyslog_headless_outputs_in_file(config_path) or changed
    return changed


def disable_rsyslog_headless_outputs_in_file(config_path: Path) -> bool:
    try:
        content = config_path.read_text(encoding="utf-8")
    except OSError:
        return False

    def comment_rule(match: re.Match[str]) -> str:
        indent = match.group("indent")
        rule = match.group("rule").rstrip()
        return (
            f"{indent}{RSYSLOG_HEADLESS_OUTPUT_COMMENT}\n"
            f"{indent}# {rule}"
        )

    updated, wall_count = RSYSLOG_EMERGENCY_WALL_RE.subn(comment_rule, content)
    updated, console_count = RSYSLOG_CONSOLE_OUTPUT_RE.subn(
        comment_rule, updated
    )
    if wall_count + console_count == 0:
        return False
    config_path.write_text(updated, encoding="utf-8")
    return True


def configure_rsyslog_limits(
    cfg: BootstrapConfig,
    *,
    logrotate_path: Path = Path("/etc/logrotate.d/rsyslog"),
    rsyslog_config_dir: Path = Path("/etc/rsyslog.d"),
) -> None:
    if not logrotate_path.parent.exists():
        return
    log_line(cfg, "bootstrap: configuring classic system log limits")
    try:
        logrotate_changed = (
            logrotate_path.read_text(encoding="utf-8")
            != RSYSLOG_LOGROTATE_CONTENT
        )
    except OSError:
        logrotate_changed = True
    if logrotate_changed:
        logrotate_path.write_text(RSYSLOG_LOGROTATE_CONTENT, encoding="utf-8")
    headless_outputs_changed = disable_rsyslog_headless_outputs(
        rsyslog_config_dir
    )
    if not logrotate_changed and not headless_outputs_changed:
        log_line(cfg, "bootstrap: classic system log limits already current")
        return
    if shutil.which("systemctl") is None:
        return
    if logrotate_changed:
        run_best_effort(
            cfg,
            ["systemctl", "start", "--no-block", "logrotate.service"],
            "queue classic system log rotation",
            timeout=15,
        )
    if headless_outputs_changed:
        run_best_effort(
            cfg,
            ["systemctl", "restart", "--no-block", "rsyslog.service"],
            "queue rsyslog restart after disabling interactive delivery",
            timeout=15,
        )


ALGIF_AEAD_DISABLE_CONF = (
    'install algif_aead /bin/false\n'
)

def configure_kernel_module_hardening(
    cfg: BootstrapConfig,
    *,
    modprobe_dir: Path = Path("/etc/modprobe.d"),
) -> None:
    log_line(cfg, "bootstrap: disabling algif_aead kernel module")
    modprobe_dir.mkdir(parents=True, exist_ok=True)
    conf = modprobe_dir / "disable-algif-aead.conf"
    conf.write_text(ALGIF_AEAD_DISABLE_CONF, encoding="utf-8")
    run_best_effort(cfg, ["rmmod", "algif_aead"], "unload algif_aead")


KERNEL_HARDENING_SYSCTL_CONF_NAME = "92-cocalc-project-host-hardening.conf"
# Set on every project host. io_uring is a large kernel attack surface that
# nothing on the host needs: io_uring_setup then fails with EPERM and libuv
# (which creates a ring when an event loop starts) falls back to epoll;
# project containers already get ENOSYS from seccomp. The setting only refuses
# new rings, so it is applied before the project-host stack starts: here,
# before every daemon start in the root helper, and at boot by systemd-sysctl.
# userfaultfd stays limited to privileged users.
KERNEL_HARDENING_SYSCTLS: dict[str, int] = {
    "kernel.io_uring_disabled": 2,
    "vm.unprivileged_userfaultfd": 0,
}
# Checked but not written: the supported images' defaults are at least this
# strict, and writing these values could lower a stricter default (Ubuntu uses
# unprivileged_bpf_disabled=2 and perf_event_paranoid=4).
KERNEL_HARDENING_MINIMUMS: dict[str, int] = {
    "kernel.apparmor_restrict_unprivileged_userns": 1,
    "kernel.unprivileged_bpf_disabled": 1,
    "kernel.perf_event_paranoid": 3,
}


def kernel_hardening_sysctl_conf() -> str:
    lines = [
        "# Managed by CoCalc project-host: kernel attack surface reduction.",
        *(f"{key} = {value}" for key, value in KERNEL_HARDENING_SYSCTLS.items()),
    ]
    return "\n".join(lines) + "\n"


def kernel_hardening_problems(proc_sys: Path = Path("/proc/sys")) -> list[str]:
    problems: list[str] = []

    def read(key: str) -> int | None:
        try:
            return int(
                (proc_sys / key.replace(".", "/")).read_text(encoding="utf-8").strip()
            )
        except (OSError, ValueError):
            return None

    for key, value in KERNEL_HARDENING_SYSCTLS.items():
        actual = read(key)
        # A larger value is stricter for io_uring_disabled; userfaultfd must be 0.
        ok = actual is not None and (
            actual == 0 if value == 0 else actual >= value
        )
        if not ok:
            problems.append(f"{key}={actual if actual is not None else 'missing'} (want {value})")
    for key, minimum in KERNEL_HARDENING_MINIMUMS.items():
        actual = read(key)
        if actual is None or actual < minimum:
            problems.append(
                f"{key}={actual if actual is not None else 'missing'} (want >= {minimum})"
            )
    return problems


def configure_kernel_sysctl_hardening(
    cfg: BootstrapConfig,
    *,
    sysctl_dir: Path = Path("/etc/sysctl.d"),
    proc_sys: Path = Path("/proc/sys"),
) -> None:
    log_line(cfg, "bootstrap: configuring kernel hardening sysctls")
    sysctl_dir.mkdir(parents=True, exist_ok=True)
    conf = sysctl_dir / KERNEL_HARDENING_SYSCTL_CONF_NAME
    conf.write_text(kernel_hardening_sysctl_conf(), encoding="utf-8")
    os.chmod(conf, 0o644)
    # -e: a kernel without one of these keys must not fail the host.
    run_best_effort(cfg, ["sysctl", "-e", "-p", str(conf)], "sysctl kernel hardening")
    # Warn rather than fail: the host-agent reports the same checks in its
    # metrics, and the hub's admin health raises them.
    for problem in kernel_hardening_problems(proc_sys):
        log_line(cfg, f"bootstrap: WARNING kernel hardening drift: {problem}")


def configure_kernel_key_limits(
    cfg: BootstrapConfig,
    *,
    sysctl_dir: Path = Path("/etc/sysctl.d"),
) -> None:
    log_line(cfg, "bootstrap: configuring kernel key quotas for rootless containers")
    sysctl_dir.mkdir(parents=True, exist_ok=True)
    conf = sysctl_dir / "60-cocalc-project-host-keyring.conf"
    conf.unlink(missing_ok=True)
    run_best_effort(cfg, ["sysctl", "-w", "kernel.keys.maxkeys=20000"], "sysctl kernel.keys.maxkeys")
    run_best_effort(cfg, ["sysctl", "-w", "kernel.keys.maxbytes=25000000"], "sysctl kernel.keys.maxbytes")


def configure_inotify_limits(
    cfg: BootstrapConfig,
    *,
    sysctl_dir: Path = Path("/etc/sysctl.d"),
) -> None:
    log_line(cfg, "bootstrap: configuring inotify limits for project workloads")
    sysctl_dir.mkdir(parents=True, exist_ok=True)
    conf = sysctl_dir / "60-cocalc-project-host-inotify.conf"
    conf.unlink(missing_ok=True)
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_user_instances=8192"],
        "sysctl fs.inotify.max_user_instances",
    )
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_user_watches=2097152"],
        "sysctl fs.inotify.max_user_watches",
    )
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_queued_events=65536"],
        "sysctl fs.inotify.max_queued_events",
    )


def detect_public_ip(cfg: BootstrapConfig) -> str | None:
    for url in ("https://api.ipify.org", "https://ifconfig.me"):
        try:
            log_line(cfg, f"bootstrap: detecting public IP via {url}")
            with urllib.request.urlopen(url, timeout=10) as resp:
                value = resp.read().decode("utf-8").strip()
            if value:
                return value
        except Exception:
            continue
    log_line(cfg, "bootstrap: could not determine public IP")
    return None


def substitute_public_ip(cfg: BootstrapConfig) -> None:
    if not any("$PUBLIC_IP" in line for line in cfg.env_lines):
        return
    public_ip = detect_public_ip(cfg)
    if not public_ip:
        return
    cfg.env_lines[:] = [line.replace("$PUBLIC_IP", public_ip) for line in cfg.env_lines]


def enable_userns(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: enabling unprivileged user namespaces")
    run_best_effort(cfg, ["sysctl", "-w", "kernel.unprivileged_userns_clone=1"], "sysctl userns")


def ensure_runtime_user(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    try:
        group = grp.getgrnam(user)
        if group.gr_gid != desired_gid:
            raise RuntimeError(
                f"runtime group {user} has gid {group.gr_gid}, expected {desired_gid}; reprovision the host"
            )
    except KeyError:
        try:
            existing = grp.getgrgid(desired_gid)
            raise RuntimeError(
                f"runtime gid {desired_gid} is already owned by group {existing.gr_name}; reprovision the host"
            )
        except KeyError:
            log_line(cfg, f"bootstrap: creating runtime group {user} gid={desired_gid}")
            run_cmd(
                cfg,
                ["groupadd", "-g", str(desired_gid), user],
                "create runtime group",
            )
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        try:
            existing = pwd.getpwuid(desired_uid)
            raise RuntimeError(
                f"runtime uid {desired_uid} is already owned by user {existing.pw_name}; reprovision the host"
            )
        except KeyError:
            log_line(cfg, f"bootstrap: creating runtime user {user} uid={desired_uid} gid={desired_gid}")
            run_cmd(
                cfg,
                [
                    "useradd",
                    "-m",
                    "-u",
                    str(desired_uid),
                    "-g",
                    str(desired_gid),
                    "-s",
                    "/bin/bash",
                    user,
                ],
                "create runtime user",
            )
        pw = pwd.getpwnam(user)
    if pw.pw_uid != desired_uid or pw.pw_gid != desired_gid:
        raise RuntimeError(
            f"runtime user {user} has uid/gid {pw.pw_uid}:{pw.pw_gid}, expected {desired_uid}:{desired_gid}; reprovision the host"
        )
    home = pw.pw_dir or f"/home/{user}"
    Path(home).mkdir(parents=True, exist_ok=True)
    run_best_effort(cfg, ["chown", f"{user}:{user}", home], "chown runtime home")


