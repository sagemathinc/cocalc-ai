def fetch_master_conat_token(cfg: BootstrapConfig) -> bytes:
    log_line(cfg, "bootstrap: fetching master conat token")
    headers = {
        "Authorization": f"Bearer {cfg.bootstrap_token}",
        "User-Agent": "cocalc-bootstrap/1.0 (master-conat-token)",
        "Accept": "text/plain,*/*",
    }
    context = None
    if cfg.ca_cert_path:
        try:
            context = ssl.create_default_context(cafile=cfg.ca_cert_path)
        except Exception:
            context = None
    try:
        request = urllib.request.Request(cfg.conat_url, headers=headers)
        with urllib.request.urlopen(request, context=context) as resp:
            return resp.read()
    except Exception as err:
        log_line(cfg, f"bootstrap: master-conat-token fetch failed via urllib ({err}); trying curl")
        if shutil.which("curl") is None:
            raise
    # to a private temp file of root's, then read back; the bearer token goes
    # in a header file, not in argv (readable by anyone via /proc)
    with tempfile.TemporaryDirectory(prefix="cocalc-token-") as tmpdir:
        dest = Path(tmpdir) / "token"
        header_file = Path(tmpdir) / "auth-header"
        fd = os.open(header_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"Authorization: Bearer {cfg.bootstrap_token}\n")
        run_cmd(
            cfg,
            [
                "curl",
                "-fsSL",
                "-o",
                str(dest),
                "-H",
                f"@{header_file}",
                "-H",
                "User-Agent: cocalc-bootstrap/1.0 (master-conat-token)",
                "-H",
                "Accept: text/plain,*/*",
                cfg.conat_url,
            ],
            "fetch master conat token via curl",
        )
        return dest.read_bytes()


def download_file(
    cfg: BootstrapConfig, url: str, dest: str, *, attempts: int = 4
) -> None:
    log_line(cfg, f"bootstrap: downloading {url}")
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    headers = {
        "User-Agent": "cocalc-bootstrap/1.0 (curl-compatible)",
        "Accept": "*/*",
    }
    context = None
    if cfg.ca_cert_path:
        try:
            context = ssl.create_default_context(cafile=cfg.ca_cert_path)
        except Exception:
            context = None
    last_error: Exception | None = None
    attempts = max(1, attempts)
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, context=context) as resp:
                data = resp.read()
            Path(dest).write_bytes(data)
            return
        except Exception as err:
            last_error = err
            log_line(
                cfg,
                f"bootstrap: download failed via urllib ({err}); trying curl",
            )
        if shutil.which("curl") is None:
            raise RuntimeError("curl not available for download fallback")
        try:
            run_cmd(
                cfg,
                ["curl", "-fsSL", "-o", dest, url],
                f"download {url} via curl",
            )
            return
        except Exception as err:
            last_error = err
            if attempt >= attempts:
                break
            delay = min(5 * attempt, 20)
            log_line(
                cfg,
                f"bootstrap: download attempt {attempt}/{attempts} failed ({err}); retrying in {delay}s",
            )
            time.sleep(delay)
    raise RuntimeError(f"download {url} failed after {attempts} attempts: {last_error}")


def verify_sha256(cfg: BootstrapConfig, path: str, expected: str | None) -> None:
    if not expected:
        return
    if not expected:
        return
    expected = expected.strip().lower()
    if not expected:
        return
    log_line(cfg, "bootstrap: verifying checksum")
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    if h.hexdigest() != expected:
        raise RuntimeError("checksum mismatch")
    log_line(cfg, "bootstrap: checksum ok")


def fetch_json(cfg: BootstrapConfig, url: str) -> dict[str, Any]:
    log_line(cfg, f"bootstrap: fetching manifest {url}")
    if cfg.ca_cert_path:
        context = ssl.create_default_context(cafile=cfg.ca_cert_path)
    else:
        context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(url, context=context, timeout=60) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload)
    except Exception as err:
        log_line(cfg, f"bootstrap: manifest fetch via urllib failed ({err}); trying curl")
    if shutil.which("curl") is None:
        raise RuntimeError("curl not available for manifest fetch fallback")
    payload = subprocess.check_output(["curl", "-fsSL", url], text=True)
    return json.loads(payload)


def extract_version_from_bundle_url(url: str) -> str | None:
    try:
        path = urllib.parse.urlparse(url).path
    except Exception:
        return None
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2:
        return None
    version = parts[-2].strip()
    return version or None


def resolve_bundle_spec(cfg: BootstrapConfig, bundle: BundleSpec) -> BundleSpec:
    if not bundle.manifest_url:
        return bundle
    manifest = fetch_json(cfg, bundle.manifest_url)
    url = f"{manifest.get('url') or ''}".strip()
    if not url:
        raise RuntimeError(f"manifest missing bundle url: {bundle.manifest_url}")
    version = f"{manifest.get('version') or ''}".strip()
    if not version:
        version = extract_version_from_bundle_url(url) or bundle.version or "latest"
    sha256 = f"{manifest.get('sha256') or ''}".strip() or bundle.sha256
    resolved = BundleSpec(
        url=url,
        sha256=sha256,
        remote=bundle.remote,
        root=bundle.root,
        dir=f"{bundle.root}/{version}",
        current=bundle.current,
        version=version,
        manifest_url=bundle.manifest_url,
    )
    log_line(
        cfg,
        f"bootstrap: resolved manifest {bundle.manifest_url} to version={version} url={url}",
    )
    return resolved


