def configure_podman(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring podman storage")
    runtime_run_root = Path("/run/cocalc")
    container_run_root = runtime_run_root / "containers"
    rootless_run_root = container_run_root / "rootless"
    root_run = container_run_root / "root"
    rootless_run = rootless_run_root / cfg.ssh_user
    user_config_root = Path(runtime_home(cfg)) / ".config"
    user_config = user_config_root / "containers"
    user_storage_conf = user_config / "storage.conf"
    current_rootless_run = configured_podman_runroot(user_storage_conf)
    migration_pending = Path(DATA_ROOT) / "containers" / "runroot-migration-pending"
    if (
        current_rootless_run
        and current_rootless_run != str(rootless_run)
        and project_host_runtime_is_active()
    ):
        # under the runtime user's data dir: written through a descriptor
        marker_dir = open_dir_nofollow(migration_pending.parent, create=True)
        try:
            write_file_at(
                marker_dir,
                migration_pending.name,
                f"current={current_rootless_run}\ndesired={rootless_run}\n",
                0o644,
                None,
            )
        finally:
            os.close(marker_dir)
        log_line(
            cfg,
            "bootstrap: deferring Podman runroot migration until the next safe host boot",
        )
        return

    runtime_run_root.mkdir(parents=True, exist_ok=True)
    container_run_root.mkdir(parents=True, exist_ok=True)
    rootless_run_root.mkdir(parents=True, exist_ok=True)
    root_run.mkdir(parents=True, exist_ok=True)
    run_best_effort(
        cfg,
        [
            "chmod",
            "0711",
            str(runtime_run_root),
            str(container_run_root),
            str(rootless_run_root),
        ],
        "make Podman runroot parents traversable",
    )
    run_best_effort(
        cfg,
        ["chmod", "0700", str(root_run)],
        "restrict root Podman runroot",
    )
    Path("/etc/containers").mkdir(parents=True, exist_ok=True)
    Path("/etc/containers/storage.conf").write_text(
        '[storage]\n'
        'driver = "overlay"\n'
        f'runroot = "{root_run}"\n'
        # root's own store stays root's (the distribution default), never
        # under the runtime user's data dir; CoCalc doesn't run root podman
        'graphroot = "/var/lib/containers/storage"\n',
        encoding="utf-8",
    )
    Path("/etc/containers/containers.conf").write_text(
        '[engine]\n'
        'cgroup_manager = "cgroupfs"\n',
        encoding="utf-8",
    )
    if cfg.ssh_user != "root":
        desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
        rootless_root = Path(f"/mnt/cocalc/data/containers/rootless/{cfg.ssh_user}")
        rootless_storage = rootless_root / "storage"
        ensure_runtime_owned_dirs(cfg, rootless_root, ["storage"])
        rootless_run.mkdir(parents=True, exist_ok=True)
        run_best_effort(
            cfg,
            [
                "chown",
                f"{cfg.ssh_user}:{cfg.ssh_user}",
                str(rootless_run),
            ],
            "chown rootless podman runroot",
        )
        run_best_effort(
            cfg,
            ["chmod", "0700", str(rootless_run)],
            "restrict rootless Podman runroot",
        )
        user_files = {
            str(user_config / "storage.conf"): (
                '[storage]\n'
                'driver = "overlay"\n'
                f'runroot = "{rootless_run}"\n'
                f'graphroot = "{rootless_storage}"\n'
            ),
            str(user_config / "containers.conf"): (
                '[engine]\n'
                'cgroup_manager = "cgroupfs"\n'
            ),
        }
        if os.geteuid() == 0:
            # In the runtime user's home: written by that user, not by root.
            run_python_as_user(
                cfg,
                cfg.ssh_user,
                USER_FILES_WRITE,
                "write_user_files",
                {"files": user_files},
                "writing podman user config",
            )
        else:
            _user_files_namespace["write_user_files"](user_files)
    try:
        marker_dir = open_dir_nofollow(migration_pending.parent)
    except (FileNotFoundError, UnsafeRuntimePath):
        marker_dir = -1
    if marker_dir >= 0:
        try:
            os.unlink(migration_pending.name, dir_fd=marker_dir)
        except FileNotFoundError:
            pass
        finally:
            os.close(marker_dir)


def write_env(cfg: BootstrapConfig, image_size_gb: int) -> None:
    log_line(cfg, f"bootstrap: writing project-host env to {cfg.env_file}")
    substitute_public_ip(cfg)
    env_path = Path(cfg.env_file)
    env_path.parent.mkdir(parents=True, exist_ok=True)
    existing_env = read_env_assignments(env_path)
    env_assignments: dict[str, str] = {}
    for line in cfg.env_lines:
        parsed = parse_env_assignment_line(line)
        if parsed is None:
            continue
        key, value = parsed
        env_assignments[key] = value
    local_env_path = project_host_local_env_path(env_path)
    if not local_env_path.exists():
        text_write_atomic(
            local_env_path,
            (
                "# Local project-host overrides.\n"
                "#\n"
                "# Bootstrap manages project-host.env and does not overwrite this file.\n"
                "# Put durable site-specific settings here, for example:\n"
                "# COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS=1\n"
                "# COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS_SEC=10\n"
            ),
        )
    uid = pwd.getpwnam(cfg.ssh_user).pw_uid if cfg.ssh_user else None
    if uid is not None:
        runtime_dir = default_podman_runtime_dir(uid)
        owner = runtime_file_owner(cfg)
        if owner is not None:
            try:
                fd = open_dir_nofollow(runtime_dir, create=True)
                try:
                    os.fchown(fd, *owner)
                finally:
                    os.close(fd)
            except UnsafeRuntimePath as err:
                log_line(cfg, f"bootstrap: refusing podman runtime dir: {err}")
        env_assignments["COCALC_PODMAN_RUNTIME_DIR"] = runtime_dir
    env_assignments["COCALC_BTRFS_ROOT_RESERVE_GB"] = str(compute_root_reserve_gb(cfg))
    env_assignments["COCALC_PROJECT_HOST_BOOTSTRAP_DIR"] = str(
        BOOTSTRAP_LIFECYCLE_EXPORT_DIR
    )
    env_assignments.setdefault(
        "COCALC_PROJECT_POOL_CGROUP",
        existing_env.get(
            "COCALC_PROJECT_POOL_CGROUP",
            DEFAULT_PROJECT_POOL_CGROUP,
        ),
    )
    env_assignments["COCALC_PROJECT_POOL_MEMORY_RESERVE_MB"] = (
        project_pool_memory_reserve_env_value(
            {
                **existing_env,
                "COCALC_PROJECT_POOL_MEMORY_RESERVE_MB": env_assignments.get(
                    "COCALC_PROJECT_POOL_MEMORY_RESERVE_MB",
                    existing_env.get("COCALC_PROJECT_POOL_MEMORY_RESERVE_MB", ""),
                ),
            }
        )
    )
    env_assignments["COCALC_PROJECT_POOL_CPU_RESERVE_CORES"] = (
        project_pool_cpu_reserve_env_value(
            {
                **existing_env,
                "COCALC_PROJECT_POOL_CPU_RESERVE_CORES": env_assignments.get(
                    "COCALC_PROJECT_POOL_CPU_RESERVE_CORES",
                    existing_env.get("COCALC_PROJECT_POOL_CPU_RESERVE_CORES", ""),
                ),
            }
        )
    )
    env_assignments.setdefault(
        "COCALC_PROJECT_QUOTA_LEDGER_MODE",
        existing_env.get("COCALC_PROJECT_QUOTA_LEDGER_MODE", "enforce"),
    )
    env_assignments.setdefault(
        "COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS",
        existing_env.get("COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS", "1"),
    )
    env_assignments.setdefault(
        "COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS_SEC",
        existing_env.get("COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS_SEC", "5"),
    )
    if cfg.image_size_gb_raw == "auto":
        env_assignments["COCALC_BTRFS_IMAGE_AUTO"] = "1"
        env_assignments["COCALC_BTRFS_IMAGE_GB"] = str(image_size_gb)
    else:
        env_assignments["COCALC_BTRFS_IMAGE_AUTO"] = "0"
        env_assignments.pop("COCALC_BTRFS_IMAGE_GB", None)
    write_env_file_atomic(
        env_path,
        render_env_text([f"{key}={value}" for key, value in env_assignments.items()]),
    )


PODMAN_BASHRC_BLOCK_START = "# >>> CoCalc project-host podman env >>>"
PODMAN_BASHRC_BLOCK_END = "# <<< CoCalc project-host podman env <<<"


def runtime_podman_env_lines(cfg: BootstrapConfig) -> list[str]:
    runtime_dir = None
    if Path(cfg.env_file).exists():
        for line in Path(cfg.env_file).read_text(encoding="utf-8").splitlines():
            if line.startswith("COCALC_PODMAN_RUNTIME_DIR="):
                runtime_dir = line.split("=", 1)[1].strip()
                if runtime_dir:
                    break
    if not runtime_dir and cfg.ssh_user:
        try:
            uid = pwd.getpwnam(cfg.ssh_user).pw_uid
        except Exception:
            uid = None
        if uid is not None:
            runtime_dir = default_podman_runtime_dir(uid)
    if not runtime_dir:
        return []
    lines = [
        f'export XDG_RUNTIME_DIR="{runtime_dir}"',
        f'export COCALC_PODMAN_RUNTIME_DIR="{runtime_dir}"',
        'export CONTAINERS_CGROUP_MANAGER="cgroupfs"',
    ]
    runtime_current = Path(
        os.environ.get(
            "COCALC_CONTAINER_RUNTIME_CURRENT",
            "/opt/cocalc/container-runtime/current",
        )
    )
    managed_podman = runtime_current / "bin" / "podman"
    if managed_podman.is_file() and os.access(managed_podman, os.X_OK):
        managed_conf = runtime_current / "etc" / "containers" / "containers.conf"
        lines.extend(
            [
                f'export PATH="{runtime_current / "bin"}:$PATH"',
                f'export CONTAINERS_CONF_OVERRIDE="{managed_conf}"',
            ]
        )
    return lines


# The managed-block edit, self-contained: configure_runtime_shell_env runs it
# in its own interpreter as the runtime user (nothing of bootstrap's state or
# open locks inherited) when bootstrap is root.
BASHRC_BLOCK_UPSERT = r"""
@@bootstrap-include embedded/bashrc-block-upsert.py@@
"""
_bashrc_block_namespace: dict[str, Any] = {}
exec(BASHRC_BLOCK_UPSERT, _bashrc_block_namespace)
PODMAN_BASHRC_COMMENT = (
    "# Added by CoCalc project-host bootstrap so rootless podman works in login shells."
)


def bashrc_block_args(path: Path, lines: list[str]) -> dict[str, Any]:
    return {
        "path": str(path),
        "start": PODMAN_BASHRC_BLOCK_START,
        "end": PODMAN_BASHRC_BLOCK_END,
        "comment": PODMAN_BASHRC_COMMENT,
        "lines": list(lines),
    }


def upsert_managed_bashrc_block(path: Path, lines: list[str]) -> None:
    _bashrc_block_namespace["upsert_bashrc_block"](**bashrc_block_args(path, lines))


# Writes files (creating their directories) as whoever runs it: used for the
# runtime user's own config files.
USER_FILES_WRITE = r"""
def write_user_files(files):
    import os

    for path, text in files.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = "%s.tmp-%d" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
"""
_user_files_namespace: dict[str, Any] = {}
exec(USER_FILES_WRITE, _user_files_namespace)


def run_python_as_user(
    cfg: BootstrapConfig, user: str, source: str, call: str, args: dict[str, Any], desc: str
) -> bool:
    """Runs call(**args), defined in source, in a separate interpreter with the
    user's uid and gid (no extra groups, a minimal environment): their home
    is theirs, so nothing there is written, or chowned, as root."""
    pw = pwd.getpwnam(user)
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            source + f"\nimport json, sys\n{call}(**json.load(sys.stdin))\n",
        ],
        input=json.dumps(args),
        text=True,
        capture_output=True,
        user=pw.pw_uid,
        group=pw.pw_gid,
        extra_groups=[],
        env={"PATH": "/usr/bin:/bin", "HOME": pw.pw_dir, "LANG": "C.UTF-8"},
        cwd="/",
        close_fds=True,
        timeout=60,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()[-1:] or [""]
        log_line(cfg, f"bootstrap: {desc} as {user} failed (ignored): {detail[0][:300]}")
        return False
    return True


