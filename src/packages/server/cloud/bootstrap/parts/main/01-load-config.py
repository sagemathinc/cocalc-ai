def load_config(bootstrap_dir: str) -> BootstrapConfig:
    facts_path = Path(bootstrap_dir) / "bootstrap-host-facts.json"
    desired_path = Path(bootstrap_dir) / "bootstrap-desired-state.json"
    facts = json_load(facts_path)
    desired = json_load(desired_path)
    _require(bool(facts), f"missing bootstrap host facts: {facts_path}")
    _require(bool(desired), f"missing bootstrap desired state: {desired_path}")
    bundle_host = desired.get("project_host_bundle") or {}
    bundle_container_runtime = desired.get("container_runtime_bundle") or None
    bundle_project = desired.get("project_bundle") or {}
    bundle_tools = desired.get("tools_bundle") or {}
    cloudflared = desired.get("cloudflared") or {}
    shared_scratch = desired.get("shared_scratch") or {}
    bootstrap_meta = desired.get("bootstrap") or {}
    bootstrap_connection = desired.get("bootstrap_connection") or {}
    cloudflared_protocol = str(cloudflared.get("protocol") or "auto").strip().lower()
    _require(
        cloudflared_protocol in {"auto", "quic", "http2"},
        "cloudflared.protocol must be auto, quic, or http2",
    )
    cloudflared_grace_period_seconds = int(
        cloudflared.get("gracePeriodSeconds")
        or cloudflared.get("grace_period_seconds")
        or 10
    )
    _require(
        1 <= cloudflared_grace_period_seconds <= 30,
        "cloudflared.gracePeriodSeconds must be between 1 and 30",
    )
    project_io_capacity = _ensure_object(
        desired.get("project_io_capacity")
        or {
            "version": 1,
            "provider": "unknown",
            "targets": [
                {
                    "mountpoint": "/mnt/cocalc",
                    "discovery": "btrfs",
                    "disk_type": "unknown",
                    "required": True,
                }
            ],
        },
        "bootstrap-desired-state.project_io_capacity",
    )
    return BootstrapConfig(
        bootstrap_user=_ensure_str(
            facts.get("bootstrap_user"), "bootstrap-host-facts.bootstrap_user"
        ),
        bootstrap_home=_ensure_str(
            facts.get("bootstrap_home"), "bootstrap-host-facts.bootstrap_home"
        ),
        bootstrap_root=_ensure_str(
            facts.get("bootstrap_root"), "bootstrap-host-facts.bootstrap_root"
        ),
        bootstrap_dir=_ensure_str(
            facts.get("bootstrap_dir"), "bootstrap-host-facts.bootstrap_dir"
        ),
        bootstrap_tmp=_ensure_str(
            facts.get("bootstrap_tmp"), "bootstrap-host-facts.bootstrap_tmp"
        ),
        log_file=_ensure_str(facts.get("log_file"), "bootstrap-host-facts.log_file"),
        expected_os=_ensure_str(
            facts.get("expected_os"), "bootstrap-host-facts.expected_os"
        ),
        expected_arch=_ensure_str(
            facts.get("expected_arch"), "bootstrap-host-facts.expected_arch"
        ),
        image_size_gb_raw=_ensure_str(
            desired.get("image_size_gb_raw") or "auto",
            "bootstrap-desired-state.image_size_gb_raw",
        ),
        root_reserve_gb_raw=_ensure_str(
            desired.get("root_reserve_gb_raw") or "25",
            "bootstrap-desired-state.root_reserve_gb_raw",
        ),
        data_disk_devices=_ensure_str(
            facts.get("data_disk_devices") or "",
            "bootstrap-host-facts.data_disk_devices",
        ),
        data_disk_candidates=_ensure_str(
            facts.get("data_disk_candidates") or "",
            "bootstrap-host-facts.data_disk_candidates",
        ),
        shared_scratch_enabled=_ensure_bool(
            shared_scratch.get("enabled"),
            "bootstrap-desired-state.shared_scratch.enabled",
            False,
        ),
        shared_scratch_devices=_ensure_str(
            facts.get("shared_scratch_disk_devices") or "",
            "bootstrap-host-facts.shared_scratch_disk_devices",
        ),
        shared_scratch_mount=_ensure_str(
            shared_scratch.get("mount") or "/mnt/cocalc-scratch",
            "bootstrap-desired-state.shared_scratch.mount",
        ),
        shared_scratch_project_mount=_ensure_str(
            shared_scratch.get("project_mount") or "/scratch",
            "bootstrap-desired-state.shared_scratch.project_mount",
        ),
        shared_scratch_filesystem=_ensure_str(
            shared_scratch.get("filesystem") or "ext4",
            "bootstrap-desired-state.shared_scratch.filesystem",
        ),
        project_io_capacity=project_io_capacity,
        project_io_policy=_ensure_object(
            desired.get("project_io_policy")
            or build_project_io_policy(project_io_capacity),
            "bootstrap-desired-state.project_io_policy",
        ),
        apt_packages=[
            str(p)
            for p in _ensure_list(
                desired.get("apt_packages") or [],
                "bootstrap-desired-state.apt_packages",
            )
        ],
        has_gpu=_ensure_bool(facts.get("has_gpu"), "bootstrap-host-facts.has_gpu"),
        ssh_user=_ensure_str(
            facts.get("runtime_user") or facts.get("ssh_user"),
            "bootstrap-host-facts.runtime_user",
        ),
        env_file=_ensure_str(facts.get("env_file"), "bootstrap-host-facts.env_file"),
        env_lines=[
            str(line)
            for line in _ensure_list(
                desired.get("env_lines") or [],
                "bootstrap-desired-state.env_lines",
            )
        ],
        node_version=_ensure_str(
            desired.get("node_version"), "bootstrap-desired-state.node_version"
        ),
        bootstrap_selector=(bootstrap_meta.get("selector") or None),
        bootstrap_py_url=(bootstrap_meta.get("url") or None),
        project_host_bundle=BundleSpec(
            url=_ensure_str(bundle_host.get("url"), "project_host_bundle.url"),
            sha256=bundle_host.get("sha256") or None,
            remote=_ensure_str(bundle_host.get("remote"), "project_host_bundle.remote"),
            root=_ensure_str(bundle_host.get("root"), "project_host_bundle.root"),
            dir=_ensure_str(bundle_host.get("dir"), "project_host_bundle.dir"),
            current=_ensure_str(bundle_host.get("current"), "project_host_bundle.current"),
            version=bundle_host.get("version"),
            manifest_url=bundle_host.get("manifest_url") or None,
            fallback_manifest_url=bundle_host.get("fallback_manifest_url") or None,
        ),
        project_bundle=BundleSpec(
            url=_ensure_str(bundle_project.get("url"), "project_bundle.url"),
            sha256=bundle_project.get("sha256") or None,
            remote=_ensure_str(bundle_project.get("remote"), "project_bundle.remote"),
            root=_ensure_str(bundle_project.get("root"), "project_bundle.root"),
            dir=_ensure_str(bundle_project.get("dir"), "project_bundle.dir"),
            current=_ensure_str(bundle_project.get("current"), "project_bundle.current"),
            version=bundle_project.get("version"),
            manifest_url=bundle_project.get("manifest_url") or None,
            fallback_manifest_url=bundle_project.get("fallback_manifest_url") or None,
        ),
        tools_bundle=BundleSpec(
            url=_ensure_str(bundle_tools.get("url"), "tools_bundle.url"),
            sha256=bundle_tools.get("sha256") or None,
            remote=_ensure_str(bundle_tools.get("remote"), "tools_bundle.remote"),
            root=_ensure_str(bundle_tools.get("root"), "tools_bundle.root"),
            dir=_ensure_str(bundle_tools.get("dir"), "tools_bundle.dir"),
            current=_ensure_str(bundle_tools.get("current"), "tools_bundle.current"),
            version=bundle_tools.get("version"),
            manifest_url=bundle_tools.get("manifest_url") or None,
            fallback_manifest_url=bundle_tools.get("fallback_manifest_url") or None,
        ),
        cloudflared=CloudflaredSpec(
            enabled=_ensure_bool(cloudflared.get("enabled"), "cloudflared.enabled"),
            hostname=cloudflared.get("hostname"),
            port=cloudflared.get("port"),
            exam_hostname=cloudflared.get("examHostname")
            or cloudflared.get("exam_hostname"),
            ssh_hostname=cloudflared.get("sshHostname")
            or cloudflared.get("ssh_hostname"),
            ssh_port=cloudflared.get("sshPort") or cloudflared.get("ssh_port"),
            token=cloudflared.get("token"),
            tunnel_id=cloudflared.get("tunnelId") or cloudflared.get("tunnel_id"),
            creds_json=cloudflared.get("credsJson") or cloudflared.get("creds_json"),
            protocol=cloudflared_protocol,
            grace_period_seconds=cloudflared_grace_period_seconds,
        ),
        conat_url=bootstrap_connection.get("conat_url") or None,
        status_url=bootstrap_connection.get("status_url") or None,
        bootstrap_token=bootstrap_connection.get("bootstrap_token") or None,
        ca_cert_path=bootstrap_connection.get("ca_cert_path") or None,
        bootstrap_done_paths=[
            str(p)
            for p in _ensure_list(
                desired.get("bootstrap_done_paths") or [],
                "bootstrap-desired-state.bootstrap_done_paths",
            )
        ],
        container_runtime_bundle=(
            BundleSpec(
                url=_ensure_str(
                    bundle_container_runtime.get("url"),
                    "container_runtime_bundle.url",
                ),
                sha256=bundle_container_runtime.get("sha256") or None,
                remote=_ensure_str(
                    bundle_container_runtime.get("remote"),
                    "container_runtime_bundle.remote",
                ),
                root=_ensure_str(
                    bundle_container_runtime.get("root"),
                    "container_runtime_bundle.root",
                ),
                dir=_ensure_str(
                    bundle_container_runtime.get("dir"),
                    "container_runtime_bundle.dir",
                ),
                current=_ensure_str(
                    bundle_container_runtime.get("current"),
                    "container_runtime_bundle.current",
                ),
                version=bundle_container_runtime.get("version"),
                manifest_url=bundle_container_runtime.get("manifest_url") or None,
                fallback_manifest_url=bundle_container_runtime.get(
                    "fallback_manifest_url"
                )
                or None,
            )
            if bundle_container_runtime
            else None
        ),
        project_runtime_uid_mode=effective_project_runtime_uid_mode(
            desired.get("project_runtime_uid_mode"),
            facts.get("env_file"),
        ),
    )


