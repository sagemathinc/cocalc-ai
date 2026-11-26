def project_host_derived_port(
    env_lines: list[str], key: str, offset: int, minimum: int = 1
) -> int:
    env: dict[str, str] = {}
    for line in env_lines:
        try:
            parsed = parse_env_assignment_line(line)
        except RuntimeError:
            continue
        if parsed is not None:
            env[parsed[0]] = parsed[1].strip().strip("\"'")

    def valid(number: int | None) -> int | None:
        return number if number is not None and number <= 65535 else None

    # The explicit key is read with Number(); PORT is read by parsePort, i.e.
    # Number() of the text after the last ":".
    explicit = valid(js_positive_integer(env.get(key)))
    if explicit is not None and explicit >= minimum:
        return explicit
    raw_port = env.get("PORT")
    base = (
        js_positive_integer(raw_port.rsplit(":", 1)[-1]) if raw_port else None
    ) or DEFAULT_PROJECT_HOST_PORT
    return valid(base + offset) or DEFAULT_PROJECT_HOST_PORT + offset


def read_env_assignments(path: str | Path) -> dict[str, str]:
    env: dict[str, str] = {}
    p = Path(path)
    if not p.exists():
        return env
    for raw_line in p.read_text(encoding="utf-8").splitlines():
        try:
            parsed = parse_env_assignment_line(raw_line)
        except RuntimeError:
            continue
        if parsed is None:
            continue
        key, value = parsed
        env[key] = value
    return env


def project_pool_memory_reserve_env_value(existing_env: dict[str, str]) -> str:
    existing = existing_env.get("COCALC_PROJECT_POOL_MEMORY_RESERVE_MB", "").strip()
    if existing and existing != str(LEGACY_PROJECT_POOL_MEMORY_RESERVE_MB):
        return existing
    return str(DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB)


def project_pool_cpu_reserve_env_value(existing_env: dict[str, str]) -> str:
    existing = existing_env.get("COCALC_PROJECT_POOL_CPU_RESERVE_CORES", "").strip()
    if existing:
        return existing
    return str(DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES)


def render_env_text(lines: list[str]) -> str:
    normalized: list[str] = []
    for line in lines:
        parsed = parse_env_assignment_line(line)
        if parsed is None:
            continue
        key, value = parsed
        normalized.append(f"{key}={value}")
    return "\n".join(normalized) + "\n"


def write_env_file_atomic(path: Path, text: str) -> None:
    previous_text = None
    if path.exists():
        previous_text = path.read_text(encoding="utf-8")
        if previous_text == text:
            return
    if previous_text is not None:
        text_write_atomic(path.with_suffix(path.suffix + ".prev"), previous_text)
    text_write_atomic(path, text)


def json_load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def symlink_version(path: str) -> str | None:
    current = Path(path)
    try:
        if current.is_symlink():
            target = os.readlink(current)
            return Path(target).name or None
        if current.exists():
            return current.name or None
    except Exception:
        return None
    return None


def normalize_map_line(line: str) -> str:
    return " ".join(line.strip().split())


def normalize_map_lines(lines: list[str]) -> list[str]:
    return [normalized for line in lines if (normalized := normalize_map_line(line))]


