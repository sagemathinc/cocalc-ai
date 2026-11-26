def setup_shared_scratch(cfg: BootstrapConfig) -> None:
    if not cfg.shared_scratch_enabled:
        return
    if cfg.shared_scratch_filesystem != "ext4":
        raise RuntimeError(
            f"unsupported shared scratch filesystem: {cfg.shared_scratch_filesystem}"
        )
    scratch_mount = Path(cfg.shared_scratch_mount)
    scratch_mount.mkdir(parents=True, exist_ok=True)
    devices = [d for d in cfg.shared_scratch_devices.split() if d]
    if not devices:
        raise RuntimeError("shared scratch is enabled but no candidate devices were configured")

    log_line(cfg, "bootstrap: waiting for shared scratch disk (up to 600s)")
    scratch_disk = None
    for attempt in range(60):
        scratch_disk = pick_unmounted_or_target_disk(
            cfg,
            devices,
            mountpoint=cfg.shared_scratch_mount,
        )
        if scratch_disk:
            break
        log_line(
            cfg,
            f"bootstrap: shared scratch disk not ready (attempt {attempt + 1}/60)",
        )
        time.sleep(10)
    if not scratch_disk:
        raise RuntimeError("shared scratch disk was not found")

    log_line(cfg, f"bootstrap: using shared scratch disk {scratch_disk}")
    fstype = subprocess.check_output(
        ["lsblk", "-no", "FSTYPE", scratch_disk],
        text=True,
    ).strip()
    if not fstype:
        run_cmd(cfg, ["mkfs.ext4", "-F", scratch_disk], "mkfs.ext4 shared scratch")
    elif fstype != "ext4":
        raise RuntimeError(
            f"refusing to mount shared scratch disk {scratch_disk} (filesystem={fstype})"
        )
    if not scratch_mount.is_mount():
        run_cmd(
            cfg,
            ["mount", scratch_disk, cfg.shared_scratch_mount],
            "mount shared scratch disk",
        )
    uuid = subprocess.check_output(
        ["blkid", "-s", "UUID", "-o", "value", scratch_disk],
        text=True,
    ).strip()
    fstab_line = (
        f"UUID={uuid} {cfg.shared_scratch_mount} ext4 defaults,nofail 0 2 # cocalc-scratch"
    )
    update_fstab(
        fstab_line,
        mountpoint=cfg.shared_scratch_mount,
        marker="cocalc-scratch",
    )
    run_best_effort(cfg, ["resize2fs", scratch_disk], "resize shared scratch filesystem")
    os.chmod(cfg.shared_scratch_mount, 0o1777)


def update_fstab(
    line: str,
    *,
    mountpoint: str = "/mnt/cocalc",
    marker: str = "cocalc-btrfs",
) -> None:
    fstab = Path("/etc/fstab")
    existing = fstab.read_text(encoding="utf-8") if fstab.exists() else ""
    lines = []
    for existing_line in existing.splitlines():
        if marker and marker in existing_line:
            continue
        if f" {mountpoint} " in existing_line:
            continue
        if mountpoint == "/mnt/cocalc" and " /btrfs " in existing_line:
            continue
        lines.append(existing_line)
    lines.append(line)
    fstab.write_text("\n".join(lines) + "\n", encoding="utf-8")


def install_btrfs_helper(cfg: BootstrapConfig) -> None:
    helper = """
@@bootstrap-include embedded/grow-btrfs.sh@@
"""
    helper_path = Path("/usr/local/sbin/cocalc-grow-btrfs")
    helper_path.write_text(helper, encoding="utf-8")
    helper_path.chmod(0o755)


def ensure_cocalc_mount(cfg: BootstrapConfig) -> None:
    if Path("/mnt/cocalc").is_mount():
        return
    log_line(cfg, "bootstrap: ensuring /mnt/cocalc is mounted")
    if Path("/usr/local/sbin/cocalc-mount-data").exists():
        run_best_effort(
            cfg,
            ["/usr/local/sbin/cocalc-mount-data"],
            "mount /mnt/cocalc via cocalc-mount-data",
        )
    if not Path("/mnt/cocalc").is_mount():
        run_best_effort(cfg, ["mount", "/mnt/cocalc"], "mount /mnt/cocalc")


MANAGED_PROJECT_JOB_HELPER = r'''
@@bootstrap-include embedded/managed-project-job.py@@
'''

RUNTIME_STORAGE_PATH_HELPER = r'''
@@bootstrap-include embedded/runtime-storage-path-helper.py@@
'''


LEGACY_MANAGED_PROJECT_IO_OVERRIDE = {
    "version": 1,
    "mode": "enforce",
    "mountpoint": "/mnt/cocalc",
    "profile": "prod-gcp-pd-balanced-dynamic-v1",
    "capacitySource": "gcp-pd-balanced-size-formula-2026-07-24",
    "capacity": {"mode": "gcp-pd-balanced"},
    "adaptive": {
        "enabled": False,
        "sampleMs": 5000,
        "enterSamples": 6,
        "recoverSamples": 24,
    },
    "ioCost": {"mode": "disabled"},
}


