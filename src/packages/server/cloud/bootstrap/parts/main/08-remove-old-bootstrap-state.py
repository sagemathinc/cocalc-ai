def remove_old_bootstrap_state(cfg: BootstrapConfig) -> None:
    """Retires DATA_ROOT/.host-bootstrap once this run used the root-only state
    root: it held root's bootstrap.py and a bootstrap token, under a directory
    the runtime user owns. The tree is opened once, checked and emptied through
    that descriptor, and its name removed only if it still names the same
    directory; anything else is left in place for inspection."""
    if os.geteuid() != 0 or not in_root_only_bootstrap_state(cfg.bootstrap_dir):
        return
    old = f"{DATA_ROOT}/{OLD_BOOTSTRAP_STATE_NAME}"
    try:
        data_fd = open_dir_nofollow(DATA_ROOT)
    except FileNotFoundError:
        return
    except UnsafeRuntimePath as err:
        log_line(cfg, f"bootstrap: refusing to remove old bootstrap dir {old}: {err}")
        return
    top_fd = None
    try:
        try:
            top_fd = os.open(OLD_BOOTSTRAP_STATE_NAME, O_DIR_NOFOLLOW, dir_fd=data_fd)
        except FileNotFoundError:
            return
        except OSError as err:
            if err.errno in (errno.ELOOP, errno.ENOTDIR):
                log_line(cfg, f"bootstrap: refusing to remove old bootstrap dir {old}: a symlink or not a directory")
                return
            raise
        runtime = runtime_file_owner(cfg)
        admin_uids = {0}
        try:
            admin_uids.add(pwd.getpwnam(cfg.bootstrap_user).pw_uid)
        except (KeyError, TypeError):
            pass
        problem = old_bootstrap_state_problem(
            top_fd,
            runtime[0] if runtime else -1,
            runtime[1] if runtime else -1,
            admin_uids,
        )
        if problem:
            log_line(cfg, f"bootstrap: refusing to remove old bootstrap dir {old}: {problem}")
            return
        top = os.fstat(top_fd)
        remove_dir_contents_at(top_fd, top.st_dev)
        current = os.lstat(OLD_BOOTSTRAP_STATE_NAME, dir_fd=data_fd)
        if (current.st_dev, current.st_ino) != (top.st_dev, top.st_ino):
            log_line(
                cfg,
                f"bootstrap: refusing to remove old bootstrap dir {old}: it was replaced while being removed (its contents are gone; the name now holds something else)",
            )
            return
        # Only an empty directory can go: rmdir by name can't take more.
        os.rmdir(OLD_BOOTSTRAP_STATE_NAME, dir_fd=data_fd)
        log_line(cfg, f"bootstrap: removed old bootstrap dir {old}")
    except (OSError, UnsafeRuntimePath) as err:
        log_line(cfg, f"bootstrap: refusing to remove old bootstrap dir {old}: {err}")
    finally:
        if top_fd is not None:
            os.close(top_fd)
        os.close(data_fd)


def finish_successful_run(cfg: BootstrapConfig) -> None:
    """After a successful run: the root-only marker (so the bay's script keeps
    taking the reconcile path once it stops trusting the data disk's marker),
    then the old state dir. Neither may fail the run."""
    for label, step in (
        ("root-only bootstrap marker", ensure_root_bootstrap_done_marker),
        ("old bootstrap dir cleanup", remove_old_bootstrap_state),
    ):
        try:
            step(cfg)
        except Exception as err:
            log_line(cfg, f"bootstrap: {label} failed (ignored): {err}")


def ensure_bootstrap_paths(cfg: BootstrapConfig) -> None:
    Path(cfg.bootstrap_root).mkdir(parents=True, exist_ok=True)
    Path(cfg.bootstrap_dir).mkdir(parents=True, exist_ok=True)
    Path(cfg.bootstrap_tmp).mkdir(parents=True, exist_ok=True)
    Path(cfg.log_file).parent.mkdir(parents=True, exist_ok=True)
    rotate_bootstrap_log(cfg)
    if cfg.bootstrap_user and cfg.bootstrap_user != "root":
        # Root-only state stays root's; only older state roots are handed to
        # the bootstrap user, as before.
        owner_paths = [
            path
            for path in (
                cfg.bootstrap_root,
                cfg.bootstrap_dir,
                cfg.bootstrap_tmp,
                str(Path(cfg.log_file).parent),
            )
            if not in_root_only_bootstrap_state(path)
        ]
        chown_paths_best_effort(
            cfg,
            cfg.bootstrap_user,
            owner_paths,
            "chown bootstrap-owner dirs",
        )
    if not cfg.ssh_user or cfg.ssh_user == "root":
        return


