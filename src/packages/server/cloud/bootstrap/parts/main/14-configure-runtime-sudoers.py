def configure_runtime_sudoers(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    log_line(cfg, f"bootstrap: configuring sudoers whitelist for {user}")
    project_host_rootctl = project_host_rootctl_path(cfg)
    rules = f"""Defaults:{user} !requiretty
Defaults:{user} secure_path=/usr/sbin:/usr/bin:/sbin:/bin
Cmnd_Alias COCALC_RUNTIME_STORAGE = /usr/local/sbin/cocalc-runtime-storage
Cmnd_Alias COCALC_RUNTIME_CLOUD = /usr/local/sbin/cocalc-cloudflared-ctl, /usr/local/sbin/cocalc-cloudflared-logs, /usr/local/sbin/cocalc-mount-data
Cmnd_Alias COCALC_RUNTIME_PROJECT_HOST = {project_host_rootctl}
{user} ALL=(root) NOPASSWD: COCALC_RUNTIME_STORAGE, COCALC_RUNTIME_CLOUD, COCALC_RUNTIME_PROJECT_HOST
"""
    path = Path("/etc/sudoers.d/cocalc-project-host-runtime")
    path.write_text(rules, encoding="utf-8")
    os.chmod(path, 0o440)
    if shutil.which("visudo"):
        run_cmd(
            cfg,
            ["visudo", "-c", "-f", str(path)],
            "validate runtime sudoers",
        )


def verify_runtime_sudoers(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    log_line(cfg, f"bootstrap: verifying sudo whitelist behavior for {user}")
    run_cmd(
        cfg,
        ["sudo", "-n", "/usr/local/sbin/cocalc-runtime-storage", "sync"],
        "runtime sudo allowlist check",
        as_user=user,
    )
    run_cmd(
        cfg,
        ["sudo", "-n", str(project_host_rootctl_path(cfg)), "noop"],
        "runtime project-host sudo allowlist check",
        as_user=user,
    )
    denied = run_cmd(
        cfg,
        ["sudo", "-n", "/bin/true"],
        "runtime sudo denylist check",
        as_user=user,
        check=False,
    )
    if denied.returncode == 0:
        raise RuntimeError(
            "runtime sudo policy too broad: non-whitelisted command /bin/true was allowed"
        )
    mount_denied = run_cmd(
        cfg,
        [
            "sudo",
            "-n",
            "/usr/local/sbin/cocalc-runtime-storage",
            "mount",
            "-t",
            "overlay",
            "overlay",
            "/mnt/cocalc/data",
        ],
        "runtime generic mount command denied check",
        as_user=user,
        check=False,
    )
    if mount_denied.returncode == 0:
        raise RuntimeError(
            "runtime storage wrapper still allows generic mount command; expected deny"
        )


def configure_critical_service_oom_protection(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: protecting host critical services from OOM kills")
    services = ["ssh.service", "sshd.service"]
    if cfg.cloudflared.enabled:
        services.append("cocalc-cloudflared.service")
    dropin_text = f"""[Service]
OOMScoreAdjust={HOST_CRITICAL_OOM_SCORE_ADJ}
"""
    for service in services:
        dropin_dir = Path("/etc/systemd/system") / f"{service}.d"
        dropin_dir.mkdir(parents=True, exist_ok=True)
        dropin_path = dropin_dir / "cocalc-oom-protect.conf"
        dropin_path.write_text(dropin_text, encoding="utf-8")
    run_best_effort(cfg, ["systemctl", "daemon-reload"], "reload systemd after OOM drop-ins")
    run_best_effort(
        cfg,
        [
            "bash",
            "-lc",
            (
                f'for pid in $(pgrep -x sshd 2>/dev/null || true); do '
                f'/usr/bin/choom -n {HOST_CRITICAL_OOM_SCORE_ADJ} -p "$pid" >/dev/null 2>&1 || '
                f'printf "%s\\n" {HOST_CRITICAL_OOM_SCORE_ADJ} >"/proc/$pid/oom_score_adj" 2>/dev/null || true; '
                "done"
            ),
        ],
        "protect sshd from OOM kills",
    )
    if cfg.cloudflared.enabled:
        run_best_effort(
            cfg,
            [
                "bash",
                "-lc",
                (
                    'pid="$(systemctl show -p MainPID --value cocalc-cloudflared.service 2>/dev/null || true)"; '
                    'if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; then '
                    f'/usr/bin/choom -n {HOST_CRITICAL_OOM_SCORE_ADJ} -p "$pid" >/dev/null 2>&1 || '
                    f'printf "%s\\n" {HOST_CRITICAL_OOM_SCORE_ADJ} >"/proc/$pid/oom_score_adj" 2>/dev/null || true; '
                    "fi"
                ),
            ],
            "protect cloudflared from OOM kills",
        )


CLOUDFLARED_NO_MPTCP_DROPIN = "[Service]\nEnvironment=GODEBUG=multipathtcp=0\n"


def configure_cloudflared(cfg: BootstrapConfig) -> None:
    if not cfg.cloudflared.enabled:
        return
    configure_cloudflared_with_options(cfg, install_package=True)


def configure_cloudflared_with_options(
    cfg: BootstrapConfig, *, install_package: bool
) -> None:
    if not cfg.cloudflared.enabled:
        return
    cloudflared_missing = shutil.which("cloudflared") is None
    should_install = install_package or cloudflared_missing
    if not should_install:
        installed = run_cmd(
            cfg,
            ["/usr/bin/cloudflared", "--version"],
            "inspect cloudflared version",
            check=False,
            timeout=15,
        )
        match = re.search(r"cloudflared version\s+([^\s(]+)", installed.stdout or "")
        installed_version = match.group(1) if match else "unknown"
        should_install = installed_version != CLOUDFLARED_VERSION
        if should_install:
            log_line(
                cfg,
                f"bootstrap: upgrading cloudflared version drift installed={installed_version} expected={CLOUDFLARED_VERSION}",
            )
    service_changed = should_install
    if should_install:
        log_line(cfg, f"bootstrap: installing cloudflared {CLOUDFLARED_VERSION}")
        arch = cfg.expected_arch
        expected_sha256 = CLOUDFLARED_DEB_SHA256.get(arch)
        if not expected_sha256:
            raise RuntimeError(f"unsupported cloudflared architecture: {arch}")
        deb_name = f"cloudflared-linux-{arch}.deb"
        download_file(
            cfg,
            f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{deb_name}",
            "/tmp/cloudflared.deb",
            attempts=6,
        )
        verify_sha256(cfg, "/tmp/cloudflared.deb", expected_sha256)
        run_cmd(cfg, ["dpkg", "-i", "/tmp/cloudflared.deb"], "install cloudflared")
    else:
        log_line(cfg, "bootstrap: reconciling cloudflared config")
    cloudflared_dir = Path("/etc/cloudflared")
    cloudflared_dir.mkdir(parents=True, exist_ok=True)
    credentials_path = cloudflared_dir / f"{cfg.cloudflared.tunnel_id}.json"
    token_path = cloudflared_dir / "token"

    def read_legacy_token_env() -> str | None:
        env_path = cloudflared_dir / "token.env"
        if not env_path.exists():
            return None
        for line in env_path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "CLOUDFLARED_TOKEN":
                token = value.strip()
                return token or None
        return None

    def write_text_if_changed(path: Path, content: str) -> bool:
        existing: str | None = None
        try:
            existing = path.read_text(encoding="utf-8")
            if existing == content:
                return False
        except OSError:
            pass
        old_sha = (
            hashlib.sha256(existing.encode("utf-8")).hexdigest()[:12]
            if existing is not None
            else "missing"
        )
        new_sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]
        log_line(
            cfg,
            f"bootstrap: updating cloudflared file path={path} old_sha={old_sha} new_sha={new_sha}",
        )
        path.write_text(content, encoding="utf-8")
        return True

    token = cfg.cloudflared.token
    if cfg.cloudflared.creds_json:
        service_changed = (
            write_text_if_changed(credentials_path, cfg.cloudflared.creds_json)
            or service_changed
        )
        os.chmod(credentials_path, 0o600)
    use_credentials = credentials_path.exists()
    if not use_credentials:
        token = token or read_legacy_token_env()
        if not token:
            raise RuntimeError(
                "cloudflared enabled but no tunnel credentials JSON or token is available"
            )
        service_changed = (
            write_text_if_changed(token_path, token + "\n") or service_changed
        )
        os.chmod(token_path, 0o600)
    def yaml_quote(value: str) -> str:
        return json.dumps(value)

    ingress_lines = [
        "ingress:",
        f"  - hostname: {yaml_quote(cfg.cloudflared.hostname)}",
        f"    service: http://localhost:{cfg.cloudflared.port}",
    ]
    if (
        cfg.cloudflared.exam_hostname
        and cfg.cloudflared.exam_hostname != cfg.cloudflared.hostname
    ):
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.exam_hostname)}",
                f"    service: http://localhost:{cfg.cloudflared.port}",
            ]
        )
    if cfg.cloudflared.ssh_hostname and cfg.cloudflared.ssh_port:
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.ssh_hostname)}",
                f"    service: ssh://localhost:{cfg.cloudflared.ssh_port}",
            ]
        )
    ingress_lines.append("  - service: http_status:404")
    ingress = "\n".join(ingress_lines)
    config_lines = [
        f"protocol: {cfg.cloudflared.protocol}",
        f"grace-period: {cfg.cloudflared.grace_period_seconds}s",
    ]
    if use_credentials:
        config_lines.append(f"tunnel: {cfg.cloudflared.tunnel_id}")
        config_lines.append(f"credentials-file: {credentials_path}")
    config_lines.append(ingress)
    service_changed = (
        write_text_if_changed(
            Path("/etc/cloudflared/config.yml"), "\n".join(config_lines) + "\n"
        )
        or service_changed
    )
    unit = """[Unit]
Description=Cloudflare Tunnel for CoCalc Project Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
"""
    unit += "ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run"
    if not use_credentials:
        unit += f" --token-file {token_path}"
    unit += "\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n"
    unit_changed = write_text_if_changed(
        Path("/etc/systemd/system/cocalc-cloudflared.service"), unit
    )
    recovery_dropin_dir = Path(
        "/etc/systemd/system/cocalc-cloudflared.service.d"
    )
    recovery_dropin_dir.mkdir(parents=True, exist_ok=True)
    recovery_dropin_changed = write_text_if_changed(
        recovery_dropin_dir / "cocalc-recovery.conf",
        "[Service]\nTimeoutStopSec=30\n",
    )
    # cloudflared is a Go program, and Go listeners use MPTCP by default; its
    # metrics listener is loopback-only, but MPTCP is surface it doesn't
    # need. A drop-in of its own, and not a service change: it takes effect at
    # the next restart instead of forcing one.
    no_mptcp_dropin_changed = write_text_if_changed(
        recovery_dropin_dir / "cocalc-no-mptcp.conf",
        CLOUDFLARED_NO_MPTCP_DROPIN,
    )
    service_changed = unit_changed or service_changed
    if unit_changed or recovery_dropin_changed or no_mptcp_dropin_changed:
        run_cmd(cfg, ["systemctl", "daemon-reload"], "daemon-reload", timeout=30)
    run_cmd(cfg, ["systemctl", "enable", "cocalc-cloudflared"], "enable cloudflared")
    active = run_cmd(
        cfg,
        ["systemctl", "is-active", "--quiet", "cocalc-cloudflared"],
        "check cloudflared status",
        check=False,
        timeout=15,
    )
    if service_changed or active.returncode != 0:
        run_cmd(
            cfg,
            ["systemctl", "restart", "cocalc-cloudflared"],
            "restart cloudflared",
            timeout=45,
        )
    else:
        log_line(cfg, "bootstrap: cloudflared config unchanged; keeping tunnel running")


