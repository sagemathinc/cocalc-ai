def build_bootstrap_connection(cfg: BootstrapConfig) -> dict[str, Any]:
    return {
        "conat_url": cfg.conat_url,
        "status_url": cfg.status_url,
        "bootstrap_token": cfg.bootstrap_token,
        "ca_cert_path": cfg.ca_cert_path,
    }


def build_desired_state(cfg: BootstrapConfig) -> dict[str, Any]:
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "recorded_at": now_iso(),
        "bootstrap": {
            "selector": cfg.bootstrap_selector,
            "url": cfg.bootstrap_py_url,
            "sha256": current_bootstrap_sha256(),
        },
        "helper_schema_version": HELPER_SCHEMA_VERSION,
        "runtime_wrapper_version": RUNTIME_WRAPPER_VERSION,
        "node_version": cfg.node_version,
        "image_size_gb_raw": cfg.image_size_gb_raw,
        "root_reserve_gb_raw": cfg.root_reserve_gb_raw,
        "apt_packages": cfg.apt_packages,
        "env_lines": cfg.env_lines,
        "bootstrap_done_paths": cfg.bootstrap_done_paths,
        "shared_scratch": {
            "enabled": cfg.shared_scratch_enabled,
            "mount": cfg.shared_scratch_mount,
            "project_mount": cfg.shared_scratch_project_mount,
            "filesystem": cfg.shared_scratch_filesystem,
        },
        "project_io_capacity": cfg.project_io_capacity,
        "project_io_policy": cfg.project_io_policy,
        "runtime_user_contract": expected_runtime_user_contract(cfg),
        "bootstrap_connection": build_bootstrap_connection(cfg),
        "project_host_bundle": {
            "url": cfg.project_host_bundle.url,
            "sha256": cfg.project_host_bundle.sha256,
            "remote": cfg.project_host_bundle.remote,
            "version": cfg.project_host_bundle.version,
            "root": cfg.project_host_bundle.root,
            "dir": cfg.project_host_bundle.dir,
            "current": cfg.project_host_bundle.current,
            "fallback_manifest_url": cfg.project_host_bundle.fallback_manifest_url,
        },
        "project_bundle": {
            "url": cfg.project_bundle.url,
            "sha256": cfg.project_bundle.sha256,
            "remote": cfg.project_bundle.remote,
            "version": cfg.project_bundle.version,
            "root": cfg.project_bundle.root,
            "dir": cfg.project_bundle.dir,
            "current": cfg.project_bundle.current,
            "fallback_manifest_url": cfg.project_bundle.fallback_manifest_url,
        },
        "tools_bundle": {
            "url": cfg.tools_bundle.url,
            "sha256": cfg.tools_bundle.sha256,
            "remote": cfg.tools_bundle.remote,
            "version": cfg.tools_bundle.version,
            "root": cfg.tools_bundle.root,
            "dir": cfg.tools_bundle.dir,
            "current": cfg.tools_bundle.current,
            "manifest_url": cfg.tools_bundle.manifest_url,
            "fallback_manifest_url": cfg.tools_bundle.fallback_manifest_url,
        },
        "cloudflared": {
            "enabled": cfg.cloudflared.enabled,
            "hostname": cfg.cloudflared.hostname,
            "exam_hostname": cfg.cloudflared.exam_hostname,
            "port": cfg.cloudflared.port,
            "ssh_hostname": cfg.cloudflared.ssh_hostname,
            "ssh_port": cfg.cloudflared.ssh_port,
            "tunnel_id": cfg.cloudflared.tunnel_id,
            "protocol": cfg.cloudflared.protocol,
            "grace_period_seconds": cfg.cloudflared.grace_period_seconds,
        },
    }
    if cfg.container_runtime_bundle is not None:
        state["container_runtime_bundle"] = {
            "url": cfg.container_runtime_bundle.url,
            "sha256": cfg.container_runtime_bundle.sha256,
            "remote": cfg.container_runtime_bundle.remote,
            "version": cfg.container_runtime_bundle.version,
            "root": cfg.container_runtime_bundle.root,
            "dir": cfg.container_runtime_bundle.dir,
            "current": cfg.container_runtime_bundle.current,
            "manifest_url": cfg.container_runtime_bundle.manifest_url,
            "fallback_manifest_url": cfg.container_runtime_bundle.fallback_manifest_url,
        }
    return state


def refresh_installed_state(cfg: BootstrapConfig, base: dict[str, Any] | None = None) -> dict[str, Any]:
    state = dict(base or {})
    state["schema_version"] = STATE_SCHEMA_VERSION
    state["recorded_at"] = now_iso()
    state["bootstrap"] = {
        "sha256": current_bootstrap_sha256(),
        "url": cfg.bootstrap_py_url,
        "selector": cfg.bootstrap_selector,
    }
    state["helper_schema_version"] = helper_schema_installed(cfg)
    state["runtime_wrapper_version"] = runtime_wrapper_version_installed()
    state["runtime_user_contract"] = read_current_runtime_user_contract(cfg)
    state["installed"] = {
        "project_host_bundle_version": symlink_version(cfg.project_host_bundle.current),
        "project_bundle_version": symlink_version(cfg.project_bundle.current),
        "tools_bundle_version": symlink_version(cfg.tools_bundle.current),
        "container_runtime_version": (
            symlink_version(cfg.container_runtime_bundle.current)
            if cfg.container_runtime_bundle is not None
            else None
        ),
    }
    return state