def prune_bundle_versions(
    cfg: BootstrapConfig,
    bundle: BundleSpec,
    *,
    keep: int = BUNDLE_RETENTION_COUNT,
) -> None:
    root = Path(bundle.root)
    if not root.is_dir():
        return
    # The root is the runtime user's: list and delete through a descriptor
    # opened without following a symlink, so nothing outside it is touched.
    try:
        root_fd = open_dir_nofollow(root)
    except UnsafeRuntimePath as err:
        log_line(cfg, f"bootstrap: refusing to prune {root}: {err}")
        chown_runtime_bundle_roots(cfg)
        return
    try:
        prune_bundle_versions_at(cfg, bundle, root, root_fd, keep)
    finally:
        os.close(root_fd)
    chown_runtime_bundle_roots(cfg)


def prune_bundle_versions_at(
    cfg: BootstrapConfig, bundle: BundleSpec, root: Path, root_fd: int, keep: int
) -> None:
    keep_resolved: set[Path] = set()
    try:
        live_versions = live_mounted_bundle_versions(root)
        live_versions.update(live_process_bundle_versions(root))
    except OSError as err:
        # Retention is optional; incomplete /proc visibility is not evidence
        # that an old runtime is unused. Still repair runtime-root ownership.
        log_line(cfg, f"bootstrap: skipping bundle pruning for {root}: {err}")
        live_versions = None
    if root.resolve() == Path(cfg.tools_bundle.root).resolve():
        # The project-host collector also knows stopped-container and SQLite
        # references. Bootstrap must not apply a weaker tools deletion policy.
        live_versions = None
    for version in sorted(live_versions or ()):
        live_dir = root / version
        if live_dir.exists() and live_dir.is_dir():
            keep_resolved.add(live_dir.resolve())
            log_line(
                cfg,
                f"bootstrap: preserving live-referenced bundle dir {live_dir}",
            )
    desired_dir = Path(bundle.dir)
    if desired_dir.exists() and desired_dir.is_dir():
        keep_resolved.add(desired_dir.resolve())
    current_path = Path(bundle.current)
    try:
        if current_path.is_symlink() or current_path.exists():
            resolved = current_path.resolve()
            if resolved.exists() and resolved.is_dir():
                keep_resolved.add(resolved)
    except Exception:
        pass
    candidates: list[Path] = []
    mtimes: dict[str, float] = {}
    for name in os.listdir(root_fd):
        if name.startswith(".") or name == "current":
            continue
        try:
            info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError:
            continue
        if not stat.S_ISDIR(info.st_mode):
            continue
        mtimes[name] = info.st_mtime
        candidates.append(root / name)
    candidates.sort(
        key=lambda child: (mtimes.get(child.name, 0), child.name),
        reverse=True,
    )
    for child in candidates:
        if live_versions is None:
            break
        try:
            resolved = child.resolve()
        except Exception:
            resolved = child
        if resolved in keep_resolved:
            continue
        if len(keep_resolved) < keep:
            if resolved.exists():
                keep_resolved.add(resolved)
            continue
        log_line(cfg, f"bootstrap: pruning old bundle dir {child}")
        shutil.rmtree(child.name, dir_fd=root_fd, ignore_errors=True)


def chown_runtime_bundle_roots(cfg: BootstrapConfig) -> None:
    """The bundle roots belong to the runtime user. As root each is handed
    over through its own descriptor, opened without following a symlink."""
    runtime_paths = [
        cfg.project_host_bundle.root,
        cfg.project_bundle.root,
        cfg.tools_bundle.root,
        *(
            [cfg.container_runtime_bundle.root]
            if cfg.container_runtime_bundle is not None
            else []
        ),
    ]
    runtime_paths = [path for path in runtime_paths if Path(path).exists()]
    if not runtime_paths:
        return
    if os.geteuid() == 0:
        owner = runtime_file_owner(cfg)
        if owner is None:
            return
        for path in runtime_paths:
            try:
                fd = open_dir_nofollow(path)
            except (UnsafeRuntimePath, FileNotFoundError) as err:
                log_line(cfg, f"bootstrap: not handing over {path}: {err}")
                continue
            try:
                os.fchown(fd, *owner)
            finally:
                os.close(fd)
    else:
        # A privileged chown by path would follow a symlink in any component;
        # without root there is no safe way to hand these over.
        log_line(cfg, "bootstrap: not root; runtime bundle roots keep their owner")


