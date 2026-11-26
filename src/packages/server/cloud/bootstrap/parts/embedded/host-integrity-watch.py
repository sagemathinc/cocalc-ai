#!/usr/bin/env python3
"""CoCalc project-host integrity watcher. Runs as root (systemd).

Every few seconds it checks where the processes of the runtime (service) user
and of the runtime user's subordinate uid ranges are running: inside a
container, or as one of the host's known services. A process that is neither
is reported. Every minute it also hashes a short list of host configuration
files and reports changes made outside a bootstrap run.

Results go to a root-owned status file that the project host includes in its
heartbeat, and new findings are also written to the serial console when there
is one. Findings never include command lines, environment or file contents.
"""

import argparse
import fcntl
import fnmatch
import glob
import hashlib
import json
import os
import pwd
import signal
import stat
import struct
import sys
import time

SCHEMA = "cocalc-host-integrity-v1"
VERSION = 1

# Programs are matched by their full path. A "*" matches within one path
# component and "{home}" is the runtime user's home directory; entries that are
# not absolute paths are ignored.
_PODMAN_HELPERS = (
    "conmon",
    "catatonit",
    "pasta",
    "pasta.avx2",
    "podman",
    "crun",
    "runc",
    "slirp4netns",
    "fuse-overlayfs",
    "rootlessport",
    "aardvark-dns",
    "netavark",
    "newuidmap",
    "newgidmap",
)
_PODMAN_EXES = (
    tuple("/usr/bin/" + name for name in _PODMAN_HELPERS)
    + tuple("/opt/cocalc/container-runtime/*/bin/" + name for name in _PODMAN_HELPERS)
    + ("/usr/sbin/runc", "/usr/libexec/podman/*")
)
# Programs the runtime user runs as host services (host user namespace).
DEFAULT_HOST_EXES = _PODMAN_EXES + (
    "/opt/cocalc/node/*/bin/node",
    "/opt/cocalc/tools/*/sshpiperd",
    "/opt/cocalc/tools/*/rustic",
    "/usr/local/libexec/cocalc-rustic",
    "/usr/lib/systemd/systemd",
    "/usr/lib/systemd/systemd-executor",
    "/usr/bin/sudo",
    "/usr/bin/dbus-daemon",
    "/usr/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/btrfs",
)
# Programs that belong in the container runtime's user namespace.
DEFAULT_RUNTIME_EXES = _PODMAN_EXES
# A trusted program must also be owned by root all the way up (file and every
# directory above it, none writable by group or others); otherwise it's
# reported as trusted-program-writable. Programs under these directories are
# still installed by the runtime user, so they aren't checked yet.
RUNTIME_OWNED_PROGRAM_DIRS = ("/opt/cocalc/container-runtime/", "/opt/cocalc/tools/")
# Placement rules: processes with these uids must run in one of these cgroups
# (prefixes; "{runtime_uid}" is replaced), or, with container_mount_ns_ok, in a
# mount namespace other than the host's (inside a container). "uids" is
# "runtime", "subordinate" or a list of [start, count] ranges. More rules come
# from the allowlist file's "placement_rules", e.g. for a dedicated project uid.
DEFAULT_PLACEMENT_RULES = (
    {
        "name": "runtime-user-outside-expected-cgroups",
        "severity": "high",
        "uids": "runtime",
        "allowed_cgroups": [
            "/cocalc-host-services",
            "/cocalc-project-pool",
            "/cocalc-project-startup",
            "/cocalc-maintenance",
            "/user.slice/user-{runtime_uid}.slice",
            "/system.slice/cocalc-project-host-watchdog.service",
        ],
        "container_mount_ns_ok": False,
    },
)
# Root-owned service cgroups whose scripts run as the runtime user: any program
# there is expected (the runtime user cannot move a process into them).
DEFAULT_SCRIPT_CGROUPS = ("/system.slice/cocalc-project-host-watchdog.service",)
# Container cgroups: a process in another user namespace counts as inside a
# container only in one of these and in a mount namespace of its own.
DEFAULT_CONTAINER_CGROUPS = ("/cocalc-project-pool",)
# Host configuration whose changes are reported: files, globs, and whole
# trees ("dir/**", walked without following links; a symlink is recorded by
# its target). Files up to 1 MB.
DEFAULT_CONFIG_PATHS = (
    "/etc/passwd",
    "/etc/shadow",
    "/etc/group",
    "/etc/gshadow",
    "/etc/subuid",
    "/etc/subgid",
    "/etc/sudoers",
    "/etc/sudoers.d/**",
    "/etc/ssh/sshd_config",
    "/etc/ssh/sshd_config.d/**",
    "/root/.ssh/authorized_keys",
    "/home/*/.ssh/authorized_keys",
    "/root/.bashrc",
    "/root/.profile",
    "/etc/crontab",
    "/etc/cron.d/**",
    "/var/spool/cron/crontabs/**",
    # units, drop-ins, enablement links, generators
    "/etc/systemd/system/**",
    "/usr/local/lib/systemd/system/**",
    "/etc/systemd/system-generators/**",
    "/usr/local/lib/systemd/system-generators/**",
    "/etc/rc.local",
    "/etc/init.d/**",
    "/etc/profile",
    "/etc/profile.d/**",
    "/etc/environment",
    "/etc/pam.d/**",
    "/etc/update-motd.d/**",
    "/etc/apt/apt.conf.d/**",
    "/etc/udev/rules.d/**",
    "/etc/logrotate.d/**",
    "/etc/modules",
    "/etc/modules-load.d/**",
    "/etc/modprobe.d/**",
    "/etc/network/if-up.d/**",
    "/etc/ld.so.preload",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d/**",
    "/usr/local/sbin/*",
    "/usr/local/libexec/*",
)
# Package installs and upgrades (unattended-upgrades) legitimately change many
# of these: while dpkg holds its lock, or changed its state in the last
# PACKAGE_QUIET_S seconds, the configuration is rebaselined, as during a
# bootstrap run. And a difference is reported only once two consecutive checks
# saw it with no package activity, so a file dpkg replaced just before it
# updated its state isn't reported either.
PACKAGE_QUIET_S = 600
DPKG_LOCKS = ("/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock")
MAX_TREE_ENTRIES = 5000
MAX_ABSORBED = 50

MAX_FINDINGS = 100
SEVERITY_RANK = {"critical": 0, "high": 1}
FINDING_KEEP_S = 24 * 3600
MAX_CONFIG_CHANGES = 200
# A config change is reported while its file differs from the baseline, and
# kept (no longer refreshed) for a day after that.
CONFIG_CHANGE_KEEP_S = 24 * 3600
MAX_INVENTORY = 300
MAX_CHAIN = 5
CONFIG_MAX_BYTES = 1 << 20
SERIAL_REPEAT_S = 3600
HEARTBEAT_WRITE_S = 15


def now_iso(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t if t else time.time()))


def read_text(path, limit=65536):
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return None


def read_link(path):
    try:
        return os.readlink(path)
    except OSError:
        return None


def subordinate_ranges(user, path="/etc/subuid"):
    ranges = []
    text = read_text(path) or ""
    for line in text.splitlines():
        parts = line.strip().split(":")
        if len(parts) != 3 or parts[0] != user:
            continue
        try:
            start, count = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        if count > 0:
            ranges.append((start, count))
    return ranges


def in_ranges(uid, ranges):
    return any(start <= uid < start + count for start, count in ranges)


class Proc:
    """What the rules need from one /proc/<pid>, and nothing else."""

    __slots__ = ("pid", "ppid", "comm", "uids", "exe", "userns", "mntns", "cgroup", "exe_root")

    def __init__(self, pid, ppid, comm, uids, exe, userns, cgroup, mntns=None, exe_root=None):
        self.pid = pid
        # for an executable deleted while it runs: whether the running inode
        # is root's (see exe_inode_root_owned)
        self.exe_root = exe_root
        self.ppid = ppid
        self.comm = comm
        self.uids = uids
        self.exe = exe
        self.userns = userns
        self.mntns = mntns
        self.cgroup = cgroup


def read_proc(proc_root, pid):
    base = os.path.join(proc_root, str(pid))
    status = read_text(os.path.join(base, "status"))
    if status is None:
        return None
    comm, ppid, uids = "", 0, ()
    for line in status.splitlines():
        if line.startswith("Name:"):
            comm = line.split(":", 1)[1].strip()[:64]
        elif line.startswith("PPid:"):
            try:
                ppid = int(line.split()[1])
            except (IndexError, ValueError):
                ppid = 0
        elif line.startswith("Uid:"):
            try:
                uids = tuple(int(v) for v in line.split()[1:5])
            except ValueError:
                uids = ()
    if not uids:
        return None
    exe = read_link(os.path.join(base, "exe"))
    userns = read_link(os.path.join(base, "ns", "user"))
    cgroup = ""
    text = read_text(os.path.join(base, "cgroup"), 4096) or ""
    for line in text.splitlines():
        if line.startswith("0::"):
            cgroup = line[3:][:200]
            break
    mntns = read_link(os.path.join(base, "ns", "mnt"))
    exe_root = None
    if exe and exe.endswith(" (deleted)"):
        exe_root = exe_inode_root_owned(base)
        if exe_root is None:
            return None  # exited meanwhile
    return Proc(pid, ppid, comm, uids, exe, userns, cgroup, mntns, exe_root)


def exe_inode_root_owned(proc_dir):
    """Whether the executable a process runs (the inode, also once deleted)
    is a root-owned regular file without group/other write; None if it
    can't be read (the process exited)."""
    try:
        st = os.stat(os.path.join(proc_dir, "exe"))
    except OSError:
        return None
    return stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022


def list_procs(proc_root):
    procs = {}
    try:
        names = os.listdir(proc_root)
    except OSError:
        return procs
    for name in names:
        if not name.isdigit():
            continue
        p = read_proc(proc_root, int(name))
        if p is not None:
            procs[p.pid] = p
    return procs


def userns_kind(proc_root, ns, member_pid, host_ns, runtime_uid, cache):
    """'host', 'runtime' (the container runtime's namespace: its root is the
    runtime user) or 'other' (a container, or anything else)."""
    if ns is None:
        return "unknown"
    if ns == host_ns:
        return "host"
    if ns in cache:
        return cache[ns]
    kind = "other"
    text = read_text(os.path.join(proc_root, str(member_pid), "uid_map")) or ""
    for line in text.splitlines():
        parts = line.split()
        # exactly root -> the runtime user, as rootless podman maps it
        if parts == ["0", str(runtime_uid), "1"]:
            kind = "runtime"
            break
    cache[ns] = kind
    return kind


def compile_exe_patterns(patterns, home):
    compiled = []
    for pattern in patterns:
        pattern = str(pattern).replace("{home}", home.rstrip("/"))
        if pattern.startswith("/"):
            compiled.append(pattern.split("/"))
    return compiled


def root_owned_chain(path, lstat=os.lstat):
    """True if path and every directory above it are owned by root, are not
    writable by group or others, and none is a symlink."""
    parts = [part for part in path.split("/") if part]
    if not path.startswith("/"):
        return False
    for i in range(len(parts) + 1):
        try:
            st = lstat("/" + "/".join(parts[:i]))
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            return False
    return True


def program_status(exe, patterns, cache, exe_root=None):
    """'trusted', 'writable' (an expected program whose path the runtime user
    could change) or 'unknown'. exe_root: for a deleted executable, whether
    its running inode is root's."""
    if not exe_allowed(exe, patterns):
        return "unknown"
    deleted = exe.endswith(" (deleted)")
    path = exe[: -len(" (deleted)")] if deleted else exe
    if path.startswith(RUNTIME_OWNED_PROGRAM_DIRS):
        return "trusted"
    # A binary replaced by an upgrade while it runs is gone from its path:
    # then the running inode must be root's, and the directory it ran from
    # root's all the way up.
    if deleted and not exe_root:
        return "writable"
    checked = os.path.dirname(path) if deleted else path
    if checked not in cache:
        cache[checked] = root_owned_chain(checked)
    return "trusted" if cache[checked] else "writable"


def exe_allowed(exe, patterns):
    """True if exe (as /proc/<pid>/exe shows it; a binary replaced while it
    runs reads " (deleted)") matches a pattern, component by component."""
    if not exe:
        return False
    if exe.endswith(" (deleted)"):
        exe = exe[: -len(" (deleted)")]
    parts = exe.split("/")
    return any(
        len(parts) == len(pattern)
        and all(fnmatch.fnmatchcase(a, b) for a, b in zip(parts, pattern))
        for pattern in patterns
    )


def parent_chain(procs, proc):
    chain, seen, cur = [], set(), procs.get(proc.ppid)
    while cur is not None and len(chain) < MAX_CHAIN and cur.pid not in seen:
        seen.add(cur.pid)
        chain.append(cur.comm)
        cur = procs.get(cur.ppid)
    return chain


def compile_placement_rules(rules, runtime_uid, project_ranges):
    """Rules with their uid ranges and cgroup prefixes resolved; invalid
    rules are skipped."""
    compiled = []
    for rule in rules:
        if not isinstance(rule, dict) or not rule.get("name"):
            continue
        spec = rule.get("uids")
        if spec == "runtime":
            ranges = [(runtime_uid, 1)]
        elif spec == "subordinate":
            ranges = list(project_ranges)
        elif isinstance(spec, list):
            try:
                ranges = [(int(a), int(b)) for a, b in spec]
            except (TypeError, ValueError):
                continue
        else:
            continue
        prefixes = [
            str(p).replace("{runtime_uid}", str(runtime_uid)).rstrip("/")
            for p in rule.get("allowed_cgroups", [])
        ]
        compiled.append(
            {
                "name": str(rule["name"]),
                "severity": str(rule.get("severity", "high")),
                "ranges": ranges,
                "prefixes": prefixes,
                "container_mount_ns_ok": bool(rule.get("container_mount_ns_ok")),
            }
        )
    return compiled


def root_id(proc_root, pid):
    """(device, inode) of the process's root directory, or None."""
    try:
        st = os.stat(os.path.join(proc_root, str(pid), "root"))
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def cgroup_allowed(cgroup, prefixes):
    return any(cgroup == p or cgroup.startswith(p + "/") for p in prefixes)


def placement_violation(p, rule, host_mntns):
    if not any(in_ranges(u, rule["ranges"]) for u in p.uids):
        return False
    if cgroup_allowed(p.cgroup, rule["prefixes"]):
        return False
    if rule["container_mount_ns_ok"] and p.mntns and p.mntns != host_mntns:
        return False
    return True


def evaluate(procs, proc_root, host_ns, runtime_uid, project_ranges, host_exes,
             runtime_exes, self_pid, placement_rules=(), host_mntns=None,
             script_cgroups=(), container_cgroups=()):
    """Returns (findings, inventory keys) for one scan. A finding is a dict
    without any command line, environment or file content."""
    findings, inventory, cache, chains = [], [], {}, {}
    host_root = root_id(proc_root, 1)

    def finding(p, rule, severity, kind):
        return {
            "rule": rule,
            "severity": severity,
            "pid": p.pid,
            "comm": p.comm,
            "exe": p.exe or "",
            "uids": list(p.uids),
            "userns": kind,
            "parents": parent_chain(procs, p),
            "cgroup": p.cgroup,
        }

    for p in procs.values():
        if p.pid == self_pid:
            continue
        for rule in placement_rules:
            if placement_violation(p, rule, host_mntns):
                kind = userns_kind(
                    proc_root, p.userns, p.pid, host_ns, runtime_uid, cache
                )
                findings.append(finding(p, rule["name"], rule["severity"], kind))
        runtime = runtime_uid in p.uids
        project = any(in_ranges(u, project_ranges) for u in p.uids)
        if not runtime and not project:
            continue
        kind = userns_kind(proc_root, p.userns, p.pid, host_ns, runtime_uid, cache)
        if (
            kind == "other"
            and p.mntns
            and p.mntns != host_mntns
            and cgroup_allowed(p.cgroup, container_cgroups)
            and root_id(proc_root, p.pid) not in (None, host_root)
        ):
            continue  # inside a container (its own root, not the host's)
        # Anything else is checked as a host process: a user namespace
        # alone (e.g. one made by the runtime user) doesn't contain it.
        inventory.append(
            "%s|%s|%s" % (kind, "project" if project else "runtime", p.exe or "?")
        )
        rule = None
        if project:
            rule, severity = "project-uid-outside-container", "critical"
        elif kind == "runtime":
            status = program_status(p.exe, runtime_exes, chains, p.exe_root)
            if status == "unknown":
                rule, severity = "unexpected-process-in-container-runtime", "critical"
            elif status == "writable":
                rule, severity = "trusted-program-writable", "high"
        elif not cgroup_allowed(p.cgroup, script_cgroups):
            status = program_status(p.exe, host_exes, chains, p.exe_root)
            if status == "unknown":
                rule, severity = "unexpected-runtime-user-process", "high"
            elif status == "writable":
                rule, severity = "trusted-program-writable", "high"
        if rule is None:
            continue
        findings.append(finding(p, rule, severity, kind))
    return findings, inventory


def tree_entries(top):
    """(entries, total, rest): files and symlinks under top (not following
    links), the first MAX_TREE_ENTRIES of them, how many there are, and a
    digest of the others' metadata (path, size, mtime, ctime, mode, owner,
    group, link target), so a change past the cap still shows. ([top], 1, "") if top
    doesn't exist (so its creation shows)."""
    if not os.path.isdir(top) or os.path.islink(top):
        return [top], 1, ""
    entries, total, rest = [], 0, hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames.sort()
        for name in sorted(filenames) + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]:
            total += 1
            path = os.path.join(dirpath, name)
            if len(entries) < MAX_TREE_ENTRIES:
                entries.append(path)
                continue
            try:
                st = os.lstat(path)
                link = read_link(path) if stat.S_ISLNK(st.st_mode) else ""
                rest.update(
                    (
                        "%s\0%d\0%d\0%d\0%o\0%d\0%d\0%s\n"
                        % (path, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_uid, st.st_gid, link)
                    ).encode()
                )
            except OSError:
                rest.update(("%s\0gone\n" % path).encode())
    return entries, total, rest.hexdigest()


def hash_config(patterns):
    digests = {}
    for pattern in patterns:
        if pattern.endswith("/**"):
            tops = sorted(glob.glob(pattern[:-3])) if any(c in pattern[:-3] for c in "*?[") else [pattern[:-3]]
            for top in tops:
                # the directories themselves: who owns them and who may
                # write them (not mtime: entries added or removed show anyway)
                if os.path.isdir(top) and not os.path.islink(top):
                    for dirpath, _dirnames, _filenames in os.walk(top):
                        try:
                            st = os.lstat(dirpath)
                        except OSError:
                            continue
                        digests[dirpath.rstrip("/") + "/"] = "dir:%o:%d:%d" % (
                            st.st_mode,
                            st.st_uid,
                            st.st_gid,
                        )
                entries, total, rest = tree_entries(top)
                for path in entries:
                    if path == top and not os.path.exists(top):
                        digests[path] = "missing"
                    else:
                        digests.update(hash_config([path]))
                if total > len(entries):
                    # entries past the cap still count
                    digests[top + "/**"] = "truncated:%d:%s" % (total, rest)
            continue
        matches = sorted(glob.glob(pattern)) if any(c in pattern for c in "*?[") else [pattern]
        for path in matches:
            try:
                st = os.lstat(path)
            except OSError:
                if path == pattern:
                    digests[path] = "missing"
                continue
            if not os.path.isfile(path) or os.path.islink(path):
                digests[path] = "link:%s" % (read_link(path) or "") if os.path.islink(path) else "special"
                continue
            if st.st_size > CONFIG_MAX_BYTES:
                digests[path] = "size:%d" % st.st_size
                continue
            try:
                with open(path, "rb") as f:
                    digests[path] = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                digests[path] = "unreadable"
    return digests


def bootstrap_busy(state_path, now, quiet_s=300, max_operation_s=3 * 3600):
    """True while a bootstrap operation runs, or finished in the last quiet_s
    seconds (its writes to host configuration are expected). An operation
    recorded as running for longer than max_operation_s (e.g. a bootstrap
    killed before it recorded the result) no longer counts."""
    if not state_path:
        return False
    try:
        st = os.stat(state_path)
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        return False
    age = now - st.st_mtime
    if state.get("current_operation"):
        return age < max_operation_s
    return age < quiet_s


def lock_held(path):
    """True if another process holds an fcntl lock on path (as dpkg and apt
    do on their locks). Only queries (F_GETLK): never takes the lock."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOCTTY)
    except OSError:
        return False
    try:
        query = struct.pack("hhqqi4x", fcntl.F_WRLCK, os.SEEK_SET, 0, 0, 0)
        answer = fcntl.fcntl(fd, fcntl.F_GETLK, query)
        return struct.unpack("hhqqi4x", answer)[0] != fcntl.F_UNLCK
    except OSError:
        return False
    finally:
        os.close(fd)


def packages_busy(state_path, now, quiet_s=PACKAGE_QUIET_S):
    """True while dpkg holds its lock, or if it changed its state in the last
    quiet_s seconds (a package install or upgrade, which writes host
    configuration)."""
    if not state_path:
        return False
    if any(lock_held(path) for path in DPKG_LOCKS):
        return True
    try:
        return now - os.stat(state_path).st_mtime < quiet_s
    except OSError:
        return False


class Watcher:
    def __init__(self, args):
        self.args = args
        self.proc_root = args.proc
        pw = pwd.getpwnam(args.runtime_user)
        self.runtime_uid = pw.pw_uid
        self.project_ranges = subordinate_ranges(args.runtime_user, args.subuid)
        allow = self.load_allowlist(args.allowlist)
        self.host_exes = compile_exe_patterns(
            list(DEFAULT_HOST_EXES) + list(allow.get("host_exes", [])), pw.pw_dir
        )
        self.runtime_exes = compile_exe_patterns(
            list(DEFAULT_RUNTIME_EXES) + list(allow.get("runtime_exes", [])), pw.pw_dir
        )
        self.config_paths = list(DEFAULT_CONFIG_PATHS) + list(allow.get("config_paths", []))
        self.script_cgroups = [
            str(c).rstrip("/")
            for c in list(DEFAULT_SCRIPT_CGROUPS) + list(allow.get("script_cgroups", []))
        ]
        self.container_cgroups = [
            str(c).rstrip("/")
            for c in list(DEFAULT_CONTAINER_CGROUPS) + list(allow.get("container_cgroups", []))
        ]
        self.placement_rules = compile_placement_rules(
            list(DEFAULT_PLACEMENT_RULES) + list(allow.get("placement_rules", [])),
            self.runtime_uid,
            self.project_ranges,
        )
        self.findings = {}
        self.inventory = {}
        # The configuration baseline and its changes survive restarts (a change
        # made while the watcher was stopped is still a change); only bootstrap
        # and SIGHUP set a new baseline.
        self.config_state_path = os.path.join(args.status_dir, "config-state.json")
        self.config_changes = {}
        self.config_baseline = None
        self.config_baseline_at = None
        self.config_state_written = None
        # differences seen at the last check, not yet reported
        self.config_pending = set()
        # files a package run changed, accepted into the baseline: path -> when
        self.config_absorbed = {}
        self.load_config_state()
        self.started_at = time.time()
        self.scans = 0
        self.errors = 0
        self.last_scan_ms = 0
        self.last_write = 0.0
        self.last_config = 0.0
        self.rebaseline = False
        self.serial_sent = {}

    @staticmethod
    def load_allowlist(path):
        if not path:
            return {}
        try:
            with open(path) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def load_config_state(self):
        try:
            with open(self.config_state_path) as f:
                state = json.load(f)
            baseline = state["baseline"]
            changes = state.get("changes", {})
            if not isinstance(baseline, dict) or not isinstance(changes, dict):
                return
        except (OSError, ValueError, KeyError, TypeError):
            return
        self.config_baseline = {str(k): str(v) for k, v in baseline.items()}
        self.config_baseline_at = state.get("baseline_at")
        self.config_changes = {
            str(path): entry
            for path, entry in changes.items()
            if isinstance(entry, dict) and isinstance(entry.get("last_seen"), str)
        }
        absorbed = state.get("absorbed", {})
        if isinstance(absorbed, dict):
            self.config_absorbed = {
                str(path): at for path, at in absorbed.items() if isinstance(at, str)
            }

    def save_config_state(self):
        text = json.dumps(
            {
                "baseline": self.config_baseline,
                "baseline_at": self.config_baseline_at,
                "changes": self.config_changes,
                "absorbed": self.config_absorbed,
            },
            sort_keys=True,
        )
        if text == self.config_state_written:
            return
        os.makedirs(self.args.status_dir, mode=0o755, exist_ok=True)
        tmp = self.config_state_path + ".%d.tmp" % os.getpid()
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, self.config_state_path)
        self.config_state_written = text

    def host_ns(self):
        return read_link(os.path.join(self.proc_root, "1", "ns", "user"))

    def scan(self, now):
        started = time.monotonic()
        procs = list_procs(self.proc_root)
        found, inventory = evaluate(
            procs,
            self.proc_root,
            self.host_ns(),
            self.runtime_uid,
            self.project_ranges,
            self.host_exes,
            self.runtime_exes,
            os.getpid(),
            self.placement_rules,
            read_link(os.path.join(self.proc_root, "1", "ns", "mnt")),
            self.script_cgroups,
            self.container_cgroups,
        )
        self.scans += 1
        self.last_scan_ms = int((time.monotonic() - started) * 1000)
        for key in inventory:
            if key in self.inventory or len(self.inventory) < MAX_INVENTORY:
                self.inventory[key] = self.inventory.get(key, 0) + 1
        new = []
        for f in found:
            key = "%s|%s|%s|%s" % (f["rule"], f["userns"], f["exe"], f["uids"][0])
            entry = self.findings.get(key)
            if entry is None:
                entry = dict(f, first_seen=now_iso(now), count=0)
                self.findings[key] = entry
                new.append(entry)
            entry.update(f, last_seen=now_iso(now))
            entry["count"] += 1
        # A finding not seen for a day is dropped; past the cap, the least
        # severe go first, and the oldest of a severity before newer ones.
        expired = now_iso(now - FINDING_KEEP_S)
        for key in [k for k, f in self.findings.items() if f["last_seen"] < expired]:
            del self.findings[key]
        if len(self.findings) > MAX_FINDINGS:
            def eviction_order(key):
                f = self.findings[key]
                return (-SEVERITY_RANK.get(f["severity"], 2), f["last_seen"])

            ordered = sorted(self.findings, key=eviction_order)
            for key in ordered[: len(self.findings) - MAX_FINDINGS]:
                del self.findings[key]
        return new

    def check_config(self, now):
        """Reports files that differ from the baseline. A change stays current
        (last_seen refreshed) while its file differs; once repaired or
        accepted by a new baseline it is kept a day as history."""
        digests = hash_config(self.config_paths)
        new, differ = [], set()
        if (
            self.config_baseline is None
            or self.rebaseline
            or bootstrap_busy(self.args.bootstrap_state, now)
        ):
            self.config_baseline = digests
            self.config_baseline_at = now_iso(now)
            self.rebaseline = False
            self.config_pending = set()
        elif packages_busy(getattr(self.args, "package_state", ""), now):
            # A package run: what changed becomes the baseline (recorded as
            # absorbed), except files already reported, which stay reported.
            active = {p for p, e in self.config_changes.items() if e.get("current")}
            changed = {
                path
                for path in set(digests) | set(self.config_baseline)
                if digests.get(path) != self.config_baseline.get(path)
            }
            for path in changed - active:
                if path in digests:
                    self.config_baseline[path] = digests[path]
                else:
                    self.config_baseline.pop(path, None)
                self.config_absorbed[path] = now_iso(now)
            for path in sorted(self.config_absorbed, key=self.config_absorbed.get)[
                : max(0, len(self.config_absorbed) - MAX_ABSORBED)
            ]:
                del self.config_absorbed[path]
            differ = changed & active
            self.config_pending = set()
        else:
            seen = {
                path
                for path in set(digests) | set(self.config_baseline)
                if digests.get(path) != self.config_baseline.get(path)
            }
            # A new difference counts once the previous check saw it too.
            differ = {
                path
                for path in seen
                if path in self.config_pending
                or self.config_changes.get(path, {}).get("current")
            }
            self.config_pending = seen
        for path in sorted(differ):
            entry = self.config_changes.get(path)
            if entry is None or not entry.get("current"):
                # new, or changed again after it was repaired
                entry = {
                    "rule": "host-config-changed",
                    "severity": "high",
                    "path": path,
                    "first_seen": now_iso(now),
                }
                self.config_changes[path] = entry
                new.append(entry)
            entry["current"] = True
            entry["last_seen"] = now_iso(now)
        for path, entry in self.config_changes.items():
            if path not in differ:
                entry["current"] = False
        expired = now_iso(now - CONFIG_CHANGE_KEEP_S)
        ordered = sorted(
            self.config_changes, key=lambda p: self.config_changes[p]["last_seen"]
        )
        for path in ordered[: max(0, len(ordered) - MAX_CONFIG_CHANGES)]:
            del self.config_changes[path]
        for path in list(self.config_changes):
            if self.config_changes[path]["last_seen"] < expired:
                del self.config_changes[path]
        self.save_config_state()
        return new

    def serial(self, entries, now):
        """Best effort: one line per new finding (at most hourly per key) on
        the serial console, which the cloud keeps off the host."""
        path = self.args.serial
        if not path or not entries or not os.path.exists(path):
            return
        lines = []
        for e in entries:
            key = "%s|%s|%s" % (e.get("rule"), e.get("exe", ""), e.get("path", ""))
            if key in self.serial_sent and now - self.serial_sent[key] < SERIAL_REPEAT_S:
                continue
            self.serial_sent[key] = now
            short = {k: e.get(k) for k in ("rule", "severity", "exe", "uids", "userns", "path") if k in e}
            lines.append("COCALC-HOST-INTEGRITY %s %s\n" % (now_iso(now), json.dumps(short, sort_keys=True)))
        if not lines:
            return
        try:
            fd = os.open(path, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
            try:
                os.write(fd, "".join(lines).encode()[:4096])
            finally:
                os.close(fd)
        except OSError:
            pass

    def status(self, now):
        return {
            "schema": SCHEMA,
            "version": VERSION,
            "started_at": now_iso(self.started_at),
            "heartbeat_at": now_iso(now),
            "scans": self.scans,
            "last_scan_ms": self.last_scan_ms,
            "errors": self.errors,
            "runtime_uid": self.runtime_uid,
            "project_uid_ranges": [list(r) for r in self.project_ranges],
            "placement_rules": [r["name"] for r in self.placement_rules],
            "findings": sorted(self.findings.values(), key=lambda e: e["last_seen"], reverse=True),
            "config": {
                "baseline_at": self.config_baseline_at,
                "files": len(self.config_baseline or {}),
                "changes": sorted(
                    self.config_changes.values(),
                    key=lambda e: (e["last_seen"], e["first_seen"]),
                    reverse=True,
                ),
                "change_count": len(self.config_changes),
                # accepted during package runs (not reported as changes)
                "absorbed": [
                    {"path": path, "at": at}
                    for path, at in sorted(
                        self.config_absorbed.items(), key=lambda kv: kv[1], reverse=True
                    )
                ],
            },
            "inventory": dict(
                sorted(self.inventory.items(), key=lambda kv: kv[1], reverse=True)
            ),
        }

    def write_status(self, now):
        directory = self.args.status_dir
        os.makedirs(directory, mode=0o755, exist_ok=True)
        os.chmod(directory, 0o755)
        tmp = os.path.join(directory, ".status.%d.tmp" % os.getpid())
        with open(tmp, "w") as f:
            json.dump(self.status(now), f, sort_keys=True)
        os.chmod(tmp, 0o644)
        os.replace(tmp, os.path.join(directory, "status.json"))
        self.last_write = now

    def step(self, now):
        new = []
        try:
            new += self.scan(now)
            if now - self.last_config >= self.args.config_interval or self.rebaseline:
                self.last_config = now
                new += self.check_config(now)
        except Exception:  # keep watching; the error count is reported
            self.errors += 1
        if new or now - self.last_write >= HEARTBEAT_WRITE_S:
            try:
                self.write_status(now)
            except OSError:
                self.errors += 1
        self.serial(new, now)
        return new


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--runtime-user", required=True)
    parser.add_argument("--status-dir", default="/var/lib/cocalc-host-integrity")
    parser.add_argument("--proc", default="/proc")
    parser.add_argument("--subuid", default="/etc/subuid")
    parser.add_argument("--allowlist", default="/etc/cocalc/host-integrity-allowlist.json")
    parser.add_argument("--bootstrap-state", default="")
    parser.add_argument("--package-state", default="/var/lib/dpkg/status")
    parser.add_argument("--serial", default="/dev/ttyS0")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--config-interval", type=float, default=60.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    watcher = Watcher(args)

    def on_hup(_sig, _frame):
        watcher.rebaseline = True

    signal.signal(signal.SIGHUP, on_hup)
    while True:
        now = time.time()
        watcher.step(now)
        if args.once:
            watcher.write_status(now)
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