def effective_project_runtime_uid_mode(desired_value: Any, env_file: Any) -> str:
    """The host's project runtime uid mode.

    COCALC_PROJECT_RUNTIME_UID_MODE in the operator's local env file (the
    same file project-host reads) wins over the desired state, so one setting
    per host drives both the subuid allocation and project-host.
    """
    if isinstance(env_file, str) and env_file:
        local = read_env_assignments(project_host_local_env_path(Path(env_file)))
        value = local.get("COCALC_PROJECT_RUNTIME_UID_MODE", "").strip()
        if value:
            return parse_project_runtime_uid_mode(value)
    return parse_project_runtime_uid_mode(desired_value)


def parse_project_runtime_uid_mode(value: Any) -> str:
    """A valid mode, or "invalid": a typo must not stop a host's bootstrap.
    project-host refuses project starts on an invalid mode and reports it in
    its health; here it keeps the separate block, the strictest allocation
    (the block comes after the container ranges, so keep-id is unaffected)."""
    if value is None or value == "":
        return "keep-id"
    if isinstance(value, str) and value in PROJECT_RUNTIME_UID_MODES:
        return value
    print(
        # never the value as set: it is environment content
        "bootstrap: invalid project runtime uid mode "
        f"(expected one of {', '.join(PROJECT_RUNTIME_UID_MODES)}); keeping the "
        "separate uid block, and project-host refuses project starts",
        file=sys.stderr,
    )
    return "invalid"


