def parse_subid_entries(path: Path) -> tuple[list[str], list[tuple[str, int, int]]]:
    if path.exists():
        raw_lines = path.read_text(encoding="utf-8").splitlines()
    else:
        raw_lines = []
    entries: list[tuple[str, int, int]] = []
    for line in raw_lines:
        parts = line.split(":")
        if len(parts) != 3:
            continue
        name = parts[0].strip()
        try:
            start = int(parts[1])
            length = int(parts[2])
        except ValueError:
            continue
        entries.append((name, start, length))
    return raw_lines, entries


def ensure_exact_subid_file(
    path: Path, user: str, ranges: tuple[tuple[int, int], ...]
) -> bool:
    raw_lines, _entries = parse_subid_entries(path)
    preserved_lines: list[str] = []
    user_lines: list[str] = []
    for line in raw_lines:
        parts = line.split(":")
        if len(parts) == 3 and parts[0].strip() == user:
            user_lines.append(f"{user}:{parts[1].strip()}:{parts[2].strip()}")
            continue
        preserved_lines.append(line)
    expected_lines = [f"{user}:{start}:{length}" for start, length in ranges]
    if user_lines == expected_lines:
        return False
    path.write_text("\n".join([*preserved_lines, *expected_lines]) + "\n", encoding="utf-8")
    return True


def project_uid_block_overlaps(path: Path, user: str) -> list[str]:
    """Entries of other users that overlap PROJECT_RUNTIME_UID_BLOCK."""
    start, length = PROJECT_RUNTIME_UID_BLOCK
    _raw_lines, entries = parse_subid_entries(path)
    return [
        f"{name}:{entry_start}:{entry_length}"
        for name, entry_start, entry_length in entries
        if name != user
        and entry_start < start + length
        and start < entry_start + entry_length
    ]


def ensure_login_defs_subid_max(path: Path = LOGIN_DEFS_PATH) -> bool:
    """Keep useradd's automatic subuid/subgid ranges below the project block.

    Ubuntu's default SUB_UID_MAX (600100000) is already below it; this pins
    the bound so a changed default or a local edit can't reach the block.
    """
    limit = PROJECT_RUNTIME_UID_BLOCK[0] - 1
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    seen: set[str] = set()
    changed = False
    out: list[str] = []
    for line in lines:
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ("SUB_UID_MAX", "SUB_GID_MAX"):
            seen.add(parts[0])
            try:
                ok = int(parts[1]) <= limit
            except ValueError:
                ok = False
            if not ok:
                line = f"{parts[0]} {600100000}"
                changed = True
        out.append(line)
    for key in ("SUB_UID_MAX", "SUB_GID_MAX"):
        if key not in seen:
            out.append(f"{key} {600100000}")
            changed = True
    if changed:
        text_write_atomic(path, "\n".join(out) + "\n", fsync=True)
    return changed


