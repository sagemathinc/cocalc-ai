def repair_host_data_ownership(cfg: BootstrapConfig) -> None:
    """Hands host-owned data back to the runtime user, through descriptors
    of the data dir (the runtime user's own): no symlink is followed, and a
    hard-linked file is never chowned."""
    if cfg.ssh_user == "root":
        return
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    data_root = Path(DATA_ROOT)
    try:
        data_fd = open_dir_nofollow(data_root)
    except FileNotFoundError:
        return
    except UnsafeRuntimePath as err:
        log_line(cfg, f"bootstrap: refusing to repair {data_root}: {err}")
        return
    try:
        for dirname in HOST_OWNED_DATA_TREE_DIRS:
            # the descriptor walk itself decides what needs changing (a check
            # by path first would follow a symlink at the top)
            chown_tree_at(cfg, data_fd, dirname, desired_uid, desired_gid)
        for dirname in HOST_OWNED_DATA_TOPLEVEL_DIRS:
            try:
                fd = os.open(dirname, O_DIR_NOFOLLOW, dir_fd=data_fd)
            except OSError:
                continue
            try:
                info = os.fstat(fd)
                if (info.st_uid, info.st_gid) != (desired_uid, desired_gid):
                    os.fchown(fd, desired_uid, desired_gid)
            finally:
                os.close(fd)
        for name in os.listdir(data_fd):
            if name not in HOST_OWNED_DATA_FILES and not HOST_OWNED_SQLITE_RE.match(name):
                continue
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=data_fd)
            except OSError:
                continue
            try:
                info = os.fstat(fd)
                if (
                    stat.S_ISREG(info.st_mode)
                    and info.st_nlink == 1
                    and (info.st_uid, info.st_gid) != (desired_uid, desired_gid)
                ):
                    os.fchown(fd, desired_uid, desired_gid)
            finally:
                os.close(fd)
    finally:
        os.close(data_fd)