def preserve_newer_nvidia_toolkit(cfg: BootstrapConfig) -> bool:
    policy = run_cmd(
        cfg, ["apt-cache", "policy", "nvidia-container-toolkit"],
        "inspect nvidia toolkit versions",
        timeout=30, env={**os.environ, "LC_ALL": "C"},
    )
    versions = {}
    for line in policy.stdout.splitlines():
        key, sep, value = line.strip().partition(":")
        if sep and key in ("Installed", "Candidate"):
            versions[key] = value.strip()
    installed = versions.get("Installed")
    candidate = versions.get("Candidate")
    if not installed or not candidate:
        raise RuntimeError("unable to determine nvidia toolkit package versions")
    if installed == "(none)":
        return False
    newer = candidate == "(none)"
    if not newer:
        comparison = run_cmd(
            cfg, ["dpkg", "--compare-versions", installed, "gt", candidate],
            "compare nvidia toolkit versions", check=False, timeout=10,
        )
        if comparison.returncode not in (0, 1):
            raise RuntimeError("unable to compare nvidia toolkit package versions")
        newer = comparison.returncode == 0
    if newer:
        # Provider images may pin an older repository version. Do not downgrade
        # a working, newer toolkit (and its tightly coupled base package).
        run_cmd(cfg, ["nvidia-ctk", "--version"], "verify installed nvidia toolkit", timeout=30)
        log_line(cfg, f"bootstrap: preserving nvidia toolkit {installed}; apt candidate is {candidate}")
    return newer


