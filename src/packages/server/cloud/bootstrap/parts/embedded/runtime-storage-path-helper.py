#!/usr/bin/python3
"""Root-owned, openat2-anchored path mutations for cocalc-runtime-storage.

The sudo caller owns /opt/cocalc/project-host, so this helper must never load
code, Node, or native addons from that tree.  Keep this file self-contained and
installed below /usr/local with root ownership.
"""

import contextlib
import ctypes
import errno
import fcntl
import json
import os
import pwd
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.parse


ALLOWED_ROOTS = {
    "/mnt/cocalc",
    "/mnt/cocalc-scratch",
    "/opt/cocalc/container-runtime",
    "/opt/cocalc/project-bundles",
    "/opt/cocalc/project-host",
    "/opt/cocalc/tools",
    "/var/lib/cocalc",
    "/var/lib/cocalc/star/project-host/0/cache",
    "/var/lib/cocalc/star/project-host/0/secrets/rustic",
}
# Backup credentials are read only by the rustic verbs.
SECRET_ROOTS = {"/var/lib/cocalc/star/project-host/0/secrets/rustic"}
# Beneath these roots generic verbs reach only the listed paths with the
# listed verbs, or nothing within the listed protected subtrees.  Owning the
# image behind /mnt/cocalc would be raw access to that filesystem, so the
# images only take truncate, and only to create a new one.
GENERIC_ONLY_PATHS = {"/var/lib/cocalc": ({"btrfs.img", "cocalc.img"}, {"truncate"})}
CREATE_ONLY_ROOTS = {"/var/lib/cocalc"}
GENERIC_PROTECTED_PATHS = {"/mnt/cocalc": ("data/secrets", ".cocalc-confined-restore")}
# The data filesystem's root stays root-owned: BEES and the R1 project-root
# hardening rely on it, so no generic verb may change it.
GENERIC_FIXED_ROOTS = {"/mnt/cocalc"}
# Verbs that act on a whole tree must not take a protected subtree with them.
TREE_COMMANDS = {"copy-tree-preserve", "copy-tree-reflink", "rename", "rm", "rmdir"}
STICKY_ROOTS = {"/mnt/cocalc-scratch"}
RUNTIME_USER = "__RUNTIME_USER__"
# R1 project runtime ids (P), outside every subordinate range.
PROJECT_RUNTIME_ID_START = 1073741824
PROJECT_RUNTIME_ID_COUNT = 65536
SUBID_FILES = ("/etc/subuid", "/etc/subgid")
COMMANDS = {
    "chmod",
    "chattr-cow",
    "chown",
    "copy-tree-preserve",
    "copy-tree-reflink",
    "mkdir",
    "rename",
    "rm",
    "rmdir",
    "truncate",
}
ANCHORED_COMMANDS = {
    "mount-overlay-project",
    "normalize-rootfs",
    "umount-overlay-project",
}
RUSTIC_COMMANDS = {
    "rustic-project-backup",
    "rustic-project-restore",
    "rustic-rootfs-backup",
    "rustic-rootfs-restore",
}
RUSTIC_PROFILE_MAX_BYTES = 1024 * 1024
RUSTIC_PROFILE_KEYS = {"repository", "password", "options"}
RUSTIC_OPTION_KEYS = {
    "access_key_id",
    "bucket",
    "endpoint",
    "region",
    "root",
    "secret_access_key",
}
ALLOW_LOOPBACK_RUSTIC_REST = "__ALLOW_LOOPBACK_RUSTIC_REST__" == "1"
# Sparse files make apparent size independent of disk usage, and Rustic reads
# every hole. Files larger than the limit are not backed up; the decision uses
# the same apparent size as Rustic, and files exactly at the limit are kept.
# The caller derives project limits from the disk quota; clamp them so it can
# neither disable the limit nor make ordinary files ineligible.
RUSTIC_BACKUP_DEFAULT_MAX_FILE_BYTES = 100 * 1000**3
RUSTIC_BACKUP_MIN_MAX_FILE_BYTES = 1000**3
RUSTIC_BACKUP_CEILING_MAX_FILE_BYTES = 1000**4
OVERSIZED_FILES_MARKER = "COCALC_BACKUP_OVERSIZED_FILES"
OVERSIZED_FILES_MAX_PATHS = 20
OVERSIZED_FILES_MAX_RECORD_BYTES = 1024 * 1024
OVERSIZED_SCAN_MAX_SUBPATHS = 1000
OVERSIZED_SCAN_MAX_RUNTIME_SECONDS = 10 * 60
# One open directory per level: well below the open-file limit.
OVERSIZED_SCAN_MAX_DEPTH = 512
# scan-changed-since: whether anything in a project changed after a time (its
# latest snapshot). The caller only needs to know whether anything besides its
# own runtime files changed, so a few paths are enough.
CHANGED_SINCE_MAX_PATHS = 64
CHANGED_SINCE_MAX_RUNTIME_SECONDS = 60
# The unprivileged caller cannot signal this root-owned helper, so its own
# timeout cannot stop Rustic. Supervise every child here instead.
RUSTIC_MAX_RUNTIME_SECONDS = 12 * 60 * 60
RUSTIC_TERMINATE_GRACE_SECONDS = 10
PR_SET_PDEATHSIG = 1
SYS_OPENAT2 = 437
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
RESOLVE_FLAGS = RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH
RESOLVE_NO_XDEV = 0x01
RESOLVE_IN_ROOT = 0x10
O_PATH = getattr(os, "O_PATH", 0o10000000)
LIBC = ctypes.CDLL(None, use_errno=True)


class OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]


def fail(message):
    raise ValueError(message)


def validate_relative(path, *, allow_root=False):
    if allow_root and path == ".":
        return
    if not path or path.startswith("/"):
        fail(f"path must be relative: {path!r}")
    if any(part in ("", ".", "..") for part in path.split("/")):
        fail(f"path must stay beneath root: {path!r}")


def openat2(dirfd, path, flags, mode=0, resolve=RESOLVE_FLAGS):
    encoded = os.fsencode(path)
    if b"\0" in encoded:
        fail("path contains NUL")
    how = OpenHow(flags=flags, mode=mode, resolve=resolve)
    result = LIBC.syscall(
        SYS_OPENAT2,
        ctypes.c_int(dirfd),
        ctypes.c_char_p(encoded),
        ctypes.byref(how),
        ctypes.sizeof(how),
    )
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), path)
    return result


