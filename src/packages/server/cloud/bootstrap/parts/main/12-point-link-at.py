def point_link_at(dirfd: int, name: str, target: str) -> None:
    """Makes name in dirfd a symlink to target: a new link renamed over the
    name, so whatever is there is replaced (a directory is removed first)."""
    tmp = f".{name}.{os.getpid()}.{os.urandom(4).hex()}"
    os.symlink(target, tmp, dir_fd=dirfd)
    try:
        try:
            os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        except OSError as err:
            if err.errno not in (errno.EISDIR, errno.ENOTEMPTY, errno.EEXIST) or not entry_is_dir(dirfd, name):
                raise
            shutil.rmtree(name, dir_fd=dirfd)
            os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dirfd)
        except OSError:
            pass
        raise


def install_privileged_tool_binaries_from_archive(
    archive_path: Path,
    *,
    destinations: dict[str, Path] | None = None,
    destination_uid: int = 0,
    destination_gid: int = 0,
) -> None:
    """Install root-run tools from an archive already trusted by the caller.

    cocalc-runtime-storage runs Rustic and BEES as root. The ordinary tools tree
    is intentionally owned by the project-host runtime account, so executing
    copies in that tree would turn a project-container escape into host root.
    The caller must authenticate this archive or explicitly trust its contents
    before invoking this function.
    """

    destinations = destinations or {
        "bin/bees": Path("/usr/local/libexec/cocalc-bees"),
        "bin/rustic": Path("/usr/local/libexec/cocalc-rustic"),
    }
    with tarfile.open(archive_path, mode="r:xz") as archive:
        members = archive.getmembers()
        for member_name, destination in destinations.items():
            candidates = [
                member
                for member in members
                if member.isfile() and Path(member.name).as_posix() == member_name
            ]
            if len(candidates) != 1:
                raise RuntimeError(
                    f"tools bundle must contain exactly one regular {member_name}"
                )
            source = archive.extractfile(candidates[0])
            if source is None:
                raise RuntimeError(
                    f"could not extract {member_name} from tools bundle"
                )
            destination.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(
                dir=str(destination.parent),
                prefix=f".{destination.name}.",
                suffix=".tmp",
            )
            tmp = Path(tmp_name)
            try:
                with os.fdopen(fd, "wb") as target:
                    shutil.copyfileobj(source, target)
                    target.flush()
                    os.fsync(target.fileno())
                os.chown(tmp, destination_uid, destination_gid)
                os.chmod(tmp, 0o755)
                os.replace(tmp, destination)
            finally:
                source.close()
                tmp.unlink(missing_ok=True)


def install_privileged_tool_binaries(
    cfg: BootstrapConfig,
    bundle: BundleSpec | None = None,
    *,
    destinations: dict[str, Path] | None = None,
    destination_uid: int = 0,
    destination_gid: int = 0,
) -> None:
    """Install trusted root-run tools from a checksum-verified tools bundle."""

    bundle = resolve_bundle_spec(cfg, bundle or cfg.tools_bundle)
    if not bundle.sha256 or not bundle.sha256.strip():
        raise RuntimeError("tools bundle checksum is required for privileged tools")
    remote = Path(bundle.remote)
    try:
        verify_sha256(cfg, str(remote), bundle.sha256)
    except (FileNotFoundError, RuntimeError):
        download_file(cfg, bundle.url, str(remote))
        verify_sha256(cfg, str(remote), bundle.sha256)
    install_privileged_tool_binaries_from_archive(
        remote,
        destinations=destinations,
        destination_uid=destination_uid,
        destination_gid=destination_gid,
    )


ROOT_UID = 0


def chown_root(path: Path | str) -> None:
    os.lchown(path, ROOT_UID, ROOT_UID)


def root_owned_parents(path: Path, lstat=os.lstat) -> bool:
    """True if every directory above path is owned by root, isn't writable
    by group or others and isn't a symlink."""
    for parent in Path(path).parents:
        try:
            st = lstat(parent)
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            return False
    return True