def write_bootstrap_state_files(cfg: BootstrapConfig) -> None:
    json_write_atomic(bootstrap_host_facts_path(cfg), build_host_facts(cfg))
    json_write_atomic(bootstrap_desired_state_path(cfg), build_desired_state(cfg))
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def _selected_fields(source: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    return {field: source[field] for field in fields if field in source}


def write_bootstrap_lifecycle_export(cfg: BootstrapConfig) -> None:
    """Publish only the non-secret state needed by project-host heartbeats."""
    desired = json_load(bootstrap_desired_state_path(cfg))
    installed = json_load(bootstrap_state_path(cfg))
    facts = json_load(bootstrap_host_facts_path(cfg))
    public_desired = _selected_fields(
        desired,
        [
            "schema_version",
            "recorded_at",
            "helper_schema_version",
            "runtime_wrapper_version",
            "runtime_user_contract",
        ],
    )
    public_desired["bootstrap"] = _selected_fields(
        desired.get("bootstrap") or {}, ["selector", "url", "sha256"]
    )
    for key in (
        "project_host_bundle",
        "project_bundle",
        "tools_bundle",
        "container_runtime_bundle",
    ):
        fields = ["version"]
        if key == "project_host_bundle":
            fields.append("root")
        public_desired[key] = _selected_fields(desired.get(key) or {}, fields)
    public_desired["tools_bundle"]["root"] = cfg.tools_bundle.root
    public_desired["tools_bundle"]["retention_lock_protocol"] = 1
    public_desired["cloudflared"] = _selected_fields(
        desired.get("cloudflared") or {}, ["enabled"]
    )

    public_installed = _selected_fields(
        installed,
        [
            "schema_version",
            "recorded_at",
            "helper_schema_version",
            "runtime_wrapper_version",
            "runtime_user_contract",
            "installed",
            "current_operation",
            "last_error",
            "last_provision_started_at",
            "last_provision_finished_at",
            "last_provision_result",
            "last_reconcile_started_at",
            "last_reconcile_finished_at",
            "last_reconcile_result",
            "provisioned",
        ],
    )
    public_installed["bootstrap"] = _selected_fields(
        installed.get("bootstrap") or {}, ["selector", "url", "sha256"]
    )
    public_facts = _selected_fields(
        facts,
        [
            "schema_version",
            "recorded_at",
            "bootstrap_root",
            "project_host_bundle_root",
        ],
    )

    export_dir = BOOTSTRAP_LIFECYCLE_EXPORT_DIR
    export_dir.mkdir(parents=True, exist_ok=True)
    export_dir.chmod(0o755)
    exports = {
        "bootstrap-desired-state.json": public_desired,
        "bootstrap-state.json": public_installed,
        "bootstrap-host-facts.json": public_facts,
    }
    for name, payload in exports.items():
        path = export_dir / name
        json_write_atomic(path, payload)
        path.chmod(0o644)


def record_operation_start(cfg: BootstrapConfig, operation: str) -> None:
    write_bootstrap_state_files(cfg)
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_started_at"] = now_iso()
    state[f"last_{operation}_result"] = "running"
    state["current_operation"] = operation
    state["last_error"] = None
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def record_operation_success(cfg: BootstrapConfig, operation: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "success"
    state["current_operation"] = None
    state["last_error"] = None
    if operation == "provision":
        state["provisioned"] = True
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def record_operation_failure(cfg: BootstrapConfig, operation: str, error: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "error"
    state["current_operation"] = None
    state["last_error"] = error
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def log_line(cfg: BootstrapConfig, message: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"{ts} {message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if cfg.log_file:
        Path(cfg.log_file).parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(cfg.log_file, "a", encoding="utf-8") as handle:
                handle.write(line)
        except PermissionError:
            pass


def rotate_bootstrap_log(cfg: BootstrapConfig) -> None:
    if not cfg.log_file:
        return
    log_path = Path(cfg.log_file)
    try:
        if not log_path.exists() or log_path.stat().st_size <= BOOTSTRAP_LOG_MAX_BYTES:
            return
        rotated = log_path.with_name(f"{log_path.name}.1")
        if rotated.exists():
            rotated.unlink()
        log_path.rename(rotated)
    except OSError:
        pass


def run_cmd(
    cfg: BootstrapConfig,
    args: list[str],
    desc: str,
    *,
    timeout: int | None = None,
    check: bool = True,
    as_user: str | None = None,
    env: dict[str, str] | None = None,
    cwd: str | Path | None = None,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[str]:
    cmd = args
    if as_user and os.geteuid() == 0 and as_user != "root":
        cmd = ["sudo", "-u", as_user, "-H"] + args
    run_cwd = str(cwd) if cwd is not None else None
    cwd_label = f" cwd={run_cwd}" if run_cwd else ""
    log_line(cfg, f"bootstrap: running {desc}{cwd_label}: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        env=env,
        cwd=run_cwd,
        pass_fds=pass_fds,
    )
    if result.stdout:
        for line in result.stdout.splitlines():
            log_line(cfg, line)
    if check and result.returncode != 0:
        raise RuntimeError(f"{desc} failed with exit code {result.returncode}")
    return result


def run_best_effort(
    cfg: BootstrapConfig,
    args: list[str],
    desc: str,
    *,
    timeout: int | None = None,
) -> None:
    try:
        run_cmd(cfg, args, desc, check=False, timeout=timeout)
    except Exception as exc:
        log_line(cfg, f"bootstrap: {desc} failed (ignored): {exc}")


def install_nvidia_cdi_normalizer() -> None:
    path = Path("/usr/local/sbin/cocalc-nvidia-cdi-normalize")
    path.write_text(NVIDIA_CDI_NORMALIZER_SCRIPT, encoding="utf-8")
    os.chmod(path, 0o755)


def normalize_nvidia_cdi_for_podman(cfg: BootstrapConfig) -> None:
    # Ubuntu 24.04 currently ships Podman 4.9, which does not understand the
    # NVIDIA Toolkit 1.19 default CDI 0.7 spec. Normalize to the older subset
    # that Podman 4 accepts so rootless project containers can resolve GPUs.
    run_best_effort(
        cfg,
        ["/usr/local/sbin/cocalc-nvidia-cdi-normalize"],
        "normalize nvidia cdi for podman",
    )


def ensure_platform(cfg: BootstrapConfig) -> None:
    os_name = os.uname().sysname.lower()
    if os_name != cfg.expected_os:
        raise RuntimeError(f"unsupported OS {os_name} (expected {cfg.expected_os})")
    arch_raw = os.uname().machine
    if arch_raw in ("x86_64", "amd64"):
        arch = "amd64"
    elif arch_raw in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        raise RuntimeError(f"unsupported architecture {arch_raw}")
    if arch != cfg.expected_arch:
        raise RuntimeError(f"unsupported architecture {arch} (expected {cfg.expected_arch})")


def compute_root_reserve_gb(cfg: BootstrapConfig) -> int:
    raw = cfg.root_reserve_gb_raw
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 15


def compute_image_size(cfg: BootstrapConfig) -> int:
    raw = cfg.image_size_gb_raw
    if raw and raw != "auto":
        try:
            return max(5, int(raw))
        except ValueError:
            pass
    usage = shutil.disk_usage("/")
    total_gb = int(usage.total / (1024**3))
    reserve_gb = compute_root_reserve_gb(cfg)
    target = total_gb - reserve_gb
    if target < 5:
        target = 5
    log_line(
        cfg,
        f"bootstrap: computed btrfs image size {target}G (disk {total_gb}G, reserve {reserve_gb}G)",
    )
    return target


def disable_unattended(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: pausing automatic apt activity")
    run_best_effort(
        cfg,
        [
            "systemctl",
            "stop",
            "apt-daily.timer",
            "apt-daily-upgrade.timer",
            "apt-daily.service",
            "apt-daily-upgrade.service",
            "cocalc-security-updates.timer",
            "cocalc-security-updates.service",
        ],
        "stop automatic apt timers and services",
        timeout=APT_LOCK_TIMEOUT_S,
    )


def apt_run(cfg: BootstrapConfig, args: list[str], desc: str, retries: int, timeout: int) -> None:
    for attempt in range(1, retries + 1):
        try:
            run_cmd(cfg, args, desc, timeout=timeout)
            return
        except Exception as exc:
            if attempt == retries:
                raise
            log_line(cfg, f"bootstrap: {desc} failed (attempt {attempt}/{retries}): {exc}")
            time.sleep(5 if desc == "apt-get update" else 10)


def reconcile_gce_ubuntu_apt_sources(
    cfg: BootstrapConfig, paths: list[Path] | None = None
) -> None:
    source_paths = paths or [
        Path("/etc/apt/sources.list.d/ubuntu.sources"),
        Path("/etc/apt/sources.list"),
    ]
    mirror: str | None = None
    existing: list[tuple[Path, str]] = []
    for path in source_paths:
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            log_line(cfg, f"bootstrap: unable to read apt sources from {path}: {exc}")
            continue
        existing.append((path, text))
        if mirror is None:
            match = GCE_UBUNTU_MIRROR_RE.search(text)
            if match:
                mirror = match.group(0).rstrip("/")
    if mirror is None:
        return
    for path, text in existing:
        updated = (
            text.replace("https://security.ubuntu.com/ubuntu/", f"{mirror}/")
            .replace("http://security.ubuntu.com/ubuntu/", f"{mirror}/")
            .replace("https://security.ubuntu.com/ubuntu", mirror)
            .replace("http://security.ubuntu.com/ubuntu", mirror)
        )
        if updated == text:
            continue
        path.write_text(updated, encoding="utf-8")
        log_line(
            cfg,
            f"bootstrap: rewrote Ubuntu security mirror in {path} to {mirror}",
        )