def runtime_userns_map_fingerprint(uid_map: list[str], gid_map: list[str]) -> str:
    payload = (
        f"uid:{chr(10).join(normalize_map_lines(uid_map))}\n"
        f"gid:{chr(10).join(normalize_map_lines(gid_map))}\n"
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def first_free_numeric_id(used: set[int], start: int) -> int:
    candidate = max(1000, int(start))
    while candidate in used:
        candidate += 1
    return candidate


def resolve_runtime_user_identity(cfg: BootstrapConfig) -> tuple[int, int]:
    user = cfg.ssh_user
    try:
        pw = pwd.getpwnam(user)
        return pw.pw_uid, pw.pw_gid
    except KeyError:
        pass

    used_uids = {entry.pw_uid for entry in pwd.getpwall()}
    used_gids = {entry.gr_gid for entry in grp.getgrall()}

    try:
        group = grp.getgrnam(user)
        desired_gid = group.gr_gid
    except KeyError:
        shared_candidate = first_free_numeric_id(
            used_uids | used_gids,
            max(PROJECT_HOST_RUNTIME_UID, PROJECT_HOST_RUNTIME_GID),
        )
        return shared_candidate, shared_candidate

    if desired_gid not in used_uids:
        return desired_gid, desired_gid
    return first_free_numeric_id(used_uids, PROJECT_HOST_RUNTIME_UID), desired_gid


def runtime_subid_ranges(cfg: BootstrapConfig) -> tuple[tuple[int, int], ...]:
    """The runtime user's subuid/subgid allocation, in /etc/subuid order."""
    if getattr(cfg, "project_runtime_uid_mode", "keep-id") == "separate":
        return (*PROJECT_HOST_RUNTIME_SUBID_RANGES, PROJECT_RUNTIME_UID_BLOCK)
    return PROJECT_HOST_RUNTIME_SUBID_RANGES


def expected_runtime_userns_map(
    cfg: BootstrapConfig,
    ranges: tuple[tuple[int, int], ...] | None = None,
) -> tuple[list[str], list[str]]:
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    uid_map = [f"0 {desired_uid} 1"]
    gid_map = [f"0 {desired_gid} 1"]
    inside = 1
    for start, length in runtime_subid_ranges(cfg) if ranges is None else ranges:
        uid_map.append(f"{inside} {start} {length}")
        gid_map.append(f"{inside} {start} {length}")
        inside += length
    return uid_map, gid_map


def accepted_runtime_userns_maps(
    cfg: BootstrapConfig,
) -> list[tuple[list[str], list[str]]]:
    """The live rootless maps the contract accepts.

    Rootless Podman reads /etc/subuid only when it creates its user namespace,
    and recreating it stops every container on the host. So a host whose
    allocation gained or lost PROJECT_RUNTIME_UID_BLOCK keeps its previous map
    until its next reboot. Accept exactly the map with and the map without
    that one trailing extent; anything else is still a mismatch.
    """
    with_block = (*PROJECT_HOST_RUNTIME_SUBID_RANGES, PROJECT_RUNTIME_UID_BLOCK)
    return [
        expected_runtime_userns_map(cfg, PROJECT_HOST_RUNTIME_SUBID_RANGES),
        expected_runtime_userns_map(cfg, with_block),
    ]


def runtime_userns_map_has_project_uid_block(uid_map: Any) -> bool:
    start, length = PROJECT_RUNTIME_UID_BLOCK
    return isinstance(uid_map, list) and any(
        line.split()[1:] == [str(start), str(length)] for line in uid_map
    )


def expected_runtime_user_contract(cfg: BootstrapConfig) -> dict[str, Any]:
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    uid_map, gid_map = expected_runtime_userns_map(cfg)
    subid_ranges = [f"{start}:{length}" for start, length in runtime_subid_ranges(cfg)]
    return {
        "user": cfg.ssh_user,
        "identity": f"{cfg.ssh_user}:{desired_uid}:{desired_gid}",
        "host_uid": desired_uid,
        "host_gid": desired_gid,
        "subuid_ranges": subid_ranges,
        "subgid_ranges": subid_ranges,
        "uid_map": uid_map,
        "gid_map": gid_map,
        "fingerprint": runtime_userns_map_fingerprint(uid_map, gid_map),
    }


def read_user_subid_ranges(path: Path, user: str) -> list[tuple[int, int]]:
    _raw_lines, entries = parse_subid_entries(path)
    return [(start, length) for name, start, length in entries if name == user]


def run_bounded_capture(
    args: list[str], timeout_s: float
) -> subprocess.CompletedProcess[str]:
    """Capture a command without allowing descendants to survive a timeout."""
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = proc.communicate()
        return subprocess.CompletedProcess(args, 124, stdout, stderr)
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)