def prepare_root_dir(root: Path) -> None:
    """Creates root (0755, root-owned). Fails closed if root is a symlink or
    a directory above it could be changed by another user."""
    if root.is_symlink():
        raise RuntimeError(f"{root} is a symlink")
    if not root_owned_parents(root):
        raise RuntimeError(f"a directory above {root} isn't root-owned")
    root.mkdir(parents=True, exist_ok=True)
    chown_root(root)
    os.chmod(root, 0o755)


def root_owned_tree(path: Path) -> bool:
    """True if path is a directory (not a symlink) and everything in it is
    owned by root, not writable by group or others and not setuid/setgid,
    with every symlink resolving inside it."""
    if path.is_symlink() or not path.is_dir():
        return False
    base = os.path.realpath(path)
    for dirpath, dirnames, filenames in os.walk(path):
        for entry in [dirpath, *(os.path.join(dirpath, n) for n in dirnames + filenames)]:
            st = os.lstat(entry)
            if stat.S_ISLNK(st.st_mode):
                target = os.path.realpath(entry)
                if target != base and not target.startswith(base + os.sep):
                    return False
                continue
            if (
                st.st_uid != ROOT_UID
                or st.st_mode & 0o022
                or st.st_mode & (stat.S_ISUID | stat.S_ISGID)
            ):
                return False
    return True


def node_tree_ok(path: Path) -> bool:
    node = path / "bin" / "node"
    return root_owned_tree(path) and node.is_file() and not node.is_symlink()


def current_node_version(root: Path) -> str | None:
    """The version root/current points at, if it is a plain version name
    whose tree checks out."""
    current = root / "current"
    if not current.is_symlink():
        return None
    name = os.readlink(current)
    if not re.fullmatch(r"v\d+\.\d+\.\d+", name) or not node_tree_ok(root / name):
        return None
    return name


def node_dist_arch() -> str:
    machine = os.uname().machine
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        machine
    )
    if arch is None:
        raise RuntimeError(f"unsupported architecture for node: {machine}")
    return arch


def node_version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.lstrip("v").split("."))


def node_version_selector(cfg: BootstrapConfig) -> str:
    """cfg.node_version as "26", "26.12" or "26.12.1" (an optional leading
    "v" is dropped). nvm aliases such as "lts/*" or "node" aren't supported:
    they are refused rather than reinterpreted."""
    wanted = cfg.node_version.strip()
    wanted = wanted[1:] if wanted.startswith("v") else wanted
    if not re.fullmatch(r"\d+(\.\d+){0,2}", wanted):
        raise RuntimeError(
            f"unsupported node version {cfg.node_version!r}: use a major, "
            "major.minor or exact version (e.g. 26, 26.12 or 26.12.1)"
        )
    return wanted


def node_version_matches(version: str, selector: str) -> bool:
    """True if version (e.g. "v26.12.1") is selector or within it."""
    return version == f"v{selector}" or version.startswith(f"v{selector}.")


def resolve_node_version(cfg: BootstrapConfig) -> str:
    """The node release for cfg.node_version: as given if exact ("26.12.1"),
    else the newest release that matches it ("26" or "26.12"), as nvm picks."""
    selector = node_version_selector(cfg)
    if re.fullmatch(r"\d+\.\d+\.\d+", selector):
        return f"v{selector}"
    releases = fetch_json(cfg, f"{NODE_DIST_URL}/index.json")
    versions = [
        str(entry.get("version", ""))
        for entry in releases
        if isinstance(entry, dict)
        and re.fullmatch(r"v\d+\.\d+\.\d+", str(entry.get("version", "")))
        and node_version_matches(str(entry.get("version", "")), selector)
    ]
    if not versions:
        raise RuntimeError(f"no node release found for {cfg.node_version}")
    return max(versions, key=node_version_key)


def extract_node_archive(archive: Path, dest: Path) -> None:
    """Unpacks node-<v>-linux-<arch>.tar.xz into dest without its top
    directory. The data filter refuses links out of the tree and device
    files, and clears setuid/setgid and group/other write bits."""
    with tarfile.open(archive, "r:xz") as tar:
        members = []
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            member.name = str(PurePosixPath(*parts[1:]))
            members.append(member)
        tar.extractall(dest, members=members, filter="data")