def retire_legacy_managed_project_io_override(override_path: Path) -> None:
    if not override_path.exists():
        return
    try:
        override = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    if override != LEGACY_MANAGED_PROJECT_IO_OVERRIDE:
        return
    retired_path = override_path.with_name(
        f"{override_path.name}.retired-gcp-pd-balanced-size-formula-2026-07-24"
    )
    if retired_path.exists():
        retired_path.unlink()
    override_path.replace(retired_path)
    os.chown(retired_path, 0, 0)
    retired_path.chmod(0o600)


def write_project_io_configuration(
    cfg: BootstrapConfig | PrivilegedWrapperConfig,
    *,
    policy_path: Path = Path("/etc/cocalc/project-io-policy.json"),
    override_path: Path = Path("/etc/cocalc/project-io-policy.override.json"),
    capacity_path: Path = Path("/etc/cocalc/project-io-capacity.json"),
) -> None:
    retire_legacy_managed_project_io_override(override_path)
    text_write_atomic(
        policy_path,
        json.dumps(cfg.project_io_policy, indent=2, sort_keys=True) + "\n",
        default_mode=0o644,
    )
    os.chown(policy_path, 0, 0)
    policy_path.chmod(0o644)
    if override_path.exists():
        os.chown(override_path, 0, 0)
        override_path.chmod(0o600)
    text_write_atomic(
        capacity_path,
        json.dumps(cfg.project_io_capacity, indent=2, sort_keys=True) + "\n",
        default_mode=0o644,
    )
    os.chown(capacity_path, 0, 0)
    capacity_path.chmod(0o644)


def install_privileged_wrappers(
    cfg: BootstrapConfig | PrivilegedWrapperConfig,
) -> None:
    storage_wrapper = """
@@bootstrap-include embedded/storage-wrapper.sh.pystr@@
"""
    mount_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-mount-data must run as root" >&2
  exit 1
fi
exec /bin/mount /mnt/cocalc
"""
    cloud_ctl_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-cloudflared-ctl must run as root" >&2
  exit 1
fi
cmd="${1:-status}"
service="cocalc-cloudflared.service"
case "$cmd" in
  start|stop|restart|status)
    exec /bin/systemctl "$cmd" "$service"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
"""
    cloud_logs_wrapper = """
@@bootstrap-include embedded/cloud-logs-wrapper.sh@@
"""
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_POOL_CGROUP__", DEFAULT_PROJECT_POOL_CGROUP
    )
    storage_wrapper = storage_wrapper.replace("__RUNTIME_USER__", cfg.ssh_user)
    storage_wrapper = storage_wrapper.replace(
        "__ALLOW_UNENFORCEABLE_PROJECT_NETWORK__",
        "1" if cfg.allow_unenforceable_project_network else "0",
    )
    storage_wrapper = storage_wrapper.replace(
        "__CONTAINER_RUNTIME_REQUIRED__",
        "1" if cfg.container_runtime_bundle is not None else "0",
    )
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB),
    )
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB),
    )
    storage_wrapper = storage_wrapper.replace(
        "__MIN_PROJECT_POOL_MEMORY_MB__",
        str(MIN_PROJECT_POOL_MEMORY_MB),
    )
    # Standalone hosts (PrivilegedWrapperConfig) have no env lines and run
    # project-host on its default ports.
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_CONAT_ROUTER_PORT__",
        str(project_conat_router_port(getattr(cfg, "env_lines", None) or [])),
    ).replace(
        "__PROJECT_SITE_CODEX_PROXY_PORT__",
        str(project_site_codex_proxy_port(getattr(cfg, "env_lines", None) or [])),
    )
    env_path = Path(getattr(cfg, "env_file", None) or DEFAULT_PROJECT_HOST_ENV_FILE)
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_HOST_ENV_FILE__", str(env_path)
    ).replace(
        "__PROJECT_HOST_LOCAL_ENV_FILE__", str(project_host_local_env_path(env_path))
    )
    storage_path_helper = RUNTIME_STORAGE_PATH_HELPER.replace(
        "__ALLOW_LOOPBACK_RUSTIC_REST__",
        "1" if cfg.allow_loopback_rustic_rest else "0",
    ).replace("__RUNTIME_USER__", cfg.ssh_user)
    wrappers = {
        "/usr/local/libexec/cocalc-managed-project-job": MANAGED_PROJECT_JOB_HELPER.replace(
            "__PROJECT_POOL_CGROUP__", DEFAULT_PROJECT_POOL_CGROUP
        ).replace("__RUNTIME_USER__", cfg.ssh_user),
        "/usr/local/libexec/cocalc-runtime-storage-path-helper": storage_path_helper,
        "/usr/local/libexec/cocalc-project-io-policy": PROJECT_IO_POLICY_HELPER,
        "/usr/local/sbin/cocalc-runtime-storage": storage_wrapper,
        "/usr/local/sbin/cocalc-mount-data": mount_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-ctl": cloud_ctl_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-logs": cloud_logs_wrapper,
    }
    for path, content in wrappers.items():
        p = Path(path)
        text_write_atomic(p, content, default_mode=0o755)
        os.chown(p, 0, 0)
        p.chmod(0o755)

    write_project_io_configuration(cfg)