def chown_tree_at(cfg: BootstrapConfig, parent_fd: int, name: str, uid: int, gid: int) -> None:
    """chown -R, through descriptors: the tree is walked without following a
    symlink, and a hard-linked file (which could be another file's inode)
    is left alone."""
    try:
        top = os.open(name, O_DIR_NOFOLLOW, dir_fd=parent_fd)
    except OSError as err:
        if err.errno in (errno.ELOOP, errno.ENOTDIR):
            log_line(cfg, f"bootstrap: refusing to repair {name}: a symlink or not a directory")
        return
    try:
        info = os.fstat(top)
        if (info.st_uid, info.st_gid) != (uid, gid):
            os.fchown(top, uid, gid)
        for _dir, dirs, files, dfd in os.fwalk(dir_fd=top, follow_symlinks=False):
            for entry in [*dirs, *files]:
                try:
                    info = os.stat(entry, dir_fd=dfd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                    continue
                if (info.st_uid, info.st_gid) != (uid, gid):
                    os.chown(entry, uid, gid, dir_fd=dfd, follow_symlinks=False)
    finally:
        os.close(top)


def ensure_legacy_btrfs_link(cfg: BootstrapConfig) -> None:
    legacy = Path("/btrfs")
    target = "/mnt/cocalc"
    try:
        if legacy.is_symlink():
            if os.readlink(legacy) == target:
                return
            legacy.unlink()
            legacy.symlink_to(target, target_is_directory=True)
            return
        if legacy.exists():
            # Leave existing non-symlink legacy path untouched.
            return
        legacy.symlink_to(target, target_is_directory=True)
    except Exception as err:
        log_line(cfg, f"bootstrap: could not create legacy /btrfs symlink: {err}")


def runtime_home(cfg: BootstrapConfig) -> str:
    try:
        return pwd.getpwnam(cfg.ssh_user).pw_dir
    except Exception:
        return cfg.bootstrap_home


def project_host_runtime_root(cfg: BootstrapConfig) -> Path:
    root = Path(cfg.project_host_bundle.root)
    if root.name == "bundles":
        return root.parent
    return Path(cfg.bootstrap_root)


def project_host_rootctl_path(_cfg: BootstrapConfig | None = None) -> Path:
    return Path("/usr/local/sbin/cocalc-project-host-rootctl")


def chown_paths_best_effort(
    cfg: BootstrapConfig,
    owner: str,
    paths: list[str | Path],
    desc: str,
    *,
    recursive: bool = False,
) -> None:
    normalized = [str(path) for path in paths if path]
    if not normalized:
        return
    args = ["chown"]
    if recursive:
        args.append("-R")
    args.append(f"{owner}:{owner}")
    args.extend(normalized)
    if os.geteuid() == 0:
        run_best_effort(cfg, args, desc)
        return
    run_best_effort(cfg, ["sudo", *args], f"sudo {desc}")


# Runtime-owned trees (the project-host root and its bin, bundle roots) are
# written through descriptors: the runtime user controls their entries, so a
# root write, chmod or chown by path could be sent through a symlink to any
# file on the host.
O_DIR_NOFOLLOW = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class UnsafeRuntimePath(RuntimeError):
    """A runtime-owned path bootstrap refuses to write through."""


def runtime_file_owner(cfg: BootstrapConfig) -> tuple[int, int] | None:
    """(uid, gid) for runtime files, as `chown user:user` gave them; None when
    not root (nothing to hand over) or the user doesn't exist."""
    if os.geteuid() != 0 or not cfg.ssh_user or cfg.ssh_user == "root":
        return None
    try:
        pw = pwd.getpwnam(cfg.ssh_user)
    except KeyError:
        return None
    try:
        gid = grp.getgrnam(cfg.ssh_user).gr_gid
    except KeyError:
        gid = pw.pw_gid
    return pw.pw_uid, gid


def open_dir_nofollow(path: str | Path, *, create: bool = False) -> int:
    """A descriptor for the directory path, opened one component at a time
    from / without following a symlink anywhere on the way."""
    path = Path(os.path.abspath(path))
    fd = os.open("/", O_DIR_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            try:
                try:
                    next_fd = os.open(part, O_DIR_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(part, 0o755, dir_fd=fd)
                    except FileExistsError:
                        pass
                    next_fd = os.open(part, O_DIR_NOFOLLOW, dir_fd=fd)
            except OSError as err:
                if err.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise UnsafeRuntimePath(
                        f"{path}: {part} is a symlink or not a directory"
                    ) from err
                raise
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def require_dir_owner(fd: int, path: str | Path, owners: set[int]) -> None:
    owner = os.fstat(fd).st_uid
    if owner not in owners:
        raise UnsafeRuntimePath(f"{path} is owned by uid {owner}")


def write_file_at(
    dirfd: int,
    name: str,
    text: str | bytes,
    mode: int,
    owner: tuple[int, int] | None,
) -> None:
    """Writes name in the directory dirfd as a new file (a temporary name,
    then renamed over name), so whatever is at name, a symlink or a hard link,
    is replaced and never written through."""
    tmp = f".{name}.{os.getpid()}.{os.urandom(4).hex()}"
    fd = os.open(
        tmp,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=dirfd,
    )
    try:
        try:
            data = text.encode("utf-8") if isinstance(text, str) else text
            while data:
                data = data[os.write(fd, data) :]
            os.fchmod(fd, mode)
            if owner is not None:
                os.fchown(fd, *owner)
        finally:
            os.close(fd)
        os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dirfd)
        except OSError:
            pass
        raise


@contextmanager
def runtime_bin_dir(cfg: BootstrapConfig):
    """The project-host root's bin as a descriptor, both opened without
    following a symlink, owned by root or the runtime user; bin is handed to
    the runtime user as before."""
    root = project_host_runtime_root(cfg)
    owner = runtime_file_owner(cfg)
    owners = {0, os.geteuid()} | ({owner[0]} if owner else set())
    root_fd = open_dir_nofollow(root, create=True)
    try:
        require_dir_owner(root_fd, root, owners)
        try:
            os.mkdir("bin", 0o755, dir_fd=root_fd)
        except FileExistsError:
            pass
        try:
            bin_fd = os.open("bin", O_DIR_NOFOLLOW, dir_fd=root_fd)
        except OSError as err:
            if err.errno in (errno.ELOOP, errno.ENOTDIR):
                raise UnsafeRuntimePath(
                    f"{root}/bin is a symlink or not a directory"
                ) from err
            raise
    finally:
        os.close(root_fd)
    try:
        require_dir_owner(bin_fd, root / "bin", owners)
        if owner is not None:
            os.fchown(bin_fd, *owner)
        yield bin_fd
    finally:
        os.close(bin_fd)


def ensure_runtime_owned_dirs(cfg: BootstrapConfig, root: Path, children: list[str]) -> None:
    """root and its direct children, created if missing and handed to the
    runtime user through descriptors (no symlink followed on the way)."""
    owner = runtime_file_owner(cfg)
    try:
        root_fd = open_dir_nofollow(root, create=True)
    except UnsafeRuntimePath as err:
        log_line(cfg, f"bootstrap: refusing to set up {root}: {err}")
        return
    try:
        if owner is not None:
            os.fchown(root_fd, *owner)
        for child in children:
            try:
                os.mkdir(child, 0o755, dir_fd=root_fd)
            except FileExistsError:
                pass
            try:
                fd = os.open(child, O_DIR_NOFOLLOW, dir_fd=root_fd)
            except OSError as err:
                if err.errno in (errno.ELOOP, errno.ENOTDIR):
                    log_line(cfg, f"bootstrap: refusing to set up {root}/{child}: a symlink or not a directory")
                    continue
                raise
            try:
                if owner is not None:
                    os.fchown(fd, *owner)
            finally:
                os.close(fd)
    finally:
        os.close(root_fd)


def in_root_only_bootstrap_state(path: str | Path) -> bool:
    root = os.path.normpath(BOOTSTRAP_STATE_ROOT)
    path = os.path.normpath(str(path))
    return path == root or path.startswith(root + "/")


def ensure_root_bootstrap_done_marker(cfg: BootstrapConfig) -> None:
    """The marker the bay's startup script trusts to skip first boot: in the
    root-only state root, which is created root 0700 if it doesn't exist."""
    if os.geteuid() != 0:
        return
    root_fd = open_dir_nofollow(BOOTSTRAP_STATE_ROOT, create=True)
    try:
        info = os.fstat(root_fd)
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o700):
            os.fchown(root_fd, 0, 0)
            os.fchmod(root_fd, 0o700)
        fd = os.open(
            ".bootstrap_done",
            os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=root_fd,
        )
        os.close(fd)
    finally:
        os.close(root_fd)


def mark_bootstrap_done(cfg: BootstrapConfig) -> None:
    """After a completed first boot: only the root-only marker. The other
    markers older scripts listed (in the runtime user's data dir, or in
    /var/lib/cocalc, which was the runtime user's before r19) are read-only
    transition input for the startup script and never written here: a root
    write by path there goes wherever that user points it."""
    ensure_root_bootstrap_done_marker(cfg)


# What older startup scripts and bootstrap.py left in DATA_ROOT/.host-bootstrap:
# only this tree is removed, nothing that merely looks harmless.
OLD_BOOTSTRAP_STATE_DIRS = ("bootstrap", "tmp")
OLD_BOOTSTRAP_STATE_FILES = frozenset(
    {
        "bootstrap.py",
        "bootstrap.py.sha256",
        "bootstrap-host-facts.json",
        "bootstrap-desired-state.json",
        "bootstrap-state.json",
        "bootstrap-config.json",
        "bootstrap.lock",
        "bootstrap.log",
        "bootstrap.log.1",
        "bootstrap.payload.sh",
        "bootstrap.sh",
    }
)
# text_write_atomic's temp names, left behind by an interrupted write
OLD_BOOTSTRAP_STATE_TEMP = re.compile(
    r"\.bootstrap-(host-facts|desired-state|state)\.json\.[A-Za-z0-9_]{1,16}\.tmp"
)


def old_bootstrap_state_problem(
    top_fd: int, runtime_uid: int, runtime_gid: int, admin_uids: set[int]
) -> str | None:
    """Why the tree open as top_fd isn't exactly an old bootstrap state dir
    (None if it is), read only through top_fd. An allow-list: the top holds
    only bootstrap/ and tmp/; bootstrap/ only the files bootstrap wrote there,
    including bootstrap.py; tmp/ nothing. Every entry is a directory or
    regular file of root or the bootstrap user, not in the runtime user's
    group, on one filesystem, and no directory is writable by group or
    others (so nothing can be added while it is removed)."""

    def entry_problem(st: os.stat_result, rel: str) -> str | None:
        if st.st_uid not in admin_uids:
            return f"{rel} is owned by uid {st.st_uid}"
        if st.st_uid == runtime_uid or st.st_gid == runtime_gid:
            return f"{rel} belongs to the runtime user"
        if st.st_dev != top.st_dev:
            return f"{rel} is on another filesystem"
        if stat.S_ISDIR(st.st_mode) and st.st_mode & 0o022:
            return f"{rel} is writable by group or others"
        return None

    top = os.fstat(top_fd)
    if not stat.S_ISDIR(top.st_mode):
        return "not a directory"
    if top.st_uid not in admin_uids:
        return f"owned by uid {top.st_uid}"
    if top.st_gid == runtime_gid:
        return "its group is the runtime user's"
    if top.st_mode & 0o022:
        return "writable by group or others"
    names = os.listdir(top_fd)
    unexpected = sorted(set(names) - set(OLD_BOOTSTRAP_STATE_DIRS))
    if unexpected:
        return f"unexpected entries {unexpected[:5]}"
    if "bootstrap" not in names:
        return "no bootstrap/"
    for sub in names:
        st = os.lstat(sub, dir_fd=top_fd)
        if not stat.S_ISDIR(st.st_mode):
            return f"{sub} is not a directory"
        problem = entry_problem(st, sub)
        if problem:
            return problem
        sub_fd = os.open(sub, O_DIR_NOFOLLOW, dir_fd=top_fd)
        try:
            opened = os.fstat(sub_fd)
            if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino):
                return f"{sub} changed while being checked"
            entries = os.listdir(sub_fd)
            for entry in entries:
                rel = f"{sub}/{entry}"
                if sub == "tmp" or not (
                    entry in OLD_BOOTSTRAP_STATE_FILES
                    or OLD_BOOTSTRAP_STATE_TEMP.fullmatch(entry)
                ):
                    return f"unexpected entry {rel}"
                est = os.lstat(entry, dir_fd=sub_fd)
                if not stat.S_ISREG(est.st_mode):
                    return f"{rel} is not a regular file"
                problem = entry_problem(est, rel)
                if problem:
                    return problem
            if sub == "bootstrap" and "bootstrap.py" not in entries:
                return "no bootstrap/bootstrap.py"
        finally:
            os.close(sub_fd)
    return None


def remove_dir_contents_at(dir_fd: int, dev: int) -> None:
    """Empties the directory open as dir_fd, through descriptors: each
    subdirectory is opened without following a symlink and must still be the
    entry that was listed, on the same filesystem."""
    for entry in os.listdir(dir_fd):
        st = os.lstat(entry, dir_fd=dir_fd)
        if not stat.S_ISDIR(st.st_mode):
            os.unlink(entry, dir_fd=dir_fd)
            continue
        if st.st_dev != dev:
            raise UnsafeRuntimePath(f"{entry} is on another filesystem")
        child = os.open(entry, O_DIR_NOFOLLOW, dir_fd=dir_fd)
        try:
            opened = os.fstat(child)
            if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino):
                raise UnsafeRuntimePath(f"{entry} changed while being removed")
            remove_dir_contents_at(child, dev)
        finally:
            os.close(child)
        os.rmdir(entry, dir_fd=dir_fd)