def node_versions_in_use(root: Path, proc_root: str = "/proc") -> set[str]:
    """Versions under root that a process runs, or that a mount namespace
    (a project container's) has mounted (kept when pruning)."""
    used: set[str] = set()
    prefix = str(root) + "/"
    try:
        dev = os.stat(root).st_dev
        device = f"{os.major(dev)}:{os.minor(dev)}"
    except OSError:
        device = None
    # the mount's source path within its filesystem: .../<root name>/<version>
    mounted = re.compile(rf"/{re.escape(root.name)}/([^/\s]+)(?:/|$)")
    try:
        pids = [name for name in os.listdir(proc_root) if name.isdigit()]
    except OSError:
        return used
    namespaces: set[str] = set()
    for pid in pids:
        try:
            exe = os.readlink(os.path.join(proc_root, pid, "exe"))
            if exe.startswith(prefix):
                used.add(exe[len(prefix) :].split("/", 1)[0])
        except OSError:
            pass
        if device is None:
            continue
        try:
            namespace = os.readlink(os.path.join(proc_root, pid, "ns", "mnt"))
        except OSError:
            continue
        if namespace in namespaces:
            continue
        try:
            with open(os.path.join(proc_root, pid, "mountinfo")) as f:
                lines = f.read().splitlines()
        except OSError:
            continue  # (e.g. it exited) another process may show the namespace
        namespaces.add(namespace)
        for line in lines:
            fields = line.split()
            if len(fields) > 4 and fields[2] == device:
                match = mounted.search(fields[3])
                if match:
                    used.add(match.group(1))
    return used


def install_node(cfg: BootstrapConfig, *, root: Path = NODE_ROOT) -> Path:
    """Installs node as root under root/<version> (checked against the
    release's SHASUMS256.txt), points root/current at it and prunes old
    versions that no process runs. Returns the node binary."""
    log_line(cfg, f"bootstrap: installing node {cfg.node_version} under {root}")
    prepare_root_dir(root)
    current = root / "current"
    selector = node_version_selector(cfg)
    try:
        version = resolve_node_version(cfg)
    except Exception as exc:
        installed = current_node_version(root)
        if installed and node_version_matches(installed, selector):
            log_line(
                cfg,
                f"bootstrap: unable to look up node releases ({exc}); keeping {installed}",
            )
            return current / "bin" / "node"
        raise
    target = root / version
    if not node_tree_ok(target):
        name = f"node-{version}-linux-{node_dist_arch()}.tar.xz"
        with tempfile.TemporaryDirectory(dir=root, prefix=".install-") as tmp:
            archive = Path(tmp) / name
            sums = Path(tmp) / "SHASUMS256.txt"
            download_file(cfg, f"{NODE_DIST_URL}/{version}/{name}", str(archive))
            download_file(cfg, f"{NODE_DIST_URL}/{version}/SHASUMS256.txt", str(sums))
            expected = next(
                (
                    line.split()[0]
                    for line in sums.read_text(encoding="utf-8").splitlines()
                    if line.split()[1:] == [name]
                ),
                None,
            )
            if not expected:
                raise RuntimeError(f"no checksum for {name} in SHASUMS256.txt")
            verify_sha256(cfg, str(archive), expected)
            staging = Path(tmp) / "node"
            staging.mkdir()
            extract_node_archive(archive, staging)
            if not (staging / "bin" / "node").is_file():
                raise RuntimeError(f"{name} has no bin/node")
            for dirpath, _dirnames, filenames in os.walk(staging):
                for entry in [dirpath, *(os.path.join(dirpath, f) for f in filenames)]:
                    chown_root(entry)
            os.chmod(staging, 0o755)
            if not root_owned_tree(staging):
                raise RuntimeError(f"{name} did not unpack as a root-owned tree")
            # Only now that the replacement is ready: move a tree we can't
            # trust out of the way rather than deleting it, since project
            # containers may have it mounted (removed once nothing uses it).
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                log_line(cfg, f"bootstrap: replacing {target}: not entirely root-owned")
                os.rename(target, root / f".replaced-{version}-{time.time_ns()}")
            os.rename(staging, target)
    link = root / f".current-{os.getpid()}"
    if link.is_symlink() or link.exists():
        link.unlink()
    os.symlink(version, link)
    os.replace(link, current)
    in_use = node_versions_in_use(root) | {version}
    versions = sorted(
        (
            entry.name
            for entry in root.iterdir()
            if entry.is_dir()
            and not entry.is_symlink()
            and re.fullmatch(r"v\d+\.\d+\.\d+", entry.name)
        ),
        key=node_version_key,
        reverse=True,
    )
    for old in versions[NODE_KEEP_VERSIONS:]:
        if old not in in_use:
            log_line(cfg, f"bootstrap: removing node {old}")
            shutil.rmtree(root / old, ignore_errors=True)
    for entry in root.iterdir():
        if entry.name.startswith(".replaced-") and entry.name not in in_use:
            log_line(cfg, f"bootstrap: removing replaced node tree {entry.name}")
            shutil.rmtree(entry, ignore_errors=True)
    return current / "bin" / "node"