def open_root(root, allowed_roots):
    if root not in allowed_roots or os.path.realpath(root) != root:
        fail(f"root is not allowed: {root!r}")
    return os.open(root, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def open_parent(rootfd, path):
    parts = path.split("/")
    parent = "/".join(parts[:-1]) or "."
    fd = openat2(rootfd, parent, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    return fd, parts[-1]


def open_existing(rootfd, path):
    return openat2(rootfd, path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)


def mkdir_beneath(rootfd, path, recursive, mode):
    if not recursive:
        parentfd, name = open_parent(rootfd, path)
        try:
            os.mkdir(name, mode, dir_fd=parentfd)
        finally:
            os.close(parentfd)
        return
    current = os.dup(rootfd)
    try:
        for part in path.split("/"):
            try:
                os.mkdir(part, mode, dir_fd=current)
            except FileExistsError:
                pass
            nextfd = openat2(current, part, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            os.close(current)
            current = nextfd
    finally:
        os.close(current)


def remove_entry(parentfd, name, recursive, force):
    for _attempt in range(4):
        try:
            info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
        except FileNotFoundError:
            if force:
                return
            raise
        if stat.S_ISDIR(info.st_mode):
            if not recursive:
                raise IsADirectoryError(errno.EISDIR, os.strerror(errno.EISDIR), name)
            try:
                childfd = openat2(
                    parentfd,
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_CLOEXEC,
                )
            except (FileNotFoundError, NotADirectoryError):
                continue
            try:
                for child in os.listdir(childfd):
                    remove_entry(childfd, child, True, force)
            finally:
                os.close(childfd)
            try:
                os.rmdir(name, dir_fd=parentfd)
                return
            except (FileNotFoundError, NotADirectoryError):
                if force:
                    return
                continue
        else:
            try:
                os.unlink(name, dir_fd=parentfd)
                return
            except FileNotFoundError:
                if force:
                    return
                continue
            except IsADirectoryError:
                continue
    raise OSError(errno.EBUSY, "path changed repeatedly during removal", name)


def parse_rustic(argv):
    command = argv[0]
    values = {"tag": [], "delete": False, "no-cache": False}
    value_options = {
        "--root",
        "--path",
        "--profile-root",
        "--profile-path",
        "--host",
        "--parent",
        "--snapshot",
        "--tag",
        "--max-file-bytes",
    }
    i = 1
    while i < len(argv):
        option = argv[i]
        if option in ("--delete", "--no-cache"):
            key = option[2:]
            if values[key]:
                fail(f"duplicate {option}")
            values[key] = True
            i += 1
            continue
        if option not in value_options or i + 1 >= len(argv):
            fail(f"invalid Rustic option: {option}")
        key = option[2:]
        if key == "tag":
            values["tag"].append(argv[i + 1])
        elif key in values:
            fail(f"duplicate Rustic option: {option}")
        else:
            values[key] = argv[i + 1]
        i += 2

    common = {"root", "path", "profile-root", "profile-path", "tag", "delete", "no-cache"}
    allowed = {
        "rustic-project-backup": common | {"host", "parent", "max-file-bytes"},
        "rustic-rootfs-backup": common | {"host"},
        "rustic-project-restore": common | {"snapshot"},
        "rustic-rootfs-restore": common | {"snapshot"},
    }[command]
    if any(key not in allowed for key in values):
        fail("option is not valid for Rustic command")
    required = {"root", "path", "profile-root", "profile-path"}
    required.add("host" if command.endswith("backup") else "snapshot")
    for key in required:
        if key not in values:
            fail(f"missing --{key}")
    if values["delete"] and command != "rustic-rootfs-restore":
        fail("--delete is only valid for rootfs restore")
    if values["no-cache"] and command != "rustic-project-restore":
        fail("--no-cache is only valid for project restore")
    if values["tag"] and not command.endswith("backup"):
        fail("--tag is only valid for backup")
    validate_relative(values["path"], allow_root=True)
    validate_relative(values["profile-path"])
    for name in ("host", "parent", "snapshot"):
        value = values.get(name)
        if value is None:
            continue
        if (
            not value
            or value.startswith("-")
            or len(value) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            fail(f"invalid Rustic {name}")
    for tag in values["tag"]:
        if (
            not tag
            or tag.startswith("-")
            or len(tag) > 1024
            or any(ord(char) < 32 or ord(char) == 127 for char in tag)
        ):
            fail("invalid Rustic tag")
    if command == "rustic-rootfs-backup":
        values["max-file-bytes"] = parse_max_file_bytes(None)
    elif "max-file-bytes" in values:
        values["max-file-bytes"] = parse_max_file_bytes(values["max-file-bytes"])
    else:
        # Project-host versions that cannot report skipped files do not ask
        # for a limit; never skip files they would not know about.
        values["max-file-bytes"] = None
    return command, values


def parse_max_file_bytes(value):
    if value is None:
        return RUSTIC_BACKUP_DEFAULT_MAX_FILE_BYTES
    if not re.fullmatch(r"[1-9][0-9]{0,18}", value):
        fail("invalid max-file-bytes")
    return min(
        max(int(value), RUSTIC_BACKUP_MIN_MAX_FILE_BYTES),
        RUSTIC_BACKUP_CEILING_MAX_FILE_BYTES,
    )


def read_validated_rustic_profile(rootfd, path, allow_loopback_rest=False):
    fd = openat2(rootfd, path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail("Rustic profile must be a regular file")
        if info.st_size <= 0 or info.st_size > RUSTIC_PROFILE_MAX_BYTES:
            fail("Rustic profile has invalid size")
        data = bytearray()
        while len(data) <= RUSTIC_PROFILE_MAX_BYTES:
            chunk = os.read(fd, min(65536, RUSTIC_PROFILE_MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > RUSTIC_PROFILE_MAX_BYTES:
            fail("Rustic profile is too large")
    finally:
        os.close(fd)
    try:
        document = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as err:
        fail(f"invalid Rustic profile: {err}")
    if set(document) != {"repository"} or not isinstance(
        document["repository"], dict
    ):
        fail("Rustic profile must contain only [repository]")
    repository = document["repository"]
    if not set(repository).issubset(RUSTIC_PROFILE_KEYS):
        fail("Rustic profile contains unsupported repository keys")
    if not {"repository", "password"}.issubset(repository):
        fail("Rustic profile is missing repository or password")
    for key in ("repository", "password"):
        if not isinstance(repository[key], str):
            fail(f"Rustic profile {key} must be a string")
    repository_url = repository["repository"]
    if repository_url == "opendal:s3":
        options = repository.get("options", {})
        if not isinstance(options, dict) or set(options) != RUSTIC_OPTION_KEYS:
            fail("Rustic profile contains unsupported repository options")
        if any(
            not isinstance(value, str)
            or not value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            for value in options.values()
        ):
            fail("Rustic repository options must be nonempty strings")
        endpoint = urllib.parse.urlsplit(options["endpoint"])
        if (
            endpoint.scheme != "https"
            or not endpoint.hostname
            or endpoint.username is not None
            or endpoint.password is not None
        ):
            fail("privileged Rustic requires an HTTPS object-store endpoint")
    elif allow_loopback_rest and repository_url.startswith("rest:"):
        if "options" in repository:
            fail("loopback Rustic REST profiles do not support options")
        endpoint = urllib.parse.urlsplit(repository_url[len("rest:") :])
        try:
            port = endpoint.port
        except ValueError:
            fail("privileged Rustic loopback REST endpoint has an invalid port")
        if (
            endpoint.scheme != "http"
            or endpoint.hostname not in {"127.0.0.1", "::1"}
            or port is None
            or endpoint.path in {"", "/"}
            or endpoint.query
            or endpoint.fragment
        ):
            fail("privileged Rustic REST endpoint must use local loopback HTTP")
    else:
        fail("privileged Rustic requires the managed opendal:s3 backend")
    return bytes(data)


def write_private_rustic_profile(
    data, directory="/run/cocalc-rustic-profiles", required_uid=0
):
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(directory)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != required_uid
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        fail("unsafe privileged Rustic profile directory")
    fd, path = tempfile.mkstemp(prefix="profile-", suffix=".toml", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        os.unlink(path)
        raise
    return path


RUSTIC_CANDIDATES = ("/usr/local/libexec/cocalc-rustic",)


def select_privileged_rustic_binary(candidates=None):
    require_root_ownership = candidates is None
    candidates = candidates or RUSTIC_CANDIDATES
    for candidate in candidates:
        try:
            info = os.stat(candidate)
        except FileNotFoundError:
            continue
        if (
            stat.S_ISREG(info.st_mode)
            and (not require_root_ownership or info.st_uid == 0)
            and not stat.S_IMODE(info.st_mode) & 0o022
            and os.access(candidate, os.X_OK)
        ):
            return candidate
    fail("trusted privileged Rustic binary is unavailable")


def raise_on_signal(signum, _frame):
    fail(f"interrupted by signal {signum}")


def parent_death_signal(parent_pid):
    def setup():
        # Kill the child if this helper dies before it can clean up.
        LIBC.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
        if os.getppid() != parent_pid:
            os._exit(1)

    return setup


def terminate_process_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=RUSTIC_TERMINATE_GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


# The caller (sudo) as of this helper's start: a helper reparented since
# then has lost its caller, also between supervised commands.
CALLER_PID = os.getppid()


def run_supervised(args, *, deadline, quiet=False, on_stdout=None, **kwargs):
    """Run args in its own process group and never leave it running.

    The caller is sudo, which an unprivileged timeout may kill outright. Stop
    the whole group when the caller disappears, the deadline passes, or this
    helper is interrupted, and return the exit status otherwise.
    """
    caller = CALLER_PID
    if os.getppid() != caller:
        fail(f"caller exited; not starting {os.path.basename(args[0])}")
    # A shared deadline (several scans, then Rustic) may already be spent.
    if time.monotonic() >= deadline:
        fail(f"deadline exceeded; not starting {os.path.basename(args[0])}")
    if on_stdout is not None:
        stdout = subprocess.PIPE
    else:
        stdout = subprocess.DEVNULL if quiet else None
    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=subprocess.DEVNULL if quiet else None,
        start_new_session=True,
        preexec_fn=parent_death_signal(os.getpid()),
        **kwargs,
    )
    try:
        reading = on_stdout is not None
        while True:
            if reading:
                ready, _, _ = select.select([proc.stdout], [], [], 1)
                if ready:
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if chunk:
                        on_stdout(chunk)
                    else:
                        reading = False
            else:
                try:
                    return proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            if os.getppid() != caller:
                fail(f"caller exited; stopped {os.path.basename(args[0])}")
            if time.monotonic() >= deadline:
                fail(f"deadline exceeded; stopped {os.path.basename(args[0])}")
    finally:
        if proc.returncode is None:
            terminate_process_group(proc)
        if proc.stdout is not None:
            proc.stdout.close()


def new_oversized_report(max_file_bytes):
    return {"max_file_bytes": max_file_bytes, "count": 0, "files": []}


def add_oversized_file(report, path, size):
    report["count"] += 1
    if len(report["files"]) < OVERSIZED_FILES_MAX_PATHS:
        report["files"].append({"path": path, "size": size})


# The oversized-file walk, run by scan_oversized_files as a supervised child
# with the tree as its working directory. It prints find's former records
# ("<size> <path>\0"). Each directory is opened relative to its parent
# without following symlinks, so the walk cannot leave the tree; and unlike
# find it does not take a directory whose (device, inode) equals an
# ancestor's for a loop: OverlayFS with xino=off, as project root filesystems
# are mounted, does not give directories unique inode numbers, and find then
# failed on a loop that does not exist. Without symlinks there are no loops.
# Arguments: max file bytes, 1 for -xdev, maximum depth.
OVERSIZED_WALK_PROGRAM = """
import os, sys
limit, xdev, max_depth = int(sys.argv[1]), sys.argv[2] == "1", int(sys.argv[3])
out = sys.stdout.buffer
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
try:
    root = os.open(".", flags)
    root_dev = os.fstat(root).st_dev
    stack = [(root, os.scandir(root), b"")]
    while stack:
        fd, entries, rel = stack[-1]
        entry = next(entries, None)
        if entry is None:
            entries.close()
            os.close(fd)
            stack.pop()
            continue
        if entry.name == ".snapshots":
            continue
        name = os.fsencode(entry.name)
        try:
            # The type comes from the listing: only regular files (for their
            # size) and, with -xdev, directories (for their device) are stat'ed.
            if entry.is_file(follow_symlinks=False):
                size = entry.stat(follow_symlinks=False).st_size
                if size > limit:
                    out.write(b"%d %s\\0" % (size, rel + name))
                continue
            if not entry.is_dir(follow_symlinks=False):
                continue
            if xdev and entry.stat(follow_symlinks=False).st_dev != root_dev:
                continue
            if len(stack) >= max_depth:
                sys.exit("directory tree too deep to scan for large files")
            child = os.open(entry.name, flags, dir_fd=fd)
        except FileNotFoundError:
            continue  # removed since it was listed
        stack.append((child, os.scandir(child), rel + name + b"/"))
    out.flush()
except OSError as err:
    sys.exit(f"oversized file scan: {err.strerror}")
"""


def scan_oversized_files(
    datafd, *, max_file_bytes, one_file_system, deadline, report=None, prefix=""
):
    """Find regular files Rustic will skip, without reading their contents."""
    # Isolated: the working directory is the user's tree, which must not
    # supply modules to a root Python.
    args = [
        sys.executable or "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        OVERSIZED_WALK_PROGRAM,
        str(max_file_bytes),
        "1" if one_file_system else "0",
        str(OVERSIZED_SCAN_MAX_DEPTH),
    ]
    if report is None:
        report = new_oversized_report(max_file_bytes)
    pending = bytearray()

    def on_stdout(chunk):
        pending.extend(chunk)
        while True:
            end = pending.find(b"\0")
            if end < 0:
                break
            size, _, path = bytes(pending[:end]).partition(b" ")
            del pending[: end + 1]
            add_oversized_file(report, prefix + os.fsdecode(path), int(size))
        if len(pending) > OVERSIZED_FILES_MAX_RECORD_BYTES:
            fail("oversized file scan produced an unbounded record")

    status = run_supervised(
        args,
        deadline=deadline,
        on_stdout=on_stdout,
        cwd=f"/proc/self/fd/{datafd}",
        env={"LANG": "C", "PATH": "/usr/bin:/bin"},
        pass_fds=(datafd,),
    )
    if status != 0 or pending:
        fail("unable to scan for files larger than the backup limit")
    return report


# The change walk, run by scan_changed_since like the oversized-file walk (the
# tree as working directory, directories opened relative to their parent
# without following symlinks, one filesystem). It prints the path ("." for
# the top) of each entry whose ctime is at or after the given time, each
# followed by \\0, and stops after the given number. ctime moves with every
# write, chmod, rename and link and, on the parent directory, every delete;
# an unprivileged process cannot set it. The top-level .snapshots directory
# only holds the project's snapshots, so managing them is not a change. Any
# other directory on another filesystem ends the walk with status 3.
# Arguments: time in ns, maximum paths, maximum depth.
CHANGED_SINCE_WALK_PROGRAM = """
import os, sys
since_ns, max_paths, max_depth = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
out = sys.stdout.buffer
# O_NOATIME: reading a directory must not write its access time, which on a
# relatime mount would change the subvolume the caller checks is unchanged.
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME
found = 0
def report(path):
    global found
    out.write(path + b"\\0")
    found += 1
    if found >= max_paths:
        out.flush()
        sys.exit(0)
try:
    root = os.open(".", flags)
    info = os.fstat(root)
    root_dev = info.st_dev
    if info.st_ctime_ns >= since_ns:
        report(b".")
    stack = [(root, os.scandir(root), b"")]
    while stack:
        fd, entries, rel = stack[-1]
        entry = next(entries, None)
        if entry is None:
            entries.close()
            os.close(fd)
            stack.pop()
            continue
        if not rel and entry.name == ".snapshots":
            continue
        name = os.fsencode(entry.name)
        try:
            st = entry.stat(follow_symlinks=False)
            if st.st_ctime_ns >= since_ns:
                report(rel + name)
            if not entry.is_dir(follow_symlinks=False):
                continue
            if st.st_dev != root_dev:
                # A nested subvolume or mount: changes below it move neither
                # the ctimes seen here nor the project's generation. Can't
                # tell (exit status 3).
                out.flush()
                sys.exit(3)
            if len(stack) >= max_depth:
                sys.exit("directory tree too deep to scan for changes")
            child = os.open(entry.name, flags, dir_fd=fd)
        except FileNotFoundError:
            continue  # removed since it was listed: its directory changed
        stack.append((child, os.scandir(child), rel + name + b"/"))
    out.flush()
except OSError as err:
    sys.exit(f"change scan: {err.strerror}")
"""


def scan_changed_since(datafd, *, since_ns, deadline):
    """Up to CHANGED_SINCE_MAX_PATHS paths changed at or after since_ns,
    without reading any file."""
    # Isolated: the working directory is the user's tree, which must not
    # supply modules to a root Python (needs Python >= 3.11: -I implies -P).
    args = [
        sys.executable or "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        CHANGED_SINCE_WALK_PROGRAM,
        str(since_ns),
        str(CHANGED_SINCE_MAX_PATHS),
        str(OVERSIZED_SCAN_MAX_DEPTH),
    ]
    paths = []
    pending = bytearray()

    def on_stdout(chunk):
        pending.extend(chunk)
        while True:
            end = pending.find(b"\0")
            if end < 0:
                break
            paths.append(os.fsdecode(bytes(pending[:end])))
            del pending[: end + 1]
        if (
            len(paths) > CHANGED_SINCE_MAX_PATHS
            or len(pending) > OVERSIZED_FILES_MAX_RECORD_BYTES
        ):
            fail("change scan produced unbounded output")

    status = run_supervised(
        args,
        deadline=deadline,
        on_stdout=on_stdout,
        cwd=f"/proc/self/fd/{datafd}",
        env={"LANG": "C", "PATH": "/usr/bin:/bin"},
        pass_fds=(datafd,),
    )
    foreign_filesystem = status == 3
    if (status != 0 and not foreign_filesystem) or pending:
        fail("unable to scan for changes")
    return {
        "since_ns": since_ns,
        "paths": paths,
        "truncated": len(paths) >= CHANGED_SINCE_MAX_PATHS,
        "foreign_filesystem": foreign_filesystem,
    }


def run_scan_changed_since(argv, allowed_roots=ALLOWED_ROOTS):
    """Print, as JSON, project-relative paths changed at or after --since-ns."""
    values = {}
    i = 1
    while i < len(argv):
        option = argv[i]
        if option not in ("--root", "--path", "--since-ns") or i + 1 >= len(argv):
            fail(f"invalid scan option: {option}")
        key = option[2:]
        if key in values:
            fail(f"duplicate scan option: {option}")
        values[key] = argv[i + 1]
        i += 2
    for key in ("root", "path", "since-ns"):
        if key not in values:
            fail(f"missing --{key}")
    validate_relative(values["path"], allow_root=True)
    since = values["since-ns"]
    if not since or len(since) > 20 or any(c not in "0123456789" for c in since):
        fail("invalid --since-ns")
    deadline = time.monotonic() + CHANGED_SINCE_MAX_RUNTIME_SECONDS
    rootfd = open_root(values["root"], allowed_roots)
    datafd = None
    try:
        datafd = openat2(
            rootfd, values["path"], O_PATH | os.O_DIRECTORY | os.O_CLOEXEC
        )
        report = scan_changed_since(datafd, since_ns=int(since), deadline=deadline)
    finally:
        if datafd is not None:
            os.close(datafd)
        os.close(rootfd)
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))


def run_scan_oversized_files(argv, allowed_roots=ALLOWED_ROOTS):
    """Print the files a project backup would skip, as JSON on stdout.

    With --subpath, only those project-relative paths are scanned. Each one is
    opened without following symlinks, so it cannot leave the project.
    """
    values = {"subpath": []}
    i = 1
    while i < len(argv):
        option = argv[i]
        if (
            option not in ("--root", "--path", "--max-file-bytes", "--subpath")
            or i + 1 >= len(argv)
        ):
            fail(f"invalid scan option: {option}")
        key = option[2:]
        if key == "subpath":
            values["subpath"].append(argv[i + 1])
        elif key in values:
            fail(f"duplicate scan option: {option}")
        else:
            values[key] = argv[i + 1]
        i += 2
    for key in ("root", "path"):
        if key not in values:
            fail(f"missing --{key}")
    validate_relative(values["path"], allow_root=True)
    if len(values["subpath"]) > OVERSIZED_SCAN_MAX_SUBPATHS:
        fail("too many scan subpaths")
    for subpath in values["subpath"]:
        validate_relative(subpath)
    max_file_bytes = parse_max_file_bytes(values.get("max-file-bytes"))
    deadline = time.monotonic() + OVERSIZED_SCAN_MAX_RUNTIME_SECONDS
    report = new_oversized_report(max_file_bytes)
    rootfd = open_root(values["root"], allowed_roots)
    datafd = None
    try:
        datafd = openat2(
            rootfd, values["path"], O_PATH | os.O_DIRECTORY | os.O_CLOEXEC
        )
        for subpath in values["subpath"] or [None]:
            if subpath is None:
                scan_oversized_files(
                    datafd,
                    max_file_bytes=max_file_bytes,
                    one_file_system=True,
                    deadline=deadline,
                    report=report,
                )
                continue
            try:
                fd = openat2(datafd, subpath, O_PATH | os.O_CLOEXEC)
            except OSError as err:
                # A symlink is copied as a link, never as a large file.
                if err.errno == errno.ELOOP:
                    continue
                raise
            try:
                info = os.fstat(fd)
                if stat.S_ISDIR(info.st_mode):
                    scan_oversized_files(
                        fd,
                        max_file_bytes=max_file_bytes,
                        one_file_system=True,
                        deadline=deadline,
                        report=report,
                        prefix=f"{subpath.rstrip('/')}/",
                    )
                elif stat.S_ISREG(info.st_mode) and info.st_size > max_file_bytes:
                    add_oversized_file(report, subpath, info.st_size)
            finally:
                os.close(fd)
    finally:
        if datafd is not None:
            os.close(datafd)
        os.close(rootfd)
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))


# Restores and tree copies write content that cocalc-host controls (its own
# backup repositories and trees), so they never run as real root.  A
# confined child sees only a private mount namespace (a tmpfs root with the
# read-only system binds below and the pinned work directories, but no host
# /proc), and runs as the runtime user in a user namespace that maps the
# runtime ids and their subordinate extents to themselves and leaves uid 0
# unmapped.  It keeps only the capabilities below.  Root writes the id maps
# itself (newuidmap would check them against root's own subordinate ids).
CONFINED_RUN_DIR = "/run/cocalc-confined"
CONFINED_CAPS = (0, 1, 2, 3, 4)  # CHOWN DAC_OVERRIDE DAC_READ_SEARCH FOWNER FSETID
CAP_SETFCAP = 31
CONFINED_SYSTEM_DIRS = ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32")
CONFINED_ETC_FILES = ("passwd", "group", "nsswitch.conf", "hosts", "host.conf", "gai.conf", "resolv.conf", "ld.so.cache")
CONFINED_ETC_DIRS = ("ssl",)
CONFINED_DEVICES = ("null", "zero", "urandom")
CONFINED_WORK_TARGETS = {"/staging", "/home", "/src", "/dest"}
CONFINED_PROFILE_TARGET = "/profile.toml"
CONFINED_RSYNC = ["/usr/bin/rsync", "-aAX", "--super", "--numeric-ids"]
# cp writes regular files through existing destination symlinks, so reflink
# copies run confined too.  Across the jail's two bind mounts FICLONE gives
# EXDEV and cp falls back to copy_file_range, which btrfs still clones.
CONFINED_CP = ["/usr/bin/cp", "-a", "--reflink=auto", "--remove-destination"]
CONFINED_ENV = {
    "HOME": "/tmp",
    "LANG": "C.UTF-8",
    "PATH": "/usr/bin:/bin",
    "RUSTIC_PROGRESS_INTERVAL": "1s",
    "SSL_CERT_DIR": "/etc/ssl/certs",
    "TMPDIR": "/tmp",
}
# rsync exit 23 ("partial transfer") is tolerated for project restores only
# when every error is one the confinement causes on purpose: an entry owned
# by an unmapped id (uid 0), a device node, or a host-global file capability.
# Such entries are suspicious in project trees, so the caller logs them.
CONFINED_SKIP_PATTERNS = (
    re.compile(r'^rsync: \[[a-z]+\] chown ".*" failed: Invalid argument \(22\)$'),
    re.compile(r'^rsync: \[[a-z]+\] send_files failed to open ".*": Permission denied \(13\)$'),
    re.compile(r'^rsync: \[[a-z]+\] mknod ".*" failed: Operation not permitted \(1\)$'),
    re.compile(r'^rsync: \[[a-z]+\] rsync_xal_set: lsetxattr\(".*","security\.capability"\) failed: (Operation not permitted \(1\)|Invalid argument \(22\))$'),
)
CONFINED_PARTIAL_LINE = re.compile(r"^rsync error: some files/attrs were not transferred .*\(code 23\).*$")
CONFINED_SKIPPED_MARKER = "COCALC_CONFINED_SKIPPED_ENTRIES"
MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_REMOUNT = 32
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18
CLONE_NEWNS = 0x00020000
CLONE_NEWPID = 0x20000000
# The jail's own procfs (Rustic needs /proc/self/exe): a fresh instance for
# the child's PID namespace, showing only the jail's processes and none of
# the system files.
CONFINED_PROC_OPTIONS = "hidepid=invisible,subset=pid"
# The new mount API (same numbers on x86_64 and arm64).  The pinned work
# directories were opened in the host mount namespace, and a classic bind
# from another namespace fails with EINVAL; a detached clone (open_tree)
# taken before unshare can be attached inside the new one (move_mount).
# pivot_root has no glibc wrapper and an arch-specific number.
SYS_PIVOT_ROOT = {"x86_64": 155, "aarch64": 41}
MNT_DETACH = 2
SYS_OPEN_TREE = 428
SYS_MOVE_MOUNT = 429
SYS_MOUNT_SETATTR = 442
OPEN_TREE_CLONE = 1
AT_EMPTY_PATH = 0x1000
AT_FDCWD = -100
MOVE_MOUNT_F_EMPTY_PATH = 0x4
MOUNT_ATTR_RDONLY = 0x1
MOUNT_ATTR_NOSUID = 0x2
MOUNT_ATTR_NODEV = 0x4
MOUNT_ATTR_NOEXEC = 0x8
# No symlink is followed in any path walk on the work directories (copies
# still read and create links as links): a second layer under the jail.
MOUNT_ATTR_NOSYMFOLLOW = 0x00200000
CLONE_NEWUSER = 0x10000000
PR_SET_KEEPCAPS = 8
PR_CAPBSET_DROP = 24
PR_SET_NO_NEW_PRIVS = 38
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_RAISE = 2
PR_CAP_AMBIENT_CLEAR_ALL = 4
LINUX_CAPABILITY_VERSION_3 = 0x20080522


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


def libc_check(result, what):
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, f"{what}: {os.strerror(error)}")


def confined_id_maps(user=RUNTIME_USER, subid_files=SUBID_FILES):
    """Identity uid and gid maps: the runtime ids and their subordinate
    extents, each mapped to itself.  Never 0, never overlapping."""
    uid, gid = runtime_user_ids(user)
    maps = []
    for own, path in ((uid, subid_files[0]), (gid, subid_files[1])):
        extents = sorted({(own, 1), *subordinate_ranges(path, user, uid)})
        for start, count in extents:
            if start <= 0 or count <= 0 or start + count > 2**32 - 1:
                fail(f"invalid id extent {start}:{count}")
        for (a, n), (b, _m) in zip(extents, extents[1:]):
            if a + n > b:
                fail("overlapping id extents")
        maps.append("".join(f"{start} {start} {count}\n" for start, count in extents))
    return uid, gid, maps[0], maps[1]


def confined_mount_plan(jail, binds, executable_dirs, path_exists=os.path.lexists,
                        is_link=os.path.islink, read_link=os.readlink, real_path=os.path.realpath):
    """The mounts that make up the jail, in order: (kind, source, target,
    flags).  kind is tmpfs, bind (then remounted with flags), mkdir, file
    (an empty mountpoint), or symlink (source is the link text)."""
    plan = [("tmpfs", "tmpfs", jail, MS_NOSUID | MS_NODEV, "mode=0755,size=16m")]
    system = MS_RDONLY | MS_NOSUID | MS_NODEV
    for path in CONFINED_SYSTEM_DIRS:
        if not path_exists(path):
            continue
        if is_link(path):
            plan.append(("symlink", read_link(path), jail + path, 0, None))
        else:
            plan.append(("mkdir", None, jail + path, 0, None))
            plan.append(("bind", path, jail + path, system, None))
    plan.append(("mkdir", None, jail + "/etc", 0, None))
    for name in CONFINED_ETC_FILES:
        source = "/etc/" + name
        if path_exists(source):
            plan.append(("file", None, f"{jail}/etc/{name}", 0, None))
            # resolv.conf is often a link into /run: bind its target only.
            plan.append(("bind", real_path(source), f"{jail}/etc/{name}", system, None))
    for name in CONFINED_ETC_DIRS:
        if path_exists("/etc/" + name):
            plan.append(("mkdir", None, f"{jail}/etc/{name}", 0, None))
            plan.append(("bind", "/etc/" + name, f"{jail}/etc/{name}", system, None))
    plan.append(("mkdir", None, jail + "/dev", 0, None))
    for name in CONFINED_DEVICES:
        plan.append(("file", None, f"{jail}/dev/{name}", 0, None))
        plan.append(("bind", "/dev/" + name, f"{jail}/dev/{name}", MS_NOSUID | MS_NOEXEC, None))
    plan.append(("mkdir", None, jail + "/proc", 0, None))
    plan.append(("proc", "proc", jail + "/proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, CONFINED_PROC_OPTIONS))
    plan.append(("mkdir", None, jail + "/tmp", 0, None))
    plan.append(("tmpfs", "tmpfs", jail + "/tmp", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777,size=256m"))
    for path in executable_dirs:
        plan.append(("mkdirs", None, jail + path, 0, None))
        plan.append(("bind", path, jail + path, MS_RDONLY | MS_NOSUID | MS_NODEV, None))
    for fd, target, writable in binds:
        if target == CONFINED_PROFILE_TARGET:
            plan.append(("file", None, jail + target, 0, None))
        else:
            plan.append(("mkdir", None, jail + target, 0, None))
        flags = MS_NOSUID | MS_NODEV | MS_NOEXEC | (0 if writable else MS_RDONLY)
        # source is the pinned fd itself: never re-resolved by path.
        plan.append(("tree", fd, jail + target, flags, None))
    return plan


def confined_mount(source, target, fstype, flags, data=None):
    encode = lambda value: None if value is None else os.fsencode(value)
    libc_check(
        LIBC.mount(encode(source), encode(target), encode(fstype), ctypes.c_ulong(flags), encode(data)),
        f"mount {target}",
    )


class MountAttr(ctypes.Structure):
    _fields_ = [
        ("attr_set", ctypes.c_uint64),
        ("attr_clr", ctypes.c_uint64),
        ("propagation", ctypes.c_uint64),
        ("userns_fd", ctypes.c_uint64),
    ]


def clone_pinned_trees(plan):
    """Before unshare: a detached, non-recursive clone of each pinned work
    directory, with its mount flags already set.  Returns {plan index:
    tree fd}, so one pinned fd may be bound at several targets."""
    trees = {}
    for index, (kind, source, _target, flags, _data) in enumerate(plan):
        if kind != "tree":
            continue
        tree = LIBC.syscall(
            SYS_OPEN_TREE, ctypes.c_int(source), b"",
            ctypes.c_uint(OPEN_TREE_CLONE | os.O_CLOEXEC | AT_EMPTY_PATH),
        )
        if tree < 0:
            error = ctypes.get_errno()
            raise OSError(error, f"open_tree: {os.strerror(error)}")
        attr = MountAttr(
            (MOUNT_ATTR_NOSUID if flags & MS_NOSUID else 0)
            | (MOUNT_ATTR_NODEV if flags & MS_NODEV else 0)
            | (MOUNT_ATTR_NOEXEC if flags & MS_NOEXEC else 0)
            | (MOUNT_ATTR_RDONLY if flags & MS_RDONLY else 0)
            | MOUNT_ATTR_NOSYMFOLLOW,
            0, 0, 0,
        )
        libc_check(
            LIBC.syscall(SYS_MOUNT_SETATTR, ctypes.c_int(tree), b"", ctypes.c_uint(AT_EMPTY_PATH),
                         ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr))),
            "mount_setattr",
        )
        trees[index] = tree
    return trees


def build_jail(plan, trees=None):
    confined_mount(None, "/", None, MS_REC | MS_PRIVATE)
    for index, (kind, source, target, flags, data) in enumerate(plan):
        if kind == "tmpfs":
            confined_mount(source, target, "tmpfs", flags, data)
        elif kind == "proc":
            confined_mount(source, target, "proc", flags, data)
        elif kind == "mkdir":
            os.mkdir(target, 0o755)
        elif kind == "mkdirs":
            os.makedirs(target, 0o755, exist_ok=True)
        elif kind == "file":
            os.close(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644))
        elif kind == "symlink":
            os.symlink(source, target)
        elif kind == "bind":
            confined_mount(source, target, None, MS_BIND)
            confined_mount(None, target, None, MS_REMOUNT | MS_BIND | flags)
        elif kind == "tree":
            tree = trees.pop(index)
            try:
                libc_check(
                    LIBC.syscall(SYS_MOVE_MOUNT, ctypes.c_int(tree), b"", ctypes.c_int(AT_FDCWD),
                                 os.fsencode(target), ctypes.c_uint(MOVE_MOUNT_F_EMPTY_PATH)),
                    f"move_mount {target}",
                )
            finally:
                os.close(tree)
            # A clone may share the source's peer group: never propagate.
            confined_mount(None, target, None, MS_PRIVATE)


def enter_jail(jail):
    """Make the jail the mount namespace's root (pivot_root, not chroot:
    the kernel refuses CLONE_NEWUSER from a chroot), then detach the old
    root, so no host mount is left in the namespace."""
    number = SYS_PIVOT_ROOT.get(os.uname().machine)
    if number is None:
        fail(f"pivot_root: unsupported machine {os.uname().machine}")
    os.mkdir(os.path.join(jail, ".old"), 0o700)
    os.chdir(jail)
    libc_check(LIBC.syscall(number, b".", b".old"), "pivot_root")
    os.chdir("/")
    libc_check(LIBC.umount2(b"/.old", MNT_DETACH), "detach old root")
    os.rmdir("/.old")


def confined_drop(uid, gid, caps, last_cap):
    libc_check(LIBC.prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0), "keepcaps")
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    last = last_cap
    for cap in range(last + 1):
        if cap not in caps:
            libc_check(LIBC.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0), f"bounding drop {cap}")
    mask = sum(1 << cap for cap in caps)
    header = CapHeader(LINUX_CAPABILITY_VERSION_3, 0)
    data = (CapData * 2)(CapData(mask, mask, mask), CapData(0, 0, 0))
    libc_check(LIBC.capset(ctypes.byref(header), data), "capset")
    libc_check(LIBC.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0), "ambient clear")
    for cap in caps:
        libc_check(LIBC.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, cap, 0, 0), f"ambient {cap}")
    libc_check(LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")


def parse_confined_spec(text, rustic_candidates=None):
    spec = json.loads(text)
    if set(spec) != {"argv", "binds", "setfcap", "tolerate_skips"}:
        fail("invalid confined spec")
    argv, binds = spec["argv"], spec["binds"]
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        fail("invalid confined argv")
    allowed_programs = {CONFINED_RSYNC[0], CONFINED_CP[0], *(rustic_candidates or RUSTIC_CANDIDATES)}
    if argv[0] == CONFINED_EXEC_PATH:
        # Only the capability walker, with its fixed arguments.
        if len(argv) != 4 or argv[1:3] != [IMAGE_CAPS_WALK, "--rootid"] or not re.fullmatch(r"[1-9][0-9]{0,9}", argv[3]):
            fail("only the image capability walker may run the helper confined")
    elif argv[0] not in allowed_programs:
        fail(f"program is not allowed in confinement: {argv[0]!r}")
    targets = set()
    parsed = []
    for bind in binds:
        fd, target, writable = bind
        if (
            not isinstance(fd, int)
            or fd < 3
            or target not in CONFINED_WORK_TARGETS | {CONFINED_PROFILE_TARGET}
            or target in targets
            or not isinstance(writable, bool)
            or (target == CONFINED_PROFILE_TARGET and writable)
        ):
            fail("invalid confined bind")
        targets.add(target)
        parsed.append((fd, target, writable))
    if not isinstance(spec["setfcap"], bool) or not isinstance(spec["tolerate_skips"], bool):
        fail("invalid confined spec")
    return argv, parsed, spec["setfcap"], spec["tolerate_skips"]


class ConfinedErrors:
    """Classifies rsync's stderr as it streams, every line, no cap.  Exit 23
    is tolerable only if every rsync error line was a deliberate confinement
    skip, there was at least one, and rsync ended with its partial-transfer
    line."""

    def __init__(self):
        self.skipped = 0
        self.unexpected = False
        self.partial = False

    def feed(self, line):
        line = line.rstrip("\n")
        if not line.startswith("rsync"):
            return
        if CONFINED_PARTIAL_LINE.match(line):
            self.partial = True
        elif any(pattern.match(line) for pattern in CONFINED_SKIP_PATTERNS):
            self.skipped += 1
        else:
            self.unexpected = True

    def tolerable(self):
        return not self.unexpected and self.skipped > 0 and self.partial


def classify_confined_errors(lines):
    """Return (tolerable, skipped) for rsync stderr lines (see ConfinedErrors)."""
    errors = ConfinedErrors()
    for line in lines:
        errors.feed(line)
    return errors.tolerable(), errors.skipped


def run_confined_exec(argv, run_dir=CONFINED_RUN_DIR, id_maps=None, rustic_candidates=None):
    """_confined-exec SPEC: run SPEC's program confined (see above).  Started
    by run_confined through run_supervised, which owns the deadline."""
    if len(argv) != 2:
        fail("usage: _confined-exec SPEC")
    program_argv, binds, setfcap, tolerate_skips = parse_confined_spec(argv[1], rustic_candidates)
    uid, gid, uid_map, gid_map = id_maps or confined_id_maps()
    caps = CONFINED_CAPS + ((CAP_SETFCAP,) if setfcap else ())
    program_dir = os.path.dirname(program_argv[0])
    executable_dirs = (
        []
        if any(program_dir == top or program_dir.startswith(top + "/") for top in CONFINED_SYSTEM_DIRS)
        else [program_dir]
    )
    ensure_private_root_directory(run_dir, 0, 0o700)
    jail = tempfile.mkdtemp(prefix="jail-", dir=run_dir)
    plan = confined_mount_plan(jail, binds, executable_dirs)
    ready_r, ready_w = os.pipe()
    go_r, go_w = os.pipe()
    err_r, err_w = os.pipe()
    # The child is PID 1 of a new PID namespace (its procfs shows only the
    # jail); this helper stays outside, keeps its real pid for the id maps,
    # and supervises it directly.  PID 1 cannot ignore SIGKILL from here.
    os.unshare(CLONE_NEWPID)
    pid = os.fork()
    if pid == 0:
        step = "setup"
        try:
            os.close(ready_r)
            os.close(go_w)
            os.close(err_r)
            os.dup2(err_w, 2)
            step = "setgroups"
            os.setgroups([])
            step = "pinned trees"
            trees = clone_pinned_trees(plan)
            step = "mount namespace"
            os.unshare(CLONE_NEWNS)
            step = "jail"
            build_jail(plan, trees)
            # The pinned fds point into the host mount namespace; once bound
            # they are not needed, and kept open they would lead back to the
            # host tree after pivot_root.
            # Read while the host /proc is still visible (the jail's procfs
            # has no /proc/sys).
            with open("/proc/sys/kernel/cap_last_cap") as handle:
                last_cap = int(handle.read())
            keep = {0, 1, 2, ready_w, go_r}
            for name in os.listdir("/proc/self/fd"):
                if int(name) not in keep:
                    try:
                        os.close(int(name))
                    except OSError:
                        pass
            step = "pivot root"
            enter_jail(jail)
            step = "user namespace"
            os.unshare(CLONE_NEWUSER)
            os.write(ready_w, b"1")
            if os.read(go_r, 1) != b"1":
                os._exit(125)
            step = "drop"
            confined_drop(uid, gid, caps, last_cap)
            step = "exec"
            os.execve(program_argv[0], program_argv, CONFINED_ENV)
        except BaseException as err:
            os.write(2, f"SECURITY_DENY code=confined-{step.replace(' ', '-')} detail={err}\n".encode())
            os._exit(126)
    os.close(ready_w)
    os.close(go_r)
    os.close(err_w)
    status = None
    try:
        try:
            if os.read(ready_r, 1) == b"1":
                with open(f"/proc/{pid}/setgroups", "w") as f:
                    f.write("deny")
                with open(f"/proc/{pid}/uid_map", "w") as f:
                    f.write(uid_map)
                with open(f"/proc/{pid}/gid_map", "w") as f:
                    f.write(gid_map)
                os.write(go_w, b"1")
        finally:
            os.close(go_w)
            os.close(ready_r)
        errors = ConfinedErrors()
        with os.fdopen(err_r, "r", errors="replace") as stream:
            for line in stream:
                sys.stderr.write(line)
                errors.feed(line)
        sys.stderr.flush()
        _pid, status = os.waitpid(pid, 0)
    finally:
        if status is None:
            # Stopped (deadline, caller gone, signal): the child is PID 1 of
            # its namespace and ignores SIGTERM, so kill it, which ends
            # every process in the namespace.
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        try:
            os.rmdir(jail)
        except OSError:
            if status is not None:
                raise  # only after a clean run; never mask the original error
    code = os.waitstatus_to_exitcode(status)
    if code == 23 and tolerate_skips and errors.tolerable():
        print(f"{CONFINED_SKIPPED_MARKER} count={errors.skipped}", file=sys.stderr, flush=True)
        return 0
    return code


CONFINED_EXEC_PATH = "/usr/local/libexec/cocalc-runtime-storage-path-helper"


def run_confined(program_argv, binds, *, deadline, setfcap=False, tolerate_skips=False, exec_path=CONFINED_EXEC_PATH):
    """Run program_argv confined, binding each (fd, target, writable)."""
    spec = json.dumps(
        {
            "argv": program_argv,
            "binds": [[fd, target, writable] for fd, target, writable in binds],
            "setfcap": setfcap,
            "tolerate_skips": tolerate_skips,
        }
    )
    return run_supervised(
        [exec_path, "_confined-exec", spec],
        deadline=deadline,
        pass_fds=tuple(fd for fd, _target, _writable in binds),
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
    )


# normalize-rootfs (re)creates these links as root; in a container tree they
# belong to the container root.  A confined copy cannot recreate a uid-0
# owner and fails closed, so they are handed to the container root first.
ROOT_OWNED_IMAGE_LINKS = (("etc", "mtab"), ("var", "run"))


def container_root_ids(user=RUNTIME_USER, subid_files=SUBID_FILES):
    uid, gid = runtime_user_ids(user)
    uids = sorted(subordinate_ranges(subid_files[0], user, uid))
    gids = sorted(subordinate_ranges(subid_files[1], user, gid))
    if not uids or not gids:
        fail("the runtime user has no subordinate ids")
    return uids[0][0], gids[0][0]


def own_root_links(treefd, owner):
    """lchown etc/mtab and var/run beneath the pinned tree to owner, only
    where each is a symlink owned by uid or gid 0.  Their parents are
    resolved without following symlinks; nothing else is touched.  Returns
    how many links changed."""
    changed = 0
    for parent, name in ROOT_OWNED_IMAGE_LINKS:
        try:
            parentfd = openat2(treefd, parent, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        except OSError:
            continue
        try:
            info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) and (info.st_uid == 0 or info.st_gid == 0):
                os.chown(name, *owner, dir_fd=parentfd, follow_symlinks=False)
                changed += 1
        except FileNotFoundError:
            pass
        finally:
            os.close(parentfd)
    return changed


# File capabilities in image trees (finding 014).  Image extraction ran as
# root and kept host-global (v2) capabilities, which are effective when the
# host runs the file.  Each image is walked once, confined with SETFCAP over
# a writable bind (see run_confined): v1/v2 become v3 rooted at the container
# root, keeping the permitted, inheritable and effective bits; v3 rooted at
# the container root is kept; any other rootid is removed, never re-rooted.
VFS_CAP_REVISION_MASK = 0xFF000000
VFS_CAP_FLAGS_EFFECTIVE = 0x000001
VFS_CAP_SIZES = {0x01000000: 12, 0x02000000: 20, 0x03000000: 24}
VFS_CAP_REVISION_3 = 0x03000000
IMAGE_CAPS_VERSION = 1
IMAGE_CAPS_WALK = "_image-caps-walk"
IMAGE_CAPS_TARGET = "/dest"
IMAGE_CAPS_STATE = "/var/lib/cocalc/image-caps.json"
IMAGE_CAPS_STATE_MAX_BYTES = 4 * 1024 * 1024
IMAGE_CAPS_STATE_MAX_IMAGES = 20000
BTRFS_IOC_GET_SUBVOL_INFO = (2 << 30) | (504 << 16) | (0x94 << 8) | 60


def parse_file_capability(value):
    """(revision, flags, (p0, i0, p1, i1), rootid or None); strict."""
    if len(value) < 4:
        fail("malformed file capability")
    magic = struct.unpack_from("<I", value)[0]
    revision = magic & VFS_CAP_REVISION_MASK
    flags = magic & ~VFS_CAP_REVISION_MASK
    if revision not in VFS_CAP_SIZES or len(value) != VFS_CAP_SIZES[revision]:
        fail("malformed file capability")
    if flags & ~VFS_CAP_FLAGS_EFFECTIVE:
        fail("file capability has unknown flags")
    if revision == 0x01000000:
        p0, i0 = struct.unpack_from("<II", value, 4)
        return revision, flags, (p0, i0, 0, 0), None
    words = struct.unpack_from("<IIII", value, 4)
    rootid = struct.unpack_from("<I", value, 20)[0] if revision == VFS_CAP_REVISION_3 else None
    return revision, flags, words, rootid


def v3_file_capability(flags, words, rootid):
    return struct.pack("<IIIIII", VFS_CAP_REVISION_3 | flags, *words, rootid)


def image_caps_walk(top, rootid):
    """Inside the confinement: convert or remove the capabilities beneath
    top (see above).  Regular files only; any traversal error, malformed
    value or unexpected errno fails the walk."""
    counts = {"converted": 0, "kept": 0, "stripped": 0}

    def raise_error(err):
        raise err

    for _dirpath, _dirnames, filenames, dirfd in os.fwalk(top, follow_symlinks=False, onerror=raise_error):
        for name in filenames:
            info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                continue
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dirfd)
            try:
                opened = os.fstat(fd)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    fail(f"file changed during the capability walk: {name!r}")
                try:
                    value = os.getxattr(fd, "security.capability")
                except OSError as err:
                    if err.errno == errno.ENODATA:
                        continue
                    if err.errno == errno.EOVERFLOW:
                        # Rooted outside this namespace: not ours to keep.
                        os.removexattr(fd, "security.capability")
                        counts["stripped"] += 1
                        continue
                    raise
                revision, flags, words, current = parse_file_capability(value)
                if revision == VFS_CAP_REVISION_3 and current == rootid:
                    counts["kept"] += 1
                elif revision == VFS_CAP_REVISION_3:
                    os.removexattr(fd, "security.capability")
                    counts["stripped"] += 1
                else:
                    os.setxattr(fd, "security.capability", v3_file_capability(flags, words, rootid))
                    counts["converted"] += 1
            finally:
                os.close(fd)
    return counts


