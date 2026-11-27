import collections
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import time

MAX_ITEMS = 500
MAX_PERSISTENCE_FILES = 500
MAX_OUTPUT_BYTES = 500 * 1024
COLLECTOR_DEADLINE = time.monotonic() + 105
PERSISTENCE_ROOTS = [
    "/etc/systemd/system",
    "/usr/local/lib/systemd/system",
    "/etc/cron.d",
    "/etc/cron.daily",
    "/etc/cron.hourly",
    "/etc/cron.weekly",
    "/etc/cron.monthly",
    "/etc/crontab",
    "/var/spool/cron/crontabs",
    "/etc/sudoers.d",
    "/etc/rc.local",
    "/etc/ld.so.preload",
    "/etc/profile",
    "/etc/profile.d",
    "/etc/modules",
    "/etc/modules-load.d",
    "/etc/modprobe.d",
    "/etc/network/if-up.d",
    "/etc/init.d",
    "/root/.ssh/authorized_keys",
    "/root/.bashrc",
    "/root/.profile",
    "/home/ubuntu/.ssh/authorized_keys",
    "/home/ubuntu/.bashrc",
    "/home/ubuntu/.profile",
    "/etc/ssh/sshd_config",
    "/etc/ssh/sshd_config.d",
]
PRIVILEGED_ROOTS = [
    path
    for path in ["/usr", "/opt", "/etc"]
    if os.path.exists(path)
]
issues = []
truncated = {}


def clean(value, limit=1000):
    text = str(value)
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", "?", text)
    return text[:limit]


def issue(section, code):
    if len(issues) >= 100:
        truncated["issues"] = True
        return
    section = clean(section, 64)
    code = clean(code, 64)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", section):
        section = "collector"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", code):
        code = "FAILED"
    issues.append({"section": section, "code": code})


def run(section, args, timeout=30, max_lines=MAX_ITEMS):
    remaining = COLLECTOR_DEADLINE - time.monotonic()
    if remaining <= 0:
        issue(section, "DEADLINE_EXCEEDED")
        return []
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=min(timeout, max(0.1, remaining)),
            check=False,
        )
    except subprocess.TimeoutExpired:
        issue(section, "TIMEOUT")
        return []
    except Exception:
        issue(section, "EXEC_FAILED")
        return []
    if result.returncode != 0:
        issue(section, f"EXIT_{result.returncode}")
    lines = [clean(line) for line in result.stdout.splitlines() if line.strip()]
    if len(lines) > max_lines:
        truncated[section] = True
    return lines[:max_lines]


def read_text(path, limit=64 * 1024):
    try:
        with open(path, "rb") as handle:
            return handle.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""


def read_link(path):
    try:
        return os.readlink(path)
    except OSError:
        return ""