def parse_only(arg: str | None) -> set[str] | None:
    if not arg:
        return None
    parts = [p.strip().lower() for p in arg.split(",") if p.strip()]
    if not parts:
        return None
    return set(parts)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def bootstrap_host_facts_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-host-facts.json"


def bootstrap_desired_state_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-desired-state.json"


def bootstrap_state_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-state.json"


def current_bootstrap_sha256() -> str | None:
    try:
        path = Path(__file__).resolve()
        h = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def json_write_atomic(path: Path, payload: dict[str, Any]) -> None:
    text_write_atomic(
        path,
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
    )


def text_write_atomic(
    path: Path, content: str, *, default_mode: int = 0o644, fsync: bool = False
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    tmp = Path(tmp_name)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
        if fsync:
            handle.flush()
            os.fsync(handle.fileno())
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        mode = default_mode
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def bootstrap_lock_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap.lock"


def bootstrap_lock_timeout_seconds() -> float:
    raw = os.environ.get("COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS", "").strip()
    if not raw:
        return 300.0
    try:
        value = float(raw)
    except ValueError:
        return 300.0
    if value <= 0:
        return 300.0
    return value


@contextmanager
def bootstrap_operation_lock(cfg: BootstrapConfig):
    lock_path = bootstrap_lock_path(cfg)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    timeout_seconds = bootstrap_lock_timeout_seconds()
    deadline = time.monotonic() + timeout_seconds
    with lock_path.open("a+", encoding="utf-8") as handle:
        log_line(cfg, f"bootstrap: acquiring lifecycle lock {lock_path}")
        next_wait_log_at = time.monotonic() + 30.0
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                now = time.monotonic()
                if now >= deadline:
                    raise TimeoutError(
                        f"timed out waiting for lifecycle lock {lock_path} after {int(timeout_seconds)}s"
                    )
                if now >= next_wait_log_at:
                    remaining = max(0, int(deadline - now))
                    log_line(
                        cfg,
                        f"bootstrap: waiting for lifecycle lock {lock_path} remaining={remaining}s",
                    )
                    next_wait_log_at = now + 30.0
                time.sleep(min(1.0, max(0.05, deadline - now)))
        try:
            log_line(cfg, f"bootstrap: acquired lifecycle lock {lock_path}")
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def parse_env_assignment_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    eq = stripped.find("=")
    if eq <= 0:
        raise RuntimeError(f"invalid env assignment line: {line!r}")
    key = stripped[:eq].strip()
    if not ENV_ASSIGNMENT_KEY_RE.match(key):
        raise RuntimeError(f"invalid env assignment key {key!r} in line: {line!r}")
    value = stripped[eq + 1 :]
    if "\n" in value or "\r" in value:
        raise RuntimeError(f"invalid env assignment value in line: {line!r}")
    return key, value


DEFAULT_PROJECT_HOST_PORT = 9002
DEFAULT_PROJECT_HOST_ENV_FILE = "/etc/cocalc/project-host.env"


def project_host_local_env_path(env_path: Path) -> Path:
    """The operator override file that project-host reads after env_path."""
    return env_path.with_name(
        env_path.name[:-4] + ".local.env"
        if env_path.name.endswith(".env")
        else "project-host.local.env"
    )


JS_DECIMAL_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
JS_RADIX_NUMBER = {"0x": (16, "0123456789abcdef"), "0o": (8, "01234567"), "0b": (2, "01")}


def js_positive_integer(value: str | None) -> int | None:
    """JavaScript's Number(value) when it is a positive integer, else None:
    how project-host reads its port settings (parsePort, parsePositiveInteger)."""
    text = str(value if value is not None else "").strip()
    if JS_DECIMAL_NUMBER.fullmatch(text):
        number = float(text)
    elif (
        text[:2].lower() in JS_RADIX_NUMBER
        and len(text) > 2
        and all(c in JS_RADIX_NUMBER[text[:2].lower()][1] for c in text[2:].lower())
    ):
        number = float(int(text[2:], JS_RADIX_NUMBER[text[:2].lower()][0]))
    else:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return int(number) if number == int(number) and number > 0 else None


def project_conat_router_port(env_lines: list[str]) -> int:
    """The port of this host's conat router, a host-local service projects
    may connect to. Derived as project-host derives it (project-host/daemon.ts):
    COCALC_PROJECT_HOST_CONAT_ROUTER_PORT, else PORT + 100, with PORT
    defaulting to 9002. That is daemon index 0, the only one bootstrap runs;
    another daemon on the same host (index > 0, PORT 9002 + index) would need
    its router port allowed too."""
    return project_host_derived_port(
        env_lines, "COCALC_PROJECT_HOST_CONAT_ROUTER_PORT", 100
    )


def project_site_codex_proxy_port(env_lines: list[str]) -> int:
    """The first port of the site-funded Codex proxy range, which projects
    may connect to: COCALC_PROJECT_HOST_SITE_CODEX_PROXY_PORT, else PORT + 300
    (siteFundedCodexProxyPorts in project-host/codex/site-funded-proxy.ts)."""
    return project_host_derived_port(
        env_lines, "COCALC_PROJECT_HOST_SITE_CODEX_PROXY_PORT", 300, minimum=1024
    )