def run_image_caps_walk_entry(argv):
    """The confined walker's entry point: exactly
    _image-caps-walk --rootid N, always on /dest."""
    if len(argv) != 3 or argv[:2] != [IMAGE_CAPS_WALK, "--rootid"] or not re.fullmatch(r"[1-9][0-9]{0,9}", argv[2]):
        fail("usage: _image-caps-walk --rootid N")
    counts = image_caps_walk(IMAGE_CAPS_TARGET, int(argv[2]))
    print(json.dumps(counts, sort_keys=True), flush=True)
    return 0


def image_identity(fd):
    """A key for an image root that survives remounts: a btrfs subvolume
    root is named by its UUID (subvolume roots all have inode 256 and their
    device numbers are reassigned); anything else by device, inode and
    ctime.  After a walk only root extraction could add a host-global
    capability again, and normalize-rootfs then forces a walk."""
    info = os.fstat(fd)
    if info.st_ino == BTRFS_FIRST_FREE_OBJECTID:
        # ioctl needs a real fd; the pinned one may be O_PATH.
        realfd = os.open(f"/proc/self/fd/{fd}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            args = bytearray(504)
            try:
                fcntl.ioctl(realfd, BTRFS_IOC_GET_SUBVOL_INFO, args)
            except OSError as err:
                # Only "not btrfs" may fall back to the inode key.
                if err.errno != errno.ENOTTY:
                    raise
            else:
                uuid = bytes(args[296:312]).hex()
                if uuid == "0" * 32:
                    fail("btrfs subvolume without a UUID")
                return f"subvol:{uuid}"
        finally:
            os.close(realfd)
    return f"inode:{info.st_dev}:{info.st_ino}:{info.st_ctime_ns}"


def read_image_caps_state(path=IMAGE_CAPS_STATE):
    """{identity: version}; anything unreadable or malformed counts as
    empty (images are walked again, never skipped)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:  # missing, or a symlink (O_NOFOLLOW)
        return {}
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 \
                or info.st_size > IMAGE_CAPS_STATE_MAX_BYTES:
            return {}
        data = os.read(fd, IMAGE_CAPS_STATE_MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        state = json.loads(data)
    except ValueError:
        return {}
    images = state.get("images") if isinstance(state, dict) else None
    if not isinstance(images, dict) or len(images) > IMAGE_CAPS_STATE_MAX_IMAGES:
        return {}
    return {
        key: value
        for key, value in images.items()
        if isinstance(key, str) and len(key) <= 128 and isinstance(value, int)
    }


def write_image_caps_state(images, path=IMAGE_CAPS_STATE):
    directory, name = os.path.split(path)
    data = json.dumps({"images": images}, sort_keys=True).encode()
    for _attempt in range(16):
        temp = f".{name}.{os.urandom(8).hex()}"
        try:
            fd = os.open(os.path.join(directory, temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except FileExistsError:
            continue
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(os.path.join(directory, temp), path)
        dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        return
    fail("could not write the image capability state")


def subvolume_readonly(treefd):
    if os.fstat(treefd).st_ino != BTRFS_FIRST_FREE_OBJECTID:
        return False
    fd = os.open(f"/proc/self/fd/{treefd}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        flags = bytearray(8)
        try:
            fcntl.ioctl(fd, BTRFS_IOC_SUBVOL_GETFLAGS, flags)
        except OSError:
            return False
        return bool(struct.unpack("<Q", flags)[0] & BTRFS_SUBVOL_RDONLY)
    finally:
        os.close(fd)


def set_subvolume_readonly(treefd, readonly):
    fd = os.open(f"/proc/self/fd/{treefd}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        flags = bytearray(8)
        fcntl.ioctl(fd, BTRFS_IOC_SUBVOL_GETFLAGS, flags)
        value = struct.unpack("<Q", flags)[0]
        value = value | BTRFS_SUBVOL_RDONLY if readonly else value & ~BTRFS_SUBVOL_RDONLY
        fcntl.ioctl(fd, BTRFS_IOC_SUBVOL_SETFLAGS, bytearray(struct.pack("<Q", value)))
    finally:
        os.close(fd)


# normalize-rootfs before helper schema 20261120-r23 created apt's partial
# dirs (and a missing lists or archives) as host root, after the ownership
# bridge (the root cause found with finding 093).  An unmapped owner's 0700
# dir cannot be read by the confined walk, so exactly these dirs, while
# still 0:0, go to the container root first, which is the owner the step
# meant them to have.
HOST_ROOT_APT_REPAIRS = (
    "var/lib/apt/lists",
    "var/lib/apt/lists/partial",
    "var/lib/apt/lists/auxfiles",
    "var/cache/apt/archives",
    "var/cache/apt/archives/partial",
)


def repair_host_root_apt_dirs(treefd, owner=None):
    """Give the allowlisted apt dirs that are real directories owned 0:0 on
    the tree's device to the container root.  No symlink is followed and no
    mount crossed; anything else, their contents included, is left to the
    walk, which fails closed on what it cannot read.  Returns the relative
    paths changed."""
    dev = os.fstat(treefd).st_dev
    repaired = []
    for rel in HOST_ROOT_APT_REPAIRS:
        try:
            fd = openat2(
                treefd,
                rel,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                resolve=RESOLVE_FLAGS | RESOLVE_NO_XDEV,
            )
        except OSError:
            continue  # absent, a symlink on the way, not a directory, a mount
        try:
            info = os.fstat(fd)
            if info.st_dev != dev or (info.st_uid, info.st_gid) != (0, 0):
                continue
            if owner is None:
                owner = container_root_ids()
            if 0 in owner:
                fail("the container root must not be host root")
            os.fchown(fd, *owner)
            repaired.append(rel)
        finally:
            os.close(fd)
    return repaired


def image_caps_preflight(treefd, *, deadline, state_path=IMAGE_CAPS_STATE, confined=None, rootid=None, force=False):
    """Walk an image root once (see image_caps_walk) unless its identity is
    stamped for this version; stamp the identity read again from the same
    pinned fd after a successful walk.  Returns the walk's outcome, or
    "stamped"."""
    confined = confined or run_confined
    lockfd = os.open(state_path + ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        if not force and read_image_caps_state(state_path).get(image_identity(treefd)) == IMAGE_CAPS_VERSION:
            return "stamped"
        rootid = rootid or container_root_ids()[0]
        # A read-only subvolume is made writable for the walk only.
        readonly = subvolume_readonly(treefd)
        if readonly:
            set_subvolume_readonly(treefd, False)
        try:
            repaired = repair_host_root_apt_dirs(treefd)
            status = confined(
                [CONFINED_EXEC_PATH, IMAGE_CAPS_WALK, "--rootid", str(rootid)],
                [(treefd, IMAGE_CAPS_TARGET, True)],
                deadline=deadline,
                setfcap=True,
            )
        finally:
            if readonly:
                set_subvolume_readonly(treefd, True)
        if status != 0:
            raise subprocess.CalledProcessError(status, [IMAGE_CAPS_WALK])
        images = read_image_caps_state(state_path)
        key = image_identity(treefd)
        images.pop(key, None)
        images[key] = IMAGE_CAPS_VERSION
        # Oldest first out: entries for deleted images age out, and a new
        # image is always stamped (an evicted one is just walked again).
        if len(images) > IMAGE_CAPS_STATE_MAX_IMAGES:
            images = dict(list(images.items())[-IMAGE_CAPS_STATE_MAX_IMAGES:])
        write_image_caps_state(images, state_path)
        if repaired:
            return "walked; repaired host-root apt dirs: " + ", ".join(repaired)
        return "walked"
    finally:
        os.close(lockfd)


IMAGE_CACHE_RELATIVE = "data/cache/images"


def open_image_cache(cache_root, cache_relative):
    rootfd = open_root(cache_root, {cache_root})
    try:
        return openat2(rootfd, cache_relative, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    finally:
        os.close(rootfd)


def run_image_caps_preflight(argv, cache_root="/mnt/cocalc", cache_relative=IMAGE_CACHE_RELATIVE, preflight=None):
    """image-caps-preflight --root /mnt/cocalc --path data/cache/images/NAME:
    an image workflow's explicit preflight of one image root.  Only image
    roots directly in the pinned image cache: a host-global capability
    anywhere else (a project home) is evidence of a crafted restore
    (finding 011) to investigate, and the runtime user must not be able to
    convert it away."""
    values, _flags = parse_named_options(argv, "image-caps-preflight", {"--root", "--path"}, {"--root", "--path"})
    prefix = cache_relative + "/"
    name = values["path"][len(prefix):] if values["path"].startswith(prefix) else ""
    if values["root"] != cache_root or not name or "/" in name or name in (".", ".."):
        fail("image-caps-preflight only takes an image root in the image cache")
    preflight = preflight or image_caps_preflight
    cachefd = open_image_cache(cache_root, cache_relative)
    try:
        treefd = openat2(cachefd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    finally:
        os.close(cachefd)
    try:
        outcome = preflight(treefd, deadline=time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS)
    finally:
        os.close(treefd)
    print(json.dumps({"image_caps": outcome}), flush=True)
    return 0


def run_migrate_image_caps(argv, cache_root="/mnt/cocalc", cache_relative=IMAGE_CACHE_RELATIVE, preflight=None):
    """migrate-image-caps: preflight every image under the pinned image
    cache (a one-off after rollout; stamped images are skipped).  Reports
    each entry.  Only regular metadata files are skipped; an entry that
    cannot be examined, opened or walked, one that vanished during the pass,
    or any other type (a symlink) counts as failed (exit 1): the cache is
    writable by the runtime user, so a pass that met any of these is rerun."""
    if argv != ["migrate-image-caps"]:
        fail("usage: migrate-image-caps")
    preflight = preflight or image_caps_preflight
    cachefd = open_image_cache(cache_root, cache_relative)
    failed = 0

    def report(name, outcome):
        print(json.dumps({"image": name, "image_caps": outcome}), flush=True)

    try:
        for name in sorted(os.listdir(cachefd)):
            try:
                info = os.stat(name, dir_fd=cachefd, follow_symlinks=False)
            except FileNotFoundError:
                failed += 1
                report(name, "vanished")
                continue
            except OSError as err:
                failed += 1
                report(name, f"failed: {err}")
                continue
            if stat.S_ISREG(info.st_mode):
                continue  # metadata files (.<image>.json)
            if not stat.S_ISDIR(info.st_mode):
                failed += 1
                report(name, "failed: not a directory")
                continue
            try:
                treefd = openat2(cachefd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            except FileNotFoundError:
                failed += 1
                report(name, "vanished")
                continue
            except OSError as err:
                failed += 1
                report(name, f"failed: {err}")
                continue
            try:
                outcome = preflight(treefd, deadline=time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS)
            except (OSError, ValueError, subprocess.CalledProcessError) as err:
                failed += 1
                outcome = f"failed: {err}"
            finally:
                os.close(treefd)
            report(name, outcome)
    finally:
        os.close(cachefd)
    return 1 if failed else 0


def make_staging_directory(parentfd, prefix, uid, gid):
    """A fresh, empty directory for the confined runtime user: created by
    root beneath a pinned parent, then handed to the runtime user."""
    for _attempt in range(16):
        name = f"{prefix}{os.urandom(8).hex()}"
        try:
            os.mkdir(name, 0o700, dir_fd=parentfd)
        except FileExistsError:
            continue
        fd = openat2(parentfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        os.fchown(fd, uid, gid)
        return name, fd
    fail("could not create a staging directory")


# Project restores stage here, beneath the data root and on the same
# filesystem; generic verbs never reach it (GENERIC_PROTECTED_PATHS).
RESTORE_STAGING_DIR = ".cocalc-confined-restore"


def open_restore_staging_parent(rootfd):
    try:
        os.mkdir(RESTORE_STAGING_DIR, 0o711, dir_fd=rootfd)
    except FileExistsError:
        pass
    fd = openat2(rootfd, RESTORE_STAGING_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
        os.close(fd)
        fail("unsafe restore staging directory")
    return fd


def restore_project_confined(rootfd, destfd, profile_fd, program, delete, uid, gid, deadline,
                             confined=None):
    """Restore into a fresh staging directory, then merge it into the
    destination with rsync, both confined.  The destination is the pinned
    directory itself, so no symlink in it or above it leaves the jail."""
    confined = confined or run_confined
    parentfd = open_restore_staging_parent(rootfd)
    name, stagefd = make_staging_directory(parentfd, "restore-", uid, gid)
    try:
        status = confined(
            program,
            [(stagefd, "/staging", True), (profile_fd, CONFINED_PROFILE_TARGET, False)],
            deadline=deadline,
        )
        if status != 0:
            raise subprocess.CalledProcessError(status, program[:1])
        # Finding 015 on the confined path: the rustic step restores into an
        # EMPTY staging directory, so the merge is the only place an existing
        # file could be trusted by size and modification time (both are easy
        # to keep while changing the bytes).  --checksum compares content and
        # still leaves identical files in place; --ignore-times would rewrite
        # every file.
        merge = [*CONFINED_RSYNC, "--checksum", *(["--delete"] if delete else []), "--", "/staging/", "/home/"]
        status = confined(
            merge,
            [(stagefd, "/staging", False), (destfd, "/home", True)],
            deadline=deadline,
            tolerate_skips=True,
        )
        if status != 0:
            raise subprocess.CalledProcessError(status, merge[:1])
    finally:
        os.close(stagefd)
        try:
            remove_entry(parentfd, name, True, True)
        finally:
            os.close(parentfd)


def restore_tree_confined(rootfd, path, profile_fd, program, uid, gid, deadline, confined=None):
    """Whole-tree (RootFS) restore: confined into a fresh directory beside
    the destination, which then replaces it.  File capabilities namespaced
    to a mapped root (container images) are kept; host-global ones cannot be
    written from the confinement."""
    confined = confined or run_confined
    parentfd, name = open_parent(rootfd, path)
    stage_name, stagefd = make_staging_directory(parentfd, f".{name}.confined-", uid, gid)
    try:
        status = confined(
            program,
            [(stagefd, "/staging", True), (profile_fd, CONFINED_PROFILE_TARGET, False)],
            deadline=deadline,
            setfcap=True,
        )
        if status != 0:
            raise subprocess.CalledProcessError(status, program[:1])
        old = f".{name}.replaced-{os.urandom(8).hex()}"
        try:
            os.rename(name, old, src_dir_fd=parentfd, dst_dir_fd=parentfd)
        except FileNotFoundError:
            old = None
        os.rename(stage_name, name, src_dir_fd=parentfd, dst_dir_fd=parentfd)
        stage_name = None
        if old is not None:
            remove_entry(parentfd, old, True, True)
    finally:
        os.close(stagefd)
        try:
            if stage_name is not None:
                remove_entry(parentfd, stage_name, True, True)
        finally:
            os.close(parentfd)


def run_rustic(
    argv,
    allowed_roots=ALLOWED_ROOTS,
    rustic_candidates=None,
    profile_run_dir="/run/cocalc-rustic-profiles",
    profile_run_dir_uid=0,
    allow_loopback_rest=ALLOW_LOOPBACK_RUSTIC_REST,
    confined=None,
):
    command, values = parse_rustic(argv)
    rootfd = open_root(values["root"], allowed_roots)
    profile_rootfd = open_root(values["profile-root"], allowed_roots)
    datafd = None
    profile_path = None
    try:
        datafd = openat2(
            rootfd,
            values["path"],
            O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
        )
        profile_data = read_validated_rustic_profile(
            profile_rootfd,
            values["profile-path"],
            allow_loopback_rest=allow_loopback_rest,
        )
        profile_path = write_private_rustic_profile(
            profile_data, profile_run_dir, profile_run_dir_uid
        )
        profile_arg = profile_path[: -len(".toml")]
        rustic = select_privileged_rustic_binary(rustic_candidates)
        base = [rustic, "-P", profile_arg]
        # Root's cache is pinned twice on purpose: the flag here, and
        # RUSTIC_CACHE_DIR below (with HOME=/root as the last fallback). The
        # flag conflicts with --no-cache, so it is left out when that is asked.
        if not values["no-cache"]:
            base += ["--cache-dir", "/root/.cache/rustic"]
        env = {
            "HOME": "/root",
            "LANG": "C.UTF-8",
            "LOGNAME": "root",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "RUSTIC_CACHE_DIR": "/root/.cache/rustic",
            "RUSTIC_PROGRESS_INTERVAL": "1s",
            "SSL_CERT_DIR": "/etc/ssl/certs",
            "USER": "root",
        }

        deadline = time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS

        def invoke(args, *, quiet=False):
            return run_supervised(
                [*base, *args],
                deadline=deadline,
                quiet=quiet,
                cwd=f"/proc/self/fd/{datafd}",
                env=env,
                pass_fds=(datafd,),
            )

        def ensure_rootfs_repository():
            if invoke(["repoinfo"], quiet=True) == 0:
                return
            init_status = invoke(["init"], quiet=True)
            # Another host may win initialization after our first probe. Object
            # storage visibility can lag that successful create briefly, so wait
            # for the shared repository rather than failing the publication.
            for delay in (0, 0.25, 0.5, 1, 2, 4, 8):
                if delay:
                    time.sleep(delay)
                if invoke(["repoinfo"], quiet=True) == 0:
                    return
            raise subprocess.CalledProcessError(init_status or 1, base)

        if command.endswith("backup"):
            max_file_bytes = values["max-file-bytes"]
            oversized = None
            if max_file_bytes is not None:
                oversized = scan_oversized_files(
                    datafd,
                    max_file_bytes=max_file_bytes,
                    one_file_system=command == "rustic-project-backup",
                    deadline=deadline,
                )
            flags = ["backup"]
            if command == "rustic-project-backup":
                flags.append("-x")
            flags.extend(["--json", "--no-scan", "--host", values["host"]])
            if max_file_bytes is not None:
                flags.extend(["--exclude-larger-than", str(max_file_bytes)])
            if oversized and oversized["count"]:
                summary = json.dumps(
                    oversized, ensure_ascii=True, separators=(",", ":")
                )
                if command == "rustic-rootfs-backup":
                    # An image silently missing files would be broken.
                    fail(f"RootFS has files larger than the backup limit: {summary}")
                # The caller reads this line; the snapshot keeps the same record.
                print(f"{OVERSIZED_FILES_MARKER} {summary}", file=sys.stderr, flush=True)
                flags.extend(["--description", f"{OVERSIZED_FILES_MARKER} {summary}"])
            for tag in values["tag"]:
                flags.extend(["--tag", tag])
            if values.get("parent"):
                flags.extend(["--parent", values["parent"]])
            if command == "rustic-project-backup":
                flags.extend(
                    ["--glob", "!.snapshots", "--glob", "!.snapshots/**"]
                )
            flags.append(".")
            if command == "rustic-rootfs-backup":
                ensure_rootfs_repository()
                status = invoke(flags)
            else:
                status = invoke(flags)
                if status != 0 and invoke(["repoinfo"], quiet=True) != 0:
                    if invoke(["init"], quiet=True) == 0 or invoke(
                        ["repoinfo"], quiet=True
                    ) == 0:
                        status = invoke(flags)
            if status != 0:
                raise subprocess.CalledProcessError(status, base)
            return

        # Restores never run as root and never write into an existing tree:
        # Rustic restores confined into a fresh staging directory (it fails,
        # and would follow symlinks, in a tree it did not create).
        uid, gid = runtime_user_ids()
        profile_fd = os.open(profile_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            # Readable by the confined runtime user only through the jail.
            os.fchown(profile_fd, 0, gid)
            os.fchmod(profile_fd, 0o640)
            program = [
                rustic,
                "-P",
                CONFINED_PROFILE_TARGET[: -len(".toml")],
                "restore",
                "--no-cache",
                "--numeric-id",
                values["snapshot"],
                "/staging",
            ]
            if command == "rustic-project-restore":
                restore_project_confined(
                    rootfd, datafd, profile_fd, program, values["delete"], uid, gid, deadline,
                    confined=confined,
                )
            else:
                restore_tree_confined(
                    rootfd, values["path"], profile_fd, program, uid, gid, deadline, confined=confined
                )
        finally:
            os.close(profile_fd)
    finally:
        if profile_path is not None:
            os.unlink(profile_path)
        if datafd is not None:
            os.close(datafd)
        os.close(profile_rootfd)
        os.close(rootfd)


def parse_named_options(argv, command, allowed, required):
    if not argv or argv[0] != command:
        fail(f"invalid {command} command")
    values = {}
    flags = set()
    i = 1
    while i < len(argv):
        option = argv[i]
        if option == "--skip-ownership-bridge":
            if option not in allowed or option in flags:
                fail(f"invalid {command} option: {option}")
            flags.add(option)
            i += 1
            continue
        if option not in allowed or i + 1 >= len(argv):
            fail(f"invalid {command} option: {option}")
        key = option[2:]
        if key in values:
            fail(f"duplicate {command} option: {option}")
        values[key] = argv[i + 1]
        i += 2
    missing = [option for option in required if option[2:] not in values]
    if missing:
        fail(f"missing {command} option: {missing[0]}")
    return values, flags


def open_named_directory(values, name, allowed_roots):
    root = values[f"{name}-root"]
    path = values[f"{name}-path"]
    validate_relative(path, allow_root=True)
    rootfd = open_root(root, allowed_roots)
    try:
        datafd = openat2(rootfd, path, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    finally:
        os.close(rootfd)
    return datafd


def run_overlay(argv, allowed_roots=ALLOWED_ROOTS):
    # An idmapped upper (--idmap) and its cleanup at unmount change the views.
    if argv and (argv[0] == "umount-overlay-project" or "--idmap" in argv):
        with view_lock():
            return _run_overlay(argv, allowed_roots)
    return _run_overlay(argv, allowed_roots)


def _run_overlay(argv, allowed_roots=ALLOWED_ROOTS):
    command = argv[0]
    names = (
        ("lower", "upper", "work", "merged")
        if command == "mount-overlay-project"
        else ("merged",)
    )
    options = {f"--{name}-{kind}" for name in names for kind in ("root", "path")}
    allowed = options | ({"--idmap"} if command == "mount-overlay-project" else set())
    values, _flags = parse_named_options(argv, command, allowed, options)
    view_uid = validate_view_uid(values["idmap"]) if "idmap" in values else None
    run_root = values["merged-root"] == PROJECT_ROOTFS_ROOT
    if run_root:
        project_id = values["merged-path"].split("/")[0]
        if values["merged-path"] != f"{validate_project_id(project_id)}/root":
            fail("invalid project rootfs mountpoint")
        if command == "mount-overlay-project":
            ensure_rootfs_mountpoint(project_id)
    else:
        # The merged dir is named after the project (allow_overlay_mountpoint).
        project_id = os.path.basename(values["merged-path"])
    if view_uid is not None and not run_root:
        fail(f"an idmapped overlay must be mounted beneath {PROJECT_ROOTFS_ROOT}")
    if view_uid is not None:
        validate_project_id(project_id)
        for name in ("upper", "work"):
            if values[f"{name}-root"] != PROJECT_UPPER_ROOT or not values[
                f"{name}-path"
            ].startswith(f"project-{project_id}/"):
                fail(f"an idmapped overlay {name} must be in project {project_id}'s home")
    descriptors = []
    staged = False
    try:
        for name in names:
            roots = (
                {*allowed_roots, PROJECT_ROOTFS_ROOT}
                if name == "merged" and run_root
                else allowed_roots
            )
            descriptors.append(open_named_directory(values, name, roots))
        if command == "mount-overlay-project" and view_uid is not None:
            # --idmap: the upper (and workdir) through an idmapped view, so
            # files the project creates keep the runtime user as owner on disk.
            lowerfd, upperfd, workfd, mergedfd = descriptors
            stagingfd, upper_name, work_name = mount_idmapped_upper(
                project_id, upperfd, workfd, view_uid
            )
            staged = True
            descriptors.append(stagingfd)
            for original, name in ((upperfd, upper_name), (workfd, work_name)):
                fd = openat2(stagingfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
                descriptors.append(fd)
                a, b = os.fstat(fd), os.fstat(original)
                if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                    fail("idmapped overlay upper does not match the requested upper")
            paths = [f"/proc/self/fd/{fd}" for fd in (lowerfd, descriptors[-2], descriptors[-1], mergedfd)]
        else:
            paths = [f"/proc/self/fd/{fd}" for fd in descriptors]
        if command == "mount-overlay-project":
            lower, upper, work, merged = paths
            mount_options = (
                f"lowerdir={lower},upperdir={upper},workdir={work},"
                "xino=off,metacopy=on,redirect_dir=on,index=off"
            )
            args = [
                "/bin/mount",
                "-t",
                "overlay",
                "overlay",
                "-o",
                mount_options,
                merged,
            ]
        else:
            args = ["/bin/umount", "-l", paths[0]]
        subprocess.run(
            args,
            pass_fds=tuple(descriptors),
            check=True,
            stdin=subprocess.DEVNULL,
        )
        staged = False
    finally:
        for fd in descriptors:
            os.close(fd)
        if staged:
            umount_view_target(f"{PROJECT_VIEW_ROOT}/{project_id}/{PROJECT_VIEW_ROOTFS_UPPER}")
    if command == "umount-overlay-project" and run_root:
        for path in (f"{PROJECT_ROOTFS_ROOT}/{project_id}/root", f"{PROJECT_ROOTFS_ROOT}/{project_id}"):
            try:
                os.rmdir(path)
            except OSError:
                break
    if command == "umount-overlay-project" and PROJECT_ID_RE.fullmatch(project_id):
        # An idmapped upper (--idmap) stays mounted until the overlay is gone.
        upper = f"{PROJECT_VIEW_ROOT}/{project_id}/{PROJECT_VIEW_ROOTFS_UPPER}"
        if upper in view_mountpoints():
            umount_view_target(upper)
            os.rmdir(upper)

def ensure_private_root_directory(path, required_uid=0, mode=0o700):
    try:
        os.mkdir(path, mode)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != required_uid
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        fail(f"unsafe privileged runtime directory: {path}")


# normalize-rootfs changes an image tree as host root (finding 093).  The
# tree's content is the image's, so every path in it is resolved against the
# pinned tree as its root (RESOLVE_IN_ROOT: absolute and ".." symlinks stay
# inside), never across a mount, and each mutation goes through a pinned fd
# whose type, device and link count were checked first.  A refusal fails the
# normalize; nothing falls back to a path-based operation.
RESOLVE_IMAGE = RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
# One component beneath a held directory: no symlink is followed, no mount crossed.
RESOLVE_WALK = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
IMAGE_RESOLVE_ATTEMPTS = 8
IMAGE_WALK_MAX_DEPTH = 256
AT_EMPTY_PATH = 0x1000
AT_SYMLINK_NOFOLLOW = 0x100
NORMALIZE_REFUSED = "normalize-image-path-refused"
NORMALIZE_SHELLS = ("/bin/bash", "/bin/sh")
NORMALIZE_PACKAGE_MANAGERS = (
    ("apt-get", "debian"),
    ("dnf", "rhel"),
    ("microdnf", "rhel"),
    ("yum", "rhel"),
    ("zypper", "sles"),
)
NORMALIZE_CA_PATHS = (
    ("etc/ssl/certs", stat.S_IFDIR),
    ("etc/ssl/cert.pem", stat.S_IFREG),
    ("etc/pki/tls/certs/ca-bundle.crt", stat.S_IFREG),
    ("etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", stat.S_IFREG),
    ("etc/ssl/ca-bundle.pem", stat.S_IFREG),
)
NORMALIZE_GLIBC_PATHS = (
    "lib64/ld-linux-x86-64.so.2",
    "lib/x86_64-linux-gnu/libc.so.6",
    "lib/ld-linux-aarch64.so.1",
    "lib64/ld-linux-aarch64.so.1",
    "lib/aarch64-linux-gnu/libc.so.6",
)
APT_STATE_TREES = ("var/lib/apt/lists", "var/cache/apt/archives")
APT_STATE_DIRS = (
    ("var/lib/apt/lists", 0o755),
    ("var/lib/apt/lists/auxfiles", 0o755),
    ("var/cache/apt/archives", 0o755),
    ("var/lib/apt/lists/partial", 0o700),
    ("var/cache/apt/archives/partial", 0o700),
)


class NormalizeRefused(ValueError):
    """A stable SECURITY_DENY line; detail names a path inside the image only."""

    def __init__(self, code, rel, reason):
        # ascii() escapes newlines and control bytes in image names, so
        # the line stays one record.
        super().__init__(f"SECURITY_DENY code={code} detail={ascii(rel)[1:-1]}: {reason}")
        self.code = code


class NormalizePreflightFailed(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class ImageTree:
    """The pinned image root: its device, and once inventoried, how many
    links inside the tree each multiply linked nondirectory has."""

    def __init__(self, fd):
        self.fd = fd
        self.dev = os.fstat(fd).st_dev
        self.links = None
        self.changed = set()


def image_resolve(tree, rel, flags, mode=0):
    """openat2 rel with the pinned tree as its root.  Missing paths raise
    FileNotFoundError or NotADirectoryError; everything else refuses."""
    for _attempt in range(IMAGE_RESOLVE_ATTEMPTS):
        try:
            return openat2(tree.fd, rel, flags | os.O_CLOEXEC, mode, resolve=RESOLVE_IMAGE)
        except (FileNotFoundError, NotADirectoryError):
            raise
        except OSError as err:
            if err.errno == errno.EAGAIN:
                continue
            if err.errno in (errno.ENOSYS, errno.EINVAL):
                raise NormalizeRefused("normalize-openat2-unavailable", rel, os.strerror(err.errno)) from None
            raise NormalizeRefused(NORMALIZE_REFUSED, rel, os.strerror(err.errno)) from None
    raise NormalizeRefused(NORMALIZE_REFUSED, rel, "resolution kept racing")


def image_check(tree, fd, rel, kind=None):
    info = os.fstat(fd)
    if info.st_dev != tree.dev:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "on another filesystem")
    if kind is not None and stat.S_IFMT(info.st_mode) != kind:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "unexpected file type")
    return info


def image_open(tree, rel, flags, kind=None):
    fd = image_resolve(tree, rel, flags)
    try:
        return fd, image_check(tree, fd, rel, kind)
    except BaseException:
        os.close(fd)
        raise


def image_stat(tree, rel):
    """What rel resolves to inside the tree (symlinks followed inside it), or None."""
    try:
        fd, info = image_open(tree, rel, O_PATH)
    except (FileNotFoundError, NotADirectoryError):
        return None
    os.close(fd)
    return info


def image_executable(tree, rel):
    info = image_stat(tree, rel)
    return info is not None and stat.S_ISREG(info.st_mode) and bool(info.st_mode & 0o111)


def image_probe(tree):
    """The facts the old shell probes read, resolved inside the image."""
    shell = next((path for path in NORMALIZE_SHELLS if image_executable(tree, path.lstrip("/"))), None)
    if shell is None:
        raise NormalizeRefused("rootfs-shell-missing", ".", "no executable bin/bash or bin/sh")
    sudo_present = image_executable(tree, "usr/bin/sudo") or image_executable(tree, "bin/sudo")
    ca_present = False
    for rel, kind in NORMALIZE_CA_PATHS:
        info = image_stat(tree, rel)
        if info is not None and stat.S_IFMT(info.st_mode) == kind:
            ca_present = True
            break
    distro_family, package_manager = "unknown", "none"
    for name, family in NORMALIZE_PACKAGE_MANAGERS:
        if image_executable(tree, f"usr/bin/{name}") or image_executable(tree, f"bin/{name}"):
            distro_family, package_manager = family, name
            break
    if not any(image_stat(tree, rel) is not None for rel in NORMALIZE_GLIBC_PATHS):
        raise NormalizePreflightFailed("rootfs preflight failed: glibc is required", 43)
    if (not sudo_present or not ca_present) and package_manager == "none":
        raise NormalizePreflightFailed(
            "rootfs preflight failed: startup bootstrap requires sudo and CA certificates, but this image has neither a supported package manager nor the required packages preinstalled",
            44,
        )
    return {
        "ok": True,
        "distro_family": distro_family,
        "package_manager": package_manager,
        "shell": shell,
        "glibc": True,
        "sudo_present": sudo_present,
        "ca_certificates_present": ca_present,
    }


def fchown_pinned(fd, uid, gid):
    """Change the owner of exactly the inode fd pins (O_PATH fds included;
    a symlink itself, never its target)."""
    if LIBC.fchownat(ctypes.c_int(fd), b"", ctypes.c_uint(uid), ctypes.c_uint(gid), AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def chmod_pinned(fd, mode):
    # The magic link names the pinned inode, which is never a symlink here.
    os.chmod(f"/proc/self/fd/{fd}", mode)


def image_split(rel):
    parent, _, name = rel.rpartition("/")
    return parent or ".", name


def image_ensure_dir(tree, rel, owner, mode=0o755):
    """mkdir -p inside the image.  Existing components resolve inside the
    tree; only a directory created here is given owner and mode."""
    parts = rel.split("/")
    for index in range(len(parts)):
        sub = "/".join(parts[: index + 1])
        try:
            fd, _info = image_open(tree, sub, O_PATH | os.O_DIRECTORY, stat.S_IFDIR)
            os.close(fd)
            continue
        except (FileNotFoundError, NotADirectoryError):
            pass
        parent, name = image_split(sub)
        parentfd, _info = image_open(tree, parent, os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
        try:
            try:
                os.mkdir(name, 0o700, dir_fd=parentfd)
            except FileExistsError:
                # A dangling symlink or a non-directory is in the way.
                raise NormalizeRefused(NORMALIZE_REFUSED, sub, "not a directory") from None
            fd = image_open_child(parentfd, name, os.O_RDONLY | os.O_DIRECTORY, sub)
            try:
                image_check(tree, fd, sub, stat.S_IFDIR)
                fchown_pinned(fd, *owner)
                os.fchmod(fd, mode)
            finally:
                os.close(fd)
        finally:
            os.close(parentfd)


def image_chmod_dir(tree, rel, mode):
    """chmod an existing directory resolved inside the tree; absent is fine."""
    try:
        fd, _info = image_open(tree, rel, os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
    except (FileNotFoundError, NotADirectoryError):
        return
    try:
        os.fchmod(fd, mode)
    finally:
        os.close(fd)


def image_remove_tree(tree, parentfd, name, rel, depth=0):
    if depth > IMAGE_WALK_MAX_DEPTH:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "too deep")
    fd = image_open_child(parentfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK, rel)
    try:
        image_check(tree, fd, rel, stat.S_IFDIR)
        for child in os.listdir(fd):
            info = os.stat(child, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                image_remove_tree(tree, fd, child, f"{rel}/{child}", depth + 1)
            else:
                os.unlink(child, dir_fd=fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parentfd)


def image_replace_with_symlink(tree, rel, target, owner):
    """ln -snf target rel, where rel's parent resolves inside the tree and
    rel itself is never followed.  A host-root link ends with owner (as
    own_root_links does where the parent is not itself a symlink)."""
    parent, name = image_split(rel)
    parentfd, _info = image_open(tree, parent, os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
    try:
        try:
            info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
        except FileNotFoundError:
            info = None
        if not (info is not None and stat.S_ISLNK(info.st_mode) and os.readlink(name, dir_fd=parentfd) == target):
            if info is not None and stat.S_ISDIR(info.st_mode):
                image_remove_tree(tree, parentfd, name, rel)
            elif info is not None:
                os.unlink(name, dir_fd=parentfd)
            os.symlink(target, name, dir_fd=parentfd)
        fd = image_open_child(parentfd, name, O_PATH | os.O_NOFOLLOW, rel)
        try:
            link = image_check(tree, fd, rel, stat.S_IFLNK)
            if link.st_uid == 0 or link.st_gid == 0:
                set_pinned_owner(tree, fd, link, rel, *owner)
        finally:
            os.close(fd)
    finally:
        os.close(parentfd)


def image_empty_file(tree, rel, mode, owner):
    """The equivalent of ': >rel; chmod mode rel' without truncating anything
    before it is known to be a singly linked regular file in the tree."""
    parent, name = image_split(rel)
    parentfd, _info = image_open(tree, parent, os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
    try:
        try:
            pathfd = image_open_child(parentfd, name, O_PATH | os.O_NOFOLLOW, rel)
        except FileNotFoundError:
            fd = image_open_child(parentfd, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, rel, mode)
            try:
                image_check(tree, fd, rel, stat.S_IFREG)
                fchown_pinned(fd, *owner)
                os.fchmod(fd, mode)
            finally:
                os.close(fd)
            return
        try:
            info = image_check(tree, pathfd, rel, stat.S_IFREG)
            if info.st_size == 0 and stat.S_IMODE(info.st_mode) == mode:
                return
            if info.st_nlink != 1:
                raise NormalizeRefused(NORMALIZE_REFUSED, rel, "hard linked")
            fd = os.open(f"/proc/self/fd/{pathfd}", os.O_WRONLY | os.O_NOCTTY | os.O_CLOEXEC)
        finally:
            os.close(pathfd)
        try:
            again = os.fstat(fd)
            if (again.st_dev, again.st_ino) != (info.st_dev, info.st_ino) or again.st_nlink != 1:
                raise NormalizeRefused(NORMALIZE_REFUSED, rel, "changed while opening")
            os.ftruncate(fd, 0)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)
    finally:
        os.close(parentfd)


def walk_image_tree(tree, dirfd, rel, visit, depth=0):
    """Visit every entry beneath the held directory dirfd.  Each entry is
    opened without following it, beneath dirfd, on the tree's device, and
    must still be the inode lstat saw; visit gets that pinned fd."""
    if depth > IMAGE_WALK_MAX_DEPTH:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "too deep")
    for name in os.listdir(dirfd):
        child = name if rel == "." else f"{rel}/{name}"
        seen = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        if seen.st_dev != tree.dev:
            raise NormalizeRefused(NORMALIZE_REFUSED, child, "on another filesystem")
        directory = stat.S_ISDIR(seen.st_mode)
        flags = (os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK) if directory else (O_PATH | os.O_NOFOLLOW)
        try:
            fd = image_open_child(dirfd, name, flags, child)
        except FileNotFoundError:
            raise NormalizeRefused(NORMALIZE_REFUSED, child, "changed during the walk") from None
        try:
            info = image_check(tree, fd, child, stat.S_IFMT(seen.st_mode))
            if info.st_ino != seen.st_ino:
                raise NormalizeRefused(NORMALIZE_REFUSED, child, "changed during the walk")
            visit(fd, info, child)
            if directory:
                walk_image_tree(tree, fd, child, visit, depth + 1)
        finally:
            os.close(fd)


def image_open_child(parentfd, name, flags, rel, mode=0):
    """One component beneath a held directory; a missing one raises
    FileNotFoundError, anything else refuses."""
    try:
        return openat2(parentfd, name, flags | os.O_CLOEXEC, mode, resolve=RESOLVE_WALK)
    except FileNotFoundError:
        raise
    except OSError as err:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, os.strerror(err.errno)) from None


def image_open_root(tree):
    fd, _info = image_open(tree, ".", os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
    return fd


def inventory_image_links(tree):
    """Count each multiply linked nondirectory's links inside the tree.  A
    link count above that means a link outside it: refuse before any change."""
    seen = {}
    nlinks = {}

    def count(_fd, info, _rel):
        if not stat.S_ISDIR(info.st_mode) and info.st_nlink > 1:
            key = (info.st_dev, info.st_ino)
            seen[key] = seen.get(key, 0) + 1
            nlinks[key] = info.st_nlink

    rootfd = image_open_root(tree)
    try:
        walk_image_tree(tree, rootfd, ".", count)
    finally:
        os.close(rootfd)
    for key, links in seen.items():
        if nlinks[key] != links:
            raise NormalizeRefused(NORMALIZE_REFUSED, ".", "a file is hard linked outside the image")
    tree.links = seen


def image_claim_inode(tree, info, rel):
    """True when this pinned inode should be changed now: once per inode,
    and a multiply linked one only while all its links are in the tree."""
    if stat.S_ISDIR(info.st_mode) or info.st_nlink == 1:
        return True
    key = (info.st_dev, info.st_ino)
    if tree.links is None or tree.links.get(key) != info.st_nlink:
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "hard linked outside the image")
    if key in tree.changed:
        return False
    tree.changed.add(key)
    return True


def set_pinned_owner(tree, fd, info, rel, uid, gid):
    # Fresh at the change: the link count, owner and mode the claim and the
    # chown act on are read from the pinned fd now, not when it was opened.
    # (A writer racing after this check is outside the model: nothing but
    # this helper writes an image tree while it is being normalized.)
    fresh = os.fstat(fd)
    if (fresh.st_dev, fresh.st_ino, stat.S_IFMT(fresh.st_mode)) != (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)):
        raise NormalizeRefused(NORMALIZE_REFUSED, rel, "changed during the walk")
    info = fresh
    if (info.st_uid, info.st_gid) == (uid, gid) or not image_claim_inode(tree, info, rel):
        return
    fchown_pinned(fd, uid, gid)
    # chown clears setuid/setgid; put them back as the old remap did.
    if not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o6000:
        chmod_pinned(fd, stat.S_IMODE(info.st_mode))


def parse_id_map(text):
    ranges = []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            fail("unexpected rootless podman id map")
        ranges.append(tuple(int(part) for part in parts))
    if not ranges:
        fail("missing rootless podman id map")
    return ranges


def rootfs_id_mapper(ranges, runtime_id, ownership_source):
    """The old to-canonical pass followed by its to-host pass, as one
    function of an inode's current id (both passes were per inode)."""
    if ownership_source not in ("keep-id", "oci-extract"):
        fail("unsupported RootFS ownership source")

    def host_to_intermediate(identifier):
        for ns_start, host_start, length in ranges:
            if host_start <= identifier < host_start + length:
                return ns_start + (identifier - host_start)
        return None

    def intermediate_to_host(identifier):
        for ns_start, host_start, length in ranges:
            if ns_start <= identifier < ns_start + length:
                return host_start + (identifier - ns_start)
        fail(f"id {identifier} is not covered by the rootless podman map; the host subuid/subgid allocation is too small for this image")

    def to_canonical(identifier):
        intermediate = host_to_intermediate(identifier)
        if intermediate is None or ownership_source == "oci-extract":
            return identifier if intermediate is None else intermediate
        if intermediate == 0:
            return runtime_id
        if 0 < intermediate <= runtime_id:
            return intermediate - 1
        return intermediate

    def to_host(identifier):
        intermediate = host_to_intermediate(identifier)
        if intermediate is None:
            intermediate = identifier
        if intermediate < runtime_id:
            intermediate += 1
        elif intermediate == runtime_id:
            intermediate = 0
        return intermediate_to_host(intermediate)

    return lambda identifier: to_host(to_canonical(identifier))


def remap_image_ids(tree, uid_ranges, gid_ranges, ownership_source, runtime_id=2001):
    map_uid = rootfs_id_mapper(uid_ranges, runtime_id, ownership_source)
    map_gid = rootfs_id_mapper(gid_ranges, runtime_id, ownership_source)
    if tree.links is None:
        inventory_image_links(tree)
    tree.changed = set()

    def remap(fd, info, rel):
        set_pinned_owner(tree, fd, info, rel, map_uid(info.st_uid), map_gid(info.st_gid))

    rootfd = image_open_root(tree)
    try:
        remap(rootfd, os.fstat(rootfd), ".")
        walk_image_tree(tree, rootfd, ".", remap)
    finally:
        os.close(rootfd)


def normalize_apt_state(tree, owner):
    """The apt state trees go to the container root, then the partial dirs
    apt needs exist with the modes apt expects."""

    def own(fd, info, rel):
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise NormalizeRefused(NORMALIZE_REFUSED, rel, "special file in apt state")
        set_pinned_owner(tree, fd, info, rel, *owner)

    if tree.links is None:
        inventory_image_links(tree)
    tree.changed = set()
    for rel in APT_STATE_TREES:
        parent, name = image_split(rel)
        try:
            parentfd, _info = image_open(tree, parent, os.O_RDONLY | os.O_DIRECTORY, stat.S_IFDIR)
        except (FileNotFoundError, NotADirectoryError):
            continue
        try:
            try:
                info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(info.st_mode):
                continue
            try:
                fd = image_open_child(parentfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK, rel)
            except FileNotFoundError:
                raise NormalizeRefused(NORMALIZE_REFUSED, rel, "changed during the walk") from None
            try:
                top = image_check(tree, fd, rel, stat.S_IFDIR)
                if top.st_ino != info.st_ino:
                    raise NormalizeRefused(NORMALIZE_REFUSED, rel, "changed during the walk")
                own(fd, top, rel)
                walk_image_tree(tree, fd, rel, own)
            finally:
                os.close(fd)
        finally:
            os.close(parentfd)
    for rel, _mode in APT_STATE_DIRS:
        image_ensure_dir(tree, rel, owner)
    for rel, mode in APT_STATE_DIRS:
        image_chmod_dir(tree, rel, mode)


def normalize_image_layout(tree, owner):
    """The directories, links and marker files every project image needs."""
    for rel in ("home", "home/user", "tmp", "var/tmp", "run", "etc", "var"):
        image_ensure_dir(tree, rel, owner)
    for rel in ("tmp", "var/tmp"):
        image_chmod_dir(tree, rel, 0o1777)
    tree.changed = set()
    image_replace_with_symlink(tree, "var/run", "/run", owner)
    image_replace_with_symlink(tree, "etc/mtab", "/proc/mounts", owner)
    image_empty_file(tree, "run/podman-init", 0o755, owner)
    image_empty_file(tree, "run/.containerenv", 0o644, owner)


def normalize_image_tree(tree, ownership_source, skip_bridge, read_id_maps, owner):
    """Everything normalize-rootfs does to the tree as host root, in order.
    Returns the probe result the caller prints."""
    result = image_probe(tree)
    # Before any change, on both paths: every multiply linked nondirectory
    # has all its links inside the tree.
    inventory_image_links(tree)
    if not skip_bridge:
        uid_ranges, gid_ranges = read_id_maps()
        remap_image_ids(tree, uid_ranges, gid_ranges, ownership_source)
    normalize_image_layout(tree, owner)
    if not skip_bridge and result["package_manager"] == "apt-get":
        normalize_apt_state(tree, owner)
    return result


def run_normalize_rootfs(
    argv,
    allowed_roots=ALLOWED_ROOTS,
    runtime_root="/run/cocalc-rootfs-normalize",
    runtime_root_uid=0,
):
    allowed = {
        "--root",
        "--path",
        "--ownership-source",
        "--podman-user",
        "--skip-ownership-bridge",
    }
    required = {"--root", "--path", "--ownership-source", "--podman-user"}
    values, flags = parse_named_options(
        argv, "normalize-rootfs", allowed, required
    )
    ownership_source = values["ownership-source"]
    if ownership_source not in ("keep-id", "oci-extract"):
        fail("unsupported RootFS ownership source")
    podman_user = values["podman-user"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", podman_user):
        fail("invalid RootFS Podman user")

    datafd = open_named_directory(
        {
            "rootfs-root": values["root"],
            "rootfs-path": values["path"],
        },
        "rootfs",
        allowed_roots,
    )
    # The rootless Podman child must traverse this directory to consume the
    # bind-mounted RootFS. It is intentionally searchable but never writable
    # by the runtime user, and random mountpoint names prevent accidental use.
    ensure_private_root_directory(runtime_root, runtime_root_uid, 0o711)
    mountpoint = tempfile.mkdtemp(prefix="rootfs-", dir=runtime_root)
    mounted = False
    try:
        subprocess.run(
            ["/bin/mount", "--bind", f"/proc/self/fd/{datafd}", mountpoint],
            pass_fds=(datafd,),
            check=True,
            stdin=subprocess.DEVNULL,
        )
        mounted = True
        wrapper = "/usr/local/sbin/cocalc-runtime-storage"
        skip_bridge = "--skip-ownership-bridge" in flags

        def read_id_maps():
            maps = []
            for kind in ("uid", "gid"):
                output = subprocess.run(
                    [wrapper, "_normalize-rootfs-idmap", "--podman-user", podman_user, kind],
                    check=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    text=True,
                ).stdout
                maps.append(parse_id_map(output))
            return maps

        owner = container_root_ids()
        if 0 in owner:
            fail("the container root must not be host root")
        result = normalize_image_tree(ImageTree(datafd), ownership_source, skip_bridge, read_id_maps, owner)
        if not skip_bridge:
            # Setuid helpers and sudo go back to the container root inside a
            # rootless container, where host paths cannot be reached.
            subprocess.run(
                [
                    wrapper,
                    "_normalize-rootfs-setid",
                    "--podman-user",
                    podman_user,
                    "--shell",
                    result["shell"],
                    mountpoint,
                ],
                check=True,
                stdin=subprocess.DEVNULL,
            )
        own_root_links(datafd, owner)
        # A newly normalized image never keeps host-global capabilities.
        image_caps_preflight(datafd, deadline=time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS, force=True)
        print(json.dumps(result, separators=(",", ":")), flush=True)
    finally:
        if mounted:
            subprocess.run(
                ["/bin/umount", "-l", mountpoint],
                check=False,
                stdin=subprocess.DEVNULL,
            )
        os.rmdir(mountpoint)
        os.close(datafd)


def parse(argv):
    if not argv or argv[0] not in COMMANDS:
        fail("unsupported command")
    command = argv[0]
    values = {"recursive": False, "force": False}
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg in ("--recursive", "--force"):
            values[arg[2:]] = True
            i += 1
            continue
        if arg not in (
            "--root",
            "--path",
            "--dest-root",
            "--dest",
            "--mode",
            "--length",
            "--uid",
            "--gid",
        ):
            fail(f"unknown option: {arg}")
        if i + 1 >= len(argv) or arg[2:] in values:
            fail(f"invalid option: {arg}")
        values[arg[2:]] = argv[i + 1]
        i += 2
    root = values.get("root", "")
    path = values.get("path", "")
    validate_relative(
        path,
        allow_root=command
        in ("chmod", "chown", "copy-tree-preserve", "copy-tree-reflink"),
    )
    if command in ("copy-tree-preserve", "copy-tree-reflink"):
        validate_relative(values.get("dest", ""), allow_root=True)
    elif command == "rename":
        validate_relative(values.get("dest", ""))
    elif "dest" in values:
        fail("--dest is only valid for rename")
    allowed = {
        "chmod": {"root", "path", "mode", "recursive", "force"},
        "chattr-cow": {"root", "path", "recursive", "force"},
        "chown": {"root", "path", "uid", "gid", "recursive", "force"},
        "copy-tree-preserve": {
            "root",
            "path",
            "dest-root",
            "dest",
            "recursive",
            "force",
        },
        "copy-tree-reflink": {
            "root",
            "path",
            "dest-root",
            "dest",
            "recursive",
            "force",
        },
        "mkdir": {"root", "path", "mode", "recursive", "force"},
        "rename": {"root", "path", "dest", "recursive", "force"},
        "rm": {"root", "path", "recursive", "force"},
        "rmdir": {"root", "path", "recursive", "force"},
        "truncate": {"root", "path", "length", "recursive", "force"},
    }[command]
    if any(key not in allowed for key in values):
        fail("option is not valid for command")
    for required in {
        "chmod": ("mode",),
        "chown": ("uid", "gid"),
        "copy-tree-preserve": ("dest-root", "dest"),
        "copy-tree-reflink": ("dest-root", "dest"),
        "mkdir": ("mode",),
        "rename": ("dest",),
        "truncate": ("length",),
    }.get(command, ()):
        if required not in values:
            fail(f"missing --{required}")
    return command, root, path, values


def parse_uint(value, name, maximum=(2**53 - 1)):
    if not value.isdigit():
        fail(f"{name} must be a non-negative integer")
    result = int(value)
    if result > maximum:
        fail(f"{name} is too large")
    return result


# Project views: idmapped bind mounts that show the runtime user's files
# (owner RUNTIME_USER on disk) as owned by a separate host uid, so a project
# container can run its user as that uid while everything on disk keeps its
# owner. Views live under PROJECT_VIEW_ROOT/<project-id>/<kind>; the root and
# the per-project dirs are root-owned 0710 with the runtime group, so the
# runtime user can reach the views to hand them to Podman but can't rename or
# replace what this helper mounts on, and the view uid can't enter at all.
PROJECT_VIEW_ROOT = "/run/cocalc/project-views"
# Serializes every change beneath PROJECT_VIEW_ROOT (mounts, unmounts, gc and
# idmapped overlay uppers), so a check for an existing mount and the mount
# itself can't interleave with another helper.
PROJECT_VIEW_LOCK = "/run/cocalc/project-views.lock"
PROJECT_VIEW_UMOUNT_ROUNDS = 16
PROJECT_VIEW_UID_START = 1073741824
PROJECT_VIEW_UID_COUNT = 65536
PROJECT_VIEW_MAX_ID = 4294967294
# kind -> (allowed source (root, relative path template), read-only)
PROJECT_VIEW_KINDS = {
    "home": (("/mnt/cocalc", "project-{id}"), False),
    "scratch": (("/mnt/cocalc", "project-{id}-scratch"), False),
    "browser-run": (("/mnt/cocalc", "data/tmp/cocalc-browser-run/{id}"), False),
    "secrets": (("/mnt/cocalc", "data/tmp/cocalc-project-secrets/{id}"), True),
}
PROJECT_VIEW_ROOTFS_UPPER = "rootfs-upper"
# The only names beneath PROJECT_VIEW_ROOT/<project-id>: every mount the
# helper makes is exactly one of these, so it never unmounts anything else.
PROJECT_VIEW_TARGETS = (*PROJECT_VIEW_KINDS, PROJECT_VIEW_ROOTFS_UPPER)
PROJECT_VIEW_MOUNT_OPTIONS = "nosuid,nodev"
# An idmapped overlay upper must live in the project's own home.
PROJECT_UPPER_ROOT = "/mnt/cocalc"
# Merged rootfs mountpoints for --idmap: <root>/<project-id>/root.
# Podman adds o+x to every parent of a --rootfs path that the container's root
# doesn't own, and fails if it can't. So <root> is root-owned 0711 (already
# traversable), and <root>/<project-id> belongs to the container root's host
# ids with mode 0700: podman leaves it alone and crun reaches it as root of the
# rootless namespace, but no project uid (or any other host uid) can enter it.
# The overlay itself is mounted on <root>/<project-id>/root.
PROJECT_ROOTFS_ROOT = "/run/cocalc/project-rootfs"
PROJECT_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PROJECT_VIEW_COMMANDS = {
    "project-view-mount",
    "project-view-umount",
    "project-view-gc",
    "project-view-harden",
}
# project-view-harden: the project data root becomes root:<runtime group>
# 0750, so only root and the runtime user can reach anything beneath it (raw
# homes, scratch, data); a separate runtime uid reaches its files only
# through its views. Raw homes owned by the runtime user also go to 0700.
PROJECT_DATA_ROOT = "/mnt/cocalc"
PROJECT_HOME_RE = re.compile(r"project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def runtime_ids():
    # the stricter check (unknown user or uid/gid 0 is a failure)
    return runtime_user_ids()


def validate_project_id(value):
    if not isinstance(value, str) or not PROJECT_ID_RE.fullmatch(value):
        fail(f"invalid project id: {value!r}")
    return value


def validate_view_uid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,9}", value):
        fail(f"invalid view uid: {value!r}")
    uid = int(value)
    if not PROJECT_VIEW_UID_START <= uid < PROJECT_VIEW_UID_START + PROJECT_VIEW_UID_COUNT:
        fail(f"view uid is outside the project runtime uid block: {uid}")
    return uid


def project_view_idmap(disk_uid, disk_gid, view_uid):
    """X-mount.idmap value: disk ids map to themselves, except the runtime
    user's uid/gid, which show as view_uid; view_uid on disk stays unmapped.
    util-linux reads each extent as <type>:<id on disk>:<id in mount>:<count>.
    """
    extents = []
    for kind, disk in (("u", disk_uid), ("g", disk_gid)):
        if not 0 < disk < view_uid:
            fail("view uid must be above the runtime user's ids")
        extents.append(f"{kind}:0:0:{disk}")
        extents.append(f"{kind}:{disk}:{view_uid}:1")
        if view_uid - disk - 1 > 0:
            extents.append(f"{kind}:{disk + 1}:{disk + 1}:{view_uid - disk - 1}")
        extents.append(f"{kind}:{view_uid + 1}:{view_uid + 1}:{PROJECT_VIEW_MAX_ID - view_uid}")
    return " ".join(extents)


def ensure_view_dir(parentfd, name, gid, mode=0o710):
    """A root-owned dir beneath parentfd (no symlinks), with group gid."""
    try:
        os.mkdir(name, mode, dir_fd=parentfd)
    except FileExistsError:
        pass
    fd = openat2(parentfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != 0:
        os.close(fd)
        fail(f"unsafe project view directory: {name}")
    os.chown(f"/proc/self/fd/{fd}", 0, gid)
    os.chmod(f"/proc/self/fd/{fd}", mode)
    return fd


def open_view_root(gid, create=True):
    """PROJECT_VIEW_ROOT, root-owned 0710 with the runtime group."""
    parent, name = os.path.split(PROJECT_VIEW_ROOT)
    if create:
        os.makedirs(parent, mode=0o711, exist_ok=True)
    check_view_parent(parent)
    parentfd = os.open(parent, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not create:
            return openat2(parentfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        return ensure_view_dir(parentfd, name, gid)
    finally:
        os.close(parentfd)


def check_view_parent(path):
    """/run/cocalc must be a root-owned dir that only root can write."""
    info = os.lstat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        fail(f"unsafe project view parent: {path}")


@contextlib.contextmanager
def view_lock():
    import fcntl

    os.makedirs(os.path.dirname(PROJECT_VIEW_LOCK), mode=0o711, exist_ok=True)
    check_view_parent(os.path.dirname(PROJECT_VIEW_LOCK))
    fd = os.open(PROJECT_VIEW_LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if os.fstat(fd).st_uid != os.geteuid():
            fail(f"unsafe project view lock: {PROJECT_VIEW_LOCK}")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def view_mountpoints():
    """Mount targets beneath PROJECT_VIEW_ROOT, deepest first; a target with
    stacked mounts appears once per mount."""
    targets = []
    with open("/proc/self/mountinfo", encoding="utf-8") as f:
        for line in f:
            target = line.split()[4].encode().decode("unicode_escape")
            if target.startswith(PROJECT_VIEW_ROOT + "/"):
                targets.append(target)
    return sorted(targets, key=len, reverse=True)


def umount_view_target(target):
    """Unmount one exact view target (a root-owned mountpoint the helper
    created) until nothing is mounted there; MNT_DETACH takes any mounts
    beneath it along."""
    for _round in range(PROJECT_VIEW_UMOUNT_ROUNDS):
        if target not in view_mountpoints():
            return
        subprocess.run(["/bin/umount", "-l", target], check=True, stdin=subprocess.DEVNULL)
    fail(f"project view mounts remain at {target}")


def assert_view_direction(source, view, uid, gid, view_uid):
    """The view must show the runtime user's ids as view_uid and every other
    owner unchanged (a guard against the idmap fields being read the other
    way round)."""
    for kind, disk, seen, runtime in (("uid", source.st_uid, view.st_uid, uid), ("gid", source.st_gid, view.st_gid, gid)):
        expected = view_uid if disk == runtime else disk
        if seen != expected:
            fail(f"project view shows {kind} {disk} as {seen}, expected {expected}")


def verify_view(projectfd, name, sourcefd, uid, gid, view_uid):
    """Check a fresh view against its source; unmount it if it's wrong."""
    fd = openat2(projectfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        assert_view_direction(os.fstat(sourcefd), os.fstat(fd), uid, gid, view_uid)
    except ValueError:
        umount_view_target(f"{PROJECT_VIEW_ROOT}/{os.path.basename(os.readlink(f'/proc/self/fd/{projectfd}'))}/{name}")
        raise
    finally:
        os.close(fd)


def container_root_ids():
    """Host uid/gid of the containers' root: the start of the runtime user's
    first subordinate range."""
    ids = []
    for path in ("/etc/subuid", "/etc/subgid"):
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) == 3 and parts[0] == RUNTIME_USER and parts[1].isdigit():
                    ids.append(int(parts[1]))
                    break
            else:
                fail(f"no subordinate range for {RUNTIME_USER} in {path}")
    return ids[0], ids[1]


def ensure_rootfs_mountpoint(project_id):
    """PROJECT_ROOTFS_ROOT/<project-id>/root, see PROJECT_ROOTFS_ROOT."""
    croot_uid, croot_gid = container_root_ids()
    parent, name = os.path.split(PROJECT_ROOTFS_ROOT)
    os.makedirs(parent, mode=0o711, exist_ok=True)
    check_view_parent(parent)
    parentfd = os.open(parent, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    rootfd = projectfd = None
    try:
        try:
            os.mkdir(name, 0o711, dir_fd=parentfd)
        except FileExistsError:
            pass
        rootfd = openat2(parentfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        info = os.fstat(rootfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o711:
            fail(f"unsafe project rootfs root: {PROJECT_ROOTFS_ROOT}")
        try:
            os.mkdir(project_id, 0o700, dir_fd=rootfd)
            created = True
        except FileExistsError:
            created = False
        projectfd = openat2(rootfd, project_id, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        if created:
            os.chown(f"/proc/self/fd/{projectfd}", croot_uid, croot_gid)
        info = os.fstat(projectfd)
        if (info.st_uid, info.st_gid) != (croot_uid, croot_gid) or stat.S_IMODE(info.st_mode) != 0o700:
            fail(f"unsafe project rootfs dir: {PROJECT_ROOTFS_ROOT}/{project_id}")
        try:
            os.mkdir("root", 0o755, dir_fd=projectfd)
        except FileExistsError:
            pass
    finally:
        for fd in (projectfd, rootfd):
            if fd is not None:
                os.close(fd)
        os.close(parentfd)


def harden_project_data_root(uid, gid):
    rootfd = os.open(PROJECT_DATA_ROOT, O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if os.fstat(rootfd).st_uid != os.geteuid():
            fail(f"unsafe project data root: {PROJECT_DATA_ROOT}")
        os.chown(f"/proc/self/fd/{rootfd}", os.geteuid(), gid)
        os.chmod(f"/proc/self/fd/{rootfd}", 0o750)
        for name in os.listdir(f"/proc/self/fd/{rootfd}"):
            if not PROJECT_HOME_RE.fullmatch(name):
                continue
            try:
                fd = openat2(rootfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            except OSError:
                continue
            try:
                info = os.fstat(fd)
                if info.st_uid == uid and stat.S_IMODE(info.st_mode) != 0o700:
                    os.chmod(f"/proc/self/fd/{fd}", 0o700)
            finally:
                os.close(fd)
    finally:
        os.close(rootfd)


def make_view_private(projectfd, name):
    """Stop propagation into a fresh view: the sources live on shared mounts,
    so mounts made later beneath a source would otherwise appear in it."""
    fd = openat2(projectfd, name, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        subprocess.run(
            ["/bin/mount", "--make-private", f"/proc/self/fd/{fd}"],
            pass_fds=(fd,),
            check=True,
            stdin=subprocess.DEVNULL,
        )
    finally:
        os.close(fd)


def umount_project_views(project_id, names=PROJECT_VIEW_TARGETS):
    for name in names:
        umount_view_target(f"{PROJECT_VIEW_ROOT}/{project_id}/{name}")


def remove_view_tree(rootfd, project_id):
    try:
        projectfd = openat2(rootfd, project_id, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    except FileNotFoundError:
        return
    try:
        for name in os.listdir(f"/proc/self/fd/{projectfd}"):
            if name not in PROJECT_VIEW_TARGETS:
                fail(f"unexpected entry in project views: {name!r}")
            os.rmdir(name, dir_fd=projectfd)
    finally:
        os.close(projectfd)
    os.rmdir(project_id, dir_fd=rootfd)


def run_project_view(argv, allowed_roots=ALLOWED_ROOTS):
    with view_lock():
        return _run_project_view(argv, allowed_roots)


def _run_project_view(argv, allowed_roots=ALLOWED_ROOTS):
    command = argv[0]
    uid, gid = runtime_ids()
    if command == "project-view-mount":
        options = {"--project", "--kind", "--uid", "--source-root", "--source-path"}
        values, _flags = parse_named_options(argv, command, options, options)
        project_id = validate_project_id(values["project"])
        kind = values["kind"]
        if kind not in PROJECT_VIEW_KINDS:
            fail(f"invalid project view kind: {kind!r}")
        view_uid = validate_view_uid(values["uid"])
        (source_root, template), read_only = PROJECT_VIEW_KINDS[kind]
        if values["source-root"] != source_root or values["source-path"] != template.format(id=project_id):
            fail(f"source is not the {kind} of project {project_id}")
        sourcefd = open_named_directory(values, "source", allowed_roots)
        target = f"{PROJECT_VIEW_ROOT}/{project_id}/{kind}"
        if target in view_mountpoints():
            os.close(sourcefd)
            fail(f"project view is already mounted: {target}")
        rootfd = projectfd = targetfd = None
        try:
            rootfd = open_view_root(gid)
            projectfd = ensure_view_dir(rootfd, project_id, gid)
            targetfd = ensure_view_dir(projectfd, kind, gid, mode=0o700)
            options = (
                f"X-mount.idmap={project_view_idmap(uid, gid, view_uid)},"
                + PROJECT_VIEW_MOUNT_OPTIONS
            )
            if read_only:
                options += ",ro"
            subprocess.run(
                [
                    "/bin/mount",
                    "--bind",
                    "-o",
                    options,
                    f"/proc/self/fd/{sourcefd}",
                    f"/proc/self/fd/{targetfd}",
                ],
                pass_fds=(sourcefd, targetfd),
                check=True,
                stdin=subprocess.DEVNULL,
            )
            # Mounted: from here on, any failure takes the view down again.
            try:
                make_view_private(projectfd, kind)
                verify_view(projectfd, kind, sourcefd, uid, gid, view_uid)
            except BaseException:
                umount_view_target(target)
                raise
        finally:
            for fd in (targetfd, projectfd, rootfd, sourcefd):
                if fd is not None:
                    os.close(fd)
        return
    if command == "project-view-umount":
        values, _flags = parse_named_options(argv, command, {"--project"}, {"--project"})
        project_id = validate_project_id(values["project"])
        try:
            rootfd = open_view_root(gid, create=False)
        except FileNotFoundError:
            return
        try:
            umount_project_views(project_id)
            remove_view_tree(rootfd, project_id)
        finally:
            os.close(rootfd)
        return
    if command == "project-view-harden":
        parse_named_options(argv, command, set(), set())
        harden_project_data_root(uid, gid)
        return
    if command == "project-view-gc":
        values, _flags = parse_named_options(argv, command, {"--keep"}, {"--keep"})
        keep = {validate_project_id(value) for value in values["keep"].split(",") if value}
        try:
            rootfd = open_view_root(gid, create=False)
        except FileNotFoundError:
            return
        try:
            for name in os.listdir(f"/proc/self/fd/{rootfd}"):
                if name in keep:
                    continue
                if not PROJECT_ID_RE.fullmatch(name):
                    fail(f"unexpected entry in {PROJECT_VIEW_ROOT}: {name!r}")
                umount_project_views(name)
                remove_view_tree(rootfd, name)
        finally:
            os.close(rootfd)
        return
    fail(f"invalid project view command: {command}")


def mount_idmapped_upper(project_id, upperfd, workfd, view_uid):
    """Bind the dir holding upperdir and workdir, idmapped, beneath the
    project's views; return (staging fd, upper name, work name).

    Overlay needs upperdir and workdir on one mount, so both must be direct
    children of the same directory.
    """
    upper_parent = os.stat("..", dir_fd=upperfd)
    work_parent = os.stat("..", dir_fd=workfd)
    if (upper_parent.st_dev, upper_parent.st_ino) != (work_parent.st_dev, work_parent.st_ino):
        fail("overlay upperdir and workdir must share a parent directory")
    upper_name = os.path.basename(os.readlink(f"/proc/self/fd/{upperfd}"))
    work_name = os.path.basename(os.readlink(f"/proc/self/fd/{workfd}"))
    uid, gid = runtime_ids()
    target = f"{PROJECT_VIEW_ROOT}/{project_id}/{PROJECT_VIEW_ROOTFS_UPPER}"
    if target in view_mountpoints():
        fail(f"idmapped overlay upper is already mounted: {target}")
    parentfd = os.open(f"/proc/self/fd/{upperfd}/..", O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    rootfd = projectfd = stagingfd = None
    try:
        if (os.fstat(parentfd).st_dev, os.fstat(parentfd).st_ino) != (upper_parent.st_dev, upper_parent.st_ino):
            fail("overlay upper parent changed while mounting")
        rootfd = open_view_root(gid)
        projectfd = ensure_view_dir(rootfd, project_id, gid)
        stagingfd = ensure_view_dir(projectfd, PROJECT_VIEW_ROOTFS_UPPER, gid, mode=0o700)
        subprocess.run(
            [
                "/bin/mount",
                "--bind",
                "-o",
                f"X-mount.idmap={project_view_idmap(uid, gid, view_uid)}",
                f"/proc/self/fd/{parentfd}",
                f"/proc/self/fd/{stagingfd}",
            ],
            pass_fds=(parentfd, stagingfd),
            check=True,
            stdin=subprocess.DEVNULL,
        )
        # Mounted: from here on, any failure takes the staged upper down again.
        try:
            make_view_private(projectfd, PROJECT_VIEW_ROOTFS_UPPER)
            verify_view(projectfd, PROJECT_VIEW_ROOTFS_UPPER, parentfd, uid, gid, view_uid)
            mounted = openat2(projectfd, PROJECT_VIEW_ROOTFS_UPPER, O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        except BaseException:
            umount_view_target(target)
            raise
        return mounted, upper_name, work_name
    finally:
        for fd in (stagingfd, projectfd, rootfd, parentfd):
            if fd is not None:
                os.close(fd)


def runtime_user_ids(user=RUNTIME_USER):
    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        fail(f"runtime user is unknown: {user!r}")
    if entry.pw_uid == 0 or entry.pw_gid == 0:
        fail("runtime user must not be root")
    return entry.pw_uid, entry.pw_gid


def subordinate_ranges(path, user, uid):
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return []
    ranges = []
    for line in lines:
        parts = line.strip().split(":")
        if len(parts) != 3 or parts[0] not in (user, str(uid)):
            continue
        if all(re.fullmatch(r"[0-9]{1,10}", part) for part in parts[1:]):
            ranges.append((int(parts[1]), int(parts[2])))
    return ranges


def owner_policy(user=RUNTIME_USER, subid_files=SUBID_FILES):
    """Ids that generic chown may assign: the runtime user, its subordinate
    ranges (container root and project ranges) and the R1 project ids."""
    uid, gid = runtime_user_ids(user)
    project = (PROJECT_RUNTIME_ID_START, PROJECT_RUNTIME_ID_COUNT)
    return {
        "uid": [(uid, 1), project, *subordinate_ranges(subid_files[0], user, uid)],
        "gid": [(gid, 1), project, *subordinate_ranges(subid_files[1], user, uid)],
    }


def parse_owner_id(value, name, ranges):
    if not re.fullmatch(r"[0-9]{1,10}", value):
        fail(f"{name} must be a non-negative integer")
    result = int(value)
    if result == 0 or not any(start <= result < start + count for start, count in ranges):
        fail(f"{name} {result} is not an allowed owner")
    return result


def parse_mode(value, root, sticky_roots=STICKY_ROOTS):
    if not re.fullmatch(r"[0-7]{3,4}", value):
        fail(f"mode must be 3 or 4 octal digits: {value!r}")
    mode = int(value, 8)
    if mode & 0o6000:
        fail(f"setuid and setgid modes are not allowed: {value!r}")
    if mode & 0o1000 and root not in sticky_roots:
        fail(f"the sticky bit is only allowed beneath scratch: {value!r}")
    return mode


def check_generic_path(root, path, command, generic_roots):
    if root not in generic_roots:
        fail(f"root is not allowed: {root!r}")
    only = GENERIC_ONLY_PATHS.get(root)
    if only is not None and (path not in only[0] or command not in only[1]):
        fail(f"{command} of this path is not allowed beneath {root}: {path!r}")
    if path == "." and root in GENERIC_FIXED_ROOTS:
        fail(f"{command} of {root} itself is not allowed")
    for protected in GENERIC_PROTECTED_PATHS.get(root, ()):
        if path == protected or path.startswith(protected + "/"):
            fail(f"path is protected: {path!r}")
        if command in TREE_COMMANDS and (path == "." or protected.startswith(path + "/")):
            fail(f"path contains a protected path: {path!r}")


def open_single_link(rootfd, path):
    # A second hard link would let a path outside a protected subtree reach
    # an inode inside it.
    fd = open_existing(rootfd, path)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) and info.st_nlink != 1:
        os.close(fd)
        fail(f"path has more than one hard link: {path!r}")
    return fd


def btrfs_ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (0x94 << 8) | nr


# btrfs takes only the command shapes callers use.  Every path operand is
# pinned beneath BTRFS_ROOTS without following symlinks and must be on btrfs.
# Subvolume create, snapshot and delete and the ro property are ioctls on the
# pinned descriptors (btrfs-progs re-resolves some of these paths by name);
# the remaining shapes run btrfs-progs on /proc/self/fd/N.
BTRFS_ROOTS = ("/mnt/cocalc", "/mnt/cocalc-scratch")
BTRFS_SUPER_MAGIC = 0x9123683E
BTRFS_FIRST_FREE_OBJECTID = 256
BTRFS_SUBVOL_RDONLY = 1 << 1
BTRFS_NAME_MAX = 255
BTRFS_IOC_SUBVOL_CREATE = btrfs_ioc(1, 14, 4096)
BTRFS_IOC_SNAP_DESTROY = btrfs_ioc(1, 15, 4096)
BTRFS_IOC_SNAP_CREATE_V2 = btrfs_ioc(1, 23, 4096)
BTRFS_IOC_SUBVOL_GETFLAGS = btrfs_ioc(2, 25, 8)
BTRFS_IOC_SUBVOL_SETFLAGS = btrfs_ioc(1, 26, 8)
BTRFS_EXECUTABLE = "/usr/bin/btrfs"
MKFS_IMAGE_ROOT = "/var/lib/cocalc"
MKFS_IMAGES = {"btrfs.img", "cocalc.img"}


def is_qgroup_id(value):
    # Only a project's quota group, never a subvolume's own (level 0).
    return re.fullmatch(r"1/[0-9]{1,15}", value) is not None


def parse_btrfs(argv):
    """Return (action, operands) for an allowed btrfs command line.  Operands
    are literal strings or (kind, path): "dir" an existing directory, "new" a
    name to create, "dest" a snapshot destination, "old" a name to delete."""

    def dirs(*paths):
        return [("dir", path) for path in paths]

    match argv:
        case ["subvolume", "create", path]:
            return "create", [("new", path)]
        case ["subvolume", "snapshot", "-r", source, dest]:
            return "snapshot-ro", [("dir", source), ("dest", dest)]
        case ["subvolume", "snapshot", source, dest]:
            return "snapshot", [("dir", source), ("dest", dest)]
        case ["subvolume", "delete", path]:
            return "delete", [("old", path)]
        case ["property", "get", "-ts", path, "ro"]:
            return "get-ro", dirs(path)
        case ["property", "set", "-ts", path, "ro", ("true" | "false") as value]:
            return "set-ro", [*dirs(path), value]
        case ["subvolume", "show", path] | ["subvolume", "list", path]:
            return "exec", [*argv[:2], *dirs(path)]
        case ["subvolume", "list", ("-o" | "-u") as flag, path]:
            return "exec", ["subvolume", "list", flag, *dirs(path)]
        case ["filesystem", ("show" | "sync") as sub, path]:
            return "exec", ["filesystem", sub, *dirs(path)]
        case ["filesystem", "usage", "-b", path] | ["filesystem", "du", "-s", path]:
            return "exec", [*argv[:3], *dirs(path)]
        case ["qgroup", "show", *flags, path] if len(flags) <= 3 and all(
            re.fullmatch(r"-[pcreFf]{1,6}|--raw|--sync", flag) for flag in flags
        ):
            return "exec", ["qgroup", "show", *flags, *dirs(path)]
        case ["qgroup", ("create" | "destroy") as sub, group, path] if is_qgroup_id(group):
            return "exec", ["qgroup", sub, group, *dirs(path)]
        case ["qgroup", "assign", "--no-rescan", source, group, path] if is_qgroup_id(group):
            return "exec", ["qgroup", "assign", "--no-rescan", *dirs(source), group, *dirs(path)]
        case ["qgroup", "limit", size, target, path] if re.fullmatch(
            r"[0-9]{1,20}[KMGTPEkmgtpe]?|none", size
        ):
            target_operand = target if is_qgroup_id(target) else ("dir", target)
            return "exec", ["qgroup", "limit", size, target_operand, *dirs(path)]
        case ["quota", "enable", "--simple", path] | ["quota", "disable", path]:
            return "exec", [*argv[:-1], *dirs(path)]
    fail(f"btrfs command is not allowed: {' '.join(argv[:3])!r}")


def btrfs_root_and_rel(path, roots):
    if not path.startswith("/"):
        fail(f"btrfs path must be absolute: {path!r}")
    for root in roots:
        if path == root:
            return root, "."
        if path.startswith(root + "/"):
            rel = path[len(root) + 1 :]
            validate_relative(rel)
            return root, rel
    fail(f"btrfs path is not allowed: {path!r}")


def require_btrfs(fd, path):
    buf = ctypes.create_string_buffer(512)
    if LIBC.fstatfs(fd, buf) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), path)
    if ctypes.c_long.from_buffer(buf).value & 0xFFFFFFFF != BTRFS_SUPER_MAGIC:
        fail(f"Not a Btrfs filesystem: {path!r}")


def open_btrfs_directory(path, roots):
    root, rel = btrfs_root_and_rel(path, roots)
    rootfd = open_root(root, set(roots))
    try:
        fd = openat2(rootfd, rel, os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_CLOEXEC)
    finally:
        os.close(rootfd)
    try:
        require_btrfs(fd, path)
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_btrfs_parent(path, roots):
    root, rel = btrfs_root_and_rel(path, roots)
    if rel == ".":
        fail(f"btrfs path needs a parent beneath {root}: {path!r}")
    parent, _, name = rel.rpartition("/")
    if len(os.fsencode(name)) > BTRFS_NAME_MAX:
        fail(f"btrfs name is too long: {path!r}")
    return open_btrfs_directory(root if not parent else f"{root}/{parent}", roots), name


def btrfs_vol_args(name, fd=0, flags=None):
    # struct btrfs_ioctl_vol_args (fd, name[4088]) or, with flags,
    # btrfs_ioctl_vol_args_v2 (fd, transid, flags, unused[4], name[4040]).
    args = bytearray(4096)
    encoded = os.fsencode(name)
    if flags is None:
        struct.pack_into("q", args, 0, fd)
        args[8 : 8 + len(encoded)] = encoded
    else:
        struct.pack_into("qQQ", args, 0, fd, 0, flags)
        args[56 : 56 + len(encoded)] = encoded
    return args


def require_subvolume(info, path):
    if not stat.S_ISDIR(info.st_mode) or info.st_ino != BTRFS_FIRST_FREE_OBJECTID:
        fail(f"Not a Btrfs subvolume: {path!r}")


def run_btrfs(argv, roots=BTRFS_ROOTS, executable=BTRFS_EXECUTABLE):
    action, operands = parse_btrfs(argv)
    fds = []

    def pin(path):
        fd = open_btrfs_directory(path, roots)
        fds.append(fd)
        return fd

    def pin_parent(path):
        fd, name = open_btrfs_parent(path, roots)
        fds.append(fd)
        return fd, name

    try:
        if action == "create":
            path = operands[0][1]
            parentfd, name = pin_parent(path)
            fcntl.ioctl(parentfd, BTRFS_IOC_SUBVOL_CREATE, btrfs_vol_args(name))
            print(f"Create subvolume '{path}'")
        elif action in ("snapshot", "snapshot-ro"):
            source, dest = operands[0][1], operands[1][1]
            sourcefd = pin(source)
            require_subvolume(os.fstat(sourcefd), source)
            parentfd, name = pin_parent(dest)
            try:
                info = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
            except FileNotFoundError:
                info = None
            if info is not None:
                if not stat.S_ISDIR(info.st_mode):
                    fail(f"snapshot destination exists: {dest!r}")
                # As btrfs-progs: an existing directory receives the snapshot
                # under the source's name.
                parentfd = openat2(parentfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK | os.O_CLOEXEC)
                fds.append(parentfd)
                name = source.rstrip("/").rpartition("/")[2]
            flags = BTRFS_SUBVOL_RDONLY if action == "snapshot-ro" else 0
            fcntl.ioctl(parentfd, BTRFS_IOC_SNAP_CREATE_V2, btrfs_vol_args(name, sourcefd, flags))
            kind = "a readonly snapshot" if flags else "a snapshot"
            print(f"Create {kind} of '{source}' in '{dest}'")
        elif action == "delete":
            path = operands[0][1]
            parentfd, name = pin_parent(path)
            require_subvolume(os.stat(name, dir_fd=parentfd, follow_symlinks=False), path)
            # The kernel looks the name up in the pinned parent; a symlink
            # there is not a subvolume.
            fcntl.ioctl(parentfd, BTRFS_IOC_SNAP_DESTROY, btrfs_vol_args(name))
            print(f"Delete subvolume (no-commit): '{path}'")
        elif action in ("get-ro", "set-ro"):
            path = operands[0][1]
            fd = pin(path)
            require_subvolume(os.fstat(fd), path)
            buf = bytearray(8)
            fcntl.ioctl(fd, BTRFS_IOC_SUBVOL_GETFLAGS, buf)
            flags = struct.unpack("Q", buf)[0]
            if action == "get-ro":
                print(f"ro={'true' if flags & BTRFS_SUBVOL_RDONLY else 'false'}")
            else:
                if operands[1] == "true":
                    flags |= BTRFS_SUBVOL_RDONLY
                else:
                    flags &= ~BTRFS_SUBVOL_RDONLY
                fcntl.ioctl(fd, BTRFS_IOC_SUBVOL_SETFLAGS, bytearray(struct.pack("Q", flags)))
        else:
            args = [executable]
            for operand in operands:
                args.append(operand if isinstance(operand, str) else f"/proc/self/fd/{pin(operand[1])}")
            sys.stdout.flush()
            return subprocess.run(args, pass_fds=tuple(fds), stdin=subprocess.DEVNULL).returncode
        sys.stdout.flush()
        return 0
    finally:
        for fd in fds:
            os.close(fd)


def run_mkfs_btrfs(argv, image_root=MKFS_IMAGE_ROOT, owner_uid=0, executable=None):
    """mkfs.btrfs only on a new image: a root-owned regular file with one link
    and no allocated blocks (as truncate creates it), opened without
    following symlinks.  mkfs.btrfs itself refuses an existing filesystem
    without -f, which is never passed."""
    values, _flags = parse_named_options(argv, "mkfs-btrfs", {"--root", "--path"}, {"--root", "--path"})
    if values["root"] != image_root or values["path"] not in MKFS_IMAGES:
        fail(f"mkfs.btrfs is only allowed on {image_root}/{{{','.join(sorted(MKFS_IMAGES))}}}")
    rootfd = open_root(image_root, {image_root})
    try:
        fd = openat2(rootfd, values["path"], os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC)
    finally:
        os.close(rootfd)
    try:
        # Two concurrent calls must not both see a fresh image.
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("mkfs.btrfs is already running on this image")
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != owner_uid
            or info.st_nlink != 1
            or info.st_blocks != 0
            or info.st_size == 0
        ):
            fail("mkfs.btrfs needs a new, empty image file")
        if executable is None:
            executable = "/usr/sbin/mkfs.btrfs" if os.path.exists("/usr/sbin/mkfs.btrfs") else "/sbin/mkfs.btrfs"
        sys.stdout.flush()
        return subprocess.run([executable, f"/proc/self/fd/{fd}"], pass_fds=(fd,), stdin=subprocess.DEVNULL).returncode
    finally:
        os.close(fd)


# Read-only tree tools the wrapper runs as root.  The helper pins the tree
# without following symlinks and re-enters the wrapper's internal verb with
# /proc/self/fd/N; that verb refuses to run under sudo.
PIN_EXEC_VERBS = {"du-bytes", "rootfs-manifest", "tar-sha256-tree"}
STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage"


def run_pin_exec(argv, allowed_roots=ALLOWED_ROOTS, wrapper=STORAGE_WRAPPER):
    values, _flags = parse_named_options(
        argv, "pin-exec", {"--root", "--path", "--verb"}, {"--root", "--path", "--verb"}
    )
    if values["verb"] not in PIN_EXEC_VERBS:
        fail(f"pin-exec verb is not allowed: {values['verb']!r}")
    validate_relative(values["path"], allow_root=True)
    rootfd = open_root(values["root"], set(allowed_roots) - SECRET_ROOTS)
    try:
        fd = openat2(rootfd, values["path"], O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    finally:
        os.close(rootfd)
    try:
        env = {key: value for key, value in os.environ.items() if not key.startswith("SUDO_")}
        sys.stdout.flush()
        return subprocess.run(
            [wrapper, f"_{values['verb']}-pinned", f"/proc/self/fd/{fd}"],
            pass_fds=(fd,),
            env=env,
            stdin=subprocess.DEVNULL,
        ).returncode
    finally:
        os.close(fd)


def run(argv, allowed_roots=ALLOWED_ROOTS, rustic_candidates=None, owners=None, confined=None):
    if argv and argv[0] == "scan-oversized-files":
        return run_scan_oversized_files(argv, allowed_roots)
    if argv and argv[0] == "scan-changed-since":
        return run_scan_changed_since(argv, allowed_roots)
    if argv and argv[0] in RUSTIC_COMMANDS:
        return run_rustic(argv, allowed_roots, rustic_candidates)
    if argv and argv[0] in PROJECT_VIEW_COMMANDS:
        return run_project_view(argv, allowed_roots)
    if argv and argv[0] in ANCHORED_COMMANDS:
        if argv[0] == "normalize-rootfs":
            return run_normalize_rootfs(argv, allowed_roots)
        return run_overlay(argv, allowed_roots)
    command, root, path, values = parse(argv)
    generic_roots = set(allowed_roots) - SECRET_ROOTS
    check_generic_path(root, path, command, generic_roots)
    if command == "rename":
        check_generic_path(root, values["dest"], command, generic_roots)
    elif command in ("copy-tree-preserve", "copy-tree-reflink"):
        check_generic_path(values["dest-root"], values["dest"], command, generic_roots)
    if command in ("chmod", "mkdir"):
        mode = parse_mode(values["mode"], root)
    elif command == "chown":
        owners = owners or owner_policy()
        uid = parse_owner_id(values["uid"], "uid", owners["uid"])
        gid = parse_owner_id(values["gid"], "gid", owners["gid"])
    rootfd = open_root(root, generic_roots)
    try:
        if command == "mkdir":
            mkdir_beneath(rootfd, path, values["recursive"], mode)
        elif command == "rename":
            sourcefd, source = open_parent(rootfd, path)
            destfd, dest = open_parent(rootfd, values["dest"])
            try:
                os.rename(source, dest, src_dir_fd=sourcefd, dst_dir_fd=destfd)
            finally:
                os.close(sourcefd)
                os.close(destfd)
        elif command in ("rm", "rmdir"):
            parentfd, name = open_parent(rootfd, path)
            try:
                if command == "rmdir" and not values["recursive"]:
                    os.rmdir(name, dir_fd=parentfd)
                else:
                    remove_entry(parentfd, name, values["recursive"], values["force"])
            finally:
                os.close(parentfd)
        elif command == "chmod":
            fd = open_single_link(rootfd, path)
            try:
                os.fchmod(fd, mode)
            finally:
                os.close(fd)
        elif command == "chown":
            fd = open_single_link(rootfd, path)
            try:
                os.fchown(fd, uid, gid)
            finally:
                os.close(fd)
        elif command in ("copy-tree-preserve", "copy-tree-reflink"):
            dest_rootfd = open_root(values["dest-root"], generic_roots)
            try:
                created = False
                if values["dest"] != ".":
                    try:
                        os.stat(values["dest"], dir_fd=dest_rootfd, follow_symlinks=False)
                    except FileNotFoundError:
                        created = True
                    mkdir_beneath(dest_rootfd, values["dest"], True, 0o755)
                sourcefd = openat2(
                    rootfd,
                    path,
                    O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
                )
                destfd = openat2(
                    dest_rootfd,
                    values["dest"],
                    O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
                )
                try:
                    source = f"/proc/self/fd/{sourcefd}"
                    dest = f"/proc/self/fd/{destfd}"
                    if command == "copy-tree-preserve":
                        # Owners, modes and namespaced file capabilities are
                        # kept, confined (see run_confined); a tree of the
                        # runtime user's cannot become root's.
                        uid, gid = runtime_user_ids()
                        if created:
                            # destfd is O_PATH: chown through its magic link.
                            os.chown(dest, uid, gid)
                        status = (confined or run_confined)(
                            [*CONFINED_RSYNC, "--", "/src/", "/dest/"],
                            [(sourcefd, "/src", False), (destfd, "/dest", True)],
                            deadline=time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS,
                            setfcap=True,
                        )
                        if status != 0:
                            raise subprocess.CalledProcessError(status, CONFINED_RSYNC[:1])
                        return
                    # copy-tree-reflink: confined as well (see CONFINED_CP).
                    uid, gid = runtime_user_ids()
                    if created:
                        os.chown(dest, uid, gid)
                    status = (confined or run_confined)(
                        [*CONFINED_CP, "--", "/src/.", "/dest/"],
                        [(sourcefd, "/src", False), (destfd, "/dest", True)],
                        deadline=time.monotonic() + RUSTIC_MAX_RUNTIME_SECONDS,
                        setfcap=True,
                    )
                    if status != 0:
                        raise subprocess.CalledProcessError(status, CONFINED_CP[:1])
                finally:
                    os.close(sourcefd)
                    os.close(destfd)
            finally:
                os.close(dest_rootfd)
        elif command == "truncate":
            flags = os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK | os.O_CLOEXEC
            if root in CREATE_ONLY_ROOTS:
                flags |= os.O_EXCL
            fd = openat2(rootfd, path, flags, 0o600)
            try:
                os.ftruncate(fd, parse_uint(values["length"], "length"))
            finally:
                os.close(fd)
        elif command == "chattr-cow":
            fd = open_existing(rootfd, path)
            try:
                subprocess.run(
                    ["/usr/bin/chattr", "+C", f"/proc/self/fd/{fd}"],
                    pass_fds=(fd,),
                    check=True,
                    stdin=subprocess.DEVNULL,
                )
            finally:
                os.close(fd)
    finally:
        os.close(rootfd)


def main(argv=None, allowed_roots=ALLOWED_ROOTS):
    if os.geteuid() != 0:
        # The capability walker runs confined as the runtime user; nothing
        # else runs without root.
        walker = sys.argv[1:] if argv is None else argv
        if walker and walker[0] == IMAGE_CAPS_WALK:
            try:
                return run_image_caps_walk_entry(walker)
            except (OSError, ValueError) as err:
                print(f"SECURITY_DENY code=image-caps-walk-failed detail={err}", file=sys.stderr)
                return 2
        print("cocalc runtime storage path helper must run as root", file=sys.stderr)
        return 1
    # sudo relays these; turning them into exceptions lets supervised
    # children be stopped instead of orphaned.
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, raise_on_signal)
    argv = sys.argv[1:] if argv is None else argv
    try:
        # These two pass the tool's own exit status through.
        if argv and argv[0] == "btrfs":
            return run_btrfs(argv[1:])
        if argv and argv[0] == "mkfs-btrfs":
            return run_mkfs_btrfs(argv)
        if argv and argv[0] == "pin-exec":
            return run_pin_exec(argv, allowed_roots)
        if argv and argv[0] == "image-caps-preflight":
            return run_image_caps_preflight(argv)
        if argv and argv[0] == "migrate-image-caps":
            return run_migrate_image_caps(argv)
        if argv and argv[0] == "_confined-exec":
            return run_confined_exec(argv)
        run(argv, allowed_roots)
        return 0
    except NormalizeRefused as err:
        print(err, file=sys.stderr)
        return 2
    except NormalizePreflightFailed as err:
        print(err, file=sys.stderr)
        return err.status
    except (OSError, ValueError, subprocess.CalledProcessError) as err:
        print(f"SECURITY_DENY code=path-helper-failed detail={err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