def upsert_bashrc_block_as_user(
    cfg: BootstrapConfig, user: str, path: Path, lines: list[str]
) -> None:
    run_python_as_user(
        cfg,
        user,
        BASHRC_BLOCK_UPSERT,
        "upsert_bashrc_block",
        bashrc_block_args(path, lines),
        f"updating {path}",
    )


def configure_runtime_shell_env(cfg: BootstrapConfig) -> None:
    if not cfg.ssh_user or cfg.ssh_user == "root":
        return
    lines = runtime_podman_env_lines(cfg)
    if not lines:
        return
    bashrc = Path(runtime_home(cfg)) / ".bashrc"
    if os.geteuid() != 0:
        upsert_managed_bashrc_block(bashrc, lines)
        return
    try:
        upsert_bashrc_block_as_user(cfg, cfg.ssh_user, bashrc, lines)
    except (KeyError, OSError, subprocess.SubprocessError) as err:
        log_line(cfg, f"bootstrap: could not update {bashrc} as {cfg.ssh_user} (ignored): {err}")

def upsert_env(path: str, key: str, value: str) -> None:
    env = read_env_assignments(path)
    env[key] = value
    write_env_file_atomic(
        Path(path),
        render_env_text([f"{name}={val}" for name, val in env.items()]),
    )