def ensure_subuids(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: ensuring subuid/subgid ranges for {cfg.ssh_user}")
    ranges = runtime_subid_ranges(cfg)
    if ranges != PROJECT_HOST_RUNTIME_SUBID_RANGES:
        overlaps = [
            *project_uid_block_overlaps(Path("/etc/subuid"), cfg.ssh_user),
            *project_uid_block_overlaps(Path("/etc/subgid"), cfg.ssh_user),
        ]
        if overlaps:
            raise RuntimeError(
                "subuid/subgid entries overlap the project runtime uid block "
                f"{PROJECT_RUNTIME_UID_BLOCK[0]}:{PROJECT_RUNTIME_UID_BLOCK[1]}: "
                + ", ".join(overlaps)
            )
        if ensure_login_defs_subid_max():
            log_line(cfg, "bootstrap: pinned SUB_UID_MAX/SUB_GID_MAX below the project runtime uid block")
    changed_subuid = ensure_exact_subid_file(Path("/etc/subuid"), cfg.ssh_user, ranges)
    changed_subgid = ensure_exact_subid_file(Path("/etc/subgid"), cfg.ssh_user, ranges)
    if changed_subuid or changed_subgid:
        log_line(
            cfg,
            "bootstrap: set exact subuid/subgid allocation "
            f"for {cfg.ssh_user} to "
            + ", ".join(f"{start}:{length}" for start, length in ranges)
            + " (Podman picks up a changed allocation at the next reboot)",
        )


def verify_runtime_user_contract(cfg: BootstrapConfig) -> None:
    desired = expected_runtime_user_contract(cfg)
    installed = read_current_runtime_user_contract(cfg)
    # A changed allocation reaches the live map only at the next reboot (see
    # accepted_runtime_userns_maps): compare the live map with the accepted
    # variant it matches.
    for uid_map, gid_map in accepted_runtime_userns_maps(cfg):
        if installed.get("uid_map") == uid_map and installed.get("gid_map") == gid_map:
            if uid_map != desired.get("uid_map"):
                log_line(
                    cfg,
                    "bootstrap: the live rootless map predates the current "
                    "subuid allocation; it takes effect at the next reboot",
                )
            desired = {
                **desired,
                "uid_map": uid_map,
                "gid_map": gid_map,
                "fingerprint": runtime_userns_map_fingerprint(uid_map, gid_map),
            }
            break
    mismatches: list[str] = []
    for key in (
        "identity",
        "subuid_ranges",
        "subgid_ranges",
        "uid_map",
        "gid_map",
        "fingerprint",
    ):
        if installed.get(key) != desired.get(key):
            mismatches.append(
                f"{key} expected={desired.get(key)!r} installed={installed.get(key)!r}"
            )
    if mismatches:
        probe_error = installed.get("probe_error")
        probe_detail = (
            f"; podman probe failed: {probe_error}" if probe_error else ""
        )
        raise RuntimeError(
            "runtime userns contract mismatch; reprovision the host or reset "
            f"the {cfg.ssh_user} rootless Podman state "
            f"({'; '.join(mismatches)}{probe_detail})"
        )


def enable_linger(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: enabling linger for {cfg.ssh_user}")
    if shutil.which("loginctl") is None:
        raise RuntimeError("loginctl not available; cannot ensure /run/user")
    run_cmd(cfg, ["loginctl", "enable-linger", cfg.ssh_user], "enable linger")


def ensure_owned_runtime_dir(path: Path, uid: int, gid: int) -> None:
    """Created if missing and handed to the runtime user through a
    descriptor: parents such as /mnt/cocalc/data/tmp are the runtime user's,
    so nothing on the way is followed (UnsafeRuntimePath)."""
    fd = open_dir_nofollow(path, create=True)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def remove_empty_dir_at(path: Path) -> bool:
    """Removes the directory path through its parent's descriptor (no symlink
    followed on the way; a symlink or file at path is refused), but only if
    it is empty: False if it still has entries, True once it is gone."""
    try:
        parent_fd = open_dir_nofollow(path.parent)
    except FileNotFoundError:
        return True
    try:
        try:
            info = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return True
        if not stat.S_ISDIR(info.st_mode):
            raise UnsafeRuntimePath(f"{path} is not a directory")
        try:
            os.rmdir(path.name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        except OSError as err:
            if err.errno in (errno.ENOTEMPTY, errno.EEXIST, errno.EBUSY):
                return False
            raise
        return True
    finally:
        os.close(parent_fd)


def remove_runtime_tree(
    path: Path,
    run_as_runtime_user: Callable[[list[str]], Any],
    podman_unshare: list[str] | None = None,
    *,
    runtime_ids: tuple[int, int] | None = None,
) -> None:
    """Removes a directory the runtime user can write. Root never walks into
    it, since anything inside could have been moved in from elsewhere: the
    runtime user empties it (then, for files of its subordinate ids, through
    `podman unshare`), and root only removes the emptied directory. Nothing
    falls back to deleting as root."""
    if remove_empty_dir_at(path):
        return
    rm = ["rm", "-rf", "--one-file-system", "--", str(path)]
    attempts = [rm]
    if podman_unshare:
        attempts.append([*podman_unshare, *rm])
    for argv in attempts:
        run_as_runtime_user(argv)
        if remove_empty_dir_at(path):
            return
    runtime = f"{runtime_ids[0]}:{runtime_ids[1]}" if runtime_ids else "unknown"
    raise RuntimeError(
        f"could not empty {path} as runtime uid:gid {runtime} (left: "
        f"{runtime_tree_residue(path)}); refusing root fallback (#94)"
    )


def runtime_tree_residue(path: Path, limit: int = 3) -> str:
    """At most limit top-level entries left in path, as name (uid:gid), for
    the operator: one lazy scan, lstat only, nothing opened below path."""
    found: list[str] = []
    try:
        fd = open_dir_nofollow(path)
    except (OSError, UnsafeRuntimePath):
        return "unknown"
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(found) >= limit:
                    break
                try:
                    info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    owner = f"{info.st_uid}:{info.st_gid}"
                except OSError:
                    owner = "?"
                found.append(f"{ascii(entry.name[:64])} ({owner})")
    except OSError:
        pass
    finally:
        os.close(fd)
    return ", ".join(found) or "unknown"


def default_podman_runtime_dir(uid: int) -> str:
    return f"/mnt/cocalc/data/tmp/cocalc-podman-runtime-{uid}"


def ensure_runtime_user_manager(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    pw = pwd.getpwnam(user)
    uid = pw.pw_uid
    gid = pw.pw_gid
    log_line(cfg, f"bootstrap: ensuring runtime manager for {user} uid={uid}")
    if shutil.which("loginctl") is not None:
        run_best_effort(
            cfg,
            ["loginctl", "enable-linger", user],
            "enable runtime user linger",
        )
    run_dir = Path("/run/user") / str(uid)
    ensure_owned_runtime_dir(run_dir, uid, gid)
    if shutil.which("systemctl") is not None:
        service = f"user@{uid}.service"
        run_best_effort(
            cfg,
            ["systemctl", "reset-failed", service],
            "reset failed runtime user manager",
        )
        run_best_effort(
            cfg,
            ["systemctl", "start", service],
            "start runtime user manager",
        )
    ensure_owned_runtime_dir(run_dir, uid, gid)
    env = read_env_assignments(cfg.env_file)
    configured_runtime = (
        env.get("COCALC_PODMAN_RUNTIME_DIR")
        or env.get("XDG_RUNTIME_DIR")
        or default_podman_runtime_dir(uid)
    ).strip()
    if Path(configured_runtime).is_absolute():
        try:
            ensure_owned_runtime_dir(Path(configured_runtime), uid, gid)
        except UnsafeRuntimePath as err:
            log_line(cfg, f"bootstrap: refusing podman runtime dir: {err}")


def prepare_dirs(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: preparing cocalc directories")
    ensure_cocalc_install_root()
    for path in ["/etc/cocalc", "/mnt/cocalc"]:
        Path(path).mkdir(parents=True, exist_ok=True)
    ensure_cocalc_state_root(cfg)


IMAGE_CACHE_ROOT = Path("/mnt/cocalc/data/cache/images")
IMAGE_ROOT_LINKS = (("etc", "mtab"), ("var", "run"))


def open_pinned_directory(path: Path) -> int:
    """Open an absolute directory one component at a time, never following
    a symlink (a symlinked component raises)."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            nextfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nextfd
    except BaseException:
        os.close(fd)
        raise
    return fd


def migrate_image_root_links(cfg: BootstrapConfig, cache_root: Path = IMAGE_CACHE_ROOT,
                             subuid: Path = Path("/etc/subuid"), subgid: Path = Path("/etc/subgid")) -> int:
    """Images normalized before the fix hold root-owned etc/mtab and
    var/run links, which a confined copy cannot reproduce (it fails
    closed).  Hand exactly those to the container root: per image, only
    where each is a symlink owned by uid or gid 0, resolved without
    following symlinks.  Nothing else is touched.  A few stat calls per
    image, so it runs on every reconcile."""
    try:
        rootfd = open_pinned_directory(cache_root)
    except FileNotFoundError:
        return 0
    except OSError as err:
        log_line(cfg, f"bootstrap: not migrating image links: {cache_root}: {err}")
        return 0
    owner = []
    for path in (subuid, subgid):
        _raw, entries = parse_subid_entries(path)
        starts = sorted(start for name, start, _length in entries if name == cfg.ssh_user)
        if not starts:
            os.close(rootfd)
            log_line(cfg, f"bootstrap: not migrating image links: no {path} entry for {cfg.ssh_user}")
            return 0
        owner.append(starts[0])
    changed = 0
    try:
        for image in os.listdir(rootfd):
            if image.startswith("."):
                continue
            try:
                imagefd = os.open(image, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=rootfd)
            except OSError:
                continue
            try:
                for parent, name in IMAGE_ROOT_LINKS:
                    try:
                        parentfd = os.open(parent, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=imagefd)
                    except OSError:
                        continue
                    try:
                        info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode) and (info.st_uid == 0 or info.st_gid == 0):
                            os.chown(name, owner[0], owner[1], dir_fd=parentfd, follow_symlinks=False)
                            changed += 1
                    except OSError as err:
                        if err.errno != errno.ENOENT:
                            log_line(cfg, f"bootstrap: image link {image}/{parent}/{name}: {err}")
                    finally:
                        os.close(parentfd)
            finally:
                os.close(imagefd)
    finally:
        os.close(rootfd)
    if changed:
        log_line(cfg, f"bootstrap: handed {changed} root-owned image links to the container root")
    return changed


def ensure_cocalc_state_root(cfg: BootstrapConfig) -> None:
    """Root-owned and not writable by others: root scripts keep state in
    /var/lib/cocalc and mount the loop image from it by name, so the runtime
    user must not be able to rename or replace anything there.  The runtime
    user only reads the published bootstrap-lifecycle view."""
    if os.geteuid() != 0:
        log_line(cfg, f"bootstrap: not root; leaving {COCALC_STATE_ROOT} ownership unchanged")
        return
    path = COCALC_STATE_ROOT
    _require(path.resolve() == path, f"CoCalc state root contains a symlink: {path}")
    path.mkdir(mode=0o755, parents=True, exist_ok=True)
    # Older bootstrap made /var/lib/cocalc runtime-owned. Migrate only that
    # inode; its children keep their ownership.
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (info.st_uid, info.st_gid) != (0, 0) or info.st_mode & 0o022:
            log_line(cfg, f"bootstrap: making {path} root-owned (was {info.st_uid}:{info.st_gid} {stat.S_IMODE(info.st_mode):o})")
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o755)
    finally:
        os.close(fd)


def tree_has_unexpected_ownership(path: Path, uid: int, gid: int) -> bool:
    if not path.exists():
        return False
    try:
        stat = path.lstat()
        if stat.st_uid != uid or stat.st_gid != gid:
            return True
        if not path.is_dir():
            return False
        for root, dirs, files in os.walk(path):
            root_path = Path(root)
            try:
                stat = root_path.lstat()
                if stat.st_uid != uid or stat.st_gid != gid:
                    return True
            except FileNotFoundError:
                continue
            for name in dirs + files:
                child = root_path / name
                try:
                    stat = child.lstat()
                except FileNotFoundError:
                    continue
                if stat.st_uid != uid or stat.st_gid != gid:
                    return True
    except FileNotFoundError:
        return False
    return False


def path_has_unexpected_ownership(path: Path, uid: int, gid: int) -> bool:
    if not path.exists():
        return False
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return False
    return stat.st_uid != uid or stat.st_gid != gid