def install_gpu_support(cfg: BootstrapConfig) -> None:
    if not cfg.has_gpu:
        return
    log_line(cfg, "bootstrap: installing nvidia container toolkit")
    apt_run(cfg, ["apt-get", "-y", "install", "ca-certificates", "gnupg"], "install nvidia deps", retries=3, timeout=120)
    run_best_effort(cfg, ["rm", "-f", "/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg"], "remove old nvidia keyring")
    run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | "
            "gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
        ],
        "import nvidia key",
    )
    run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | "
            "sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | "
            "tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
        ],
        "write nvidia repo",
    )
    apt_run(cfg, ["apt-get", "-y", "update"], "apt-get update (nvidia)", retries=3, timeout=60)
    if not preserve_newer_nvidia_toolkit(cfg):
        install_nvidia_toolkit_package(cfg)
    configure_nvidia_toolkit(cfg)


def install_nvidia_toolkit_package(cfg: BootstrapConfig) -> None:
    apt_run(
        cfg,
        [
            "apt-get",
            "-y",
            "--allow-change-held-packages",
            "install",
            "nvidia-container-toolkit",
        ],
        "install nvidia-container-toolkit",
        retries=3,
        timeout=180,
    )


def configure_nvidia_toolkit(cfg: BootstrapConfig) -> None:
    run_best_effort(cfg, ["ldconfig"], "ldconfig")
    install_nvidia_cdi_normalizer()
    run_best_effort(cfg, ["nvidia-ctk", "cdi", "generate", "--output=/etc/cdi/nvidia.yaml"], "nvidia cdi generate")
    normalize_nvidia_cdi_for_podman(cfg)
    run_best_effort(cfg, ["usermod", "-aG", "video,render", cfg.ssh_user], "usermod nvidia groups")
    helper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  exit 0