def status_value(text, key):
    match = re.search(rf"^{re.escape(key)}:\s+(.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else ""


def file_record(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    record = {
        "path": clean(path),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": f"{stat.S_IMODE(info.st_mode):04o}",
        "mtime": datetime.datetime.fromtimestamp(
            info.st_mtime, datetime.timezone.utc
        ).isoformat(),
        "size": info.st_size,
        "type": "symlink" if stat.S_ISLNK(info.st_mode) else "file",
    }
    if stat.S_ISLNK(info.st_mode):
        try:
            target = os.readlink(path)
            checked = os.lstat(path)
            if (
                not stat.S_ISLNK(checked.st_mode)
                or checked.st_dev != info.st_dev
                or checked.st_ino != info.st_ino
            ):
                issue("persistence", "FILE_CHANGED")
                return record
            record["link_target"] = clean(target)
        except OSError:
            issue("persistence", "READLINK_FAILED")
    if stat.S_ISREG(info.st_mode) and info.st_size <= 1024 * 1024:
        descriptor = None
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or (
                opened.st_dev != info.st_dev or opened.st_ino != info.st_ino
            ):
                issue("persistence", "FILE_CHANGED")
                return record
            digest = hashlib.sha256()
            with os.fdopen(descriptor, "rb") as handle:
                descriptor = None
                for chunk in iter(lambda: handle.read(128 * 1024), b""):
                    digest.update(chunk)
            record["sha256"] = digest.hexdigest()
        except OSError:
            issue("persistence", "HASH_FAILED")
        finally:
            if descriptor is not None:
                os.close(descriptor)
    return record


def collect_persistence():
    paths = set()
    limit_reached = False
    for root in PERSISTENCE_ROOTS:
        if os.path.isfile(root) or os.path.islink(root):
            paths.add(root)
            continue
        if not os.path.isdir(root):
            continue
        for current, directories, files in os.walk(root, followlinks=False):
            directories[:] = sorted(directories)
            for name in sorted(files):
                paths.add(os.path.join(current, name))
                if len(paths) >= MAX_PERSISTENCE_FILES:
                    limit_reached = True
                    break
            if limit_reached:
                break
        if limit_reached:
            break
    records = [file_record(path) for path in sorted(paths)]
    return [record for record in records if record is not None], limit_reached


def collect_accounts():
    uid_zero = []
    interactive = []
    for entry in pwd.getpwall():
        record = {
            "name": clean(entry.pw_name, 128),
            "uid": entry.pw_uid,
            "gid": entry.pw_gid,
            "home": clean(entry.pw_dir),
            "shell": clean(entry.pw_shell),
        }
        if entry.pw_uid == 0:
            uid_zero.append(record)
        if entry.pw_uid >= 1000 and entry.pw_shell not in ("/usr/sbin/nologin", "/bin/false"):
            interactive.append(record)
    return {"uid_zero": uid_zero, "interactive": interactive}


def process_cgroup(proc):
    for line in read_text(proc / "cgroup", 16384).splitlines():
        fields = line.split(":", 2)
        if len(fields) != 3 or fields[0] != "0" or fields[1]:
            continue
        path = clean(fields[2], 512)
        return re.sub(
            r"^/cocalc-backup-browsers/browser-[0-9]+$",
            "/cocalc-backup-browsers/browser-*",
            path,
        )
    return ""


def collect_processes():
    host_mnt = read_link("/proc/1/ns/mnt")
    host_user = read_link("/proc/1/ns/user")
    records = []
    scanned = 0
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        scanned += 1
        status_text = read_text(proc / "status")
        uid_fields = status_value(status_text, "Uid").split()
        uid = int(uid_fields[0]) if uid_fields else -1
        same_mount_namespace = read_link(proc / "ns/mnt") == host_mnt
        same_user_namespace = read_link(proc / "ns/user") == host_user
        if uid != 0 and not (same_mount_namespace and same_user_namespace):
            continue
        exe = read_link(proc / "exe")
        if not exe:
            continue
        comm = clean(read_text(proc / "comm", 256).strip(), 64) or "[unknown]"
        capability_mask = clean(status_value(status_text, "CapEff"), 32)
        target = exe.removesuffix(" (deleted)")
        executable_uid = None
        executable_mode = None
        try:
            info = os.stat(target)
            executable_uid = info.st_uid
            executable_mode = f"{stat.S_IMODE(info.st_mode):04o}"
        except OSError:
            pass
        flags = []
        if uid == 0 and not same_mount_namespace:
            flags.append("root-with-isolated-mount-namespace")
        if uid == 0 and not same_user_namespace:
            flags.append("root-with-isolated-user-namespace")
        if exe.endswith(" (deleted)"):
            flags.append("deleted-executable")
        if exe.startswith("memfd:") or "/memfd:" in exe:
            flags.append("memfd-executable")
        if exe.startswith(("/tmp/", "/var/tmp/", "/dev/shm/")):
            flags.append("temporary-executable")
        if uid == 0 and exe.startswith(("/home/", "/mnt/cocalc/")):
            flags.append("root-from-writable-tree")
        if uid == 0 and executable_uid not in (None, 0):
            flags.append("root-executable-not-owned-by-root")
        if executable_mode is not None and int(executable_mode, 8) & 0o022:
            flags.append("executable-group-or-world-writable")
        records.append(
            {
                "pid": int(proc.name),
                "uid": uid,
                "comm": comm,
                "exe": clean(exe),
                "capability_mask": capability_mask,
                "executable_uid": executable_uid,
                "executable_mode": executable_mode,
                "cgroup": process_cgroup(proc),
                "flags": flags,
            }
        )
    grouped = collections.Counter(
        (
            record["uid"],
            record["comm"],
            record["exe"],
            record["capability_mask"],
            record["executable_uid"],
            record["executable_mode"],
            record["cgroup"],
        )
        for record in records
    )
    summary = []
    for key, count in sorted(grouped.items(), key=lambda item: (-item[1], item[0])):
        item = {
            "count": count,
            "uid": key[0],
            "comm": key[1],
            "exe": key[2],
            "capability_mask": key[3],
        }
        if key[4] is not None:
            item["executable_uid"] = key[4]
        if key[5] is not None:
            item["executable_mode"] = key[5]
        if key[6]:
            item["cgroup"] = key[6]
        summary.append(item)
    findings = []
    for record in records:
        if not record["flags"]:
            continue
        finding = {key: value for key, value in record.items() if value is not None}
        findings.append(finding)
    return {
        "scanned_process_count": scanned,
        "process_count": len(records),
        "summary": summary[:MAX_ITEMS],
        "findings": findings[:MAX_ITEMS],
    }, {record["pid"] for record in records}


def socket_endpoint(value):
    value = value.strip()
    if value.startswith("["):
        closing = value.rfind("]:")
        if closing >= 0:
            return value[1:closing], value[closing + 2:]
    host, separator, port = value.rpartition(":")
    return (host, port) if separator else (value, "")


def is_loopback_host(host):
    candidate = host.split("%", 1)[0]
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return candidate == "localhost"


def established_endpoints(fields):
    # `ss ... state established` normally omits the state column, while some
    # versions retain it. In both forms endpoints follow the queue columns.
    offset = 0 if fields and fields[0].isdigit() else 1
    local_index = offset + 2
    peer_index = offset + 3
    if len(fields) <= peer_index:
        return None
    return fields[local_index], fields[peer_index]


def parse_listener_lines(listener_lines, host_pids):
    listener_counts = collections.Counter()
    listening_ports = set()
    for line in listener_lines:
        pid_match = re.search(r"pid=(\d+)", line)
        if pid_match and int(pid_match.group(1)) not in host_pids:
            continue
        fields = line.split()
        if len(fields) < 6:
            continue
        process_match = re.search(r'users:\(\("([^\"]+)\"', line)
        process = clean(process_match.group(1), 128) if process_match else "unattributed"
        local = clean(fields[4], 256)
        listener_counts[(clean(fields[0], 16), process, local)] += 1
        listening_ports.add(local.rsplit(":", 1)[-1])
    return listener_counts, listening_ports


def collect_network(host_pids):
    listener_lines = run("network_listeners", ["/usr/bin/ss", "-H", "-lntup"], max_lines=5000)
    listener_counts, listening_ports = parse_listener_lines(listener_lines, host_pids)
    if any(key[1] == "unattributed" for key in listener_counts):
        # ss can observe a pasta forwarding socket while its owning process is
        # exiting, after the users/PID metadata has already disappeared. Use a
        # second complete sample so persistent unattributed sockets remain
        # visible while teardown races do not become security alerts.
        time.sleep(0.2)
        listener_lines = run(
            "network_listeners_resample",
            ["/usr/bin/ss", "-H", "-lntup"],
            max_lines=5000,
        )
        listener_counts, listening_ports = parse_listener_lines(listener_lines, host_pids)
    listeners = [
        {"count": count, "protocol": key[0], "process": key[1], "local": key[2]}
        for key, count in listener_counts.most_common(200)
    ]
    if len(listener_counts) > len(listeners):
        truncated["network_listeners"] = True

    connection_lines = run(
        "network_established",
        ["/usr/bin/ss", "-H", "-tanp", "state", "established"],
        max_lines=5000,
    )
    connection_counts = collections.Counter()
    for line in connection_lines:
        pid_match = re.search(r"pid=(\d+)", line)
        if not pid_match or int(pid_match.group(1)) not in host_pids:
            continue
        fields = line.split()
        endpoints = established_endpoints(fields)
        if endpoints is None:
            continue
        process_match = re.search(r'users:\(\("([^\"]+)\"', line)
        process = clean(process_match.group(1), 128) if process_match else "unknown"
        local, peer = endpoints
        _local_host, local_port = socket_endpoint(local)
        peer_host, peer_port = socket_endpoint(peer)
        if is_loopback_host(peer_host):
            continue
        normalized_peer = peer_host if local_port in listening_ports else f"{peer_host}:{peer_port}"
        connection_counts[(process, clean(local_port, 16), clean(normalized_peer, 256))] += 1
    established = [
        {"count": count, "process": key[0], "local_port": key[1], "peer": key[2]}
        for key, count in connection_counts.most_common(200)
    ]
    if len(connection_counts) > len(established):
        truncated["network_established"] = True
    return {"listeners": listeners, "established": established}


def snap_mount_unit(name, revision):
    # systemd path escaping uses '-' as the path separator, so literal hyphens
    # in snap names are escaped in generated mount unit names.
    escaped_name = name.replace("-", "\\x2d")
    return f"snap-{escaped_name}-{revision}.mount"


def mountinfo_path(value):
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def collect_loop_mount_backing_files(
    mountinfo_file="/proc/self/mountinfo",
    sys_dev_root="/sys/dev/block",
):
    backing_files = {}
    for line in read_text(mountinfo_file, 4 * 1024 * 1024).splitlines():
        fields = line.split()
        try:
            separator = fields.index("-")
        except ValueError:
            continue
        if (
            len(fields) <= separator + 2
            or len(fields) < 5
            or fields[separator + 1] != "squashfs"
            or not re.fullmatch(r"[0-9]+:[0-9]+", fields[2])
        ):
            continue
        backing_file = read_text(
            pathlib.Path(sys_dev_root) / fields[2] / "loop" / "backing_file",
            4096,
        ).strip()
        if not backing_file:
            continue
        if not backing_file.startswith("/"):
            backing_file = f"/{backing_file}"
        backing_files[os.path.normpath(mountinfo_path(fields[4]))] = os.path.normpath(
            backing_file
        )
    return backing_files


def parse_systemd_unit(text):
    sections = {}
    current = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        section_match = re.fullmatch(r"\[([A-Za-z]+)\]", line)
        if section_match:
            current = section_match.group(1)
            sections.setdefault(current, [])
            continue
        if current is None or line.endswith("\\") or "=" not in line:
            return None
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key):
            return None
        sections[current].append((key, value))
    return sections


def verified_snap_mount_unit(
    unit_path,
    name,
    revision,
    backing_image,
    revision_directory,
    systemd_root,
):
    try:
        info = unit_path.lstat()
    except OSError:
        return False
    if (
        info.st_uid != 0
        or info.st_gid != 0
        or not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o644
        or info.st_size > 16 * 1024
    ):
        return False
    sections = parse_systemd_unit(read_text(unit_path, 16 * 1024))
    expected = {
        "Unit": collections.Counter(
            [
                ("Description", f"Mount unit for {name}, revision {revision}"),
                ("After", "snapd.mounts-pre.target"),
                ("Before", "snapd.mounts.target"),
            ]
        ),
        "Mount": collections.Counter(
            [
                ("What", os.path.normpath(backing_image)),
                ("Where", os.path.normpath(revision_directory)),
                ("Type", "squashfs"),
                ("Options", "nodev,ro,x-gdu.hide,x-gvfs-hide"),
                ("LazyUnmount", "yes"),
            ]
        ),
        "Install": collections.Counter(
            [
                ("WantedBy", "snapd.mounts.target"),
                ("WantedBy", "multi-user.target"),
            ]
        ),
    }
    if sections is None or set(sections) != set(expected):
        return False
    if any(
        collections.Counter(sections[key]) != value
        for key, value in expected.items()
    ):
        return False
    for wants in ("multi-user.target.wants", "snapd.mounts.target.wants"):
        link = pathlib.Path(systemd_root) / wants / unit_path.name
        try:
            link_info = link.lstat()
        except OSError:
            return False
        if (
            link_info.st_uid != 0
            or link_info.st_gid != 0
            or not stat.S_ISLNK(link_info.st_mode)
            or stat.S_IMODE(link_info.st_mode) != 0o777
            or os.path.normpath(read_link(link)) != os.path.normpath(unit_path)
        ):
            return False
    return True


def collect_snap_mount_units(
    snap_root="/snap",
    snap_state_root="/var/lib/snapd/snaps",
    mountinfo_file="/proc/self/mountinfo",
    sys_dev_root="/sys/dev/block",
    systemd_root="/etc/systemd/system",
):
    units = []
    backing_files = collect_loop_mount_backing_files(mountinfo_file, sys_dev_root)
    try:
        snap_directories = sorted(pathlib.Path(snap_root).iterdir())
    except OSError:
        return units
    for snap_directory in snap_directories:
        name = snap_directory.name
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
            continue
        try:
            revision_directories = sorted(snap_directory.iterdir())
        except OSError:
            continue
        for revision_directory in revision_directories:
            revision = revision_directory.name
            if not re.fullmatch(r"[1-9][0-9]*", revision):
                continue
            backing_image = pathlib.Path(snap_state_root) / f"{name}_{revision}.snap"
            if backing_files.get(os.path.normpath(revision_directory)) != os.path.normpath(
                backing_image
            ):
                continue
            try:
                info = backing_image.lstat()
            except OSError:
                continue
            if (
                info.st_uid != 0
                or info.st_gid != 0
                or not stat.S_ISREG(info.st_mode)
                or stat.S_IMODE(info.st_mode) & 0o022
            ):
                continue
            unit = snap_mount_unit(name, revision)
            if not verified_snap_mount_unit(
                pathlib.Path(systemd_root) / unit,
                name,
                revision,
                backing_image,
                revision_directory,
                systemd_root,
            ):
                continue
            units.append(unit)
    return sorted(set(units))[:MAX_ITEMS]


def collect_authentication():
    lines = run(
        "authentication",
        ["/usr/bin/journalctl", "--since", "7 days ago", "-n", "20000", "-u", "ssh", "-u", "sshd", "--no-pager", "-o", "cat"],
        timeout=60,
        max_lines=20000,
    )
    accepted = collections.Counter()
    failed = 0
    invalid = 0
    for line in lines:
        match = re.search(r"Accepted (\S+) for (\S+) from ([^ ]+)", line)
        if match:
            accepted[(clean(match.group(1), 32), clean(match.group(2), 128), clean(match.group(3), 128))] += 1
        if "Failed password" in line or "Failed publickey" in line:
            failed += 1
        if "Invalid user" in line:
            invalid += 1
    accepted_records = [
        {"count": count, "method": key[0], "user": key[1], "source": key[2]}
        for key, count in accepted.most_common(100)
    ]
    return {"accepted": accepted_records, "failed": failed, "invalid_user": invalid}


def collect_kernel_signals():
    lines = run(
        "kernel_signals",
        ["/usr/bin/journalctl", "-k", "--since", "7 days ago", "-n", "20000", "--no-pager", "-o", "cat"],
        timeout=60,
        max_lines=20000,
    )
    patterns = {
        "apparmor_denied": re.compile(r"apparmor.*denied", re.I),
        "oom": re.compile(r"oom-kill|out of memory", re.I),
        "segfault": re.compile(r"segfault|general protection", re.I),
        "tainted": re.compile(r"taint", re.I),
        "module_verification_failed": re.compile(r"module verification failed", re.I),
    }
    counts = collections.Counter()
    for line in lines:
        for name, pattern in patterns.items():
            if pattern.search(line):
                counts[name] += 1
    return dict(sorted(counts.items()))


def bound_output(output):
    encoded = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return output

    output["coverage"] = "partial"
    output["truncated"]["output_budget"] = True
    sections = [
        (output["persistence"], "files", "persistence"),
        (output["host_processes"], "summary", "process_summary"),
        (output["host_processes"], "findings", "process_findings"),
        (output["privileged_files"], "writable", "privileged_writable"),
        (output["privileged_files"], "suid_sgid", "suid_sgid"),
        (output["privileged_files"], "capabilities", "file_capabilities"),
        (output["services"], "enabled", "enabled_services"),
        (output["services"], "failed", "failed_services"),
        (output["network"], "listeners", "network_listeners"),
        (output["network"], "established", "network_established"),
        (output["authentication_7d"], "accepted", "authentication"),
        (output["package_integrity"], "differences", "package_integrity"),
        (output["accounts"], "interactive", "interactive_accounts"),
        (output["accounts"], "uid_zero", "uid_zero_accounts"),
    ]
    while len(encoded) > MAX_OUTPUT_BYTES:
        candidates = [
            (len(container[key]), container, key, name)
            for container, key, name in sections
            if container[key]
        ]
        if not candidates:
            raise RuntimeError("intrusion snapshot metadata exceeded output budget")
        length, container, key, name = max(candidates, key=lambda item: item[0])
        del container[key][-max(1, length // 4):]
        output["truncated"][name] = True
        encoded = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    return output


def main():
    started = time.monotonic()
    captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    processes, host_pids = collect_processes()
    persistence_files, persistence_truncated = collect_persistence()
    if persistence_truncated:
        truncated["persistence"] = True
    writable = run(
        "privileged_writable",
        ["/usr/bin/find", *PRIVILEGED_ROOTS, "-xdev", "-type", "f", "(", "-perm", "-002", "-o", "-perm", "-020", ")", "-printf", "%p\\t%U:%G\\t%m\\n"],
        timeout=60,
    ) if PRIVILEGED_ROOTS else []
    suid_sgid = run(
        "suid_sgid",
        ["/usr/bin/find", *PRIVILEGED_ROOTS, "-xdev", "-type", "f", "-perm", "/6000", "-printf", "%p\\t%U:%G\\t%m\\n"],
        timeout=60,
    ) if PRIVILEGED_ROOTS else []
    capabilities = run(
        "file_capabilities",
        ["/usr/sbin/getcap", "-r", *PRIVILEGED_ROOTS],
        timeout=60,
    ) if PRIVILEGED_ROOTS else []
    enabled = run(
        "enabled_services",
        ["/usr/bin/systemctl", "list-unit-files", "--state=enabled", "--no-legend", "--no-pager"],
    )
    failed = run(
        "failed_services",
        ["/usr/bin/systemctl", "--failed", "--no-legend", "--no-pager"],
    )
    package_differences = run(
        "package_integrity",
        ["/usr/bin/dpkg", "--verify"],
        timeout=90,
        max_lines=200,
    )
    accounts = collect_accounts()
    snap_mount_units = collect_snap_mount_units()
    network = collect_network(host_pids)
    authentication = collect_authentication()
    kernel_signals = collect_kernel_signals()
    boot_id = clean(read_text("/proc/sys/kernel/random/boot_id", 256).strip(), 128)
    output = {
        "version": 2,
        "captured_at": captured_at,
        "duration_ms": 0,
        "hostname": clean(os.uname().nodename, 256),
        "kernel": clean(os.uname().release, 256),
        "boot_id": boot_id,
        "coverage": "partial" if issues or any(truncated.values()) else "complete",
        "accounts": accounts,
        "host_processes": processes,
        "persistence": {"files": persistence_files, "truncated": persistence_truncated},
        "privileged_files": {
            "writable": writable,
            "suid_sgid": suid_sgid,
            "capabilities": capabilities,
        },
        "services": {"enabled": enabled, "failed": failed},
        "snap_mount_units": snap_mount_units,
        "network": network,
        "authentication_7d": authentication,
        "kernel_signals_7d": kernel_signals,
        "package_integrity": {"manager": "dpkg", "differences": package_differences},
        "issues": issues,
        "truncated": truncated,
    }
    bound_output(output)
    output["duration_ms"] = int((time.monotonic() - started) * 1000)
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