def podman_apparmor_exec_prefix() -> list[str]:
    aa_exec = shutil.which("aa-exec")
    if not aa_exec:
        return []
    try:
        probe = subprocess.run(
            [aa_exec, "-p", "podman", "--", "true"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=APPARMOR_PROFILE_PROBE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if probe.returncode == 0:
        return [aa_exec, "-p", "podman", "--"]
    return []


def podman_probe_error(proc: subprocess.CompletedProcess[str]) -> str:
    return " ".join(f"{proc.stderr or ''}\n{proc.stdout or ''}".split())[:1000]


def podman_has_stale_boot_state(proc: subprocess.CompletedProcess[str]) -> bool:
    error = podman_probe_error(proc)
    return any(pattern.search(error) for pattern in PODMAN_STALE_BOOT_ERROR_PATTERNS)


def repair_stale_podman_boot_state(
    cfg: BootstrapConfig,
    *,
    uid: int,
    gid: int,
    runtime_dir: str,
    run_as_runtime_user: Callable[[list[str]], Any],
    podman_unshare: list[str] | None = None,
) -> None:
    if project_host_runtime_is_active():
        raise RuntimeError(
            "refusing to clear stale Podman boot state while project runtimes are active"
        )
    expected_runtime_dir = Path(default_podman_runtime_dir(uid))
    if Path(runtime_dir) != expected_runtime_dir:
        raise RuntimeError(
            "refusing to clear stale Podman boot state outside the managed runtime "
            f"directory (configured={runtime_dir!r}, expected={str(expected_runtime_dir)!r})"
        )
    rootless_run = Path("/run/cocalc/containers/rootless") / cfg.ssh_user
    runtime_tmp = expected_runtime_dir / "libpod" / "tmp"
    for path in (
        rootless_run,
        expected_runtime_dir,
        expected_runtime_dir / "libpod",
        runtime_tmp,
    ):
        if path.is_symlink():
            raise RuntimeError(
                f"refusing to clear stale Podman boot state through symlink {path}"
            )
    # runtime_tmp first: it holds the stale pause state, which `podman
    # unshare` would otherwise try to join.
    for path in (runtime_tmp, rootless_run):
        remove_runtime_tree(
            path, run_as_runtime_user, podman_unshare, runtime_ids=(uid, gid)
        )
    ensure_owned_runtime_dir(rootless_run, uid, gid)
    ensure_owned_runtime_dir(expected_runtime_dir, uid, gid)
    log_line(
        cfg,
        "bootstrap: cleared stale rootless Podman boot-scoped state after host reboot",
    )


def read_current_runtime_user_contract(cfg: BootstrapConfig) -> dict[str, Any]:
    contract: dict[str, Any] = {"user": cfg.ssh_user}
    try:
        pw = pwd.getpwnam(cfg.ssh_user)
    except KeyError:
        return contract
    contract["host_uid"] = pw.pw_uid
    contract["host_gid"] = pw.pw_gid
    contract["identity"] = f"{cfg.ssh_user}:{pw.pw_uid}:{pw.pw_gid}"
    contract["subuid_ranges"] = [
        f"{start}:{length}" for start, length in read_user_subid_ranges(Path("/etc/subuid"), cfg.ssh_user)
    ]
    contract["subgid_ranges"] = [
        f"{start}:{length}" for start, length in read_user_subid_ranges(Path("/etc/subgid"), cfg.ssh_user)
    ]
    runtime_current = Path(
        os.environ.get(
            "COCALC_CONTAINER_RUNTIME_CURRENT",
            "/opt/cocalc/container-runtime/current",
        )
    )
    managed_podman = runtime_current / "bin" / "podman"
    managed_conf = runtime_current / "etc" / "containers" / "containers.conf"
    runtime_env: list[str] = []
    runtime_dir = default_podman_runtime_dir(pw.pw_uid)
    if managed_podman.is_file() and os.access(managed_podman, os.X_OK):
        podman = str(managed_podman)
        env_assignments = read_env_assignments(cfg.env_file)
        runtime_dir = (
            env_assignments.get("COCALC_PODMAN_RUNTIME_DIR")
            or env_assignments.get("XDG_RUNTIME_DIR")
            or default_podman_runtime_dir(pw.pw_uid)
        )
        runtime_env = [
            f"PATH={runtime_current / 'bin'}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            f"CONTAINERS_CONF_OVERRIDE={managed_conf}",
            f"XDG_RUNTIME_DIR={runtime_dir}",
            f"COCALC_PODMAN_RUNTIME_DIR={runtime_dir}",
            'CONTAINERS_CGROUP_MANAGER=cgroupfs',
        ]
    else:
        podman = shutil.which("podman")
    if not podman:
        return contract
    if os.geteuid() == 0 and cfg.ssh_user != "root":
        prefix = ["sudo", "-u", cfg.ssh_user, "-H", "env", *runtime_env]
    else:
        prefix = ["env", *runtime_env] if runtime_env else []
    apparmor_prefix = podman_apparmor_exec_prefix()
    podman_command = shlex.join(
        [*apparmor_prefix, podman, "unshare", "cat", "/proc/self/uid_map"]
    )
    uid_proc = run_bounded_capture(
        prefix + ["bash", "-lc", f'cd "$HOME" && exec {podman_command}'],
        RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S,
    )
    if uid_proc.returncode != 0 and podman_has_stale_boot_state(uid_proc):

        def run_as_runtime_user(argv: list[str]) -> subprocess.CompletedProcess[str]:
            return run_bounded_capture(
                prefix + ["bash", "-lc", f'cd "$HOME" && exec {shlex.join(argv)}'],
                RUNTIME_TREE_REMOVE_TIMEOUT_S,
            )

        try:
            repair_stale_podman_boot_state(
                cfg,
                uid=pw.pw_uid,
                gid=pw.pw_gid,
                runtime_dir=runtime_dir,
                run_as_runtime_user=run_as_runtime_user,
                podman_unshare=[*apparmor_prefix, podman, "unshare"],
            )
            uid_proc = run_bounded_capture(
                prefix + ["bash", "-lc", f'cd "$HOME" && exec {podman_command}'],
                RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S,
            )
        except Exception as exc:
            contract["probe_error"] = (
                f"{podman_probe_error(uid_proc)}; automatic stale-boot repair failed: {exc}"
            )[:2000]
            return contract
    if uid_proc.returncode != 0:
        contract["probe_error"] = podman_probe_error(uid_proc)
        log_line(
            cfg,
            "bootstrap: unable to inspect runtime uid map "
            f"(exit={uid_proc.returncode}); continuing without userns map facts",
        )
        return contract
    podman_command = shlex.join(
        [*apparmor_prefix, podman, "unshare", "cat", "/proc/self/gid_map"]
    )
    gid_proc = run_bounded_capture(
        prefix + ["bash", "-lc", f'cd "$HOME" && exec {podman_command}'],
        RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S,
    )
    if uid_proc.returncode == 0 and gid_proc.returncode == 0:
        uid_map = normalize_map_lines(uid_proc.stdout.splitlines())
        gid_map = normalize_map_lines(gid_proc.stdout.splitlines())
        contract["uid_map"] = uid_map
        contract["gid_map"] = gid_map
        contract["fingerprint"] = runtime_userns_map_fingerprint(uid_map, gid_map)
    return contract


def helper_schema_installed(cfg: BootstrapConfig) -> str | None:
    path = project_host_rootctl_path(cfg)
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None
    match = re.search(r'^HELPER_SCHEMA_VERSION="([^"]+)"$', text, re.MULTILINE)
    return match.group(1) if match else None


def runtime_wrapper_version_installed() -> str | None:
    return (
        RUNTIME_WRAPPER_VERSION
        if Path("/usr/local/sbin/cocalc-runtime-storage").exists()
        else None
    )


def build_host_facts(cfg: BootstrapConfig) -> dict[str, Any]:
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "recorded_at": now_iso(),
        "bootstrap_user": cfg.bootstrap_user,
        "bootstrap_home": cfg.bootstrap_home,
        "bootstrap_root": cfg.bootstrap_root,
        "bootstrap_dir": cfg.bootstrap_dir,
        "bootstrap_tmp": cfg.bootstrap_tmp,
        "log_file": cfg.log_file,
        "runtime_user": cfg.ssh_user,
        "expected_os": cfg.expected_os,
        "expected_arch": cfg.expected_arch,
        "has_gpu": cfg.has_gpu,
        "env_file": cfg.env_file,
        "data_disk_devices": cfg.data_disk_devices,
        "data_disk_candidates": cfg.data_disk_candidates,
        "shared_scratch_disk_devices": cfg.shared_scratch_devices,
        "runtime_user_host_uid": desired_uid,
        "runtime_user_host_gid": desired_gid,
        "project_host_bundle_root": cfg.project_host_bundle.root,
        "container_runtime_root": (
            cfg.container_runtime_bundle.root
            if cfg.container_runtime_bundle is not None
            else None
        ),
        "project_bundle_root": cfg.project_bundle.root,
        "tools_root": cfg.tools_bundle.root,
    }