fi
if [ ! -x /usr/bin/nvidia-ctk ]; then
  exit 0
fi
if [ -f /etc/cdi/nvidia.yaml ]; then
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
  exit 0
fi
ldconfig || true
if command -v nvidia-smi >/dev/null 2>&1 || ldconfig -p 2>/dev/null | grep -q libnvidia-ml.so.1; then
  /usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml || exit 0
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
fi
exit 0
"""
    Path("/usr/local/sbin/cocalc-nvidia-cdi").write_text(helper, encoding="utf-8")
    os.chmod("/usr/local/sbin/cocalc-nvidia-cdi", 0o755)
    Path("/etc/cron.d/cocalc-nvidia-cdi").write_text(
        "*/5 * * * * root /usr/local/sbin/cocalc-nvidia-cdi >/dev/null 2>&1\n",
        encoding="utf-8",
    )
    os.chmod("/etc/cron.d/cocalc-nvidia-cdi", 0o644)


def project_host_restart_fingerprint(cfg: BootstrapConfig) -> dict[str, str]:
    """Digests of what a running project-host stack loaded at startup.

    The boot-time reconcile rewrites everything; it must only restart the
    stack (which systemd already started at boot) when one of these changed.
    Keys name the component so a restart can say why; values are digests.
    """
    parts: dict[str, str] = {}

    def digest_bytes(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def add_file(key: str, path: Path | str, dir_fd: int | None = None) -> None:
        # Some of these are in runtime-owned dirs: never follow a symlink
        # there, read only regular files, and at most a bounded size.
        try:
            fd = os.open(
                path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd
            )
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    parts[key] = "not-a-regular-file"
                    return
                info = os.fstat(fd)
                with os.fdopen(fd, "rb", closefd=False) as f:
                    data = f.read(FINGERPRINT_MAX_FILE_BYTES + 1)
                if len(data) > FINGERPRINT_MAX_FILE_BYTES:
                    # stable, so an unchanged big file isn't a change
                    parts[key] = f"too-large:{info.st_size}:{info.st_mtime_ns}"
                    return
                parts[key] = digest_bytes(data)
            finally:
                os.close(fd)
        except FileNotFoundError:
            parts[key] = "missing"
        except OSError as exc:
            # Unknown is a change: never skip a restart on a read failure.
            parts[key] = f"unreadable:{os.urandom(8).hex()}:{exc.errno}"

    for name, bundle in (
        ("project_host_bundle", cfg.project_host_bundle),
        ("project_bundle", cfg.project_bundle),
        ("tools_bundle", cfg.tools_bundle),
        ("container_runtime_bundle", cfg.container_runtime_bundle),
    ):
        if bundle is not None:
            parts[f"bundle:{name}"] = (
                os.path.realpath(bundle.current) if bundle.current else ""
            )
    parts["node"] = f"{cfg.node_version}"
    # the release current points at (a selector like "26" moves with patches)
    current_node = NODE_ROOT / "current"
    parts["node_current"] = (
        os.path.realpath(current_node) if os.path.lexists(current_node) else "missing"
    )
    # and which file it is: a reinstall of the same version (a repaired tree)
    # is a new inode
    try:
        info = os.stat(current_node / "bin" / "node")
        parts["node_binary"] = f"{info.st_dev}:{info.st_ino}:{info.st_mtime_ns}:{info.st_size}"
    except OSError:
        parts["node_binary"] = "missing"
    # R/bin through the same no-follow descriptors as the writes
    bin_fd = -1
    try:
        root_fd = open_dir_nofollow(project_host_runtime_root(cfg))
        try:
            bin_fd = os.open("bin", O_DIR_NOFOLLOW, dir_fd=root_fd)
        except OSError as err:
            if err.errno in (errno.ELOOP, errno.ENOTDIR):
                raise UnsafeRuntimePath("bin is a symlink or not a directory") from err
            raise
        finally:
            os.close(root_fd)
        for name in sorted(os.listdir(bin_fd)):
            info = os.stat(name, dir_fd=bin_fd, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                add_file(f"bin:{name}", name, dir_fd=bin_fd)
    except FileNotFoundError:
        parts["bin"] = "missing"
    except UnsafeRuntimePath:
        parts["bin"] = "unsafe"  # stable: refused the same way every time
    except OSError as exc:
        # Unknown is a change: never skip a restart on a read failure.
        parts["bin"] = f"unreadable:{os.urandom(8).hex()}:{exc.errno}"
    finally:
        if bin_fd >= 0:
            os.close(bin_fd)
    env_path = Path(cfg.env_file)
    local_env_path = env_path.with_name(
        env_path.name[:-4] + ".local.env"
        if env_path.name.endswith(".env")
        else "project-host.local.env"
    )
    # Per key, so a restart names the setting that changed (never its value).
    for label, path in (("env", env_path), ("local_env", local_env_path)):
        try:
            env = read_env_assignments(path)
            for key, value in env.items():
                # A GCP Spot VM gets a new ephemeral IP on every start, so this
                # changes on every boot. The control plane takes the endpoint
                # from the provider for GCP, so it is not worth a restart.
                if (
                    key == "PROJECT_HOST_SSH_SERVER"
                    and env.get("PROJECT_HOST_CLOUD_PROVIDER") == "gcp"
                ):
                    continue
                parts[f"{label}:{key}"] = digest_bytes(value.encode())
        except Exception as exc:
            parts[label] = f"unreadable:{os.urandom(8).hex()}:{type(exc).__name__}"
    add_file("master_conat_token", "/mnt/cocalc/data/secrets/master-conat-token")
    containers = Path(runtime_home(cfg)) / ".config" / "containers"
    add_file("podman:storage.conf", containers / "storage.conf")
    add_file("podman:containers.conf", containers / "containers.conf")
    return parts