def reconcile_bees_runtime_policy(cfg: BootstrapConfig) -> None:
    run_best_effort(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-bees",
            "/mnt/cocalc",
        ],
        "reconcile BEES runtime policy",
    )


def reconcile_project_network_limits(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-project-network-limits",
        ],
        "reconcile per-project network containment",
        timeout=60,
    )


def reconcile_project_io_policy(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-project-io-policy",
        ],
        "reconcile per-project I/O containment",
        # Device discovery can approach two minutes on small, busy hosts.
        # Keep this bounded while leaving enough margin for fleet reconciliation.
        timeout=300,
    )


def reconcile_host_service_cgroup(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-host-service-cgroup",
        ],
        "reconcile project-host service priority",
        timeout=30,
    )


def reconcile_storage_and_containment(cfg: BootstrapConfig) -> None:
    # Network reconciliation creates the project-pool hierarchy, which also
    # applies io.max. Establish every required writable mount before that
    # fail-closed policy can inspect the capacity manifest.
    ensure_cocalc_mount(cfg)
    setup_shared_scratch(cfg)
    ensure_btrfs_data(cfg)
    reconcile_bees_runtime_policy(cfg)
    reconcile_project_network_limits(cfg)
    reconcile_project_io_policy(cfg)
    reconcile_host_service_cgroup(cfg)


def ensure_btrfs_data(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: ensuring /mnt/cocalc/data subvolume")
    try:
        run_cmd(cfg, ["btrfs", "subvolume", "show", "/mnt/cocalc/data"], "btrfs subvolume show", check=False)
    except Exception:
        pass
    if not Path(DATA_ROOT).exists():
        try:
            run_cmd(cfg, ["btrfs", "subvolume", "create", DATA_ROOT], "btrfs subvolume create", check=False)
        except Exception:
            Path(DATA_ROOT).mkdir(parents=True, exist_ok=True)
    # The data dir is handed to the runtime user, so its entries are theirs:
    # set them up through descriptors, refusing a symlink.
    owner = runtime_file_owner(cfg)
    data_fd = open_dir_nofollow(DATA_ROOT)
    try:
        if owner is not None:
            os.fchown(data_fd, *owner)
        for name, mode in (("secrets", None), ("tmp", 0o1777)):
            try:
                os.mkdir(name, 0o755, dir_fd=data_fd)
            except FileExistsError:
                pass
            try:
                fd = os.open(name, O_DIR_NOFOLLOW, dir_fd=data_fd)
            except OSError as err:
                if err.errno in (errno.ELOOP, errno.ENOTDIR):
                    log_line(cfg, f"bootstrap: refusing {DATA_ROOT}/{name}: a symlink or not a directory")
                    continue
                raise
            try:
                if mode is not None:
                    os.fchmod(fd, mode)
                if owner is not None:
                    os.fchown(fd, *owner)
            finally:
                os.close(fd)
    finally:
        os.close(data_fd)
    repair_host_data_ownership(cfg)


def project_host_runtime_is_active() -> bool:
    markers = (b"project-host:app", b"cocalc-project-podman", b"/conmon")
    proc = Path("/proc")
    try:
        entries = proc.iterdir()
    except OSError:
        return True
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
            continue
        if any(marker in cmdline for marker in markers):
            return True
    return False


def configured_podman_runroot(path: Path) -> str | None:
    # In the runtime user's home: no symlink followed on the way, only a file.
    try:
        dir_fd = open_dir_nofollow(path.parent)
    except (OSError, UnsafeRuntimePath):
        return None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    except OSError:
        return None
    finally:
        os.close(dir_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as f:
            text = f.read(1 << 20)
    except (OSError, ValueError):
        return None
    finally:
        os.close(fd)
    match = re.search(r'^\s*runroot\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else None


ROOT_PODMAN_UNITS_TO_STOP = ("podman-auto-update.timer", "podman.socket")
ROOT_PODMAN_UNITS_TO_MASK = (
    "podman-auto-update.timer",
    "podman-auto-update.service",
    "podman.service",
    "podman.socket",
    "podman-clean-transient.service",
)


def disable_root_podman_units(cfg: BootstrapConfig) -> None:
    """The distribution's root podman units (auto-update, the API socket,
    boot-time prune) aren't used by CoCalc: stopped and masked, on every
    reconcile. Our own podman calls are unaffected."""
    if shutil.which("systemctl") is None:
        return
    run_best_effort(
        cfg,
        ["systemctl", "disable", "--now", *ROOT_PODMAN_UNITS_TO_STOP],
        "stop the distribution's root podman units",
    )
    run_best_effort(
        cfg,
        ["systemctl", "mask", *ROOT_PODMAN_UNITS_TO_MASK],
        "mask the distribution's root podman units",
    )