def install_node_runtime_libs(
    cfg: BootstrapConfig,
    *,
    root: Path = NODE_RUNTIME_LIBS_ROOT,
    candidates: tuple[str, ...] = HOST_LIBATOMIC_CANDIDATES,
) -> None:
    """Publishes the host's libatomic.so.1 (node needs it in older project
    images) as a root-owned file; project-host mounts the directory."""
    source = next((c for c in candidates if os.path.isfile(c)), None)
    if source is None:
        log_line(cfg, "bootstrap: libatomic.so.1 not found; skipping node runtime libs")
        return
    prepare_root_dir(root)
    target = root / "libatomic.so.1"
    data = Path(source).read_bytes()
    try:
        st = os.lstat(target)
    except OSError:
        st = None
    if (
        st is not None
        and stat.S_ISREG(st.st_mode)
        and st.st_uid == ROOT_UID
        and st.st_mode & 0o7777 == 0o644
        and st.st_nlink == 1
        and target.read_bytes() == data
    ):
        # Current and only ever writable by root: keep this inode. Anything
        # else gets a new inode even with equal bytes, since a process that
        # opened the old one for writing would keep that descriptor.
        return
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    # Never rewrite the published file in place: running processes may map
    # it. os.replace also replaces a symlink rather than following it.
    staged = root / f".libatomic.so.1.{os.getpid()}"
    staged.write_bytes(data)
    chown_root(staged)
    os.chmod(staged, 0o644)
    os.replace(staged, target)
    log_line(cfg, f"bootstrap: published {source} as {target}")


# `setcap cap_net_bind_service=+ep` as the kernel stores it (struct
# vfs_cap_data, revision 2): the effective flag, then permitted and inheritable
# for capabilities 0-31 and 32-63. CAP_NET_BIND_SERVICE is 10.
NODE_BIND_SERVICE_CAPABILITY = struct.pack("<5I", 0x02000001, 1 << 10, 0, 0, 0)


def configure_node_bind_service_capability(cfg: BootstrapConfig) -> None:
    direct_port = next(
        (
            line.split("=", 1)[1].strip()
            for line in cfg.env_lines
            if line.startswith("COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT=")
        ),
        "",
    )
    if not direct_port:
        return
    # Everything this step depends on (the node binary and its tree) is
    # checked first, so any failure skips only the capability: the HTTPS
    # listener then can't bind, and the rest of the reconcile still runs.
    try:
        set_node_bind_service_capability(cfg)
    except Exception as err:
        log_line(cfg, f"bootstrap: refusing to set the node bind capability: {err}")


def set_node_bind_service_capability(cfg: BootstrapConfig) -> None:
    # The capability must be on the binary the project-host wrapper runs: the
    # root-owned node under NODE_ROOT (#1526) when it is executable, else the
    # runtime user's nvm node (the wrapper's fallback).
    if os.access(NODE_ROOT / "current" / "bin" / "node", os.X_OK):
        set_root_node_bind_service_capability(cfg)
    else:
        set_nvm_node_bind_service_capability(cfg)