def ensure_env_default(path: str, key: str, value: str) -> None:
    env = read_env_assignments(path)
    if key in env:
        return
    env[key] = value
    write_env_file_atomic(
        Path(path),
        render_env_text([f"{name}={val}" for name, val in env.items()]),
    )


def report_bootstrap_status(
    cfg: BootstrapConfig,
    status: str,
    message: str | None = None,
) -> None:
    if not cfg.status_url or not cfg.bootstrap_token:
        return
    payload: dict[str, Any] = {"status": status}
    if message:
        payload["message"] = message
    headers = {
        "Authorization": f"Bearer {cfg.bootstrap_token}",
        "User-Agent": "cocalc-bootstrap/1.0 (status)",
        "Content-Type": "application/json",
        "Accept": "application/json,text/plain,*/*",
    }
    context = None
    if cfg.ca_cert_path:
        try:
            context = ssl.create_default_context(cafile=cfg.ca_cert_path)
        except Exception:
            context = None
    try:
        request = urllib.request.Request(
            cfg.status_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, context=context, timeout=10):
            return
    except Exception as err:
        log_line(cfg, f"bootstrap: status update failed ({err})")


def setup_master_conat_token(cfg: BootstrapConfig) -> None:
    if not cfg.conat_url or not cfg.bootstrap_token:
        return
    path = Path(DATA_ROOT) / "secrets" / "master-conat-token"
    owner = runtime_file_owner(cfg)
    # The data disk is the runtime user's: the token is read, written and
    # handed over through a descriptor of secrets/, never by path.
    secrets_fd = open_dir_nofollow(path.parent, create=True)
    try:
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=secrets_fd)
        except FileNotFoundError:
            fd = -1
        except OSError as err:
            if err.errno != errno.ELOOP:
                raise
            fd = -1  # a symlink at the name: replaced below
        if fd >= 0:
            try:
                info = os.fstat(fd)
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    log_line(cfg, "bootstrap: master conat token already present")
                    os.fchmod(fd, 0o600)
                    if owner is not None:
                        os.fchown(fd, *owner)
                    return
            finally:
                os.close(fd)
        data = fetch_master_conat_token(cfg)
        write_file_at(secrets_fd, path.name, data, 0o600, owner)
    finally:
        os.close(secrets_fd)