def decode_mountinfo_path(value: str) -> str:
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def strip_deleted_mount_suffix(value: str) -> str:
    for suffix in ["//deleted", " (deleted)"]:
        if value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def check_bundle_reference_scan_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise TimeoutError("live bundle reference scan exceeded time limit")


def live_mounted_bundle_versions(root: Path) -> set[str]:
    """Return version directories under root referenced by live mountinfo.

    Podman inspect can report a symlink source such as /opt/cocalc/tools/current,
    while the kernel mount namespace records the resolved bind source. When a
    host upgrade prunes that source, live containers can end up with
    /opt/cocalc/tools/<version>//deleted mounted and lose files. Mountinfo is the
    authoritative signal for protecting runtime versions from pruning.
    """
    try:
        root_abs = root.resolve()
    except Exception:
        root_abs = root.absolute()
    root_text = str(root_abs)
    versions: set[str] = set()
    deadline = time.monotonic() + BUNDLE_REFERENCE_SCAN_SECONDS
    for proc in PROC_ROOT.iterdir():
        check_bundle_reference_scan_deadline(deadline)
        if not proc.name.isdigit():
            continue
        mountinfo = proc / "mountinfo"
        try:
            lines = mountinfo.read_text(
                encoding="utf-8",
                errors="replace",
            ).splitlines()
        except (FileNotFoundError, ProcessLookupError):
            continue
        for line in lines:
            check_bundle_reference_scan_deadline(deadline)
            fields = line.split(" ")
            if len(fields) < 5:
                continue
            source_root = strip_deleted_mount_suffix(
                decode_mountinfo_path(fields[3])
            )
            if source_root == root_text:
                continue
            if not source_root.startswith(f"{root_text}/"):
                continue
            remainder = source_root[len(root_text) + 1 :]
            version = remainder.split("/", 1)[0]
            if version and version != "current":
                versions.add(version)
    return versions


def live_process_bundle_versions(root: Path) -> set[str]:
    """Protect bundles referenced by process paths, files, maps or command lines.

    Component-scoped rollouts can intentionally leave project-host services on
    different artifact versions. Node can overwrite its command line, so inspect
    kernel references independently of argv. Do not read process environments or
    open file contents. Unreadable references abort pruning, not installation.
    """
    try:
        root_abs = root.resolve()
    except Exception:
        root_abs = root.absolute()
    root_prefix = f"{root_abs}/"
    versions: set[str] = set()
    deadline = time.monotonic() + BUNDLE_REFERENCE_SCAN_SECONDS

    def add_path(value: str) -> None:
        value = os.path.normpath(strip_deleted_mount_suffix(value))
        if not value.startswith(root_prefix):
            return
        version = value[len(root_prefix):].split("/", 1)[0]
        if version and version not in {"current", ".", ".."}:
            versions.add(version)

    def add_link(link: Path) -> None:
        check_bundle_reference_scan_deadline(deadline)
        try:
            add_path(os.readlink(link))
        except (FileNotFoundError, ProcessLookupError):
            # Processes exit, descriptors close, and kernel threads have no exe.
            pass

    for proc in PROC_ROOT.iterdir():
        check_bundle_reference_scan_deadline(deadline)
        if not proc.name.isdigit():
            continue
        try:
            cmdline = (proc / "cmdline").read_bytes().replace(b"\0", b" ")
            text = os.fsdecode(cmdline)
        except (FileNotFoundError, ProcessLookupError):
            text = ""
        offset = 0
        while True:
            check_bundle_reference_scan_deadline(deadline)
            start = text.find(root_prefix, offset)
            if start < 0:
                break
            remainder = text[start + len(root_prefix) :]
            first = remainder.split("/", 1)[0].split(None, 1)
            if first:
                add_path(root_prefix + first[0])
            offset = start + len(root_prefix)
        for name in ("cwd", "exe", "root"):
            add_link(proc / name)
        try:
            for fd in (proc / "fd").iterdir():
                add_link(fd)
        except (FileNotFoundError, ProcessLookupError):
            pass
        try:
            with (proc / "maps").open(encoding="utf-8", errors="replace") as maps:
                for line in maps:
                    check_bundle_reference_scan_deadline(deadline)
                    fields = line.split(None, 5)
                    if len(fields) == 6:
                        add_path(decode_mountinfo_path(fields[5].rstrip("\n")))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return versions