def ensure_cocalc_install_root() -> None:
    path = COCALC_INSTALL_ROOT
    _require(path.resolve() == path, f"CoCalc installation root contains a symlink: {path}")
    path.mkdir(mode=0o755, exist_ok=True)
    # Older bootstrap made /opt/cocalc runtime-owned. Migrate only that inode;
    # project-host, tools, bundles and container-runtime retain their ownership.
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fchown(fd, *COCALC_INSTALL_OWNER)
        os.fchmod(fd, 0o755)
    finally:
        os.close(fd)
    info = path.lstat()
    _require(
        stat.S_ISDIR(info.st_mode)
        and (info.st_uid, info.st_gid) == COCALC_INSTALL_OWNER
        and not info.st_mode & 0o022,
        f"CoCalc installation root must be root-owned and not writable by others: {path}",
    )


def extract_bundle(cfg: BootstrapConfig, bundle: BundleSpec) -> BundleSpec:
    if Path(bundle.root).resolve() == Path(cfg.tools_bundle.root).resolve():
        with tools_artifact_lock(bundle.root):
            return extract_bundle_unlocked(cfg, bundle)
    return extract_bundle_unlocked(cfg, bundle)


@contextmanager
def tools_artifact_lock(root: str):
    """Coordinate tools extraction/activation with the project-host collector.

    The tools root may belong to the runtime user, so nothing in it is
    opened, created or changed by path: the lock is opened relative to a
    descriptor of the root without following a symlink, and a lock file that
    isn't bootstrap's own (root's) regular file is replaced, never followed.
    """
    Path(root).mkdir(parents=True, exist_ok=True)
    try:
        dirfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as err:
        raise RuntimeError(f"tools artifact root {root} is not a directory: {err}")
    try:
        fd = _open_tools_lock(dirfd)
        if fd is None:
            _replace_tools_lock(dirfd)
            fd = _open_tools_lock(dirfd)
            if fd is None:
                raise RuntimeError(
                    f"{root}/{TOOLS_LOCK_NAME} was changed while it was being replaced; not extracting tools"
                )
        try:
            # Keep the inode permanently: unlinking it would split the lock domain.
            os.fchmod(fd, 0o644)
            deadline = time.monotonic() + bootstrap_lock_timeout_seconds()
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("timed out waiting for tools artifact lock")
                    time.sleep(0.1)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
    finally:
        os.close(dirfd)


TOOLS_LOCK_NAME = ".artifact.lock"


def _open_tools_lock(dirfd: int) -> int | None:
    """The lock file in the tools root, if it is a regular file owned by
    bootstrap's user (root), with one link and no group/other write. Opened
    relative to the root's descriptor; a symlink is never followed."""
    try:
        fd = os.open(
            TOOLS_LOCK_NAME,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o644,
            dir_fd=dirfd,
        )
    except OSError as err:
        if err.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO):
            return None
        raise
    info = os.fstat(fd)
    if (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and info.st_nlink == 1
        and not info.st_mode & 0o022
    ):
        return fd
    os.close(fd)
    return None


def _replace_tools_lock(dirfd: int) -> None:
    """A fresh lock file renamed over whatever has the lock's name (rename
    replaces the entry itself, never what a symlink points at)."""
    fresh = f"{TOOLS_LOCK_NAME}.{os.getpid()}.{os.urandom(4).hex()}"
    fd = os.open(
        fresh,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o644,
        dir_fd=dirfd,
    )
    try:
        os.fchmod(fd, 0o644)
    finally:
        os.close(fd)
    try:
        os.rename(fresh, TOOLS_LOCK_NAME, src_dir_fd=dirfd, dst_dir_fd=dirfd)
    except OSError:
        os.unlink(fresh, dir_fd=dirfd)
        raise


def extract_bundle_unlocked(cfg: BootstrapConfig, bundle: BundleSpec) -> BundleSpec:
    bundle = resolve_bundle_spec(cfg, bundle)
    Path(cfg.bootstrap_tmp).mkdir(parents=True, exist_ok=True)
    if (
        cfg.bootstrap_user
        and cfg.bootstrap_user != "root"
        and not in_root_only_bootstrap_state(cfg.bootstrap_tmp)
    ):
        run_best_effort(
            cfg,
            ["chown", f"{cfg.bootstrap_user}:{cfg.bootstrap_user}", cfg.bootstrap_tmp],
            "chown bootstrap tmp",
        )
    root = Path(bundle.root)
    desired_dir = Path(bundle.dir)
    current_path = Path(bundle.current)
    if desired_dir.parent != root:
        raise RuntimeError(f"bundle dir {desired_dir} must be an entry of {root}")
    # The root is the runtime user's: everything below happens through a
    # descriptor opened without following a symlink, never by path.
    root_fd = open_dir_nofollow(root, create=True)
    try:
        if entry_is_dir(root_fd, desired_dir.name):
            try:
                target = read_link_at(current_path)
            except OSError:
                target = None
            if target in (str(desired_dir), desired_dir.name):
                log_line(
                    cfg,
                    f"bootstrap: bundle already current version={bundle.version or desired_dir.name} root={bundle.root}",
                )
                os.close(root_fd)
                root_fd = -1
                prune_bundle_versions(cfg, bundle)
                return bundle
            log_line(
                cfg,
                f"bootstrap: reusing existing bundle version={bundle.version or desired_dir.name} root={bundle.root}",
            )
        else:
            try:
                if bundle.fallback_manifest_url and not bundle.sha256:
                    # A kept version the store no longer serves: there is no
                    # checksum to verify a download against, so don't try one.
                    raise RuntimeError("no checksum for a kept version that is not installed")
                download_file(cfg, bundle.url, bundle.remote)
                verify_sha256(cfg, bundle.remote, bundle.sha256)
            except Exception as err:
                if not bundle.fallback_manifest_url:
                    raise
                log_line(
                    cfg,
                    f"bootstrap: desired bundle version={bundle.version} is not installed and could not be downloaded ({err}); falling back to {bundle.fallback_manifest_url}",
                )
                os.close(root_fd)
                root_fd = -1
                return extract_bundle_unlocked(
                    cfg,
                    replace(
                        bundle,
                        manifest_url=bundle.fallback_manifest_url,
                        fallback_manifest_url=None,
                    ),
                )
            install_bundle_tree(cfg, bundle, root_fd, desired_dir.name)
        # current may live elsewhere (project-host: next to bundles/)
        if current_path.parent == root:
            point_link_at(root_fd, current_path.name, str(desired_dir))
        else:
            link_dir_fd = open_dir_nofollow(current_path.parent, create=True)
            try:
                point_link_at(link_dir_fd, current_path.name, str(desired_dir))
            finally:
                os.close(link_dir_fd)
    finally:
        if root_fd >= 0:
            os.close(root_fd)
    prune_bundle_versions(cfg, bundle)
    return bundle


def read_link_at(path: Path) -> str:
    """The target of the symlink path, read through its parent's descriptor."""
    dir_fd = open_dir_nofollow(path.parent)
    try:
        return os.readlink(path.name, dir_fd=dir_fd)
    finally:
        os.close(dir_fd)


def entry_is_dir(dirfd: int, name: str) -> bool:
    try:
        return stat.S_ISDIR(os.stat(name, dir_fd=dirfd, follow_symlinks=False).st_mode)
    except FileNotFoundError:
        return False


def install_bundle_tree(
    cfg: BootstrapConfig, bundle: BundleSpec, root_fd: int, version: str
) -> None:
    """Extracts the verified archive into a fresh root-only dir inside the
    root (reached through its descriptor, so a rename of the name can't
    redirect tar), strips setuid/setgid bits, hands the tree to the runtime
    user, then renames it into place as version."""
    staging = f".staging-{version}-{os.getpid()}-{os.urandom(4).hex()}"
    os.mkdir(staging, 0o700, dir_fd=root_fd)
    staging_fd = os.open(staging, O_DIR_NOFOLLOW, dir_fd=root_fd)
    try:
        try:
            run_cmd(
                cfg,
                [
                    "tar",
                    "-xJf",
                    bundle.remote,
                    "--strip-components=1",
                    "--no-same-owner",
                    "-C",
                    f"/proc/self/fd/{staging_fd}",
                ],
                f"extract {bundle.url}",
                pass_fds=(staging_fd,),
            )
            owner = runtime_file_owner(cfg)
            for _dir, dirs, files, dfd in os.fwalk(dir_fd=staging_fd, follow_symlinks=False):
                for name in [*dirs, *files]:
                    info = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                    if (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) and info.st_mode & (
                        stat.S_ISUID | stat.S_ISGID
                    ):
                        os.chmod(name, stat.S_IMODE(info.st_mode) & ~(stat.S_ISUID | stat.S_ISGID), dir_fd=dfd)
                    if owner is not None:
                        os.chown(name, *owner, dir_fd=dfd, follow_symlinks=False)
            # whatever is at the version's name is replaced, never followed
            if entry_is_dir(root_fd, version):
                shutil.rmtree(version, dir_fd=root_fd)
            else:
                try:
                    os.unlink(version, dir_fd=root_fd)
                except FileNotFoundError:
                    pass
            os.rename(staging, version, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        except BaseException:
            shutil.rmtree(staging, dir_fd=root_fd, ignore_errors=True)
            raise
        # through the descriptor: the name may have changed since the rename
        os.fchmod(staging_fd, 0o755)
        if owner is not None:
            os.fchown(staging_fd, *owner)
    finally:
        os.close(staging_fd)