def pick_unmounted_or_target_disk(
    cfg: BootstrapConfig,
    devices: list[str],
    *,
    mountpoint: str,
    min_size_bytes: int = 10 * 1024 * 1024 * 1024,
) -> str | None:
    for dev in devices:
        if not dev or not Path(dev).exists():
            continue
        try:
            mountpoints = (
                subprocess.check_output(["lsblk", "-nr", "-o", "MOUNTPOINT", dev], text=True)
                .strip()
                .splitlines()
            )
        except Exception:
            mountpoints = []
        mountpoints = [m for m in mountpoints if m]
        if mountpoints and mountpoint in mountpoints:
            return dev
        if mountpoints:
            log_line(cfg, f"bootstrap: skipping {dev} (mounted at {mountpoints})")
            continue
        try:
            size_bytes = int(
                subprocess.check_output(["lsblk", "-nb", "-o", "SIZE", dev], text=True)
                .strip()
                .splitlines()[0]
            )
        except Exception:
            size_bytes = 0
        if size_bytes and size_bytes < min_size_bytes:
            log_line(cfg, f"bootstrap: skipping {dev} (size {size_bytes}B too small)")
            continue
        return dev
    return None


def pick_data_disk(cfg: BootstrapConfig, devices: list[str]) -> str | None:
    return pick_unmounted_or_target_disk(cfg, devices, mountpoint="/mnt/cocalc")


def setup_btrfs(cfg: BootstrapConfig, image_size_gb: int) -> None:
    legacy_mount = Path("/btrfs")
    if legacy_mount.is_mount() and not Path("/mnt/cocalc").is_mount():
        run_best_effort(
            cfg,
            ["mount", "--bind", "/btrfs", "/mnt/cocalc"],
            "bind legacy /btrfs mount at /mnt/cocalc",
        )
    data_disk_devices = [d for d in cfg.data_disk_devices.split() if d]
    data_disk = None
    if data_disk_devices:
        log_line(cfg, "bootstrap: waiting for data disk (up to 600s)")
        for attempt in range(60):
            data_disk = pick_data_disk(cfg, data_disk_devices)
            if data_disk:
                break
            log_line(cfg, f"bootstrap: data disk not ready (attempt {attempt + 1}/60)")
            time.sleep(10)
    if data_disk:
        log_line(cfg, f"bootstrap: using data disk {data_disk}")
        fstype = subprocess.check_output(["lsblk", "-no", "FSTYPE", data_disk], text=True).strip()
        if not fstype:
            run_cmd(cfg, ["mkfs.btrfs", "-f", data_disk], "mkfs.btrfs")
        elif fstype != "btrfs":
            raise RuntimeError(f"refusing to format {data_disk} (filesystem={fstype})")
        if not Path("/mnt/cocalc").is_mount():
            run_cmd(cfg, ["mount", data_disk, "/mnt/cocalc"], "mount data disk")
        uuid = subprocess.check_output(["blkid", "-s", "UUID", "-o", "value", data_disk], text=True).strip()
        fstab_line = f"UUID={uuid} /mnt/cocalc btrfs defaults,nofail 0 0"
        update_fstab(fstab_line)
        ensure_legacy_btrfs_link(cfg)
        return
    log_line(cfg, "bootstrap: no data disk found; using loopback image")
    image_path = Path("/var/lib/cocalc/cocalc.img")
    legacy_image_path = Path("/var/lib/cocalc/btrfs.img")
    if not image_path.exists() and legacy_image_path.exists():
        image_path = legacy_image_path
    image_path.parent.mkdir(parents=True, exist_ok=True)
    if not image_path.exists():
        run_cmd(cfg, ["truncate", "-s", f"{image_size_gb}G", str(image_path)], "truncate btrfs image")
        run_cmd(cfg, ["mkfs.btrfs", "-f", str(image_path)], "mkfs.btrfs image")
    if not Path("/mnt/cocalc").is_mount():
        run_cmd(cfg, ["mount", "-o", "loop", str(image_path), "/mnt/cocalc"], "mount btrfs image")
    fstab_line = f"{image_path} /mnt/cocalc btrfs loop,defaults,nofail 0 0 # cocalc-btrfs"
    update_fstab(fstab_line)
    ensure_legacy_btrfs_link(cfg)


