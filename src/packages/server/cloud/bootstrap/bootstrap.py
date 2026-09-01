#!/usr/bin/env python3
"""Python-first project-host bootstrap.

This script replaces the legacy monolithic shell bootstrap. It is stdlib-only
and driven by split bootstrap state files written by bootstrap-host.ts.

High-level responsibilities:
  1) Sanity checks (OS/arch, required tools) and logging bootstrap state.
  2) APT setup: update + install base packages with retries/timeouts.
  3) Storage: configure /mnt/cocalc (disk or loopback), helpers, and /mnt/cocalc/data.
  4) Podman storage config (rootful + rootless) and runtime dir.
  5) Project-host env file (including public IP substitution if needed).
  6) Fetch + verify bundles/tools and unpack them into cocalc-host paths.
  7) Install Node via nvm, write wrapper + helper scripts.
  8) Optional cloudflared setup, GPU setup, and autostart cron.
  9) Start project-host, enable managed security updates, mark bootstrap done.
"""

from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import shlex
import signal
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STATE_SCHEMA_VERSION = 1
HELPER_SCHEMA_VERSION = "20260901-v46"
RUNTIME_WRAPPER_VERSION = "20260825-v16"
BOOTSTRAP_LIFECYCLE_EXPORT_DIR = Path("/var/lib/cocalc/bootstrap-lifecycle")
NVM_VERSION = "0.40.4"
CLOUDFLARED_VERSION = "2026.7.2"
CLOUDFLARED_DEB_SHA256 = {
    "amd64": "88195157a136199a86977c122a22084dae6907480bbe3640222b7b55834afc3a",
    "arm64": "ddd7d2a0d55a1879485ac34354e936424f1df92e306bfa6428a81908aaddbe87",
}
BOOTSTRAP_LOG_MAX_BYTES = 4 * 1024 * 1024
BUNDLE_RETENTION_COUNT = 3
PROC_ROOT = Path("/proc")
ROOTLESS_SUBID_MIN_TOTAL = 4 * 1024 * 1024
ROOTLESS_SUBID_ALIGNMENT = 65536
PROJECT_HOST_RUNTIME_UID = 2000
PROJECT_HOST_RUNTIME_GID = 2000
HOST_CRITICAL_OOM_SCORE_ADJ = -900
DEFAULT_PROJECT_POOL_CGROUP = "/sys/fs/cgroup/cocalc-project-pool"
LEGACY_PROJECT_POOL_MEMORY_RESERVE_MB = 3072
DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB = "auto"
DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB = 3072
DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB = 8192
MIN_PROJECT_POOL_MEMORY_MB = 1024
DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES = "auto"
DYNAMIC_PROJECT_POOL_CPU_RESERVE_MIN_CORES = 1
DYNAMIC_PROJECT_POOL_CPU_RESERVE_MAX_CORES = 4
DYNAMIC_PROJECT_POOL_CPU_RESERVE_DIVISOR = 4
MIN_PROJECT_POOL_CPU_CORES = 1
PROJECT_POOL_CPU_PERIOD_US = 100000
NVIDIA_CDI_PODMAN4_VERSION = "0.5.0"
PROJECT_HOST_RUNTIME_SUBID_RANGES = (
    (231072, ROOTLESS_SUBID_ALIGNMENT),
    (327680, ROOTLESS_SUBID_MIN_TOTAL - ROOTLESS_SUBID_ALIGNMENT),
)
APT_RETRIES = 5
APT_ACQUIRE_TIMEOUT_S = 60
APT_LOCK_TIMEOUT_S = 120
APT_UPDATE_TIMEOUT_S = 180
APT_INSTALL_TIMEOUT_S = 600
RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S = 10
APPARMOR_PROFILE_PROBE_TIMEOUT_S = 2
PODMAN_STALE_BOOT_ERROR_PATTERNS = (
    re.compile(r"current system boot ID differs from cached boot ID", re.IGNORECASE),
    re.compile(
        r"cannot re-exec process to join the existing user namespace", re.IGNORECASE
    ),
    re.compile(r"cannot join.*user namespace", re.IGNORECASE),
    re.compile(r"failed to reexec", re.IGNORECASE),
    re.compile(r"invalid internal status", re.IGNORECASE),
)
NODE_RUNTIME_APT_PACKAGES = ("libatomic1",)
AUTOMATIC_SECURITY_UPDATES_CONFIG = """// Managed by CoCalc project-host bootstrap.
// CoCalc's own systemd timer runs unattended-upgrade; disable the distro's
// overlapping periodic scheduler.
APT::Periodic::Enable "0";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::SyslogEnable "true";
"""
GCE_UBUNTU_MIRROR_RE = re.compile(
    r"https?://[A-Za-z0-9.-]*gce(?:\.clouds)?\.archive\.ubuntu\.com/ubuntu/?"
)
HOST_OWNED_DATA_TREE_DIRS = (
    "secrets",
    "sync",
    "rustic",
    "backup-index",
    "forensics",
    "logs",
)
HOST_OWNED_DATA_TOPLEVEL_DIRS = ("cache",)
HOST_OWNED_DATA_FILES = (
    "log",
    "daemon.pid",
    "host-agent.log",
    "host-agent.pid",
    "supervision-events.jsonl",
    "host-agent-state.json",
    "conat-router.log",
)
HOST_OWNED_SQLITE_RE = re.compile(r"^(sqlite\.db|sync-fs\.sqlite)(?:-(?:wal|shm))?$")
ENV_ASSIGNMENT_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PROJECT_IO_POLICY_HELPER = r'''#!/usr/bin/env python3
"""Resolve project I/O policy into concrete cgroup v2 device limits."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

GIB = 1024 * 1024 * 1024
MIB = 1024 * 1024
POLICY_VERSION = 1
CAPACITY_VERSION = 1
DYNAMIC_CAPACITY_MODE = "gcp-pd-balanced"
GCP_BALANCED_BTRFS_HEADROOM_PERCENT = 90
CLASSES = ("standard", "member", "premium")
SCOPES = ("pool", "lifecycle-pool", "maintenance", "startup", *CLASSES)
METRICS = ("rbps", "wbps", "riops", "wiops")

DEFAULTS = {
    "version": POLICY_VERSION,
    "mode": "disabled",
    "mountpoint": "/mnt/cocalc",
    "profile": "unconfigured",
    "capacitySource": "unconfigured",
    "capacity": {"mode": "static"},
    "pool": {"rbps": 0, "wbps": 0, "riops": 0, "wiops": 0},
    "leafClasses": {
        "standard": {
            "weight": 100,
            "rbps": 0,
            "wbps": 0,
            "riops": 0,
            "wiops": 0,
        },
        "member": {
            "weight": 200,
            "rbps": 0,
            "wbps": 0,
            "riops": 0,
            "wiops": 0,
        },
        "premium": {
            "weight": 400,
            "rbps": 0,
            "wbps": 0,
            "riops": 0,
            "wiops": 0,
        },
    },
}


def object_value(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def load_object(path: str, *, missing_ok: bool = False) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as handle:
            return object_value(json.load(handle), path)
    except FileNotFoundError:
        if missing_ok:
            return {}
        raise


def merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    result = dict(left)
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = value
    return result


def clean_text(value: Any, fallback: str, name: str) -> str:
    text = str(value or "").strip() or fallback
    if any(char in text for char in ("\t", "\n", "\0")):
        raise ValueError(f"invalid {name}")
    return text


def integer(
    row: dict[str, Any], key: str, *, positive: bool = False
) -> int:
    value = row.get(key, 0)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"invalid {key}")
    if positive and value <= 0:
        raise ValueError(f"missing enforced {key}")
    return value


def normalize_policy(
    policy_path: str, override_path: str, io_class: str
) -> dict[str, Any]:
    if io_class not in CLASSES:
        io_class = "standard"
    policy = merge(
        merge(DEFAULTS, load_object(policy_path, missing_ok=True)),
        load_object(override_path, missing_ok=True),
    )
    version = policy.get("version")
    if isinstance(version, bool) or version != POLICY_VERSION:
        raise ValueError("project I/O policy version must be 1")
    mode = policy.get("mode")
    if mode not in ("disabled", "observe", "enforce"):
        raise ValueError("invalid project I/O policy mode")
    mountpoint = clean_text(
        policy.get("mountpoint"), "/mnt/cocalc", "project I/O mountpoint"
    )
    if not mountpoint.startswith("/"):
        raise ValueError("invalid project I/O mountpoint")
    capacity = object_value(policy.get("capacity") or {}, "capacity")
    capacity_mode = capacity.get("mode") or "static"
    if capacity_mode not in ("static", DYNAMIC_CAPACITY_MODE):
        raise ValueError("invalid project I/O capacity mode")
    pool = object_value(policy.get("pool") or {}, "pool")
    leaf_classes = object_value(
        policy.get("leafClasses") or {}, "leafClasses"
    )
    leaf = object_value(leaf_classes.get(io_class) or {}, io_class)
    require_static = mode == "enforce" and capacity_mode == "static"
    pool_values = {
        key: integer(pool, key, positive=require_static) for key in METRICS
    }
    leaf_values = {
        key: integer(leaf, key, positive=require_static) for key in METRICS
    }
    if require_static:
        for key in METRICS:
            if leaf_values[key] > pool_values[key]:
                raise ValueError(f"leaf {key} exceeds pool {key}")
    weight = integer(leaf, "weight", positive=True)
    if weight > 10000:
        raise ValueError("I/O weight exceeds 10000")
    return {
        "version": version,
        "mode": mode,
        "mountpoint": mountpoint,
        "profile": clean_text(
            policy.get("profile"), "unconfigured", "profile"
        ),
        "capacity_source": clean_text(
            policy.get("capacitySource"),
            "unconfigured",
            "capacitySource",
        ),
        "capacity_mode": capacity_mode,
        "pool": pool_values,
        "leaf": {**leaf_values, "weight": weight},
        "io_class": io_class,
    }


def policy_fields(policy: dict[str, Any]) -> str:
    return "\t".join(
        map(
            str,
            [
                policy["mode"],
                policy["mountpoint"],
                *[policy["pool"][key] for key in METRICS],
                *[policy["leaf"][key] for key in METRICS],
                policy["leaf"]["weight"],
                policy["io_class"],
                policy["version"],
                policy["profile"],
                policy["capacity_source"],
                policy["capacity_mode"],
            ],
        )
    )


def run_output(args: list[str]) -> str:
    result = subprocess.run(
        args,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    if result.returncode:
        raise ValueError(
            f"{args[0]} failed ({result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def btrfs_devices(mountpoint: str) -> list[str]:
    output = run_output(
        ["/usr/bin/btrfs", "filesystem", "show", "--raw", mountpoint]
    )
    devices = []
    for line in output.splitlines():
        parts = line.split()
        if parts and parts[0] == "devid":
            devices.append(parts[-1])
    return devices


def mounted_device(mountpoint: str) -> list[str]:
    source = run_output(
        ["/usr/bin/findmnt", "-n", "-o", "SOURCE", "-T", mountpoint]
    )
    return [source] if source else []


def capacity_targets(capacity_path: str) -> tuple[str, list[dict[str, Any]]]:
    capacity = load_object(capacity_path)
    version = capacity.get("version")
    if isinstance(version, bool) or version != CAPACITY_VERSION:
        raise ValueError("project I/O capacity version must be 1")
    provider = clean_text(capacity.get("provider"), "unknown", "provider")
    targets = capacity.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError("project I/O capacity targets must not be empty")
    normalized = []
    for index, value in enumerate(targets):
        target = object_value(value, f"targets[{index}]")
        mountpoint = clean_text(
            target.get("mountpoint"), "", f"targets[{index}].mountpoint"
        )
        if not mountpoint.startswith("/"):
            raise ValueError(f"invalid targets[{index}].mountpoint")
        discovery = target.get("discovery")
        if discovery not in ("btrfs", "mount"):
            raise ValueError(f"invalid targets[{index}].discovery")
        disk_type = clean_text(
            target.get("disk_type"), "unknown", f"targets[{index}].disk_type"
        )
        required = target.get("required", True)
        if not isinstance(required, bool):
            raise ValueError(f"invalid targets[{index}].required")
        normalized.append(
            {
                "mountpoint": mountpoint,
                "discovery": discovery,
                "disk_type": disk_type,
                "required": required,
            }
        )
    return provider, normalized


def scheduler_for(device: str) -> str | None:
    name = os.path.basename(os.path.realpath(device))
    path = Path("/sys/class/block") / name / "queue" / "scheduler"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for value in text.split():
        if value.startswith("[") and value.endswith("]"):
            return value[1:-1]
    return None


def filesystem_for(mountpoint: str) -> str:
    try:
        return run_output(
            ["/usr/bin/findmnt", "-n", "-o", "FSTYPE", "-T", mountpoint]
        )
    except ValueError:
        return "unknown"


def inspect_device(
    device: str,
    *,
    provider: str,
    disk_type: str,
    mountpoint: str,
) -> dict[str, Any]:
    resolved = os.path.realpath(device)
    device_stat = os.stat(resolved)
    if not stat.S_ISBLK(device_stat.st_mode):
        raise ValueError(f"project I/O device is not a block device: {device}")
    size_text = run_output(["/usr/sbin/blockdev", "--getsize64", resolved])
    size_bytes = int(size_text)
    if size_bytes <= 0:
        raise ValueError(f"project I/O device has invalid size: {device}")
    return {
        "device": resolved,
        "major_minor": (
            f"{os.major(device_stat.st_rdev)}:{os.minor(device_stat.st_rdev)}"
        ),
        "scheduler": scheduler_for(resolved),
        "size_bytes": size_bytes,
        "provider": provider,
        "disk_type": disk_type,
        "mountpoints": [mountpoint],
        "filesystems": [filesystem_for(mountpoint)],
    }


def discover_devices(
    policy: dict[str, Any], capacity_path: str
) -> list[dict[str, Any]]:
    if policy["capacity_mode"] == "static":
        provider = "static"
        targets = [
            {
                "mountpoint": policy["mountpoint"],
                "discovery": "btrfs",
                "disk_type": "static",
                "required": True,
            }
        ]
    else:
        provider, targets = capacity_targets(capacity_path)
    devices: dict[str, dict[str, Any]] = {}
    for target in targets:
        mountpoint = target["mountpoint"]
        if target["discovery"] == "btrfs":
            paths = btrfs_devices(mountpoint)
        else:
            paths = mounted_device(mountpoint)
        if not paths and target["required"]:
            raise ValueError(
                f"no block devices discovered for required mountpoint {mountpoint}"
            )
        for path in paths:
            row = inspect_device(
                path,
                provider=provider,
                disk_type=target["disk_type"],
                mountpoint=mountpoint,
            )
            existing = devices.get(row["major_minor"])
            if existing is None:
                devices[row["major_minor"]] = row
                continue
            if (
                existing["provider"] != row["provider"]
                or existing["disk_type"] != row["disk_type"]
            ):
                raise ValueError(
                    f"conflicting capacity metadata for {row['major_minor']}"
                )
            existing["mountpoints"] = sorted(
                set(existing["mountpoints"] + row["mountpoints"])
            )
            existing["filesystems"] = sorted(
                set(existing["filesystems"] + row["filesystems"])
            )
    if not devices:
        raise ValueError("no project-writable block devices discovered")
    return sorted(devices.values(), key=lambda row: row["major_minor"])


def balanced_device_capacity(device: dict[str, Any]) -> dict[str, int]:
    if device["provider"] != "gcp" or device["disk_type"] != "balanced":
        raise ValueError(
            "gcp-pd-balanced capacity requires GCP balanced disks only"
        )
    size_bytes = device["size_bytes"]
    physical_iops = min(15000, 3000 + (6 * size_bytes) // GIB)
    size_throughput = (
        140 * MIB + (28 * size_bytes * MIB) // (100 * GIB)
    )
    return {
        "physical_read_bps": min(240 * MIB, size_throughput),
        # 200 MiB/s is below the smallest documented pd-balanced write cap.
        "physical_write_bps": min(200 * MIB, size_throughput),
        "physical_iops": physical_iops,
    }


def effective_limits(
    policy: dict[str, Any],
    devices: list[dict[str, Any]],
    scope: str,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if scope not in SCOPES:
        raise ValueError(
            "scope must be pool, lifecycle-pool, maintenance, startup, standard, member, or premium"
        )
    if policy["capacity_mode"] == "static":
        if scope in ("pool", "lifecycle-pool"):
            limits = policy["pool"]
        elif scope == "maintenance":
            limits = {
                key: max(1, policy["pool"][key] // 10) for key in METRICS
            }
        elif scope == "startup":
            limits = policy["pool"]
        else:
            limits = policy["leaf"]
        return [
            {**row, "limits": {key: limits[key] for key in METRICS}}
            for row in devices
        ], None
    factors = {
        "pool": {key: 100 for key in METRICS},
        # While a lifecycle operation is active, ordinary projects yield a
        # part of their write budget. The startup sibling can use 50% of
        # physical write capacity, while the ordinary pool temporarily drops
        # from 25% to 15% and retains its full read budget. Staging showed that
        # 20% left too little margin for Podman metadata work under sustained
        # buffered writes.
        "lifecycle-pool": {
            "rbps": 100,
            "wbps": 60,
            "riops": 100,
            "wiops": 60,
        },
        "maintenance": {key: 10 for key in METRICS},
        # Ordinary projects reserve 25% of write capacity. Give lifecycle
        # work 50%, leaving 25% uncommitted while a start is active.
        "startup": {"rbps": 100, "wbps": 200, "riops": 100, "wiops": 200},
        "standard": {key: 25 for key in METRICS},
        "member": {key: 50 for key in METRICS},
        "premium": {key: 75 for key in METRICS},
    }[scope]
    # Each Persistent Disk has its own size-derived limits; combining capacities
    # before applying the formula loses the baseline capacity of every extra disk.
    capacities = [balanced_device_capacity(row) for row in devices]
    rows = []
    for row, capacity in zip(devices, capacities):
        btrfs_project_data = (
            "btrfs" in row.get("filesystems", []) and scope != "maintenance"
        )
        if btrfs_project_data:
            # Low nested io.max ceilings turn Btrfs metadata transactions into
            # throttled filesystem-wide lock holders. Give project and lifecycle
            # work nearly the physical device envelope instead; io.weight and
            # direct offender eviction provide fairness under real contention.
            pool = {
                "rbps": max(
                    1,
                    (
                        capacity["physical_read_bps"]
                        * GCP_BALANCED_BTRFS_HEADROOM_PERCENT
                    )
                    // 100,
                ),
                "wbps": max(
                    1,
                    (
                        capacity["physical_write_bps"]
                        * GCP_BALANCED_BTRFS_HEADROOM_PERCENT
                    )
                    // 100,
                ),
                "riops": max(
                    1,
                    (
                        capacity["physical_iops"]
                        * GCP_BALANCED_BTRFS_HEADROOM_PERCENT
                    )
                    // 100,
                ),
                "wiops": max(
                    1,
                    (
                        capacity["physical_iops"]
                        * GCP_BALANCED_BTRFS_HEADROOM_PERCENT
                    )
                    // 100,
                ),
            }
            scope_factors = {key: 100 for key in METRICS}
        else:
            pool = {
                "rbps": max(1, (capacity["physical_read_bps"] * 50) // 100),
                "wbps": max(1, (capacity["physical_write_bps"] * 25) // 100),
                "riops": max(1, (capacity["physical_iops"] * 50) // 100),
                "wiops": max(1, (capacity["physical_iops"] * 25) // 100),
            }
            scope_factors = factors
        rows.append(
            {
                **row,
                "limits": {
                    key: max(1, (pool[key] * scope_factors[key]) // 100)
                    for key in METRICS
                },
            }
        )
    total_bytes = sum(row["size_bytes"] for row in devices)
    return rows, {
        "total_bytes": total_bytes,
        "device_count": len(devices),
        "physical_read_bps": sum(
            row["physical_read_bps"] for row in capacities
        ),
        "physical_write_bps": sum(
            row["physical_write_bps"] for row in capacities
        ),
        "physical_iops": sum(row["physical_iops"] for row in capacities),
    }


def limit_rows_tsv(rows: list[dict[str, Any]]) -> str:
    lines = []
    for row in rows:
        limits = row["limits"]
        lines.append(
            "\t".join(
                map(
                    str,
                    [
                        row["major_minor"],
                        *[limits[key] for key in METRICS],
                        row["device"],
                        row.get("scheduler") or "",
                        row["size_bytes"],
                        row["provider"],
                        row["disk_type"],
                        json.dumps(row["mountpoints"], separators=(",", ":")),
                        json.dumps(row["filesystems"], separators=(",", ":")),
                    ],
                )
            )
        )
    return "\n".join(lines)


def policy_status(
    policy: dict[str, Any], capacity_path: str
) -> dict[str, Any]:
    result = {
        "policy_mode": policy["mode"],
        "policy_version": policy["version"],
        "policy_profile": policy["profile"],
        "capacity_source": policy["capacity_source"],
        "capacity_mode": policy["capacity_mode"],
        "mountpoint": policy["mountpoint"],
        "mountpoints": [policy["mountpoint"]],
        "filesystem": "unknown",
        "devices": [],
    }
    try:
        devices = discover_devices(policy, capacity_path)
        rows, capacity = effective_limits(policy, devices, "pool")
        result["devices"] = [
            {
                key: row[key]
                for key in (
                    "device",
                    "major_minor",
                    "scheduler",
                    "size_bytes",
                    "provider",
                    "disk_type",
                    "mountpoints",
                    "filesystems",
                    "limits",
                )
                if row.get(key) is not None
            }
            for row in rows
        ]
        result["mountpoints"] = sorted(
            {path for row in rows for path in row["mountpoints"]}
        )
        filesystems = sorted(
            {value for row in rows for value in row["filesystems"]}
        )
        result["filesystem"] = (
            filesystems[0] if len(filesystems) == 1 else ",".join(filesystems)
        )
        if capacity is not None:
            result["derived_capacity"] = capacity
    except Exception as exc:
        result["discovery_error"] = str(exc)
    return result


def main() -> int:
    if len(sys.argv) < 2:
        raise ValueError("missing command")
    command = sys.argv[1]
    if command == "fields" and len(sys.argv) == 5:
        policy = normalize_policy(sys.argv[2], sys.argv[3], sys.argv[4])
        print(policy_fields(policy))
        return 0
    if command in ("limits", "status") and len(sys.argv) == 7:
        policy = normalize_policy(sys.argv[2], sys.argv[3], sys.argv[6])
        if command == "status":
            print(
                json.dumps(
                    policy_status(policy, sys.argv[4]),
                    separators=(",", ":"),
                )
            )
            return 0
        devices = discover_devices(policy, sys.argv[4])
        rows, _capacity = effective_limits(policy, devices, sys.argv[5])
        print(limit_rows_tsv(rows))
        return 0
    if command == "calculate" and len(sys.argv) == 3:
        devices = json.load(sys.stdin)
        policy = {
            "capacity_mode": DYNAMIC_CAPACITY_MODE,
            "pool": {},
            "leaf": {},
        }
        rows, capacity = effective_limits(policy, devices, sys.argv[2])
        print(json.dumps({"rows": rows, "capacity": capacity}, separators=(",", ":")))
        return 0
    raise ValueError("invalid project I/O policy helper arguments")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"project I/O policy error: {exc}", file=sys.stderr)
        raise SystemExit(1)
'''

NVIDIA_CDI_NORMALIZER_SCRIPT = f"""#!/usr/bin/env python3
import sys
from pathlib import Path

COMPAT_VERSION = "{NVIDIA_CDI_PODMAN4_VERSION}"
CDI_PATHS = (Path("/etc/cdi/nvidia.yaml"), Path("/var/run/cdi/nvidia.yaml"))


def strip_yaml_field(lines, field):
    out = []
    i = 0
    needle = f"{{field}}:"
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped == needle:
            indent = len(line) - len(line.lstrip(" "))
            i += 1
            while i < len(lines):
                next_line = lines[i]
                next_stripped = next_line.strip()
                if not next_stripped:
                    i += 1
                    continue
                next_indent = len(next_line) - len(next_line.lstrip(" "))
                if next_indent > indent:
                    i += 1
                    continue
                break
            continue
        out.append(line)
        i += 1
    return out


def normalize(path):
    if not path.exists():
        return False
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    lines = strip_yaml_field(lines, "additionalGids")
    changed_version = False
    for i, line in enumerate(lines):
        if line.startswith("cdiVersion:"):
            replacement = f"cdiVersion: {{COMPAT_VERSION}}\\n"
            if line != replacement:
                lines[i] = replacement
                changed_version = True
            break
    updated = "".join(lines)
    if updated == original and not changed_version:
        return False
    path.write_text(updated, encoding="utf-8")
    path.chmod(0o644)
    return True


changed = False
paths = [Path(arg) for arg in sys.argv[1:]] or list(CDI_PATHS)
for path in paths:
    changed = normalize(path) or changed
raise SystemExit(0)
"""


@dataclass(frozen=True)
class BundleSpec:
    url: str
    sha256: str | None
    remote: str
    root: str
    dir: str
    current: str
    version: str | None = None
    manifest_url: str | None = None


@dataclass(frozen=True)
class CloudflaredSpec:
    enabled: bool
    hostname: str | None = None
    port: int | None = None
    app_public_wildcard: str | None = None
    exam_hostname: str | None = None
    ssh_hostname: str | None = None
    ssh_port: int | None = None
    token: str | None = None
    tunnel_id: str | None = None
    creds_json: str | None = None
    protocol: str = "auto"
    grace_period_seconds: int = 10


@dataclass(frozen=True)
class BootstrapConfig:
    bootstrap_user: str
    bootstrap_home: str
    bootstrap_root: str
    bootstrap_dir: str
    bootstrap_tmp: str
    log_file: str
    expected_os: str
    expected_arch: str
    image_size_gb_raw: str
    root_reserve_gb_raw: str
    data_disk_devices: str
    data_disk_candidates: str
    shared_scratch_enabled: bool
    shared_scratch_devices: str
    shared_scratch_mount: str
    shared_scratch_project_mount: str
    shared_scratch_filesystem: str
    project_io_capacity: dict[str, Any]
    project_io_policy: dict[str, Any]
    apt_packages: list[str]
    has_gpu: bool
    ssh_user: str
    env_file: str
    env_lines: list[str]
    node_version: str
    bootstrap_selector: str | None
    bootstrap_py_url: str | None
    project_host_bundle: BundleSpec
    project_bundle: BundleSpec
    tools_bundle: BundleSpec
    cloudflared: CloudflaredSpec
    conat_url: str | None
    status_url: str | None
    bootstrap_token: str | None
    ca_cert_path: str | None
    bootstrap_done_paths: list[str]
    container_runtime_bundle: BundleSpec | None = None
    allow_loopback_rustic_rest: bool = False


@dataclass(frozen=True)
class PrivilegedWrapperConfig:
    """Minimal configuration needed outside managed cloud-host bootstrap."""

    ssh_user: str
    project_io_capacity: dict[str, Any]
    project_io_policy: dict[str, Any]
    container_runtime_bundle: BundleSpec | None = None
    allow_loopback_rustic_rest: bool = False


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _ensure_str(value: Any, name: str) -> str:
    if isinstance(value, str):
        return value
    raise RuntimeError(f"{name} missing or invalid")


def _ensure_bool(value: Any, name: str, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise RuntimeError(f"{name} must be boolean")


def _ensure_list(value: Any, name: str) -> list[Any]:
    if isinstance(value, list):
        return value
    raise RuntimeError(f"{name} must be list")


def _ensure_object(value: Any, name: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    raise RuntimeError(f"{name} must be object")


def build_project_io_policy(capacity: dict[str, Any]) -> dict[str, Any]:
    targets = capacity.get("targets")
    supports_dynamic_capacity = (
        capacity.get("provider") == "gcp"
        and isinstance(targets, list)
        and bool(targets)
        and all(
            isinstance(target, dict) and target.get("disk_type") == "balanced"
            for target in targets
        )
    )
    pool = (
        {"rbps": 67108864, "wbps": 33554432, "riops": 2000, "wiops": 1000}
        if supports_dynamic_capacity
        else {"rbps": 0, "wbps": 0, "riops": 0, "wiops": 0}
    )
    return {
        "version": 1,
        "mode": "enforce" if supports_dynamic_capacity else "disabled",
        "mountpoint": "/mnt/cocalc",
        "profile": (
            "gcp-pd-balanced-btrfs-headroom"
            if supports_dynamic_capacity
            else "unconfigured"
        ),
        "capacitySource": (
            "gcp-pd-balanced-btrfs-headroom-2026-08-04"
            if supports_dynamic_capacity
            else "unconfigured"
        ),
        "capacity": {
            "mode": "gcp-pd-balanced" if supports_dynamic_capacity else "static"
        },
        "pool": pool,
        "leafClasses": {
            "standard": {
                "weight": 100,
                **{key: value // 4 for key, value in pool.items()},
            },
            "member": {
                "weight": 200,
                **{key: value // 2 for key, value in pool.items()},
            },
            "premium": {
                "weight": 400,
                **{key: (value * 3) // 4 for key, value in pool.items()},
            },
        },
        "adaptive": {
            "enabled": False,
            "sampleMs": 5000,
            "enterSamples": 6,
            "recoverSamples": 24,
        },
        "ioCost": {"mode": "disabled"},
    }


def standalone_privileged_wrapper_config(
    ssh_user: str,
) -> PrivilegedWrapperConfig:
    """Build fail-safe wrapper settings for a standalone btrfs project host."""

    _require(bool(ssh_user.strip()), "standalone runtime user must not be empty")
    capacity = {
        "version": 1,
        "provider": "standalone",
        "targets": [
            {
                "mountpoint": "/mnt/cocalc",
                "discovery": "btrfs",
                "disk_type": "unknown",
                "required": True,
            }
        ],
    }
    return PrivilegedWrapperConfig(
        ssh_user=ssh_user,
        project_io_capacity=capacity,
        project_io_policy=build_project_io_policy(capacity),
        allow_loopback_rustic_rest=True,
    )


def load_config(bootstrap_dir: str) -> BootstrapConfig:
    facts_path = Path(bootstrap_dir) / "bootstrap-host-facts.json"
    desired_path = Path(bootstrap_dir) / "bootstrap-desired-state.json"
    facts = json_load(facts_path)
    desired = json_load(desired_path)
    _require(bool(facts), f"missing bootstrap host facts: {facts_path}")
    _require(bool(desired), f"missing bootstrap desired state: {desired_path}")
    bundle_host = desired.get("project_host_bundle") or {}
    bundle_container_runtime = desired.get("container_runtime_bundle") or None
    bundle_project = desired.get("project_bundle") or {}
    bundle_tools = desired.get("tools_bundle") or {}
    cloudflared = desired.get("cloudflared") or {}
    shared_scratch = desired.get("shared_scratch") or {}
    bootstrap_meta = desired.get("bootstrap") or {}
    bootstrap_connection = desired.get("bootstrap_connection") or {}
    cloudflared_protocol = str(cloudflared.get("protocol") or "auto").strip().lower()
    _require(
        cloudflared_protocol in {"auto", "quic", "http2"},
        "cloudflared.protocol must be auto, quic, or http2",
    )
    cloudflared_grace_period_seconds = int(
        cloudflared.get("gracePeriodSeconds")
        or cloudflared.get("grace_period_seconds")
        or 10
    )
    _require(
        1 <= cloudflared_grace_period_seconds <= 30,
        "cloudflared.gracePeriodSeconds must be between 1 and 30",
    )
    project_io_capacity = _ensure_object(
        desired.get("project_io_capacity")
        or {
            "version": 1,
            "provider": "unknown",
            "targets": [
                {
                    "mountpoint": "/mnt/cocalc",
                    "discovery": "btrfs",
                    "disk_type": "unknown",
                    "required": True,
                }
            ],
        },
        "bootstrap-desired-state.project_io_capacity",
    )
    return BootstrapConfig(
        bootstrap_user=_ensure_str(
            facts.get("bootstrap_user"), "bootstrap-host-facts.bootstrap_user"
        ),
        bootstrap_home=_ensure_str(
            facts.get("bootstrap_home"), "bootstrap-host-facts.bootstrap_home"
        ),
        bootstrap_root=_ensure_str(
            facts.get("bootstrap_root"), "bootstrap-host-facts.bootstrap_root"
        ),
        bootstrap_dir=_ensure_str(
            facts.get("bootstrap_dir"), "bootstrap-host-facts.bootstrap_dir"
        ),
        bootstrap_tmp=_ensure_str(
            facts.get("bootstrap_tmp"), "bootstrap-host-facts.bootstrap_tmp"
        ),
        log_file=_ensure_str(facts.get("log_file"), "bootstrap-host-facts.log_file"),
        expected_os=_ensure_str(
            facts.get("expected_os"), "bootstrap-host-facts.expected_os"
        ),
        expected_arch=_ensure_str(
            facts.get("expected_arch"), "bootstrap-host-facts.expected_arch"
        ),
        image_size_gb_raw=_ensure_str(
            desired.get("image_size_gb_raw") or "auto",
            "bootstrap-desired-state.image_size_gb_raw",
        ),
        root_reserve_gb_raw=_ensure_str(
            desired.get("root_reserve_gb_raw") or "25",
            "bootstrap-desired-state.root_reserve_gb_raw",
        ),
        data_disk_devices=_ensure_str(
            facts.get("data_disk_devices") or "",
            "bootstrap-host-facts.data_disk_devices",
        ),
        data_disk_candidates=_ensure_str(
            facts.get("data_disk_candidates") or "",
            "bootstrap-host-facts.data_disk_candidates",
        ),
        shared_scratch_enabled=_ensure_bool(
            shared_scratch.get("enabled"),
            "bootstrap-desired-state.shared_scratch.enabled",
            False,
        ),
        shared_scratch_devices=_ensure_str(
            facts.get("shared_scratch_disk_devices") or "",
            "bootstrap-host-facts.shared_scratch_disk_devices",
        ),
        shared_scratch_mount=_ensure_str(
            shared_scratch.get("mount") or "/mnt/cocalc-scratch",
            "bootstrap-desired-state.shared_scratch.mount",
        ),
        shared_scratch_project_mount=_ensure_str(
            shared_scratch.get("project_mount") or "/scratch",
            "bootstrap-desired-state.shared_scratch.project_mount",
        ),
        shared_scratch_filesystem=_ensure_str(
            shared_scratch.get("filesystem") or "ext4",
            "bootstrap-desired-state.shared_scratch.filesystem",
        ),
        project_io_capacity=project_io_capacity,
        project_io_policy=_ensure_object(
            desired.get("project_io_policy")
            or build_project_io_policy(project_io_capacity),
            "bootstrap-desired-state.project_io_policy",
        ),
        apt_packages=[
            str(p)
            for p in _ensure_list(
                desired.get("apt_packages") or [],
                "bootstrap-desired-state.apt_packages",
            )
        ],
        has_gpu=_ensure_bool(facts.get("has_gpu"), "bootstrap-host-facts.has_gpu"),
        ssh_user=_ensure_str(
            facts.get("runtime_user") or facts.get("ssh_user"),
            "bootstrap-host-facts.runtime_user",
        ),
        env_file=_ensure_str(facts.get("env_file"), "bootstrap-host-facts.env_file"),
        env_lines=[
            str(line)
            for line in _ensure_list(
                desired.get("env_lines") or [],
                "bootstrap-desired-state.env_lines",
            )
        ],
        node_version=_ensure_str(
            desired.get("node_version"), "bootstrap-desired-state.node_version"
        ),
        bootstrap_selector=(bootstrap_meta.get("selector") or None),
        bootstrap_py_url=(bootstrap_meta.get("url") or None),
        project_host_bundle=BundleSpec(
            url=_ensure_str(bundle_host.get("url"), "project_host_bundle.url"),
            sha256=bundle_host.get("sha256") or None,
            remote=_ensure_str(bundle_host.get("remote"), "project_host_bundle.remote"),
            root=_ensure_str(bundle_host.get("root"), "project_host_bundle.root"),
            dir=_ensure_str(bundle_host.get("dir"), "project_host_bundle.dir"),
            current=_ensure_str(bundle_host.get("current"), "project_host_bundle.current"),
            version=bundle_host.get("version"),
            manifest_url=bundle_host.get("manifest_url") or None,
        ),
        project_bundle=BundleSpec(
            url=_ensure_str(bundle_project.get("url"), "project_bundle.url"),
            sha256=bundle_project.get("sha256") or None,
            remote=_ensure_str(bundle_project.get("remote"), "project_bundle.remote"),
            root=_ensure_str(bundle_project.get("root"), "project_bundle.root"),
            dir=_ensure_str(bundle_project.get("dir"), "project_bundle.dir"),
            current=_ensure_str(bundle_project.get("current"), "project_bundle.current"),
            version=bundle_project.get("version"),
            manifest_url=bundle_project.get("manifest_url") or None,
        ),
        tools_bundle=BundleSpec(
            url=_ensure_str(bundle_tools.get("url"), "tools_bundle.url"),
            sha256=bundle_tools.get("sha256") or None,
            remote=_ensure_str(bundle_tools.get("remote"), "tools_bundle.remote"),
            root=_ensure_str(bundle_tools.get("root"), "tools_bundle.root"),
            dir=_ensure_str(bundle_tools.get("dir"), "tools_bundle.dir"),
            current=_ensure_str(bundle_tools.get("current"), "tools_bundle.current"),
            version=bundle_tools.get("version"),
            manifest_url=bundle_tools.get("manifest_url") or None,
        ),
        cloudflared=CloudflaredSpec(
            enabled=_ensure_bool(cloudflared.get("enabled"), "cloudflared.enabled"),
            hostname=cloudflared.get("hostname"),
            port=cloudflared.get("port"),
            app_public_wildcard=cloudflared.get("appPublicWildcard")
            or cloudflared.get("app_public_wildcard"),
            exam_hostname=cloudflared.get("examHostname")
            or cloudflared.get("exam_hostname"),
            ssh_hostname=cloudflared.get("sshHostname")
            or cloudflared.get("ssh_hostname"),
            ssh_port=cloudflared.get("sshPort") or cloudflared.get("ssh_port"),
            token=cloudflared.get("token"),
            tunnel_id=cloudflared.get("tunnelId") or cloudflared.get("tunnel_id"),
            creds_json=cloudflared.get("credsJson") or cloudflared.get("creds_json"),
            protocol=cloudflared_protocol,
            grace_period_seconds=cloudflared_grace_period_seconds,
        ),
        conat_url=bootstrap_connection.get("conat_url") or None,
        status_url=bootstrap_connection.get("status_url") or None,
        bootstrap_token=bootstrap_connection.get("bootstrap_token") or None,
        ca_cert_path=bootstrap_connection.get("ca_cert_path") or None,
        bootstrap_done_paths=[
            str(p)
            for p in _ensure_list(
                desired.get("bootstrap_done_paths") or [],
                "bootstrap-desired-state.bootstrap_done_paths",
            )
        ],
        container_runtime_bundle=(
            BundleSpec(
                url=_ensure_str(
                    bundle_container_runtime.get("url"),
                    "container_runtime_bundle.url",
                ),
                sha256=bundle_container_runtime.get("sha256") or None,
                remote=_ensure_str(
                    bundle_container_runtime.get("remote"),
                    "container_runtime_bundle.remote",
                ),
                root=_ensure_str(
                    bundle_container_runtime.get("root"),
                    "container_runtime_bundle.root",
                ),
                dir=_ensure_str(
                    bundle_container_runtime.get("dir"),
                    "container_runtime_bundle.dir",
                ),
                current=_ensure_str(
                    bundle_container_runtime.get("current"),
                    "container_runtime_bundle.current",
                ),
                version=bundle_container_runtime.get("version"),
                manifest_url=bundle_container_runtime.get("manifest_url") or None,
            )
            if bundle_container_runtime
            else None
        ),
    )


def parse_only(arg: str | None) -> set[str] | None:
    if not arg:
        return None
    parts = [p.strip().lower() for p in arg.split(",") if p.strip()]
    if not parts:
        return None
    return set(parts)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def bootstrap_host_facts_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-host-facts.json"


def bootstrap_desired_state_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-desired-state.json"


def bootstrap_state_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap-state.json"


def current_bootstrap_sha256() -> str | None:
    try:
        path = Path(__file__).resolve()
        h = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def json_write_atomic(path: Path, payload: dict[str, Any]) -> None:
    text_write_atomic(
        path,
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
    )


def text_write_atomic(path: Path, content: str, *, default_mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    tmp = Path(tmp_name)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        mode = default_mode
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def bootstrap_lock_path(cfg: BootstrapConfig) -> Path:
    return Path(cfg.bootstrap_dir) / "bootstrap.lock"


def bootstrap_lock_timeout_seconds() -> float:
    raw = os.environ.get("COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS", "").strip()
    if not raw:
        return 300.0
    try:
        value = float(raw)
    except ValueError:
        return 300.0
    if value <= 0:
        return 300.0
    return value


@contextmanager
def bootstrap_operation_lock(cfg: BootstrapConfig):
    lock_path = bootstrap_lock_path(cfg)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    timeout_seconds = bootstrap_lock_timeout_seconds()
    deadline = time.monotonic() + timeout_seconds
    with lock_path.open("a+", encoding="utf-8") as handle:
        log_line(cfg, f"bootstrap: acquiring lifecycle lock {lock_path}")
        next_wait_log_at = time.monotonic() + 30.0
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                now = time.monotonic()
                if now >= deadline:
                    raise TimeoutError(
                        f"timed out waiting for lifecycle lock {lock_path} after {int(timeout_seconds)}s"
                    )
                if now >= next_wait_log_at:
                    remaining = max(0, int(deadline - now))
                    log_line(
                        cfg,
                        f"bootstrap: waiting for lifecycle lock {lock_path} remaining={remaining}s",
                    )
                    next_wait_log_at = now + 30.0
                time.sleep(min(1.0, max(0.05, deadline - now)))
        try:
            log_line(cfg, f"bootstrap: acquired lifecycle lock {lock_path}")
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def parse_env_assignment_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    eq = stripped.find("=")
    if eq <= 0:
        raise RuntimeError(f"invalid env assignment line: {line!r}")
    key = stripped[:eq].strip()
    if not ENV_ASSIGNMENT_KEY_RE.match(key):
        raise RuntimeError(f"invalid env assignment key {key!r} in line: {line!r}")
    value = stripped[eq + 1 :]
    if "\n" in value or "\r" in value:
        raise RuntimeError(f"invalid env assignment value in line: {line!r}")
    return key, value


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


def expected_runtime_userns_map(cfg: BootstrapConfig) -> tuple[list[str], list[str]]:
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    uid_map = [f"0 {desired_uid} 1"]
    gid_map = [f"0 {desired_gid} 1"]
    inside = 1
    for start, length in PROJECT_HOST_RUNTIME_SUBID_RANGES:
        uid_map.append(f"{inside} {start} {length}")
        gid_map.append(f"{inside} {start} {length}")
        inside += length
    return uid_map, gid_map


def expected_runtime_user_contract(cfg: BootstrapConfig) -> dict[str, Any]:
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    uid_map, gid_map = expected_runtime_userns_map(cfg)
    subid_ranges = [f"{start}:{length}" for start, length in PROJECT_HOST_RUNTIME_SUBID_RANGES]
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
    cfg: BootstrapConfig, *, uid: int, gid: int, runtime_dir: str
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
    for path in (rootless_run, runtime_tmp):
        if path.exists():
            shutil.rmtree(path)
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
        try:
            repair_stale_podman_boot_state(
                cfg,
                uid=pw.pw_uid,
                gid=pw.pw_gid,
                runtime_dir=runtime_dir,
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


def build_bootstrap_connection(cfg: BootstrapConfig) -> dict[str, Any]:
    return {
        "conat_url": cfg.conat_url,
        "status_url": cfg.status_url,
        "bootstrap_token": cfg.bootstrap_token,
        "ca_cert_path": cfg.ca_cert_path,
    }


def build_desired_state(cfg: BootstrapConfig) -> dict[str, Any]:
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "recorded_at": now_iso(),
        "bootstrap": {
            "selector": cfg.bootstrap_selector,
            "url": cfg.bootstrap_py_url,
            "sha256": current_bootstrap_sha256(),
        },
        "helper_schema_version": HELPER_SCHEMA_VERSION,
        "runtime_wrapper_version": RUNTIME_WRAPPER_VERSION,
        "node_version": cfg.node_version,
        "image_size_gb_raw": cfg.image_size_gb_raw,
        "root_reserve_gb_raw": cfg.root_reserve_gb_raw,
        "apt_packages": cfg.apt_packages,
        "env_lines": cfg.env_lines,
        "bootstrap_done_paths": cfg.bootstrap_done_paths,
        "shared_scratch": {
            "enabled": cfg.shared_scratch_enabled,
            "mount": cfg.shared_scratch_mount,
            "project_mount": cfg.shared_scratch_project_mount,
            "filesystem": cfg.shared_scratch_filesystem,
        },
        "project_io_capacity": cfg.project_io_capacity,
        "project_io_policy": cfg.project_io_policy,
        "runtime_user_contract": expected_runtime_user_contract(cfg),
        "bootstrap_connection": build_bootstrap_connection(cfg),
        "project_host_bundle": {
            "url": cfg.project_host_bundle.url,
            "sha256": cfg.project_host_bundle.sha256,
            "remote": cfg.project_host_bundle.remote,
            "version": cfg.project_host_bundle.version,
            "root": cfg.project_host_bundle.root,
            "dir": cfg.project_host_bundle.dir,
            "current": cfg.project_host_bundle.current,
        },
        "project_bundle": {
            "url": cfg.project_bundle.url,
            "sha256": cfg.project_bundle.sha256,
            "remote": cfg.project_bundle.remote,
            "version": cfg.project_bundle.version,
            "root": cfg.project_bundle.root,
            "dir": cfg.project_bundle.dir,
            "current": cfg.project_bundle.current,
        },
        "tools_bundle": {
            "url": cfg.tools_bundle.url,
            "sha256": cfg.tools_bundle.sha256,
            "remote": cfg.tools_bundle.remote,
            "version": cfg.tools_bundle.version,
            "root": cfg.tools_bundle.root,
            "dir": cfg.tools_bundle.dir,
            "current": cfg.tools_bundle.current,
            "manifest_url": cfg.tools_bundle.manifest_url,
        },
        "cloudflared": {
            "enabled": cfg.cloudflared.enabled,
            "hostname": cfg.cloudflared.hostname,
            "app_public_wildcard": cfg.cloudflared.app_public_wildcard,
            "exam_hostname": cfg.cloudflared.exam_hostname,
            "port": cfg.cloudflared.port,
            "ssh_hostname": cfg.cloudflared.ssh_hostname,
            "ssh_port": cfg.cloudflared.ssh_port,
            "tunnel_id": cfg.cloudflared.tunnel_id,
            "protocol": cfg.cloudflared.protocol,
            "grace_period_seconds": cfg.cloudflared.grace_period_seconds,
        },
    }
    if cfg.container_runtime_bundle is not None:
        state["container_runtime_bundle"] = {
            "url": cfg.container_runtime_bundle.url,
            "sha256": cfg.container_runtime_bundle.sha256,
            "remote": cfg.container_runtime_bundle.remote,
            "version": cfg.container_runtime_bundle.version,
            "root": cfg.container_runtime_bundle.root,
            "dir": cfg.container_runtime_bundle.dir,
            "current": cfg.container_runtime_bundle.current,
            "manifest_url": cfg.container_runtime_bundle.manifest_url,
        }
    return state


def refresh_installed_state(cfg: BootstrapConfig, base: dict[str, Any] | None = None) -> dict[str, Any]:
    state = dict(base or {})
    state["schema_version"] = STATE_SCHEMA_VERSION
    state["recorded_at"] = now_iso()
    state["bootstrap"] = {
        "sha256": current_bootstrap_sha256(),
        "url": cfg.bootstrap_py_url,
        "selector": cfg.bootstrap_selector,
    }
    state["helper_schema_version"] = helper_schema_installed(cfg)
    state["runtime_wrapper_version"] = runtime_wrapper_version_installed()
    state["runtime_user_contract"] = read_current_runtime_user_contract(cfg)
    state["installed"] = {
        "project_host_bundle_version": symlink_version(cfg.project_host_bundle.current),
        "project_bundle_version": symlink_version(cfg.project_bundle.current),
        "tools_bundle_version": symlink_version(cfg.tools_bundle.current),
        "container_runtime_version": (
            symlink_version(cfg.container_runtime_bundle.current)
            if cfg.container_runtime_bundle is not None
            else None
        ),
    }
    return state


def write_bootstrap_state_files(cfg: BootstrapConfig) -> None:
    json_write_atomic(bootstrap_host_facts_path(cfg), build_host_facts(cfg))
    json_write_atomic(bootstrap_desired_state_path(cfg), build_desired_state(cfg))
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def _selected_fields(source: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    return {field: source[field] for field in fields if field in source}


def write_bootstrap_lifecycle_export(cfg: BootstrapConfig) -> None:
    """Publish only the non-secret state needed by project-host heartbeats."""
    desired = json_load(bootstrap_desired_state_path(cfg))
    installed = json_load(bootstrap_state_path(cfg))
    facts = json_load(bootstrap_host_facts_path(cfg))
    public_desired = _selected_fields(
        desired,
        [
            "schema_version",
            "recorded_at",
            "helper_schema_version",
            "runtime_wrapper_version",
            "runtime_user_contract",
        ],
    )
    public_desired["bootstrap"] = _selected_fields(
        desired.get("bootstrap") or {}, ["selector", "url", "sha256"]
    )
    for key in (
        "project_host_bundle",
        "project_bundle",
        "tools_bundle",
        "container_runtime_bundle",
    ):
        fields = ["version"]
        if key == "project_host_bundle":
            fields.append("root")
        public_desired[key] = _selected_fields(desired.get(key) or {}, fields)
    public_desired["cloudflared"] = _selected_fields(
        desired.get("cloudflared") or {}, ["enabled"]
    )

    public_installed = _selected_fields(
        installed,
        [
            "schema_version",
            "recorded_at",
            "helper_schema_version",
            "runtime_wrapper_version",
            "runtime_user_contract",
            "installed",
            "current_operation",
            "last_error",
            "last_provision_started_at",
            "last_provision_finished_at",
            "last_provision_result",
            "last_reconcile_started_at",
            "last_reconcile_finished_at",
            "last_reconcile_result",
            "provisioned",
        ],
    )
    public_installed["bootstrap"] = _selected_fields(
        installed.get("bootstrap") or {}, ["selector", "url", "sha256"]
    )
    public_facts = _selected_fields(
        facts,
        [
            "schema_version",
            "recorded_at",
            "bootstrap_root",
            "project_host_bundle_root",
        ],
    )

    export_dir = BOOTSTRAP_LIFECYCLE_EXPORT_DIR
    export_dir.mkdir(parents=True, exist_ok=True)
    export_dir.chmod(0o755)
    exports = {
        "bootstrap-desired-state.json": public_desired,
        "bootstrap-state.json": public_installed,
        "bootstrap-host-facts.json": public_facts,
    }
    for name, payload in exports.items():
        path = export_dir / name
        json_write_atomic(path, payload)
        path.chmod(0o644)


def record_operation_start(cfg: BootstrapConfig, operation: str) -> None:
    write_bootstrap_state_files(cfg)
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_started_at"] = now_iso()
    state[f"last_{operation}_result"] = "running"
    state["current_operation"] = operation
    state["last_error"] = None
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def record_operation_success(cfg: BootstrapConfig, operation: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "success"
    state["current_operation"] = None
    state["last_error"] = None
    if operation == "provision":
        state["provisioned"] = True
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def record_operation_failure(cfg: BootstrapConfig, operation: str, error: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "error"
    state["current_operation"] = None
    state["last_error"] = error
    json_write_atomic(bootstrap_state_path(cfg), state)
    write_bootstrap_lifecycle_export(cfg)


def log_line(cfg: BootstrapConfig, message: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"{ts} {message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if cfg.log_file:
        Path(cfg.log_file).parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(cfg.log_file, "a", encoding="utf-8") as handle:
                handle.write(line)
        except PermissionError:
            pass


def rotate_bootstrap_log(cfg: BootstrapConfig) -> None:
    if not cfg.log_file:
        return
    log_path = Path(cfg.log_file)
    try:
        if not log_path.exists() or log_path.stat().st_size <= BOOTSTRAP_LOG_MAX_BYTES:
            return
        rotated = log_path.with_name(f"{log_path.name}.1")
        if rotated.exists():
            rotated.unlink()
        log_path.rename(rotated)
    except OSError:
        pass


def run_cmd(
    cfg: BootstrapConfig,
    args: list[str],
    desc: str,
    *,
    timeout: int | None = None,
    check: bool = True,
    as_user: str | None = None,
    env: dict[str, str] | None = None,
    cwd: str | Path | None = None,
) -> subprocess.CompletedProcess[str]:
    cmd = args
    if as_user and os.geteuid() == 0 and as_user != "root":
        cmd = ["sudo", "-u", as_user, "-H"] + args
    run_cwd = str(cwd) if cwd is not None else None
    cwd_label = f" cwd={run_cwd}" if run_cwd else ""
    log_line(cfg, f"bootstrap: running {desc}{cwd_label}: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        env=env,
        cwd=run_cwd,
    )
    if result.stdout:
        for line in result.stdout.splitlines():
            log_line(cfg, line)
    if check and result.returncode != 0:
        raise RuntimeError(f"{desc} failed with exit code {result.returncode}")
    return result


def run_best_effort(
    cfg: BootstrapConfig,
    args: list[str],
    desc: str,
    *,
    timeout: int | None = None,
) -> None:
    try:
        run_cmd(cfg, args, desc, check=False, timeout=timeout)
    except Exception as exc:
        log_line(cfg, f"bootstrap: {desc} failed (ignored): {exc}")


def install_nvidia_cdi_normalizer() -> None:
    path = Path("/usr/local/sbin/cocalc-nvidia-cdi-normalize")
    path.write_text(NVIDIA_CDI_NORMALIZER_SCRIPT, encoding="utf-8")
    os.chmod(path, 0o755)


def normalize_nvidia_cdi_for_podman(cfg: BootstrapConfig) -> None:
    # Ubuntu 24.04 currently ships Podman 4.9, which does not understand the
    # NVIDIA Toolkit 1.19 default CDI 0.7 spec. Normalize to the older subset
    # that Podman 4 accepts so rootless project containers can resolve GPUs.
    run_best_effort(
        cfg,
        ["/usr/local/sbin/cocalc-nvidia-cdi-normalize"],
        "normalize nvidia cdi for podman",
    )


def ensure_platform(cfg: BootstrapConfig) -> None:
    os_name = os.uname().sysname.lower()
    if os_name != cfg.expected_os:
        raise RuntimeError(f"unsupported OS {os_name} (expected {cfg.expected_os})")
    arch_raw = os.uname().machine
    if arch_raw in ("x86_64", "amd64"):
        arch = "amd64"
    elif arch_raw in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        raise RuntimeError(f"unsupported architecture {arch_raw}")
    if arch != cfg.expected_arch:
        raise RuntimeError(f"unsupported architecture {arch} (expected {cfg.expected_arch})")


def compute_root_reserve_gb(cfg: BootstrapConfig) -> int:
    raw = cfg.root_reserve_gb_raw
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 15


def compute_image_size(cfg: BootstrapConfig) -> int:
    raw = cfg.image_size_gb_raw
    if raw and raw != "auto":
        try:
            return max(5, int(raw))
        except ValueError:
            pass
    usage = shutil.disk_usage("/")
    total_gb = int(usage.total / (1024**3))
    reserve_gb = compute_root_reserve_gb(cfg)
    target = total_gb - reserve_gb
    if target < 5:
        target = 5
    log_line(
        cfg,
        f"bootstrap: computed btrfs image size {target}G (disk {total_gb}G, reserve {reserve_gb}G)",
    )
    return target


def disable_unattended(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: pausing automatic apt activity")
    run_best_effort(
        cfg,
        [
            "systemctl",
            "stop",
            "apt-daily.timer",
            "apt-daily-upgrade.timer",
            "apt-daily.service",
            "apt-daily-upgrade.service",
            "cocalc-security-updates.timer",
            "cocalc-security-updates.service",
        ],
        "stop automatic apt timers and services",
        timeout=APT_LOCK_TIMEOUT_S,
    )


def apt_run(cfg: BootstrapConfig, args: list[str], desc: str, retries: int, timeout: int) -> None:
    for attempt in range(1, retries + 1):
        try:
            run_cmd(cfg, args, desc, timeout=timeout)
            return
        except Exception as exc:
            if attempt == retries:
                raise
            log_line(cfg, f"bootstrap: {desc} failed (attempt {attempt}/{retries}): {exc}")
            time.sleep(5 if desc == "apt-get update" else 10)


def reconcile_gce_ubuntu_apt_sources(
    cfg: BootstrapConfig, paths: list[Path] | None = None
) -> None:
    source_paths = paths or [
        Path("/etc/apt/sources.list.d/ubuntu.sources"),
        Path("/etc/apt/sources.list"),
    ]
    mirror: str | None = None
    existing: list[tuple[Path, str]] = []
    for path in source_paths:
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            log_line(cfg, f"bootstrap: unable to read apt sources from {path}: {exc}")
            continue
        existing.append((path, text))
        if mirror is None:
            match = GCE_UBUNTU_MIRROR_RE.search(text)
            if match:
                mirror = match.group(0).rstrip("/")
    if mirror is None:
        return
    for path, text in existing:
        updated = (
            text.replace("https://security.ubuntu.com/ubuntu/", f"{mirror}/")
            .replace("http://security.ubuntu.com/ubuntu/", f"{mirror}/")
            .replace("https://security.ubuntu.com/ubuntu", mirror)
            .replace("http://security.ubuntu.com/ubuntu", mirror)
        )
        if updated == text:
            continue
        path.write_text(updated, encoding="utf-8")
        log_line(
            cfg,
            f"bootstrap: rewrote Ubuntu security mirror in {path} to {mirror}",
        )


def apt_update_install(cfg: BootstrapConfig) -> None:
    reconcile_gce_ubuntu_apt_sources(cfg)
    log_line(cfg, "bootstrap: updating apt package lists")
    apt_opts = [
        "-y",
        "-o",
        "Acquire::ForceIPv4=true",
        "-o",
        f"Acquire::Retries={APT_RETRIES}",
        "-o",
        f"Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S}",
    ]
    apt_run(
        cfg,
        ["apt-get", *apt_opts, "update"],
        "apt-get update",
        retries=APT_RETRIES,
        timeout=APT_UPDATE_TIMEOUT_S,
    )
    log_line(cfg, "bootstrap: installing base packages")
    apt_install_opts = (
        apt_opts
        + ["--no-install-recommends", "install"]
        + effective_apt_packages(cfg)
    )
    apt_run(
        cfg,
        ["apt-get", *apt_install_opts],
        "apt-get install",
        retries=APT_RETRIES,
        timeout=APT_INSTALL_TIMEOUT_S,
    )


def ensure_automatic_security_updates(
    cfg: BootstrapConfig,
    *,
    config_path: Path = Path("/etc/apt/apt.conf.d/52cocalc-periodic"),
    helper_path: Path = Path("/usr/local/sbin/cocalc-security-update"),
    service_path: Path = Path(
        "/etc/systemd/system/cocalc-security-updates.service"
    ),
    timer_path: Path = Path("/etc/systemd/system/cocalc-security-updates.timer"),
    status_dir: Path = Path("/var/lib/cocalc/security-updates"),
) -> None:
    log_line(cfg, "bootstrap: configuring automatic security updates")
    reconcile_gce_ubuntu_apt_sources(cfg)
    apt_opts = [
        "-y",
        "-o",
        "Acquire::ForceIPv4=true",
        "-o",
        f"Acquire::Retries={APT_RETRIES}",
        "-o",
        f"Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S}",
        "-o",
        f"DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S}",
    ]
    apt_run(
        cfg,
        ["apt-get", *apt_opts, "update"],
        "apt-get update for automatic security updates",
        retries=APT_RETRIES,
        timeout=APT_UPDATE_TIMEOUT_S,
    )
    apt_run(
        cfg,
        [
            "apt-get",
            *apt_opts,
            "--no-install-recommends",
            "install",
            "unattended-upgrades",
        ],
        "install unattended-upgrades",
        retries=APT_RETRIES,
        timeout=APT_INSTALL_TIMEOUT_S,
    )
    if shutil.which("unattended-upgrade") is None:
        raise RuntimeError("unattended-upgrade executable is missing after install")
    text_write_atomic(config_path, AUTOMATIC_SECURITY_UPDATES_CONFIG)
    status_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(status_dir, 0o755)
    status_dir_shell = shlex.quote(str(status_dir))
    helper = f"""#!/usr/bin/env bash
set -euo pipefail
umask 022

STATUS_DIR={status_dir_shell}
STATUS_FILE="$STATUS_DIR/status.json"
LOCK_FILE=/run/lock/cocalc-security-updates.lock

mkdir -p "$STATUS_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status() {{
  local result="$1" exit_code="$2" finished_at tmp
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp "$STATUS_DIR/.status.XXXXXX")"
  printf '{{\n  "schema": "cocalc-security-updates-v1",\n  "result": "%s",\n  "exit_code": %s,\n  "started_at": "%s",\n  "finished_at": "%s"\n}}\n' \
    "$result" "$exit_code" "$STARTED_AT" "$finished_at" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATUS_FILE"
}}
record_failure() {{
  local exit_code="$?"
  set +e
  write_status failed "$exit_code"
}}
trap record_failure EXIT

write_status running 0
export DEBIAN_FRONTEND=noninteractive
apt-get -y \
  -o Acquire::ForceIPv4=true \
  -o Acquire::Retries={APT_RETRIES} \
  -o Acquire::http::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o Acquire::https::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o Acquire::ftp::Timeout={APT_ACQUIRE_TIMEOUT_S} \
  -o DPkg::Lock::Timeout={APT_LOCK_TIMEOUT_S} \
  update
unattended-upgrade --verbose
write_status ok 0
trap - EXIT
"""
    text_write_atomic(helper_path, helper, default_mode=0o755)
    os.chmod(helper_path, 0o755)
    service = f"""[Unit]
Description=Install CoCalc project-host security updates
Wants=network-online.target
After=network-online.target
ConditionPathIsExecutable={helper_path}

[Service]
Type=oneshot
ExecStart={helper_path}
TimeoutStartSec=45min
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=10
IOWeight=10
UMask=0022
"""
    timer = """[Unit]
Description=Daily CoCalc project-host security updates

[Timer]
OnCalendar=*-*-* 05:00:00 UTC
RandomizedDelaySec=3h
FixedRandomDelay=true
Persistent=true
AccuracySec=1min
Unit=cocalc-security-updates.service

[Install]
WantedBy=timers.target
"""
    text_write_atomic(service_path, service)
    text_write_atomic(timer_path, timer)
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd security update units",
        timeout=30,
    )
    run_cmd(
        cfg,
        [
            "systemctl",
            "disable",
            "--now",
            "apt-daily.timer",
            "apt-daily-upgrade.timer",
        ],
        "disable distro automatic apt timers",
        timeout=APT_LOCK_TIMEOUT_S,
    )
    run_cmd(
        cfg,
        [
            "systemctl",
            "enable",
            "--now",
            "cocalc-security-updates.timer",
        ],
        "enable managed security update timer",
        timeout=APT_LOCK_TIMEOUT_S,
    )
    for timer in ("cocalc-security-updates.timer",):
        run_cmd(
            cfg,
            ["systemctl", "is-enabled", timer],
            f"verify {timer} enabled",
            timeout=30,
        )
        run_cmd(
            cfg,
            ["systemctl", "is-active", timer],
            f"verify {timer} active",
            timeout=30,
        )


def node_major_version(node_version: str) -> int:
    match = re.match(r"^v?(\d+)(?:\.|$)", node_version.strip())
    if not match:
        return 0
    return int(match.group(1))


def effective_apt_packages(cfg: BootstrapConfig) -> list[str]:
    packages = list(cfg.apt_packages)
    if node_major_version(cfg.node_version) >= 26:
        existing = set(packages)
        for package in NODE_RUNTIME_APT_PACKAGES:
            if package not in existing:
                packages.append(package)
                existing.add(package)
    return packages


def configure_chrony(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring time sync")
    run_best_effort(cfg, ["systemctl", "disable", "--now", "systemd-timesyncd"], "disable timesyncd")
    run_best_effort(cfg, ["systemctl", "enable", "--now", "chrony"], "enable chrony")
    chrony_conf = "pool pool.ntp.org iburst maxsources 4\nmakestep 1.0 -1\nrtcsync\n"
    Path("/etc/chrony/chrony.conf").write_text(chrony_conf, encoding="utf-8")
    run_best_effort(cfg, ["systemctl", "restart", "chrony"], "restart chrony")


def configure_journald_limits(
    cfg: BootstrapConfig,
    *,
    dropin_dir: Path = Path("/etc/systemd/journald.conf.d"),
) -> None:
    if shutil.which("systemctl") is None:
        return
    log_line(cfg, "bootstrap: configuring journald disk limits")
    dropin_dir.mkdir(parents=True, exist_ok=True)
    dropin = dropin_dir / "90-cocalc-root-disk.conf"
    content = "[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=100M\n"
    try:
        changed = dropin.read_text(encoding="utf-8") != content
    except OSError:
        changed = True
    if not changed:
        log_line(cfg, "bootstrap: journald disk limits already current")
        return
    dropin.write_text(content, encoding="utf-8")
    run_best_effort(
        cfg,
        ["systemctl", "restart", "--no-block", "systemd-journald"],
        "queue systemd-journald restart",
        timeout=15,
    )
    if shutil.which("journalctl") is not None:
        run_best_effort(
            cfg,
            ["journalctl", "--vacuum-size=200M"],
            "vacuum systemd journal",
            timeout=60,
        )


def configure_daily_root_cleanup(
    cfg: BootstrapConfig,
    *,
    helper_path: Path = Path("/usr/local/sbin/cocalc-root-cleanup"),
    service_path: Path = Path(
        "/etc/systemd/system/cocalc-root-cleanup.service"
    ),
    timer_path: Path = Path("/etc/systemd/system/cocalc-root-cleanup.timer"),
    status_dir: Path = Path("/var/lib/cocalc/root-cleanup"),
) -> None:
    log_line(cfg, "bootstrap: configuring daily safe root cleanup")
    if status_dir.is_symlink():
        raise RuntimeError(
            f"root cleanup status directory is a symlink: {status_dir}"
        )
    status_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(status_dir, 0o755)
    helper = f"""#!/usr/bin/env bash
set -uo pipefail
umask 022

STATUS_DIR={shlex.quote(str(status_dir))}
STATUS_FILE="$STATUS_DIR/status.json"
LOCK_FILE="$STATUS_DIR/cleanup.lock"
MIN_FREE_BYTES=$((5 * 1024 * 1024 * 1024))
DRY_RUN=0

case "${{1:-}}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

mkdir -p "$STATUS_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

dir_bytes() {{
  local total=0 path value
  for path in "$@"; do
    [ -e "$path" ] || continue
    value="$(du -sx -B1 -- "$path" 2>/dev/null | cut -f1)"
    if echo "$value" | grep -Eq '^[0-9]+$'; then
      total=$((total + value))
    fi
  done
  echo "$total"
}}

freed_bytes() {{
  local before="$1" after="$2"
  if [ "$before" -gt "$after" ]; then
    echo $((before - after))
  else
    echo 0
  fi
}}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ROOT_FREE_BEFORE="$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')"
SNAP_BEFORE="$(dir_bytes /var/lib/snapd/cache)"
APT_BEFORE="$(dir_bytes /var/cache/apt)"
JOURNAL_BEFORE="$(dir_bytes /var/log/journal /run/log/journal)"
RUSTIC_BEFORE="$(dir_bytes /root/.cache/rustic)"

# Every path below is an explicit cache or bounded log location. Do not add
# release directories or project data without a separate retention design.
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -d /var/lib/snapd/cache ] && [ ! -L /var/lib/snapd/cache ]; then
    find /var/lib/snapd/cache -xdev -type f -delete 2>/dev/null || true
  fi
  if command -v apt-get >/dev/null 2>&1; then
    flock -n /run/lock/cocalc-security-updates.lock \
      timeout 10m apt-get clean >/dev/null 2>&1 || true
  fi
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  fi
  if [ -d /root/.cache/rustic ] && [ ! -L /root/.cache/rustic ]; then
    flock -n /run/lock/cocalc-privileged-rustic-cache.lock \
      bash -c 'if ! pgrep -x rustic >/dev/null 2>&1; then
        find /root/.cache/rustic -mindepth 1 -maxdepth 1 \
          ! -name CACHEDIR.TAG -exec rm -rf --one-file-system -- {{}} +
      fi' >/dev/null 2>&1 || true
  fi
fi

SNAP_AFTER="$(dir_bytes /var/lib/snapd/cache)"
APT_AFTER="$(dir_bytes /var/cache/apt)"
JOURNAL_AFTER="$(dir_bytes /var/log/journal /run/log/journal)"
RUSTIC_AFTER="$(dir_bytes /root/.cache/rustic)"
ROOT_FREE_AFTER="$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')"
RESULT=ok
if [ "$DRY_RUN" -eq 1 ]; then
  RESULT=dry-run
elif ! echo "$ROOT_FREE_AFTER" | grep -Eq '^[0-9]+$' || \
   [ "$ROOT_FREE_AFTER" -lt "$MIN_FREE_BYTES" ]; then
  RESULT=insufficient
fi
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp "$STATUS_DIR/.status.XXXXXX")"
printf '{{\n  "schema": "cocalc-root-cleanup-v1",\n  "result": "%s",\n  "started_at": "%s",\n  "finished_at": "%s",\n  "root_free_before_bytes": %s,\n  "root_free_after_bytes": %s,\n  "snap_freed_bytes": %s,\n  "apt_freed_bytes": %s,\n  "journal_freed_bytes": %s,\n  "privileged_rustic_freed_bytes": %s\n}}\n' \
  "$RESULT" "$STARTED_AT" "$FINISHED_AT" \
  "${{ROOT_FREE_BEFORE:-0}}" "${{ROOT_FREE_AFTER:-0}}" \
  "$(freed_bytes "$SNAP_BEFORE" "$SNAP_AFTER")" \
  "$(freed_bytes "$APT_BEFORE" "$APT_AFTER")" \
  "$(freed_bytes "$JOURNAL_BEFORE" "$JOURNAL_AFTER")" \
  "$(freed_bytes "$RUSTIC_BEFORE" "$RUSTIC_AFTER")" >"$TMP"
chmod 0644 "$TMP"
mv -f "$TMP" "$STATUS_FILE"
logger -t cocalc-root-cleanup \
  "result=$RESULT root_free_before=${{ROOT_FREE_BEFORE:-unknown}} root_free_after=${{ROOT_FREE_AFTER:-unknown}}"
"""
    text_write_atomic(helper_path, helper, default_mode=0o755)
    os.chmod(helper_path, 0o755)
    service = f"""[Unit]
Description=Reclaim safe CoCalc project-host root caches
ConditionPathIsExecutable={helper_path}

[Service]
Type=oneshot
ExecStart={helper_path}
TimeoutStartSec=30min
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=5
IOWeight=5
UMask=0022
"""
    timer = """[Unit]
Description=Daily safe CoCalc project-host root cleanup

[Timer]
OnCalendar=*-*-* 10:00:00 UTC
RandomizedDelaySec=2h
FixedRandomDelay=true
Persistent=true
AccuracySec=5min
Unit=cocalc-root-cleanup.service

[Install]
WantedBy=timers.target
"""
    text_write_atomic(service_path, service)
    text_write_atomic(timer_path, timer)
    run_cmd(
        cfg,
        ["systemctl", "daemon-reload"],
        "reload systemd root cleanup units",
        timeout=30,
    )
    run_cmd(
        cfg,
        ["systemctl", "enable", "--now", "cocalc-root-cleanup.timer"],
        "enable safe root cleanup timer",
        timeout=30,
    )
    for check in ("is-enabled", "is-active"):
        run_cmd(
            cfg,
            ["systemctl", check, "cocalc-root-cleanup.timer"],
            f"verify root cleanup timer {check}",
            timeout=30,
        )


RSYSLOG_LOGROTATE_CONTENT = """/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
    daily
    rotate 3
    maxsize 256M
    missingok
    notifempty
    compress
    sharedscripts
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}
"""

RSYSLOG_EMERGENCY_WALL_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<rule>\*\.emerg[ \t]+:omusrmsg:\*[ \t]*(?:#.*)?)$",
    re.MULTILINE,
)
RSYSLOG_CONSOLE_OUTPUT_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<rule>[^#\s][^\n]*[ \t]+-?/dev/console[ \t]*(?:#.*)?)$",
    re.MULTILINE,
)
RSYSLOG_HEADLESS_OUTPUT_COMMENT = (
    "# CoCalc headless hosts retain emergency messages in syslog and journald."
)


def disable_rsyslog_headless_outputs(config_dir: Path) -> bool:
    changed = False
    for config_path in sorted(config_dir.glob("*.conf")):
        changed = disable_rsyslog_headless_outputs_in_file(config_path) or changed
    return changed


def disable_rsyslog_headless_outputs_in_file(config_path: Path) -> bool:
    try:
        content = config_path.read_text(encoding="utf-8")
    except OSError:
        return False

    def comment_rule(match: re.Match[str]) -> str:
        indent = match.group("indent")
        rule = match.group("rule").rstrip()
        return (
            f"{indent}{RSYSLOG_HEADLESS_OUTPUT_COMMENT}\n"
            f"{indent}# {rule}"
        )

    updated, wall_count = RSYSLOG_EMERGENCY_WALL_RE.subn(comment_rule, content)
    updated, console_count = RSYSLOG_CONSOLE_OUTPUT_RE.subn(
        comment_rule, updated
    )
    if wall_count + console_count == 0:
        return False
    config_path.write_text(updated, encoding="utf-8")
    return True


def configure_rsyslog_limits(
    cfg: BootstrapConfig,
    *,
    logrotate_path: Path = Path("/etc/logrotate.d/rsyslog"),
    rsyslog_config_dir: Path = Path("/etc/rsyslog.d"),
) -> None:
    if not logrotate_path.parent.exists():
        return
    log_line(cfg, "bootstrap: configuring classic system log limits")
    try:
        logrotate_changed = (
            logrotate_path.read_text(encoding="utf-8")
            != RSYSLOG_LOGROTATE_CONTENT
        )
    except OSError:
        logrotate_changed = True
    if logrotate_changed:
        logrotate_path.write_text(RSYSLOG_LOGROTATE_CONTENT, encoding="utf-8")
    headless_outputs_changed = disable_rsyslog_headless_outputs(
        rsyslog_config_dir
    )
    if not logrotate_changed and not headless_outputs_changed:
        log_line(cfg, "bootstrap: classic system log limits already current")
        return
    if shutil.which("systemctl") is None:
        return
    if logrotate_changed:
        run_best_effort(
            cfg,
            ["systemctl", "start", "--no-block", "logrotate.service"],
            "queue classic system log rotation",
            timeout=15,
        )
    if headless_outputs_changed:
        run_best_effort(
            cfg,
            ["systemctl", "restart", "--no-block", "rsyslog.service"],
            "queue rsyslog restart after disabling interactive delivery",
            timeout=15,
        )


ALGIF_AEAD_DISABLE_CONF = (
    'install algif_aead /bin/false\n'
)

def configure_kernel_module_hardening(
    cfg: BootstrapConfig,
    *,
    modprobe_dir: Path = Path("/etc/modprobe.d"),
) -> None:
    log_line(cfg, "bootstrap: disabling algif_aead kernel module")
    modprobe_dir.mkdir(parents=True, exist_ok=True)
    conf = modprobe_dir / "disable-algif-aead.conf"
    conf.write_text(ALGIF_AEAD_DISABLE_CONF, encoding="utf-8")
    run_best_effort(cfg, ["rmmod", "algif_aead"], "unload algif_aead")


def configure_kernel_key_limits(
    cfg: BootstrapConfig,
    *,
    sysctl_dir: Path = Path("/etc/sysctl.d"),
) -> None:
    log_line(cfg, "bootstrap: configuring kernel key quotas for rootless containers")
    sysctl_dir.mkdir(parents=True, exist_ok=True)
    conf = sysctl_dir / "60-cocalc-project-host-keyring.conf"
    conf.unlink(missing_ok=True)
    run_best_effort(cfg, ["sysctl", "-w", "kernel.keys.maxkeys=20000"], "sysctl kernel.keys.maxkeys")
    run_best_effort(cfg, ["sysctl", "-w", "kernel.keys.maxbytes=25000000"], "sysctl kernel.keys.maxbytes")


def configure_inotify_limits(
    cfg: BootstrapConfig,
    *,
    sysctl_dir: Path = Path("/etc/sysctl.d"),
) -> None:
    log_line(cfg, "bootstrap: configuring inotify limits for project workloads")
    sysctl_dir.mkdir(parents=True, exist_ok=True)
    conf = sysctl_dir / "60-cocalc-project-host-inotify.conf"
    conf.unlink(missing_ok=True)
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_user_instances=8192"],
        "sysctl fs.inotify.max_user_instances",
    )
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_user_watches=2097152"],
        "sysctl fs.inotify.max_user_watches",
    )
    run_best_effort(
        cfg,
        ["sysctl", "-w", "fs.inotify.max_queued_events=65536"],
        "sysctl fs.inotify.max_queued_events",
    )


def detect_public_ip(cfg: BootstrapConfig) -> str | None:
    for url in ("https://api.ipify.org", "https://ifconfig.me"):
        try:
            log_line(cfg, f"bootstrap: detecting public IP via {url}")
            with urllib.request.urlopen(url, timeout=10) as resp:
                value = resp.read().decode("utf-8").strip()
            if value:
                return value
        except Exception:
            continue
    log_line(cfg, "bootstrap: could not determine public IP")
    return None


def substitute_public_ip(cfg: BootstrapConfig) -> None:
    if not any("$PUBLIC_IP" in line for line in cfg.env_lines):
        return
    public_ip = detect_public_ip(cfg)
    if not public_ip:
        return
    cfg.env_lines[:] = [line.replace("$PUBLIC_IP", public_ip) for line in cfg.env_lines]


def enable_userns(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: enabling unprivileged user namespaces")
    run_best_effort(cfg, ["sysctl", "-w", "kernel.unprivileged_userns_clone=1"], "sysctl userns")


def ensure_runtime_user(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    try:
        group = grp.getgrnam(user)
        if group.gr_gid != desired_gid:
            raise RuntimeError(
                f"runtime group {user} has gid {group.gr_gid}, expected {desired_gid}; reprovision the host"
            )
    except KeyError:
        try:
            existing = grp.getgrgid(desired_gid)
            raise RuntimeError(
                f"runtime gid {desired_gid} is already owned by group {existing.gr_name}; reprovision the host"
            )
        except KeyError:
            log_line(cfg, f"bootstrap: creating runtime group {user} gid={desired_gid}")
            run_cmd(
                cfg,
                ["groupadd", "-g", str(desired_gid), user],
                "create runtime group",
            )
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        try:
            existing = pwd.getpwuid(desired_uid)
            raise RuntimeError(
                f"runtime uid {desired_uid} is already owned by user {existing.pw_name}; reprovision the host"
            )
        except KeyError:
            log_line(cfg, f"bootstrap: creating runtime user {user} uid={desired_uid} gid={desired_gid}")
            run_cmd(
                cfg,
                [
                    "useradd",
                    "-m",
                    "-u",
                    str(desired_uid),
                    "-g",
                    str(desired_gid),
                    "-s",
                    "/bin/bash",
                    user,
                ],
                "create runtime user",
            )
        pw = pwd.getpwnam(user)
    if pw.pw_uid != desired_uid or pw.pw_gid != desired_gid:
        raise RuntimeError(
            f"runtime user {user} has uid/gid {pw.pw_uid}:{pw.pw_gid}, expected {desired_uid}:{desired_gid}; reprovision the host"
        )
    home = pw.pw_dir or f"/home/{user}"
    Path(home).mkdir(parents=True, exist_ok=True)
    run_best_effort(cfg, ["chown", f"{user}:{user}", home], "chown runtime home")


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


def ensure_subuids(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: ensuring subuid/subgid ranges for {cfg.ssh_user}")
    changed_subuid = ensure_exact_subid_file(
        Path("/etc/subuid"), cfg.ssh_user, PROJECT_HOST_RUNTIME_SUBID_RANGES
    )
    changed_subgid = ensure_exact_subid_file(
        Path("/etc/subgid"), cfg.ssh_user, PROJECT_HOST_RUNTIME_SUBID_RANGES
    )
    if changed_subuid or changed_subgid:
        log_line(
            cfg,
            "bootstrap: set exact subuid/subgid allocation "
            f"for {cfg.ssh_user} to "
            + ", ".join(f"{start}:{length}" for start, length in PROJECT_HOST_RUNTIME_SUBID_RANGES),
        )


def verify_runtime_user_contract(cfg: BootstrapConfig) -> None:
    desired = expected_runtime_user_contract(cfg)
    installed = read_current_runtime_user_contract(cfg)
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
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, 0o700)


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
        ensure_owned_runtime_dir(Path(configured_runtime), uid, gid)


def prepare_dirs(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: preparing cocalc directories")
    for path in ["/opt/cocalc", "/var/lib/cocalc", "/etc/cocalc", "/mnt/cocalc"]:
        Path(path).mkdir(parents=True, exist_ok=True)
    run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", "/opt/cocalc", "/var/lib/cocalc"], "chown cocalc dirs")


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


def repair_host_data_ownership(cfg: BootstrapConfig) -> None:
    if cfg.ssh_user == "root":
        return
    desired_uid, desired_gid = resolve_runtime_user_identity(cfg)
    data_root = Path("/mnt/cocalc/data")
    recursive_targets: list[str] = []
    top_level_dir_targets: list[str] = []
    file_targets: list[str] = []

    for dirname in HOST_OWNED_DATA_TREE_DIRS:
        path = data_root / dirname
        if tree_has_unexpected_ownership(path, desired_uid, desired_gid):
            recursive_targets.append(str(path))
    for dirname in HOST_OWNED_DATA_TOPLEVEL_DIRS:
        path = data_root / dirname
        if path_has_unexpected_ownership(path, desired_uid, desired_gid):
            top_level_dir_targets.append(str(path))

    try:
        for child in data_root.iterdir():
            if not child.is_file():
                continue
            if child.name not in HOST_OWNED_DATA_FILES and not HOST_OWNED_SQLITE_RE.match(
                child.name
            ):
                continue
            if path_has_unexpected_ownership(child, desired_uid, desired_gid):
                file_targets.append(str(child))
    except FileNotFoundError:
        return

    if recursive_targets:
        run_best_effort(
            cfg,
            ["chown", "-R", f"{cfg.ssh_user}:{cfg.ssh_user}", *recursive_targets],
            "repair host data dir ownership",
        )
    if top_level_dir_targets:
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", *top_level_dir_targets],
            "repair host data top-level dir ownership",
        )
    if file_targets:
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", *file_targets],
            "repair host data file ownership",
        )


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


def ensure_bootstrap_paths(cfg: BootstrapConfig) -> None:
    Path(cfg.bootstrap_root).mkdir(parents=True, exist_ok=True)
    Path(cfg.bootstrap_dir).mkdir(parents=True, exist_ok=True)
    Path(cfg.bootstrap_tmp).mkdir(parents=True, exist_ok=True)
    Path(cfg.log_file).parent.mkdir(parents=True, exist_ok=True)
    rotate_bootstrap_log(cfg)
    if cfg.bootstrap_user and cfg.bootstrap_user != "root":
        owner_paths = [
            cfg.bootstrap_root,
            cfg.bootstrap_dir,
            cfg.bootstrap_tmp,
            str(Path(cfg.log_file).parent),
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
    keep_resolved: set[Path] = set()
    live_versions = live_mounted_bundle_versions(root)
    live_versions.update(live_process_bundle_versions(root))
    for version in sorted(live_versions):
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
    for child in root.iterdir():
        if child.name.startswith(".") or child.name == "current":
            continue
        try:
            if child.is_symlink() or not child.is_dir():
                continue
        except OSError:
            continue
        candidates.append(child)
    candidates.sort(
        key=lambda child: (
            child.stat().st_mtime if child.exists() else 0,
            child.name,
        ),
        reverse=True,
    )
    for child in candidates:
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
        shutil.rmtree(child, ignore_errors=True)
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
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", *runtime_paths],
            "chown runtime dir roots",
        )
    else:
        run_best_effort(
            cfg,
            ["sudo", "chown", f"{cfg.ssh_user}:{cfg.ssh_user}", *runtime_paths],
            "sudo chown runtime dir roots",
        )


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
    try:
        proc_entries = list(PROC_ROOT.iterdir())
    except Exception:
        return versions
    for proc in proc_entries:
        if not proc.name.isdigit():
            continue
        mountinfo = proc / "mountinfo"
        try:
            lines = mountinfo.read_text(
                encoding="utf-8",
                errors="replace",
            ).splitlines()
        except Exception:
            continue
        for line in lines:
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
    """Return version directories referenced by live process command lines.

    Component-scoped rollouts can intentionally leave project-host services on
    different artifact versions. Those services do not bind mount their own
    bundle, so mountinfo alone cannot protect their supervisor path.
    """
    try:
        root_abs = root.resolve()
    except Exception:
        root_abs = root.absolute()
    root_prefix = f"{root_abs}/"
    versions: set[str] = set()
    try:
        proc_entries = list(PROC_ROOT.iterdir())
    except Exception:
        return versions
    for proc in proc_entries:
        if not proc.name.isdigit():
            continue
        try:
            cmdline = (proc / "cmdline").read_bytes().replace(b"\0", b" ")
            text = os.fsdecode(cmdline)
        except Exception:
            continue
        offset = 0
        while True:
            start = text.find(root_prefix, offset)
            if start < 0:
                break
            remainder = text[start + len(root_prefix) :]
            version = remainder.split("/", 1)[0].split(None, 1)[0]
            if version and version not in {"current", "."}:
                candidate = root_abs / version
                try:
                    if candidate.is_dir() and not candidate.is_symlink():
                        versions.add(version)
                except OSError:
                    pass
            offset = start + len(root_prefix)
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


def setup_shared_scratch(cfg: BootstrapConfig) -> None:
    if not cfg.shared_scratch_enabled:
        return
    if cfg.shared_scratch_filesystem != "ext4":
        raise RuntimeError(
            f"unsupported shared scratch filesystem: {cfg.shared_scratch_filesystem}"
        )
    scratch_mount = Path(cfg.shared_scratch_mount)
    scratch_mount.mkdir(parents=True, exist_ok=True)
    devices = [d for d in cfg.shared_scratch_devices.split() if d]
    if not devices:
        raise RuntimeError("shared scratch is enabled but no candidate devices were configured")

    log_line(cfg, "bootstrap: waiting for shared scratch disk (up to 600s)")
    scratch_disk = None
    for attempt in range(60):
        scratch_disk = pick_unmounted_or_target_disk(
            cfg,
            devices,
            mountpoint=cfg.shared_scratch_mount,
        )
        if scratch_disk:
            break
        log_line(
            cfg,
            f"bootstrap: shared scratch disk not ready (attempt {attempt + 1}/60)",
        )
        time.sleep(10)
    if not scratch_disk:
        raise RuntimeError("shared scratch disk was not found")

    log_line(cfg, f"bootstrap: using shared scratch disk {scratch_disk}")
    fstype = subprocess.check_output(
        ["lsblk", "-no", "FSTYPE", scratch_disk],
        text=True,
    ).strip()
    if not fstype:
        run_cmd(cfg, ["mkfs.ext4", "-F", scratch_disk], "mkfs.ext4 shared scratch")
    elif fstype != "ext4":
        raise RuntimeError(
            f"refusing to mount shared scratch disk {scratch_disk} (filesystem={fstype})"
        )
    if not scratch_mount.is_mount():
        run_cmd(
            cfg,
            ["mount", scratch_disk, cfg.shared_scratch_mount],
            "mount shared scratch disk",
        )
    uuid = subprocess.check_output(
        ["blkid", "-s", "UUID", "-o", "value", scratch_disk],
        text=True,
    ).strip()
    fstab_line = (
        f"UUID={uuid} {cfg.shared_scratch_mount} ext4 defaults,nofail 0 2 # cocalc-scratch"
    )
    update_fstab(
        fstab_line,
        mountpoint=cfg.shared_scratch_mount,
        marker="cocalc-scratch",
    )
    run_best_effort(cfg, ["resize2fs", scratch_disk], "resize shared scratch filesystem")
    os.chmod(cfg.shared_scratch_mount, 0o1777)


def update_fstab(
    line: str,
    *,
    mountpoint: str = "/mnt/cocalc",
    marker: str = "cocalc-btrfs",
) -> None:
    fstab = Path("/etc/fstab")
    existing = fstab.read_text(encoding="utf-8") if fstab.exists() else ""
    lines = []
    for existing_line in existing.splitlines():
        if marker and marker in existing_line:
            continue
        if f" {mountpoint} " in existing_line:
            continue
        if mountpoint == "/mnt/cocalc" and " /btrfs " in existing_line:
            continue
        lines.append(existing_line)
    lines.append(line)
    fstab.write_text("\n".join(lines) + "\n", encoding="utf-8")


def install_btrfs_helper(cfg: BootstrapConfig) -> None:
    helper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-grow-btrfs must run as root" >&2
  exit 1
fi
TARGET_GB="${1:-}"
IMAGE_NEW="/var/lib/cocalc/cocalc.img"
IMAGE_OLD="/var/lib/cocalc/btrfs.img"
IMAGE="$IMAGE_NEW"
if [ ! -f "$IMAGE" ] && [ -f "$IMAGE_OLD" ]; then
  IMAGE="$IMAGE_OLD"
fi
MOUNTPOINT="/mnt/cocalc"
ENV_FILE="/etc/cocalc/project-host.env"
if [ -n "$TARGET_GB" ]; then
  TARGET_GB="${TARGET_GB%%[!0-9]*}"
fi
if [ -n "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
  if grep -q '^COCALC_BTRFS_IMAGE_GB=' "$ENV_FILE"; then
    sed -i.bak "s/^COCALC_BTRFS_IMAGE_GB=.*/COCALC_BTRFS_IMAGE_GB=${TARGET_GB}/" "$ENV_FILE"
  else
    echo "COCALC_BTRFS_IMAGE_GB=${TARGET_GB}" >> "$ENV_FILE"
  fi
fi
if ! mountpoint -q "$MOUNTPOINT"; then
  exit 0
fi
MOUNT_SOURCE="$(findmnt -n -o SOURCE "$MOUNTPOINT" 2>/dev/null || true)"
refresh_block_device() {
  local source="$1"
  local resolved parent_name parent part_num base rescan_path
  resolved="$(readlink -f "$source" 2>/dev/null || printf '%s' "$source")"
  parent_name="$(lsblk -no PKNAME "$resolved" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  part_num="$(lsblk -no PARTN "$resolved" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  if [ -n "$parent_name" ]; then
    parent="/dev/$parent_name"
  else
    parent="$resolved"
  fi
  base="$(basename "$parent")"
  rescan_path="/sys/class/block/$base/device/rescan"
  if [ -w "$rescan_path" ]; then
    echo 1 > "$rescan_path" || true
  fi
  blockdev --rereadpt "$parent" >/dev/null 2>&1 || true
  if command -v partprobe >/dev/null 2>&1; then
    partprobe "$parent" >/dev/null 2>&1 || true
  fi
  if command -v udevadm >/dev/null 2>&1; then
    udevadm settle >/dev/null 2>&1 || true
  fi
  if [ -n "$part_num" ]; then
    if ! command -v growpart >/dev/null 2>&1; then
      echo "growpart is required to grow partition-backed filesystem $resolved" >&2
      return 1
    fi
    growpart "$parent" "$part_num" >/dev/null 2>&1 || true
    blockdev --rereadpt "$parent" >/dev/null 2>&1 || true
    if command -v partprobe >/dev/null 2>&1; then
      partprobe "$parent" >/dev/null 2>&1 || true
    fi
    if command -v udevadm >/dev/null 2>&1; then
      udevadm settle >/dev/null 2>&1 || true
    fi
  fi
}
if [ "$MOUNT_SOURCE" = "$IMAGE" ] || [ "${MOUNT_SOURCE#/dev/loop}" != "$MOUNT_SOURCE" ]; then
  if [ ! -f "$IMAGE" ]; then
    exit 0
  fi
  if [ -z "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
    AUTO_MODE="$(grep -E '^COCALC_BTRFS_IMAGE_AUTO=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
    if [ "$AUTO_MODE" = "1" ]; then
      ROOT_TOTAL_GB="$(df -BG / | awk 'NR==2 {gsub(/G/, "", $2); print $2}' || true)"
      RESERVE_GB="$(grep -E '^COCALC_BTRFS_ROOT_RESERVE_GB=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
      if ! echo "$RESERVE_GB" | grep -Eq '^[0-9]+$'; then
        RESERVE_GB=15
      fi
      if echo "$ROOT_TOTAL_GB" | grep -Eq '^[0-9]+$'; then
        TARGET_GB="$((ROOT_TOTAL_GB - RESERVE_GB))"
        if [ "$TARGET_GB" -lt 5 ]; then
          TARGET_GB=5
        fi
      fi
    fi
  fi
  if [ -z "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
    TARGET_GB="$(grep -E '^COCALC_BTRFS_IMAGE_GB=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
  fi
  if [ -z "$TARGET_GB" ] || ! echo "$TARGET_GB" | grep -Eq '^[0-9]+$'; then
    exit 0
  fi
  CURRENT_BYTES="$(stat -c %s "$IMAGE" 2>/dev/null || echo 0)"
  TARGET_BYTES="$((TARGET_GB * 1024 * 1024 * 1024))"
  if [ "$CURRENT_BYTES" -lt "$TARGET_BYTES" ]; then
    echo "bootstrap: growing btrfs image to ${TARGET_GB}G"
    truncate -s "${TARGET_GB}G" "$IMAGE"
    LOOP_DEV="$(losetup -j "$IMAGE" | head -n1 | cut -d: -f1 || true)"
    if [ -n "$LOOP_DEV" ]; then
      losetup -c "$LOOP_DEV" || true
    fi
  fi
  btrfs filesystem resize max "$MOUNTPOINT" >/dev/null 2>&1 || true
  exit 0
fi
refresh_block_device "$MOUNT_SOURCE" || true
btrfs filesystem resize max "$MOUNTPOINT" >/dev/null 2>&1 || true
"""
    helper_path = Path("/usr/local/sbin/cocalc-grow-btrfs")
    helper_path.write_text(helper, encoding="utf-8")
    helper_path.chmod(0o755)


def ensure_cocalc_mount(cfg: BootstrapConfig) -> None:
    if Path("/mnt/cocalc").is_mount():
        return
    log_line(cfg, "bootstrap: ensuring /mnt/cocalc is mounted")
    if Path("/usr/local/sbin/cocalc-mount-data").exists():
        run_best_effort(
            cfg,
            ["/usr/local/sbin/cocalc-mount-data"],
            "mount /mnt/cocalc via cocalc-mount-data",
        )
    if not Path("/mnt/cocalc").is_mount():
        run_best_effort(cfg, ["mount", "/mnt/cocalc"], "mount /mnt/cocalc")


RUNTIME_STORAGE_PATH_HELPER = r'''#!/usr/bin/python3
"""Root-owned, openat2-anchored path mutations for cocalc-runtime-storage.

The sudo caller owns /opt/cocalc/project-host, so this helper must never load
code, Node, or native addons from that tree.  Keep this file self-contained and
installed below /usr/local with root ownership.
"""

import ctypes
import errno
import os
import re
import stat
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
SYS_OPENAT2 = 437
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
RESOLVE_FLAGS = RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH
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


def openat2(dirfd, path, flags, mode=0):
    encoded = os.fsencode(path)
    if b"\0" in encoded:
        fail("path contains NUL")
    how = OpenHow(flags=flags, mode=mode, resolve=RESOLVE_FLAGS)
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
    values = {"tag": [], "delete": False}
    value_options = {
        "--root",
        "--path",
        "--profile-root",
        "--profile-path",
        "--host",
        "--parent",
        "--snapshot",
        "--tag",
    }
    i = 1
    while i < len(argv):
        option = argv[i]
        if option == "--delete":
            if values["delete"]:
                fail("duplicate --delete")
            values["delete"] = True
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

    common = {"root", "path", "profile-root", "profile-path", "tag", "delete"}
    allowed = {
        "rustic-project-backup": common | {"host", "parent"},
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
    return command, values


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


def select_privileged_rustic_binary(candidates=None):
    require_root_ownership = candidates is None
    candidates = candidates or ("/usr/local/libexec/cocalc-rustic",)
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


def run_rustic(
    argv,
    allowed_roots=ALLOWED_ROOTS,
    rustic_candidates=None,
    profile_run_dir="/run/cocalc-rustic-profiles",
    profile_run_dir_uid=0,
    allow_loopback_rest=ALLOW_LOOPBACK_RUSTIC_REST,
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

        def invoke(args, *, quiet=False):
            result = subprocess.run(
                [*base, *args],
                cwd=f"/proc/self/fd/{datafd}",
                env=env,
                pass_fds=(datafd,),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL if quiet else None,
                stderr=subprocess.DEVNULL if quiet else None,
            )
            return result.returncode

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
            flags = ["backup"]
            if command == "rustic-project-backup":
                flags.append("-x")
            flags.extend(["--json", "--no-scan", "--host", values["host"]])
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

        restore = ["restore"]
        if values["delete"]:
            restore.append("--delete")
        restore.extend([values["snapshot"], f"/proc/self/fd/{datafd}"])
        status = invoke(restore)
        if status != 0:
            raise subprocess.CalledProcessError(status, base)
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
    command = argv[0]
    names = (
        ("lower", "upper", "work", "merged")
        if command == "mount-overlay-project"
        else ("merged",)
    )
    options = {f"--{name}-{kind}" for name in names for kind in ("root", "path")}
    values, _flags = parse_named_options(argv, command, options, options)
    descriptors = []
    try:
        for name in names:
            descriptors.append(open_named_directory(values, name, allowed_roots))
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
    finally:
        for fd in descriptors:
            os.close(fd)


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
        args = [
            "/usr/local/sbin/cocalc-runtime-storage",
            "_normalize-rootfs-anchored",
            "--ownership-source",
            ownership_source,
        ]
        if "--skip-ownership-bridge" in flags:
            args.append("--skip-ownership-bridge")
        args.extend(["--podman-user", podman_user, mountpoint])
        subprocess.run(args, check=True, stdin=subprocess.DEVNULL)
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


def run(argv, allowed_roots=ALLOWED_ROOTS, rustic_candidates=None):
    if argv and argv[0] in RUSTIC_COMMANDS:
        return run_rustic(argv, allowed_roots, rustic_candidates)
    if argv and argv[0] in ANCHORED_COMMANDS:
        if argv[0] == "normalize-rootfs":
            return run_normalize_rootfs(argv, allowed_roots)
        return run_overlay(argv, allowed_roots)
    command, root, path, values = parse(argv)
    rootfd = open_root(root, allowed_roots)
    try:
        if command == "mkdir":
            mode = int(values["mode"], 8)
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
            fd = open_existing(rootfd, path)
            try:
                os.fchmod(fd, int(values["mode"], 8))
            finally:
                os.close(fd)
        elif command == "chown":
            fd = open_existing(rootfd, path)
            try:
                os.fchown(fd, parse_uint(values["uid"], "uid", 2**32 - 1), parse_uint(values["gid"], "gid", 2**32 - 1))
            finally:
                os.close(fd)
        elif command in ("copy-tree-preserve", "copy-tree-reflink"):
            dest_rootfd = open_root(values["dest-root"], allowed_roots)
            try:
                if values["dest"] != ".":
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
                        args = [
                            "/usr/bin/rsync",
                            "-aAX",
                            "--numeric-ids",
                            "--",
                            f"{source}/",
                            f"{dest}/",
                        ]
                    else:
                        args = [
                            "/bin/cp",
                            "-a",
                            "--reflink=auto",
                            "--",
                            f"{source}/.",
                            f"{dest}/",
                        ]
                    subprocess.run(
                        args,
                        pass_fds=(sourcefd, destfd),
                        check=True,
                        stdin=subprocess.DEVNULL,
                    )
                finally:
                    os.close(sourcefd)
                    os.close(destfd)
            finally:
                os.close(dest_rootfd)
        elif command == "truncate":
            fd = openat2(
                rootfd,
                path,
                os.O_WRONLY | os.O_CREAT | os.O_NONBLOCK | os.O_CLOEXEC,
                0o600,
            )
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
        print("cocalc runtime storage path helper must run as root", file=sys.stderr)
        return 1
    try:
        run(sys.argv[1:] if argv is None else argv, allowed_roots)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as err:
        print(f"SECURITY_DENY code=path-helper-failed detail={err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
'''


LEGACY_MANAGED_PROJECT_IO_OVERRIDE = {
    "version": 1,
    "mode": "enforce",
    "mountpoint": "/mnt/cocalc",
    "profile": "prod-gcp-pd-balanced-dynamic-v1",
    "capacitySource": "gcp-pd-balanced-size-formula-2026-07-24",
    "capacity": {"mode": "gcp-pd-balanced"},
    "adaptive": {
        "enabled": False,
        "sampleMs": 5000,
        "enterSamples": 6,
        "recoverSamples": 24,
    },
    "ioCost": {"mode": "disabled"},
}


def retire_legacy_managed_project_io_override(override_path: Path) -> None:
    if not override_path.exists():
        return
    try:
        override = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    if override != LEGACY_MANAGED_PROJECT_IO_OVERRIDE:
        return
    retired_path = override_path.with_name(
        f"{override_path.name}.retired-gcp-pd-balanced-size-formula-2026-07-24"
    )
    if retired_path.exists():
        retired_path.unlink()
    override_path.replace(retired_path)
    os.chown(retired_path, 0, 0)
    retired_path.chmod(0o600)


def write_project_io_configuration(
    cfg: BootstrapConfig | PrivilegedWrapperConfig,
    *,
    policy_path: Path = Path("/etc/cocalc/project-io-policy.json"),
    override_path: Path = Path("/etc/cocalc/project-io-policy.override.json"),
    capacity_path: Path = Path("/etc/cocalc/project-io-capacity.json"),
) -> None:
    retire_legacy_managed_project_io_override(override_path)
    text_write_atomic(
        policy_path,
        json.dumps(cfg.project_io_policy, indent=2, sort_keys=True) + "\n",
        default_mode=0o644,
    )
    os.chown(policy_path, 0, 0)
    policy_path.chmod(0o644)
    if override_path.exists():
        os.chown(override_path, 0, 0)
        override_path.chmod(0o600)
    text_write_atomic(
        capacity_path,
        json.dumps(cfg.project_io_capacity, indent=2, sort_keys=True) + "\n",
        default_mode=0o644,
    )
    os.chown(capacity_path, 0, 0)
    capacity_path.chmod(0o644)


def install_privileged_wrappers(
    cfg: BootstrapConfig | PrivilegedWrapperConfig,
) -> None:
    storage_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-runtime-storage must run as root" >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "usage: cocalc-runtime-storage <command> [args...]" >&2
  exit 2
fi
cmd="$1"
shift
cd /
BEES_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-bees"
BEES_CGROUP_MAX_WORKERS="4"
BEES_CGROUP_CPU_PERIOD="100000"
BEES_CGROUP_CPU_WEIGHT="1"
BEES_CGROUP_IO_WEIGHT="1"
BEES_CGROUP_IO_READ_BPS="$((64 * 1024 * 1024))"
BEES_CGROUP_IO_WRITE_BPS="$((16 * 1024 * 1024))"
BEES_CGROUP_MEMORY_HIGH_MAX="$((4 * 1024 * 1024 * 1024))"
BEES_CGROUP_MEMORY_MAX_MAX="$((8 * 1024 * 1024 * 1024))"
BEES_CGROUP_MEMORY_HIGH_MIN="$((1 * 1024 * 1024 * 1024))"
BEES_CGROUP_MEMORY_MAX_MIN="$((2 * 1024 * 1024 * 1024))"
BEES_CGROUP_PIDS_MAX="64"
MAINTENANCE_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-maintenance"
MAINTENANCE_CGROUP_CPU_MAX="200000 100000"
MAINTENANCE_CGROUP_CPU_WEIGHT="10"
MAINTENANCE_CGROUP_IO_WEIGHT="10"
MAINTENANCE_CGROUP_MEMORY_HIGH="$((4 * 1024 * 1024 * 1024))"
MAINTENANCE_CGROUP_MEMORY_MAX="$((8 * 1024 * 1024 * 1024))"
MAINTENANCE_CGROUP_PIDS_MAX="256"
HOST_SERVICE_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-host-services"
HOST_SERVICE_CGROUP_CPU_WEIGHT="10000"
HOST_SERVICE_CGROUP_IO_WEIGHT="10000"
BACKUP_BROWSER_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-backup-browsers"
BACKUP_BROWSER_POOL_CPU_MAX="200000 100000"
BACKUP_BROWSER_POOL_MEMORY_HIGH="$((3 * 1024 * 1024 * 1024))"
BACKUP_BROWSER_POOL_MEMORY_MAX="$((4 * 1024 * 1024 * 1024))"
BACKUP_BROWSER_POOL_PIDS_MAX="512"
BACKUP_BROWSER_CGROUP_CPU_MAX="200000 100000"
BACKUP_BROWSER_CGROUP_CPU_WEIGHT="100"
BACKUP_BROWSER_CGROUP_IO_WEIGHT="100"
BACKUP_BROWSER_CGROUP_MEMORY_HIGH="$((1280 * 1024 * 1024))"
BACKUP_BROWSER_CGROUP_MEMORY_MAX="$((2 * 1024 * 1024 * 1024))"
BACKUP_BROWSER_CGROUP_PIDS_MAX="128"
PROJECT_STARTUP_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-project-startup"
PROJECT_STARTUP_CREATE_CGROUP_DEFAULT="${PROJECT_STARTUP_CGROUP_DEFAULT}/create"
PROJECT_STARTUP_CGROUP_CPU_MAX="200000 100000"
PROJECT_STARTUP_CGROUP_CPU_WEIGHT="10000"
PROJECT_STARTUP_CGROUP_IO_WEIGHT="10000"
# Memory charged while a process is in a child cgroup stays charged to this
# hierarchy after the process moves and the child is removed. An aggregate
# limit therefore grows with every project start and eventually throttles
# Podman while it holds global runtime locks. Bound each startup leaf instead.
PROJECT_STARTUP_CGROUP_MEMORY_HIGH="max"
PROJECT_STARTUP_CGROUP_MEMORY_MAX="max"
PROJECT_STARTUP_CREATE_CGROUP_MEMORY_HIGH="$((4 * 1024 * 1024 * 1024))"
PROJECT_STARTUP_CREATE_CGROUP_MEMORY_MAX="$((8 * 1024 * 1024 * 1024))"
PROJECT_STARTUP_CGROUP_PIDS_MAX="4096"
PROJECT_POOL_CGROUP_DEFAULT="__PROJECT_POOL_CGROUP__"
PROJECT_IO_POLICY_DEFAULT="/etc/cocalc/project-io-policy.json"
PROJECT_IO_POLICY_OVERRIDE_DEFAULT="/etc/cocalc/project-io-policy.override.json"
PROJECT_IO_CAPACITY_DEFAULT="/etc/cocalc/project-io-capacity.json"
PROJECT_IO_POLICY_HELPER="/usr/local/libexec/cocalc-project-io-policy"
# This state is needed when cgroups are reconstructed at boot, before each
# project has necessarily restarted and reported its authoritative class.
PROJECT_IO_CLASS_STATE_DIR="/var/lib/cocalc/project-io-classes"
PROJECT_STORAGE_WORKER_MEMORY_MAX="$((2 * 1024 * 1024 * 1024))"
PROJECT_STORAGE_WORKER_MEMORY_HIGH="$((1 * 1024 * 1024 * 1024))"
PROJECT_PROCESS_OOM_SCORE_ADJ="500"
RUNTIME_USER="__RUNTIME_USER__"
CONTAINER_RUNTIME_CURRENT="/opt/cocalc/container-runtime/current"
CONTAINER_RUNTIME_REQUIRED="__CONTAINER_RUNTIME_REQUIRED__"
PROJECT_LEAF_POOL_HEADROOM_BYTES="$((2 * 1024 * 1024 * 1024))"
MIN_PROJECT_LEAF_MEMORY_MAX_BYTES="$((512 * 1024 * 1024))"
PROJECT_PASTA_NOFILE_LIMIT="4096"
PROJECT_TCP_NEW_RATE="50"
PROJECT_TCP_NEW_BURST="200"
PROJECT_UDP_NEW_RATE="100"
PROJECT_UDP_NEW_BURST="400"
# Cloud providers can multiplex metadata, DNS, and NTP on these addresses.
# Block metadata HTTP(S) without breaking the DNS service projects inherit
# from the host (notably GCP's 169.254.169.254:53 resolver).
PROJECT_METADATA_IPV4="169.254.169.254"
PROJECT_METADATA_IPV6="fd20:ce::254"
PROJECT_METADATA_TCP_PORTS="{ 80, 443 }"
PROJECT_NETWORK_NFT="/usr/sbin/nft"
PROJECT_NETWORK_TABLE="cocalc_project_network"
PROJECT_NETWORK_CHAIN="output"
PROJECT_CGROUP_LOCK_WAIT_SECONDS="5"
PROJECT_IO_RESERVATION_LOCK="/run/lock/cocalc-project-io-reservation.lock"
PROJECT_IO_NORMAL_LIMITS_SNAPSHOT="/run/cocalc-project-pool-normal-io.max"
PROJECT_IO_PRESSURE_MODE_STATE="/run/cocalc-project-pool-pressure-mode"
PROJECT_NETWORK_RECONCILE_ATTEMPTS="3"
PROJECT_NETWORK_BOOT_RECONCILE_ATTEMPTS="20"
PROJECT_NETWORK_BOOT_RECONCILE_DELAY_SECONDS="2"
PRIVILEGED_RUSTIC_CACHE="/root/.cache/rustic"
PRIVILEGED_RUSTIC_CACHE_LOCK="/run/lock/cocalc-privileged-rustic-cache.lock"
PRIVILEGED_RUSTIC_CACHE_MAX_BYTES="$((4 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_CACHE_TARGET_BYTES="$((3 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_CACHE_HARD_BYTES="$((6 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_ROOT_MIN_FREE_BYTES="$((5 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_ROOT_TARGET_FREE_BYTES="$((6 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_ROOT_CRITICAL_FREE_BYTES="$((2 * 1024 * 1024 * 1024))"
PRIVILEGED_RUSTIC_CACHE_MIN_AGE_SECONDS="$((24 * 60 * 60))"
# Full-chain reads are only used by background reconciliation and can take
# over ten seconds on a busy host with hundreds of cgroup/socket rules.
# Foreground project creation uses an append-only write and does not pay this
# timeout unless it must repair a missing table.
PROJECT_NETWORK_NFT_TIMEOUT_SECONDS="30"

deny() {
  local code="$1"
  local detail="$2"
  echo "SECURITY_DENY code=${code} detail=${detail}" >&2
  exit 2
}

run_rootfs_podman_as_user() {
  local podman_user="$1"
  local runtime_uid runtime_dir podman_bin
  local -a runtime_env podman_prefix=()
  shift
  if [ "$podman_user" != "$RUNTIME_USER" ]; then
    deny "rootfs-podman-user-mismatch" "$podman_user"
  fi
  runtime_uid="$(id -u -- "$podman_user")"
  runtime_dir="/mnt/cocalc/data/tmp/cocalc-podman-runtime-${runtime_uid}"
  runtime_env=(
    "XDG_RUNTIME_DIR=${runtime_dir}"
    "COCALC_PODMAN_RUNTIME_DIR=${runtime_dir}"
    "CONTAINERS_CGROUP_MANAGER=cgroupfs"
  )
  if [ -x "${CONTAINER_RUNTIME_CURRENT}/bin/podman" ]; then
    podman_bin="${CONTAINER_RUNTIME_CURRENT}/bin/podman"
    runtime_env+=(
      "CONTAINERS_CONF_OVERRIDE=${CONTAINER_RUNTIME_CURRENT}/etc/containers/containers.conf"
      "PATH=${CONTAINER_RUNTIME_CURRENT}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    )
  elif [ "$CONTAINER_RUNTIME_REQUIRED" = "1" ]; then
    deny "managed-podman-missing" "${CONTAINER_RUNTIME_CURRENT}/bin/podman"
  elif [ -x /usr/bin/podman ]; then
    # Legacy bootstrap payloads without a managed runtime remain supported.
    podman_bin="/usr/bin/podman"
  else
    deny "podman-missing" "/usr/bin/podman"
  fi
  # Ubuntu grants unprivileged user namespaces to Podman via this profile.
  # The managed binary is under /opt, so enter the profile explicitly.
  if [ -x /usr/bin/aa-exec ] && \
     grep -q '^podman ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    podman_prefix=(/usr/bin/aa-exec -p podman --)
  fi
  /usr/bin/sudo -u "$podman_user" -H /usr/bin/env \
    "${runtime_env[@]}" \
    "${podman_prefix[@]}" \
    "$podman_bin" "$@"
}

maintain_privileged_rustic_cache() {
  local cache_bytes root_free_bytes urgent cutoff entry_bytes newest entry
  if [ ! -d "$PRIVILEGED_RUSTIC_CACHE" ]; then
    return 0
  fi
  cache_bytes="$(du -s -B1 -- "$PRIVILEGED_RUSTIC_CACHE" 2>/dev/null | cut -f1)"
  root_free_bytes="$(df --output=avail -B1 / 2>/dev/null | tail -n 1 | tr -d ' ')"
  if ! echo "$cache_bytes" | grep -Eq '^[0-9]+$' || \
     ! echo "$root_free_bytes" | grep -Eq '^[0-9]+$'; then
    return 0
  fi
  if [ "$cache_bytes" -le "$PRIVILEGED_RUSTIC_CACHE_MAX_BYTES" ] && \
     [ "$root_free_bytes" -ge "$PRIVILEGED_RUSTIC_ROOT_MIN_FREE_BYTES" ]; then
    return 0
  fi

  urgent=false
  if [ "$cache_bytes" -gt "$PRIVILEGED_RUSTIC_CACHE_HARD_BYTES" ] || \
     [ "$root_free_bytes" -lt "$PRIVILEGED_RUSTIC_ROOT_CRITICAL_FREE_BYTES" ]; then
    urgent=true
  fi
  cutoff="$(($(date +%s) - PRIVILEGED_RUSTIC_CACHE_MIN_AGE_SECONDS))"
  while IFS=$'\t' read -r entry_bytes newest entry; do
    if [ "$cache_bytes" -le "$PRIVILEGED_RUSTIC_CACHE_TARGET_BYTES" ] && \
       [ "$root_free_bytes" -ge "$PRIVILEGED_RUSTIC_ROOT_TARGET_FREE_BYTES" ]; then
      break
    fi
    if ! echo "$entry_bytes" | grep -Eq '^[0-9]+$' || \
       ! echo "$newest" | grep -Eq '^[0-9]+$'; then
      continue
    fi
    case "$entry" in
      "$PRIVILEGED_RUSTIC_CACHE"/[0-9a-fA-F][0-9a-fA-F]*) ;;
      *) continue ;;
    esac
    if [ "${#entry}" -ne "$((${#PRIVILEGED_RUSTIC_CACHE} + 65))" ] || \
       ! basename "$entry" | grep -Eq '^[0-9a-fA-F]{64}$' || \
       [ ! -d "$entry" ] || [ -L "$entry" ]; then
      continue
    fi
    if [ "$urgent" = false ] && [ "$newest" -ge "$cutoff" ]; then
      continue
    fi
    # Also protect Rustic processes not yet updated to use the shared lock.
    if pgrep -x rustic >/dev/null 2>&1; then
      return 0
    fi
    if rm -rf --one-file-system -- "$entry"; then
      cache_bytes="$((cache_bytes > entry_bytes ? cache_bytes - entry_bytes : 0))"
      root_free_bytes="$((root_free_bytes + entry_bytes))"
      logger -t cocalc-runtime-storage \
        "removed stale privileged Rustic cache entry=$(basename "$entry") bytes=$entry_bytes"
    fi
  done < <(
    for entry in "$PRIVILEGED_RUSTIC_CACHE"/*; do
      [ -d "$entry" ] && [ ! -L "$entry" ] || continue
      basename "$entry" | grep -Eq '^[0-9a-fA-F]{64}$' || continue
      du -s -B1 --time --time-style=+%s -- "$entry" 2>/dev/null || true
    done | sort -t $'\t' -k2,2n
  )
}

prepare_privileged_rustic_cache() {
  exec 7>"$PRIVILEGED_RUSTIC_CACHE_LOCK"
  # An exclusive lock is available only when no cooperating Rustic operation
  # is active. If it is unavailable, join the existing shared lock below.
  if flock -n -x 7; then
    maintain_privileged_rustic_cache || true
  fi
  if ! flock -s -w 120 7; then
    deny "privileged-rustic-cache-lock-timeout" "$PRIVILEGED_RUSTIC_CACHE_LOCK"
  fi
}

acquire_project_cgroup_lock() {
  exec 9>/run/lock/cocalc-project-cgroups.lock
  if ! flock -x -w "$PROJECT_CGROUP_LOCK_WAIT_SECONDS" 9; then
    deny "project-cgroup-lock-timeout" "$PROJECT_CGROUP_LOCK_WAIT_SECONDS"
  fi
}

acquire_project_cgroup_shared_lock() {
  exec 9>/run/lock/cocalc-project-cgroups.lock
  if ! flock -s -w "$PROJECT_CGROUP_LOCK_WAIT_SECONDS" 9; then
    deny "project-cgroup-lock-timeout" "$PROJECT_CGROUP_LOCK_WAIT_SECONDS"
  fi
}

release_project_lock() {
  flock -u 9 || true
  exec 9>&-
}

acquire_project_io_reservation_lock() {
  exec 8>"$PROJECT_IO_RESERVATION_LOCK"
  if ! flock -x -w "$PROJECT_CGROUP_LOCK_WAIT_SECONDS" 8; then
    deny "project-io-reservation-lock-timeout" "$PROJECT_CGROUP_LOCK_WAIT_SECONDS"
  fi
}

acquire_project_io_reservation_shared_lock() {
  exec 8>"$PROJECT_IO_RESERVATION_LOCK"
  if ! flock -s -w "$PROJECT_CGROUP_LOCK_WAIT_SECONDS" 8; then
    deny "project-io-reservation-lock-timeout" "$PROJECT_CGROUP_LOCK_WAIT_SECONDS"
  fi
}

release_project_io_reservation_lock() {
  flock -u 8 || true
  exec 8>&-
}

is_project_uuid() {
  echo "$1" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

require_live_pid() {
  local pid="$1"
  if ! echo "$pid" | grep -Eq '^[0-9]+$' || [ "$pid" -le 1 ] || ! kill -0 "$pid" 2>/dev/null; then
    deny "project-pid-invalid" "$pid"
  fi
}

require_runtime_owned_pid() {
  local pid="$1" expected_uid="${SUDO_UID:-}" actual_uid
  require_live_pid "$pid"
  if ! echo "$expected_uid" | grep -Eq '^[0-9]+$' || [ "$expected_uid" -eq 0 ]; then
    deny "project-runtime-uid-invalid" "${expected_uid:-missing}"
  fi
  actual_uid="$(awk '/^Uid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  if [ "$actual_uid" != "$expected_uid" ]; then
    deny "project-pid-owner-mismatch" "pid=${pid},expected=${expected_uid},actual=${actual_uid:-missing}"
  fi
}

is_trusted_conmon_executable() {
  local executable="$1" runtime_relative version owner_uid runtime_uid mode
  case "$executable" in
    /usr/bin/conmon) ;;
    /opt/cocalc/container-runtime/*/bin/conmon)
      runtime_relative="${executable#/opt/cocalc/container-runtime/}"
      version="${runtime_relative%%/*}"
      [ "$runtime_relative" = "${version}/bin/conmon" ] || return 1
      echo "$version" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' || return 1
      ;;
    *) return 1 ;;
  esac
  [ -f "$executable" ] || return 1
  owner_uid="$(stat -Lc '%u' "$executable" 2>/dev/null || true)"
  mode="$(stat -Lc '%a' "$executable" 2>/dev/null || true)"
  runtime_uid="${SUDO_UID:-0}"
  echo "$runtime_uid" | grep -Eq '^[0-9]+$' || return 1
  [ "$owner_uid" = "0" ] ||
    { [ "$runtime_uid" -gt 0 ] && [ "$owner_uid" = "$runtime_uid" ]; } ||
    return 1
  echo "$mode" | grep -Eq '^[0-7]{3,4}$' || return 1
  [ "$((8#$mode & 022))" -eq 0 ] || return 1
}

host_service_process_title() {
  local title=""
  IFS= read -r -d '' title < "/proc/$1/cmdline" 2>/dev/null || true
  printf '%s\n' "$title"
}

require_host_service_pid() {
  local pid="$1" runtime_uid actual_uid title
  require_live_pid "$pid"
  runtime_uid="$(id -u "$RUNTIME_USER")"
  actual_uid="$(awk '/^Uid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  if [ "$actual_uid" != "$runtime_uid" ]; then
    deny "host-service-pid-owner-mismatch" "pid=${pid},expected=${runtime_uid},actual=${actual_uid:-missing}"
  fi
  title="$(host_service_process_title "$pid")"
  if ! grep -Eq '^project-host:(app|host-agent(:[0-9]+)?|conat-router|conat-persist|acp-worker|conat-router-cluster-node)$' <<< "$title"; then
    deny "host-service-process-title-invalid" "pid=${pid},title=${title:-missing}"
  fi
}

project_pool_relative_path() {
  printf '%s\n' "${PROJECT_POOL_CGROUP_DEFAULT#/sys/fs/cgroup}"
}

project_legacy_cgroup() {
  printf '%s/legacy\n' "$PROJECT_POOL_CGROUP_DEFAULT"
}

project_cgroup() {
  printf '%s/project-%s\n' "$PROJECT_POOL_CGROUP_DEFAULT" "$1"
}

project_startup_runtime_cgroup() {
  printf '%s/project-%s\n' "$PROJECT_STARTUP_CGROUP_DEFAULT" "$1"
}

project_startup_runtime_cgroup_relative_path() {
  printf '%s/project-%s\n' "${PROJECT_STARTUP_CGROUP_DEFAULT#/sys/fs/cgroup}" "$1"
}

project_cgroup_relative_path() {
  printf '%s/project-%s\n' "$(project_pool_relative_path)" "$1"
}

project_io_policy_fields() {
  local io_class="${1:-standard}"
  case "$io_class" in
    standard|member|premium) ;;
    *) io_class="standard" ;;
  esac
  "$PROJECT_IO_POLICY_HELPER" fields \
    "$PROJECT_IO_POLICY_DEFAULT" \
    "$PROJECT_IO_POLICY_OVERRIDE_DEFAULT" \
    "$io_class"
}

project_io_limit_rows() {
  local scope="$1" io_class="${2:-standard}"
  "$PROJECT_IO_POLICY_HELPER" limits \
    "$PROJECT_IO_POLICY_DEFAULT" \
    "$PROJECT_IO_POLICY_OVERRIDE_DEFAULT" \
    "$PROJECT_IO_CAPACITY_DEFAULT" \
    "$scope" \
    "$io_class"
}

project_io_policy_status() {
  "$PROJECT_IO_POLICY_HELPER" status \
    "$PROJECT_IO_POLICY_DEFAULT" \
    "$PROJECT_IO_POLICY_OVERRIDE_DEFAULT" \
    "$PROJECT_IO_CAPACITY_DEFAULT" \
    "pool" \
    "standard"
}

clear_stale_io_max() {
  local cgroup="$1" current_devices="$2" device snapshot
  [ -w "$cgroup/io.max" ] || return 0
  snapshot="$(cat "$cgroup/io.max")"
  while read -r device _rest; do
    [ -n "$device" ] || continue
    if ! grep -Fqx "$device" <<< "$current_devices"; then
      printf '%s rbps=max wbps=max riops=max wiops=max\n' "$device" > "$cgroup/io.max"
    fi
  done <<< "$snapshot"
}

apply_io_max() {
  local cgroup="$1" scope="$2" mode="$3" io_class="${4:-standard}"
  local rows="${5:-}" devices device rbps wbps riops wiops line snapshot
  if [ ! -w "$cgroup/io.max" ]; then
    [ "$mode" = "enforce" ] && deny "project-io-max-unavailable" "$cgroup"
    return 0
  fi
  if [ "$mode" != "enforce" ]; then
    # Disabling containment must not depend on storage discovery succeeding.
    # Clear every existing device cap, including devices removed from the
    # current capacity manifest.
    snapshot="$(cat "$cgroup/io.max")"
    while read -r device _rest; do
      [ -n "$device" ] || continue
      printf '%s rbps=max wbps=max riops=max wiops=max\n' "$device" > "$cgroup/io.max"
    done <<< "$snapshot"
    return 0
  fi
  if [ -z "$rows" ]; then
    if ! rows="$(project_io_limit_rows "$scope" "$io_class")"; then
      deny "project-io-device-unavailable" "$scope"
    fi
  fi
  devices="$(cut -f1 <<< "$rows")"
  [ -n "$devices" ] || {
    deny "project-io-device-unavailable" "$scope"
  }
  clear_stale_io_max "$cgroup" "$devices"
  while IFS=$'\t' read -r device rbps wbps riops wiops _rest; do
    [ -n "$device" ] || continue
    line="$device rbps=$rbps wbps=$wbps riops=$riops wiops=$wiops"
    printf '%s\n' "$line" > "$cgroup/io.max"
  done <<< "$rows"
}

verify_io_max() {
  local cgroup="$1" scope="$2" io_class="${3:-standard}"
  local rows="${4:-}" device rbps wbps riops wiops line
  [ -r "$cgroup/io.max" ] || deny "project-io-max-unavailable" "$cgroup"
  if [ -z "$rows" ]; then
    rows="$(project_io_limit_rows "$scope" "$io_class")" ||
      deny "project-io-device-unavailable" "$scope"
  fi
  [ -n "$rows" ] || deny "project-io-device-unavailable" "$scope"
  while IFS=$'\t' read -r device rbps wbps riops wiops _rest; do
    [ -n "$device" ] || continue
    line="$(awk -v device="$device" '$1 == device {print; exit}' "$cgroup/io.max")"
    for expected in "rbps=$rbps" "wbps=$wbps" "riops=$riops" "wiops=$wiops"; do
      grep -qw "$expected" <<< "$line" || deny "project-io-limit-mismatch" "cgroup=$cgroup,device=$device,expected=$expected,actual=${line:-missing}"
    done
  done <<< "$rows"
}

project_startup_runtime_active_count() {
  local cgroup count=0
  for cgroup in "${PROJECT_STARTUP_CGROUP_DEFAULT}"/project-*; do
    [ -d "$cgroup" ] || continue
    if grep -q '^populated 1$' "$cgroup/cgroup.events" 2>/dev/null ||
      [ -n "$(cat "$cgroup/cgroup.procs" 2>/dev/null || true)" ]; then
      count="$((count + 1))"
    fi
  done
  printf '%s\n' "$count"
}

current_project_pool_io_scope() {
  if project_io_pressure_protection_enabled ||
    [ "$(project_startup_runtime_active_count)" -gt 0 ]; then
    printf 'lifecycle-pool\n'
  else
    printf 'pool\n'
  fi
}

project_io_pressure_protection_enabled() {
  [ "$(cat "$PROJECT_IO_PRESSURE_MODE_STATE" 2>/dev/null || true)" = "protect" ]
}

apply_project_pool_io_policy() {
  local scope="${1:-}" fields mode rows=""
  [ -n "$scope" ] || scope="$(current_project_pool_io_scope)"
  fields="$(project_io_policy_fields standard)" || deny "project-io-policy-invalid" "pool"
  IFS=$'\t' read -r mode _rest <<< "$fields"
  if [ "$mode" = "enforce" ]; then
    rows="$(project_io_limit_rows "$scope")" ||
      deny "project-io-device-unavailable" "$scope"
  fi
  apply_io_max "$PROJECT_POOL_CGROUP_DEFAULT" "$scope" "$mode" standard "$rows"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$PROJECT_POOL_CGROUP_DEFAULT" "$scope" standard "$rows"
  fi
}

apply_project_pool_io_snapshot() {
  local snapshot="$1" line
  [ -s "$snapshot" ] || deny "project-io-normal-snapshot-missing" "$snapshot"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s\n' "$line" > "${PROJECT_POOL_CGROUP_DEFAULT}/io.max"
  done < "$snapshot"
}

verify_project_pool_io_snapshot() {
  local snapshot="$1" device expected line
  [ -s "$snapshot" ] || deny "project-io-normal-snapshot-missing" "$snapshot"
  while read -r device expected; do
    [ -n "$device" ] || continue
    line="$(awk -v device="$device" '$1 == device {print; exit}' "${PROJECT_POOL_CGROUP_DEFAULT}/io.max")"
    for expected in $expected; do
      grep -qw "$expected" <<< "$line" ||
        deny "project-io-normal-snapshot-mismatch" \
          "device=${device},expected=${expected},actual=${line:-missing}"
    done
  done < "$snapshot"
}

reserve_project_startup_io_capacity() {
  local fields mode snapshot_tmp
  acquire_project_io_reservation_lock
  fields="$(project_io_policy_fields standard)" || deny "project-io-policy-invalid" "pool"
  IFS=$'\t' read -r mode _rest <<< "$fields"
  if [ "$mode" != "enforce" ]; then
    # Disabled and observational policy intentionally leave pool io.max empty.
    # There is no normal ceiling to preserve or lifecycle headroom to grant.
    release_project_io_reservation_lock
    return 0
  fi
  if project_io_pressure_protection_enabled; then
    release_project_io_reservation_lock
    return 0
  fi
  if [ -s "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT" ]; then
    release_project_io_reservation_lock
    return 0
  fi
  snapshot_tmp="${PROJECT_IO_NORMAL_LIMITS_SNAPSHOT}.$$"
  umask 077
  cat "${PROJECT_POOL_CGROUP_DEFAULT}/io.max" > "$snapshot_tmp"
  [ -s "$snapshot_tmp" ] || deny "project-io-normal-snapshot-empty" "$snapshot_tmp"
  mv -f "$snapshot_tmp" "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
  apply_project_pool_io_policy "lifecycle-pool"
  release_project_io_reservation_lock
}

release_project_startup_io_capacity() {
  acquire_project_io_reservation_lock
  if [ "$(project_startup_runtime_active_count)" -gt 0 ]; then
    release_project_io_reservation_lock
    return 0
  fi
  if project_io_pressure_protection_enabled; then
    rm -f "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
    release_project_io_reservation_lock
    return 0
  fi
  if [ -s "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT" ]; then
    apply_project_pool_io_snapshot "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
    verify_project_pool_io_snapshot "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
    rm -f "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
  else
    # Recover safely after an interrupted helper upgrade or manual cgroup edit.
    apply_project_pool_io_policy "pool"
  fi
  release_project_io_reservation_lock
}

set_project_pool_pressure_mode() {
  local mode="$1" state_tmp
  acquire_project_io_reservation_lock
  case "$mode" in
    protect)
      state_tmp="${PROJECT_IO_PRESSURE_MODE_STATE}.$$"
      umask 077
      printf 'protect\n' > "$state_tmp"
      mv -f "$state_tmp" "$PROJECT_IO_PRESSURE_MODE_STATE"
      apply_project_pool_io_policy "lifecycle-pool"
      ;;
    normal)
      rm -f "$PROJECT_IO_PRESSURE_MODE_STATE"
      if [ "$(project_startup_runtime_active_count)" -gt 0 ]; then
        apply_project_pool_io_policy "lifecycle-pool"
      else
        apply_project_pool_io_policy "pool"
        rm -f "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
      fi
      ;;
    *) deny "project-io-pressure-mode-invalid" "$mode" ;;
  esac
  release_project_io_reservation_lock
}

reconcile_project_pool_io_reservation() {
  local scope
  acquire_project_io_reservation_lock
  scope="$(current_project_pool_io_scope)"
  apply_project_pool_io_policy "$scope"
  if [ "$scope" = "pool" ]; then
    rm -f "$PROJECT_IO_NORMAL_LIMITS_SNAPSHOT"
  fi
  release_project_io_reservation_lock
}

configure_maintenance_cgroup() {
  local fields mode
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$MAINTENANCE_CGROUP_DEFAULT"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/cpu.max" ] &&
    printf '%s\n' "$MAINTENANCE_CGROUP_CPU_MAX" > "${MAINTENANCE_CGROUP_DEFAULT}/cpu.max"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/cpu.weight" ] &&
    printf '%s\n' "$MAINTENANCE_CGROUP_CPU_WEIGHT" > "${MAINTENANCE_CGROUP_DEFAULT}/cpu.weight"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/io.weight" ] &&
    printf 'default %s\n' "$MAINTENANCE_CGROUP_IO_WEIGHT" > "${MAINTENANCE_CGROUP_DEFAULT}/io.weight"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/memory.high" ] &&
    printf '%s\n' "$MAINTENANCE_CGROUP_MEMORY_HIGH" > "${MAINTENANCE_CGROUP_DEFAULT}/memory.high"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/memory.max" ] &&
    printf '%s\n' "$MAINTENANCE_CGROUP_MEMORY_MAX" > "${MAINTENANCE_CGROUP_DEFAULT}/memory.max"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/memory.swap.max" ] &&
    printf '0\n' > "${MAINTENANCE_CGROUP_DEFAULT}/memory.swap.max"
  [ -w "${MAINTENANCE_CGROUP_DEFAULT}/pids.max" ] &&
    printf '%s\n' "$MAINTENANCE_CGROUP_PIDS_MAX" > "${MAINTENANCE_CGROUP_DEFAULT}/pids.max"
  fields="$(project_io_policy_fields standard)" ||
    deny "project-io-policy-invalid" "maintenance"
  IFS=$'\t' read -r mode _rest <<< "$fields"
  apply_io_max "$MAINTENANCE_CGROUP_DEFAULT" "maintenance" "$mode"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$MAINTENANCE_CGROUP_DEFAULT" "maintenance"
  fi
}

configure_host_service_cgroup() {
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$HOST_SERVICE_CGROUP_DEFAULT"
  [ -w "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.max" ] &&
    printf 'max 100000\n' > "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.max"
  [ -w "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.weight" ] &&
    printf '%s\n' "$HOST_SERVICE_CGROUP_CPU_WEIGHT" > "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.weight"
  [ -w "${HOST_SERVICE_CGROUP_DEFAULT}/io.weight" ] &&
    printf 'default %s\n' "$HOST_SERVICE_CGROUP_IO_WEIGHT" > "${HOST_SERVICE_CGROUP_DEFAULT}/io.weight"
  [ -w "${HOST_SERVICE_CGROUP_DEFAULT}/memory.max" ] &&
    printf 'max\n' > "${HOST_SERVICE_CGROUP_DEFAULT}/memory.max"
  [ -w "${HOST_SERVICE_CGROUP_DEFAULT}/pids.max" ] &&
    printf 'max\n' > "${HOST_SERVICE_CGROUP_DEFAULT}/pids.max"
}

host_service_cgroup_ready() {
  [ -d "$HOST_SERVICE_CGROUP_DEFAULT" ] || return 1
  [ "$(cat "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.max" 2>/dev/null || true)" = "max 100000" ] || return 1
  [ "$(cat "${HOST_SERVICE_CGROUP_DEFAULT}/cpu.weight" 2>/dev/null || true)" = "$HOST_SERVICE_CGROUP_CPU_WEIGHT" ] || return 1
  [ "$(awk '$1 == "default" {print $2}' "${HOST_SERVICE_CGROUP_DEFAULT}/io.weight" 2>/dev/null || true)" = "$HOST_SERVICE_CGROUP_IO_WEIGHT" ] || return 1
  [ "$(cat "${HOST_SERVICE_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)" = "max" ] || return 1
  [ "$(cat "${HOST_SERVICE_CGROUP_DEFAULT}/pids.max" 2>/dev/null || true)" = "max" ] || return 1
}

attach_host_service_pid() {
  local pid="$1" actual
  require_host_service_pid "$pid"
  configure_host_service_cgroup
  printf '%s\n' "$pid" > "${HOST_SERVICE_CGROUP_DEFAULT}/cgroup.procs"
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  [ "$actual" = "${HOST_SERVICE_CGROUP_DEFAULT#/sys/fs/cgroup}" ] ||
    deny "host-service-cgroup-attachment-failed" "pid=${pid},actual=${actual:-missing}"
}

backup_browser_cgroup_for_pid() {
  local pid="$1"
  echo "$pid" | grep -Eq '^[0-9]+$' || deny "backup-browser-pid-invalid" "$pid"
  [ "$pid" -gt 1 ] || deny "backup-browser-pid-invalid" "$pid"
  printf '%s/browser-%s\n' "$BACKUP_BROWSER_CGROUP_DEFAULT" "$pid"
}

configure_backup_browser_cgroup_parent() {
  local leaf
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$BACKUP_BROWSER_CGROUP_DEFAULT"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/cpu.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_POOL_CPU_MAX" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/cpu.max"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/cpu.weight" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_CPU_WEIGHT" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/cpu.weight"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/io.weight" ] &&
    printf 'default %s\n' "$BACKUP_BROWSER_CGROUP_IO_WEIGHT" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/io.weight"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.high" ] &&
    printf '%s\n' "$BACKUP_BROWSER_POOL_MEMORY_HIGH" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.high"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_POOL_MEMORY_MAX" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.max"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.swap.max" ] &&
    printf '0\n' > "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.swap.max"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.oom.group" ] &&
    printf '1\n' > "${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.oom.group"
  [ -w "${BACKUP_BROWSER_CGROUP_DEFAULT}/pids.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_POOL_PIDS_MAX" > "${BACKUP_BROWSER_CGROUP_DEFAULT}/pids.max"
  enable_cgroup_controllers "$BACKUP_BROWSER_CGROUP_DEFAULT"
  for leaf in "${BACKUP_BROWSER_CGROUP_DEFAULT}"/browser-*; do
    [ -d "$leaf" ] || continue
    if [ -z "$(cat "${leaf}/cgroup.procs" 2>/dev/null || true)" ]; then
      rmdir "$leaf" 2>/dev/null || true
    fi
  done
}

attach_backup_browser_pid() {
  local pid="$1" leaf actual
  require_runtime_owned_pid "$pid"
  configure_backup_browser_cgroup_parent
  leaf="$(backup_browser_cgroup_for_pid "$pid")"
  mkdir -p "$leaf"
  [ -w "${leaf}/cpu.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_CPU_MAX" > "${leaf}/cpu.max"
  [ -w "${leaf}/cpu.weight" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_CPU_WEIGHT" > "${leaf}/cpu.weight"
  [ -w "${leaf}/io.weight" ] &&
    printf 'default %s\n' "$BACKUP_BROWSER_CGROUP_IO_WEIGHT" > "${leaf}/io.weight"
  [ -w "${leaf}/memory.high" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_MEMORY_HIGH" > "${leaf}/memory.high"
  [ -w "${leaf}/memory.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_MEMORY_MAX" > "${leaf}/memory.max"
  [ -w "${leaf}/memory.swap.max" ] &&
    printf '0\n' > "${leaf}/memory.swap.max"
  [ -w "${leaf}/memory.oom.group" ] &&
    printf '1\n' > "${leaf}/memory.oom.group"
  [ -w "${leaf}/pids.max" ] &&
    printf '%s\n' "$BACKUP_BROWSER_CGROUP_PIDS_MAX" > "${leaf}/pids.max"
  printf '%s\n' "$pid" > "${leaf}/cgroup.procs"
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  [ "$actual" = "${leaf#/sys/fs/cgroup}" ] ||
    deny "backup-browser-cgroup-attachment-failed" "pid=${pid},actual=${actual:-missing}"
}

remove_backup_browser_cgroup() {
  local pid="$1" leaf
  leaf="$(backup_browser_cgroup_for_pid "$pid")"
  [ -d "$leaf" ] || return 0
  [ -z "$(cat "${leaf}/cgroup.procs" 2>/dev/null || true)" ] ||
    deny "backup-browser-cgroup-not-empty" "pid=${pid}"
  rmdir "$leaf" 2>/dev/null || true
}

reconcile_host_service_cgroup() {
  local pid_file pid title runtime_uid actual_uid
  configure_host_service_cgroup
  runtime_uid="$(id -u "$RUNTIME_USER")"
  for pid_file in \
    /mnt/cocalc/data/daemon.pid \
    /mnt/cocalc/data/project-host-app.pid \
    /mnt/cocalc/data/conat-router.pid \
    /mnt/cocalc/data/conat-persist.pid \
    /mnt/cocalc/data/conat-persist-app.pid \
    /mnt/cocalc/data/host-agent.pid \
    /mnt/cocalc/data/acp-worker.pid; do
    [ -r "$pid_file" ] || continue
    pid="$(cat "$pid_file")"
    if ! echo "$pid" | grep -Eq '^[0-9]+$' || [ "$pid" -le 1 ] || ! kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    actual_uid="$(awk '/^Uid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
    [ "$actual_uid" = "$runtime_uid" ] || continue
    title="$(host_service_process_title "$pid")"
    grep -Eq '^project-host:(app|host-agent(:[0-9]+)?|conat-router|conat-persist|acp-worker|conat-router-cluster-node)$' <<< "$title" || continue
    require_host_service_pid "$pid"
    printf '%s\n' "$pid" > "${HOST_SERVICE_CGROUP_DEFAULT}/cgroup.procs"
  done
}

configure_project_startup_cgroup() {
  local fields mode pid attempt remaining
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$PROJECT_STARTUP_CGROUP_DEFAULT"
  mkdir -p "$PROJECT_STARTUP_CREATE_CGROUP_DEFAULT"
  # Helper v21 attached podman-create launchers directly to the parent. Move
  # any mixed-version processes into the compatibility leaf before enabling
  # controllers; cgroup v2 forbids internal processes in a delegated parent.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      printf '%s\n' "$pid" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cgroup.procs" || true
    done < "${PROJECT_STARTUP_CGROUP_DEFAULT}/cgroup.procs"
    remaining="$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/cgroup.procs")"
    [ -z "$remaining" ] && break
    sleep 0.01
  done
  if [ -n "${remaining:-}" ]; then
    deny "project-startup-internal-processes-remain" "$remaining"
  fi
  enable_cgroup_controllers "$PROJECT_STARTUP_CGROUP_DEFAULT"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.max" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_CPU_MAX" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.max"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.weight" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_CPU_WEIGHT" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.weight"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/io.weight" ] &&
    printf 'default %s\n' "$PROJECT_STARTUP_CGROUP_IO_WEIGHT" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/io.weight"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.high" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_MEMORY_HIGH" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.high"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.max" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_MEMORY_MAX" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.max"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.swap.max" ] &&
    printf '0\n' > "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.swap.max"
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/pids.max" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_PIDS_MAX" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/pids.max"
  fields="$(project_io_policy_fields standard)" ||
    deny "project-io-policy-invalid" "startup"
  IFS=$'\t' read -r mode _rest <<< "$fields"
  apply_io_max "$PROJECT_STARTUP_CGROUP_DEFAULT" "startup" "$mode"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$PROJECT_STARTUP_CGROUP_DEFAULT" "startup"
  fi
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.max" ] &&
    printf 'max 100000\n' > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.max"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.weight" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_CPU_WEIGHT" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.weight"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/io.weight" ] &&
    printf 'default %s\n' "$PROJECT_STARTUP_CGROUP_IO_WEIGHT" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/io.weight"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.high" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CREATE_CGROUP_MEMORY_HIGH" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.high"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.max" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CREATE_CGROUP_MEMORY_MAX" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.max"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.swap.max" ] &&
    printf '0\n' > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.swap.max"
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/pids.max" ] &&
    printf '%s\n' "$PROJECT_STARTUP_CGROUP_PIDS_MAX" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/pids.max"
  apply_io_max "$PROJECT_STARTUP_CREATE_CGROUP_DEFAULT" "startup" "$mode"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$PROJECT_STARTUP_CREATE_CGROUP_DEFAULT" "startup"
  fi
}

project_startup_cgroup_ready() {
  local controller
  [ -d "$PROJECT_STARTUP_CGROUP_DEFAULT" ] || return 1
  [ -d "$PROJECT_STARTUP_CREATE_CGROUP_DEFAULT" ] || return 1
  [ -w "${PROJECT_STARTUP_CGROUP_DEFAULT}/cgroup.procs" ] || return 1
  [ -w "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cgroup.procs" ] || return 1
  [ -z "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/cgroup.procs" 2>/dev/null || true)" ] || return 1
  for controller in cpu memory pids io; do
    grep -qw "$controller" "${PROJECT_STARTUP_CGROUP_DEFAULT}/cgroup.subtree_control" || return 1
  done
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.max" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_CPU_MAX" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/cpu.weight" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_CPU_WEIGHT" ] || return 1
  [ "$(awk '$1 == "default" {print $2}' "${PROJECT_STARTUP_CGROUP_DEFAULT}/io.weight" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_IO_WEIGHT" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.high" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_MEMORY_HIGH" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_MEMORY_MAX" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.swap.max" 2>/dev/null || true)" = "0" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CGROUP_DEFAULT}/pids.max" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_PIDS_MAX" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.max" 2>/dev/null || true)" = "max 100000" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cpu.weight" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_CPU_WEIGHT" ] || return 1
  [ "$(awk '$1 == "default" {print $2}' "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/io.weight" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_IO_WEIGHT" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.high" 2>/dev/null || true)" = "$PROJECT_STARTUP_CREATE_CGROUP_MEMORY_HIGH" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)" = "$PROJECT_STARTUP_CREATE_CGROUP_MEMORY_MAX" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.swap.max" 2>/dev/null || true)" = "0" ] || return 1
  [ "$(cat "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/pids.max" 2>/dev/null || true)" = "$PROJECT_STARTUP_CGROUP_PIDS_MAX" ] || return 1
  return 0
}

apply_existing_project_io_policy() {
  local cgroup="$1" project_id="$2" io_class="standard" fields
  local mode mountpoint _pool_rbps _pool_wbps _pool_riops _pool_wiops
  local rbps wbps riops wiops weight _class
  if [ -r "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}" ]; then
    io_class="$(cat "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}")"
    case "$io_class" in
      standard|member|premium) ;;
      *) io_class="standard" ;;
    esac
    printf '%s\n' "$io_class" > "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}"
  fi
  fields="$(project_io_policy_fields "$io_class")" || deny "project-io-policy-invalid" "$io_class"
  IFS=$'\t' read -r mode mountpoint _pool_rbps _pool_wbps _pool_riops _pool_wiops rbps wbps riops wiops weight _class _policy_version _policy_profile _capacity_source _capacity_mode <<< "$fields"
  if [ -w "$cgroup/io.weight" ]; then
    printf 'default %s\n' "$weight" > "$cgroup/io.weight"
  fi
  apply_io_max "$cgroup" "$io_class" "$mode" "$io_class"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$cgroup" "$io_class" "$io_class"
  fi
}

normalize_project_io_class_state() {
  local state_file project_id io_class
  mkdir -p "$PROJECT_IO_CLASS_STATE_DIR"
  for state_file in "${PROJECT_IO_CLASS_STATE_DIR}"/*; do
    [ -f "$state_file" ] || continue
    project_id="${state_file##*/}"
    if ! is_project_uuid "$project_id"; then
      rm -f -- "$state_file"
      continue
    fi
    io_class="$(cat "$state_file")"
    case "$io_class" in
      standard|member|premium) ;;
      *) io_class="standard" ;;
    esac
    printf '%s\n' "$io_class" > "$state_file"
  done
}

reconcile_project_io_policy() {
  local pool project_id
  acquire_project_cgroup_lock
  normalize_project_io_class_state
  configure_project_pool_hierarchy
  configure_maintenance_cgroup
  for pool in "${PROJECT_POOL_CGROUP_DEFAULT}"/project-*; do
    [ -d "$pool" ] || continue
    project_id="${pool##*/project-}"
    is_project_uuid "$project_id" || continue
    apply_existing_project_io_policy "$pool" "$project_id"
  done
  release_project_lock
}

enable_cgroup_controllers() {
  local parent="$1" controller
  [ -w "${parent}/cgroup.subtree_control" ] || return 0
  for controller in cpu memory pids io; do
    if grep -qw "$controller" "${parent}/cgroup.controllers"; then
      printf '+%s\n' "$controller" > "${parent}/cgroup.subtree_control"
    fi
  done
}

configure_project_pool_hierarchy() {
  local legacy pid attempt remaining
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$PROJECT_POOL_CGROUP_DEFAULT"
  legacy="$(project_legacy_cgroup)"
  mkdir -p "$legacy"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      printf '%s\n' "$pid" > "${legacy}/cgroup.procs" || true
    done < "${PROJECT_POOL_CGROUP_DEFAULT}/cgroup.procs"
    remaining="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/cgroup.procs")"
    [ -z "$remaining" ] && break
    sleep 0.05
  done
  if [ -n "${remaining:-}" ]; then
    deny "project-pool-internal-processes-remain" "$remaining"
  fi
  enable_cgroup_controllers "$PROJECT_POOL_CGROUP_DEFAULT"
  reconcile_project_pool_io_reservation
  # The startup cgroup is a root-level sibling so container creation can use
  # capacity reserved from ordinary projects without executing project code.
  configure_project_startup_cgroup
}

project_pool_hierarchy_ready() {
  local controller
  [ -d "$PROJECT_POOL_CGROUP_DEFAULT" ] || return 1
  [ -d "$(project_legacy_cgroup)" ] || return 1
  [ -r "${PROJECT_POOL_CGROUP_DEFAULT}/cgroup.subtree_control" ] || return 1
  for controller in cpu memory pids io; do
    grep -qw "$controller" "${PROJECT_POOL_CGROUP_DEFAULT}/cgroup.subtree_control" || return 1
  done
  return 0
}

require_finite_project_pool_memory_max() {
  local memory_max
  memory_max="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)"
  if ! echo "$memory_max" | grep -Eq '^[0-9]+$' || [ "$memory_max" -le 0 ]; then
    deny "project-pool-memory-max-unbounded" "${memory_max:-missing}"
  fi
}

valid_cgroup_limit() {
  [ "$1" = "max" ] || echo "$1" | grep -Eq '^[0-9]+$'
}

valid_positive_cgroup_limit() {
  echo "$1" | grep -Eq '^[0-9]+$' && [ "$1" -gt 0 ]
}

effective_project_memory_max() {
  local requested="$1" pool_max ceiling
  pool_max="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)"
  valid_positive_cgroup_limit "$pool_max" || deny "project-pool-memory-max-unbounded" "${pool_max:-missing}"
  ceiling="$((pool_max - PROJECT_LEAF_POOL_HEADROOM_BYTES))"
  if [ "$ceiling" -lt "$MIN_PROJECT_LEAF_MEMORY_MAX_BYTES" ]; then
    deny "project-pool-memory-headroom-insufficient" "pool_max=${pool_max},ceiling=${ceiling}"
  fi
  if [ "$requested" = "max" ] || [ "$requested" -gt "$ceiling" ]; then
    printf '%s\n' "$ceiling"
  else
    printf '%s\n' "$requested"
  fi
}

configure_project_cgroup() {
  local cgroup="$1" memory_max="$2" memory_high="$3" memory_low="$4"
  local memory_swap_max="$5" pids_max="$6" cpu_quota="$7"
  local cpu_period="$8" cpu_weight="$9" io_weight="${10}" io_class="${11:-standard}"
  local value requested_memory_max fields io_mode io_mountpoint
  local _pool_rbps _pool_wbps _pool_riops _pool_wiops rbps wbps riops wiops policy_weight
  for value in "$memory_max" "$memory_high" "$memory_low" "$memory_swap_max" "$pids_max" "$cpu_quota"; do
    valid_cgroup_limit "$value" || deny "project-cgroup-limit-invalid" "$value"
  done
  valid_positive_cgroup_limit "$cpu_period" || deny "project-cgroup-cpu-period-invalid" "$cpu_period"
  if ! valid_positive_cgroup_limit "$cpu_weight" || [ "$cpu_weight" -gt 10000 ]; then
    deny "project-cgroup-cpu-weight-invalid" "$cpu_weight"
  fi
  if ! valid_positive_cgroup_limit "$io_weight" || [ "$io_weight" -gt 10000 ]; then
    deny "project-cgroup-io-weight-invalid" "$io_weight"
  fi
  fields="$(project_io_policy_fields "$io_class")" || deny "project-io-policy-invalid" "$io_class"
  IFS=$'\t' read -r io_mode io_mountpoint _pool_rbps _pool_wbps _pool_riops _pool_wiops rbps wbps riops wiops policy_weight io_class _policy_version _policy_profile _capacity_source <<< "$fields"
  if [ "$io_mode" = "enforce" ]; then
    io_weight="$policy_weight"
  fi
  requested_memory_max="$memory_max"
  memory_max="$(effective_project_memory_max "$memory_max")"
  if [ "$memory_high" != "max" ] && [ "$memory_high" -gt "$memory_max" ]; then
    memory_high="$memory_max"
  fi
  if [ "$memory_low" != "max" ] && [ "$memory_low" -gt "$memory_max" ]; then
    memory_low="$memory_max"
  fi
  if [ "$requested_memory_max" != "$memory_max" ]; then
    echo "project cgroup memory limit clamped: requested=${requested_memory_max} effective=${memory_max}" >&2
  fi
  mkdir -p "$cgroup"
  printf '%s\n' "$memory_max" > "$cgroup/memory.max"
  printf '%s\n' "$memory_high" > "$cgroup/memory.high"
  printf '%s\n' "$memory_low" > "$cgroup/memory.low"
  printf '%s\n' "$memory_swap_max" > "$cgroup/memory.swap.max"
  printf '%s\n' "$pids_max" > "$cgroup/pids.max"
  printf '%s %s\n' "$cpu_quota" "$cpu_period" > "$cgroup/cpu.max"
  printf '%s\n' "$cpu_weight" > "$cgroup/cpu.weight"
  if [ -w "$cgroup/io.weight" ]; then
    printf 'default %s\n' "$io_weight" > "$cgroup/io.weight"
  fi
  apply_io_max "$cgroup" "$io_class" "$io_mode" "$io_class"
  if [ "$io_mode" = "enforce" ]; then
    verify_io_max "$cgroup" "$io_class" "$io_class"
  fi
  mkdir -p "$PROJECT_IO_CLASS_STATE_DIR"
  chmod 0755 "$PROJECT_IO_CLASS_STATE_DIR"
  printf '%s\n' "$io_class" > "${PROJECT_IO_CLASS_STATE_DIR}/$(basename "$cgroup" | sed 's/^project-//')"
  # Keep the hard project cap, but let the kernel kill the process that caused
  # the OOM instead of terminating every terminal, kernel, and project daemon.
  printf '0\n' > "$cgroup/memory.oom.group"
}

configure_project_startup_runtime_leaf() {
  local cgroup="$1" memory_max="$2" memory_high="$3" memory_low="$4"
  local memory_swap_max="$5" pids_max="$6" cpu_quota="$7"
  local cpu_period="$8" startup_cpu_weight="$9"
  local startup_io_weight="${10}" io_class="${11:-standard}"
  local fields mode
  configure_project_cgroup \
    "$cgroup" "$memory_max" "$memory_high" "$memory_low" \
    "$memory_swap_max" "$pids_max" "$cpu_quota" "$cpu_period" \
    "$startup_cpu_weight" "$startup_io_weight" "$io_class"
  fields="$(project_io_policy_fields "$io_class")" ||
    deny "project-io-policy-invalid" "$io_class"
  IFS=$'\t' read -r mode _rest <<< "$fields"
  apply_io_max "$cgroup" "startup" "$mode" "$io_class"
  if [ "$mode" = "enforce" ]; then
    verify_io_max "$cgroup" "startup" "$io_class"
  fi
  # Enforced policy normally replaces the caller's requested weight. Give a
  # starting runtime first service inside the bounded startup parent.
  printf '%s\n' "$startup_cpu_weight" > "$cgroup/cpu.weight"
  if [ -w "$cgroup/io.weight" ]; then
    printf 'default %s\n' "$startup_io_weight" > "$cgroup/io.weight"
  fi
}

project_pid_is_in_pool() {
  local project_id="$1" pid="$2" actual expected
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  expected="$(project_cgroup_relative_path "$project_id")"
  case "$actual" in
    "$expected"|"$expected"/*) return 0 ;;
  esac
  return 1
}

verify_project_pid_in_startup_runtime() {
  local project_id="$1" pid="$2" actual expected
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  expected="$(project_startup_runtime_cgroup_relative_path "$project_id")"
  [ "$actual" = "$expected" ] ||
    deny "project-startup-runtime-cgroup-verification-failed" \
      "pid=${pid},expected=${expected},actual=${actual:-missing}"
}

verify_project_pid_in_pool() {
  local project_id="$1" pid="$2" actual expected
  if project_pid_is_in_pool "$project_id" "$pid"; then
    return 0
  fi
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  expected="$(project_cgroup_relative_path "$project_id")"
  echo "project cgroup verification failed: pid=${pid} expected=${expected} actual=${actual:-missing}" >&2
  return 1
}

attach_project_launcher() {
  local project_id="$1" pid="$2" target
  require_runtime_owned_pid "$pid"
  target="$(project_cgroup "$project_id")"
  [ -d "$target" ] || target="$(project_legacy_cgroup)"
  [ -d "$target" ] || target="$PROJECT_POOL_CGROUP_DEFAULT"
  printf '%s\n' "$pid" > "${target}/cgroup.procs"
  printf '%s\n' "$PROJECT_PROCESS_OOM_SCORE_ADJ" > "/proc/${pid}/oom_score_adj"
}

bees_cgroup() {
  printf '%s\n' "${BEES_CGROUP_DEFAULT}"
}

bees_worker_count() {
  local cpu_count
  cpu_count="$(/usr/bin/nproc 2>/dev/null || printf '1\n')"
  if ! echo "$cpu_count" | grep -Eq '^[0-9]+$' || [ "$cpu_count" -lt 1 ]; then
    cpu_count=1
  fi
  if [ "$cpu_count" -gt "$BEES_CGROUP_MAX_WORKERS" ]; then
    cpu_count="$BEES_CGROUP_MAX_WORKERS"
  fi
  printf '%s\n' "$cpu_count"
}

bees_memory_limits() {
  local total_kib total_bytes memory_high memory_max
  total_kib="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true)"
  if ! echo "$total_kib" | grep -Eq '^[0-9]+$' || [ "$total_kib" -le 0 ]; then
    printf '%s %s\n' "$BEES_CGROUP_MEMORY_HIGH_MAX" "$BEES_CGROUP_MEMORY_MAX_MAX"
    return 0
  fi
  total_bytes="$((total_kib * 1024))"
  memory_high="$((total_bytes / 16))"
  memory_max="$((total_bytes / 8))"
  if [ "$memory_high" -lt "$BEES_CGROUP_MEMORY_HIGH_MIN" ]; then
    memory_high="$BEES_CGROUP_MEMORY_HIGH_MIN"
  elif [ "$memory_high" -gt "$BEES_CGROUP_MEMORY_HIGH_MAX" ]; then
    memory_high="$BEES_CGROUP_MEMORY_HIGH_MAX"
  fi
  if [ "$memory_max" -lt "$BEES_CGROUP_MEMORY_MAX_MIN" ]; then
    memory_max="$BEES_CGROUP_MEMORY_MAX_MIN"
  elif [ "$memory_max" -gt "$BEES_CGROUP_MEMORY_MAX_MAX" ]; then
    memory_max="$BEES_CGROUP_MEMORY_MAX_MAX"
  fi
  printf '%s %s\n' "$memory_high" "$memory_max"
}

configure_bees_cgroup() {
  local pool="$1" mountpoint="$2" workers memory_high memory_max
  local fields mode policy_profile rows
  local device major_hex minor_hex major minor
  local -a io_limits=()
  enable_cgroup_controllers /sys/fs/cgroup
  mkdir -p "$pool"
  workers="$(bees_worker_count)"
  read -r memory_high memory_max < <(bees_memory_limits)
  printf '%s %s\n' "$((workers * BEES_CGROUP_CPU_PERIOD))" "$BEES_CGROUP_CPU_PERIOD" > "${pool}/cpu.max"
  printf '%s\n' "$BEES_CGROUP_CPU_WEIGHT" > "${pool}/cpu.weight"
  printf '%s\n' "$memory_high" > "${pool}/memory.high"
  printf '%s\n' "$memory_max" > "${pool}/memory.max"
  if [ -w "${pool}/memory.swap.max" ]; then
    printf '0\n' > "${pool}/memory.swap.max"
  fi
  printf '0\n' > "${pool}/memory.oom.group"
  printf '%s\n' "$BEES_CGROUP_PIDS_MAX" > "${pool}/pids.max"
  if [ -w "${pool}/io.weight" ]; then
    printf 'default %s\n' "$BEES_CGROUP_IO_WEIGHT" > "${pool}/io.weight"
  fi
  if [ -w "${pool}/io.max" ]; then
    fields="$(project_io_policy_fields standard)" ||
      deny "project-io-policy-invalid" "bees"
    IFS=$'\t' read -r mode _mountpoint _pool_rbps _pool_wbps _pool_riops _pool_wiops _rbps _wbps _riops _wiops _weight _io_class _policy_version policy_profile _capacity_source _capacity_mode <<< "$fields"
    if [ "$mode" = "enforce" ] &&
      [ "$policy_profile" = "gcp-pd-balanced-btrfs-headroom" ]; then
      # BEES performs Btrfs metadata transactions. A low io.max can turn it
      # into a filesystem-wide lock holder even though it is nice/idle and has
      # I/O weight 1. Use the same finite device-headroom envelope as the
      # project pool; CPU, weight, and idle scheduling still keep it subordinate.
      rows="$(project_io_limit_rows pool standard)" ||
        deny "project-io-device-unavailable" "bees"
      apply_io_max "$pool" "pool" "$mode" standard "$rows"
      verify_io_max "$pool" "pool" standard "$rows"
      return 0
    fi
    while IFS= read -r device; do
      [ -b "$device" ] || continue
      read -r major_hex minor_hex < <(stat -Lc '%t %T' "$device")
      major="$((16#$major_hex))"
      minor="$((16#$minor_hex))"
      io_limits+=("${major}:${minor} rbps=${BEES_CGROUP_IO_READ_BPS} wbps=${BEES_CGROUP_IO_WRITE_BPS}")
    done < <(/usr/bin/btrfs filesystem show --raw "$mountpoint" 2>/dev/null | awk '$1 == "devid" {print $NF}')
    if [ "${#io_limits[@]}" -gt 0 ]; then
      printf '%s\n' "${io_limits[@]}" > "${pool}/io.max"
    fi
  fi
}

attach_pid_to_project_pool_storage() {
  local pid="$1" pool="$2"
  if [ -z "$pid" ] || ! echo "$pid" | grep -Eq '^[0-9]+$' || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' "$pid" > "$pool/cgroup.procs"
}

attach_pid_tree_to_project_pool_storage() {
  local root_pid="$1" pool="$2" pending pid child children_file children
  if [ -z "$root_pid" ] || ! kill -0 "$root_pid" 2>/dev/null; then
    return 0
  fi
  pending="$root_pid"
  while [ -n "$pending" ]; do
    pid="${pending%% *}"
    if [ "$pending" = "$pid" ]; then
      pending=""
    else
      pending="${pending#* }"
    fi
    attach_pid_to_project_pool_storage "$pid" "$pool" || true
    children_file="/proc/${pid}/task/${pid}/children"
    children=""
    if [ -r "$children_file" ]; then
      read -r children < "$children_file" || true
    fi
    for child in $children; do
      [ -n "$child" ] || continue
      pending="${pending:+${pending} }${child}"
    done
  done
}

move_project_startup_runtime_to_pool() {
  local project_id="$1" pool="$2" source pid attempt remaining
  source="$(project_startup_runtime_cgroup "$project_id")"
  [ -d "$source" ] || return 1
  # Move every process from the root-owned leaf, rather than relying only on a
  # process-tree snapshot. Once init is moved, new children inherit the final
  # leaf; retries close the small fork race for conmon and networking helpers.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      printf '%s\n' "$pid" > "$pool/cgroup.procs" || true
    done < "$source/cgroup.procs"
    remaining="$(cat "$source/cgroup.procs" 2>/dev/null || true)"
    [ -z "$remaining" ] && break
    sleep 0.01
  done
  [ -z "${remaining:-}" ] ||
    deny "project-startup-runtime-processes-remain" \
      "project=${project_id},pids=${remaining}"
  rmdir "$source" 2>/dev/null ||
    deny "project-startup-runtime-cleanup-failed" "$project_id"
  return 0
}

find_project_conmon_pids() {
  local project_id="$1" name="project-$1"
  ps -eo pid=,args= | awk -v name="$name" '
    /(^|\\/)conmon([[:space:]]|$)/ &&
    $0 !~ /--exec-attach/ &&
    $0 !~ /--exec-process-spec/ &&
    index($0, " -n " name " ") > 0 { print $1 }
  '
}

find_pasta_pids() {
  ps -eo pid=,comm= | awk '$2 == "pasta" || $2 ~ /^pasta[.]/ {print $1}'
}

find_pasta_pids_for_netns() {
  local expected_netns_path="$1" pid proc arg expect_netns netns_path
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    proc="/proc/${pid}"
    netns_path=""
    expect_netns=0
    while IFS= read -r arg; do
      if [ "$expect_netns" = "1" ]; then
        netns_path="$arg"
        break
      fi
      case "$arg" in
        --netns) expect_netns=1 ;;
        --netns=*) netns_path="${arg#--netns=}"; break ;;
      esac
    done < <(tr '\\0' '\\n' < "$proc/cmdline" 2>/dev/null || true)
    [ "$netns_path" = "$expected_netns_path" ] && printf '%s\n' "$pid"
  done < <(find_pasta_pids)
}

find_pasta_pids_for_project() {
  local project_id="$1" expected pid actual
  expected="$(project_cgroup_relative_path "$project_id")"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
    [ "$actual" = "$expected" ] && printf '%s\\n' "$pid"
  done < <(find_pasta_pids)
}

project_network_cgroup_path() {
  local project_id="$1"
  printf '%s/project-%s\\n' "$(project_network_pool_cgroup_path)" "$project_id"
}

project_network_pool_cgroup_path() {
  local relative
  relative="${PROJECT_POOL_CGROUP_DEFAULT#/sys/fs/cgroup/}"
  relative="${relative#/}"
  printf '%s\\n' "$relative"
}

project_network_cgroup_level() {
  local path
  path="$(project_network_cgroup_path "$1")"
  awk -F/ '{print NF}' <<< "$path"
}

project_network_rule_marker() {
  printf 'cocalc-project-network-%s\\n' "$1"
}

project_network_policy_dir() {
  printf '/var/lib/cocalc/project-network-policies\\n'
}

exam_runtime_dir() {
  printf '/var/lib/cocalc/exam-runtime\\n'
}

exam_current_run_file() {
  printf '%s/current-run\\n' "$(exam_runtime_dir)"
}

set_current_exam_run() {
  local run_id="$1" dir
  is_project_uuid "$run_id" || deny "exam-run-id-invalid" "$run_id"
  dir="$(exam_runtime_dir)"
  /usr/bin/install -d -m 0700 -o root -g root "$dir"
  printf '%s\\n' "$run_id" > "$(exam_current_run_file)"
  chmod 0600 "$(exam_current_run_file)"
}

clear_current_exam_run() {
  local run_id="$1" current=""
  is_project_uuid "$run_id" || deny "exam-run-id-invalid" "$run_id"
  if [ -r "$(exam_current_run_file)" ]; then
    current="$(cat "$(exam_current_run_file)" 2>/dev/null || true)"
  fi
  if [ -n "$current" ] && [ "$current" != "$run_id" ]; then
    deny "exam-run-id-mismatch" "$run_id"
  fi
  rm -f "$(exam_current_run_file)"
}

poweroff_exam_host() {
  local run_id="$1" current=""
  is_project_uuid "$run_id" || deny "exam-run-id-invalid" "$run_id"
  if [ -r "$(exam_current_run_file)" ]; then
    current="$(cat "$(exam_current_run_file)" 2>/dev/null || true)"
  fi
  [ "$current" = "$run_id" ] || deny "exam-run-id-mismatch" "$run_id"
  printf 'exam-deadline:%s\\n' "$run_id" > /mnt/cocalc/data/host-shutdown-intent
  /usr/bin/systemctl poweroff --no-block
}

project_network_policy_file() {
  printf '%s/%s\\n' "$(project_network_policy_dir)" "$1"
}

project_network_policy() {
  local file
  file="$(project_network_policy_file "$1")"
  if [ -r "$file" ] && [ "$(cat "$file" 2>/dev/null || true)" = "disabled" ]; then
    printf 'disabled\\n'
  else
    printf 'normal\\n'
  fi
}

set_project_network_policy() {
  local project_id="$1" policy="$2" dir file
  is_project_uuid "$project_id" || deny "project-id-invalid" "$project_id"
  dir="$(project_network_policy_dir)"
  file="$(project_network_policy_file "$project_id")"
  /usr/bin/install -d -m 0700 -o root -g root "$dir"
  case "$policy" in
    disabled)
      printf 'disabled\\n' > "$file"
      chmod 0600 "$file"
      ;;
    normal)
      rm -f "$file"
      ;;
    *)
      deny "project-network-policy-invalid" "$policy"
      ;;
  esac
}

require_project_network_tools() {
  [ -x "$PROJECT_NETWORK_NFT" ] || deny "project-network-tool-missing" "$PROJECT_NETWORK_NFT"
  [ -x /usr/bin/prlimit ] || deny "project-network-tool-missing" "/usr/bin/prlimit"
  [ -x /usr/bin/timeout ] || deny "project-network-tool-missing" "/usr/bin/timeout"
}

run_project_network_nft() {
  /usr/bin/timeout --signal=TERM --kill-after=2s \
    "${PROJECT_NETWORK_NFT_TIMEOUT_SECONDS}s" "$PROJECT_NETWORK_NFT" "$@"
}

configure_project_network_table() {
  require_project_network_tools
  if ! run_project_network_nft list table inet "$PROJECT_NETWORK_TABLE" >/dev/null 2>&1; then
    if ! run_project_network_nft add table inet "$PROJECT_NETWORK_TABLE" 2>/dev/null; then
      run_project_network_nft list table inet "$PROJECT_NETWORK_TABLE" >/dev/null
    fi
  fi
  if ! run_project_network_nft list chain inet "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" >/dev/null 2>&1; then
    if ! printf 'add chain inet %s %s { type filter hook output priority filter; policy accept; }\\n' \
      "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" | run_project_network_nft -f - 2>/dev/null; then
      run_project_network_nft list chain inet "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" >/dev/null
    fi
  fi
}

ensure_project_network_rule() {
  local project_id="$1"
  is_project_uuid "$project_id" || deny "project-id-invalid" "$project_id"
  # Listing a cgroup/socket rule chain can take many seconds on a busy host.
  # Project creation must not depend on that read path: append containment
  # rules atomically, then let the periodic full reconciliation remove any
  # duplicate or stale rules. Bootstrap normally creates the table first; the
  # fallback keeps a cold or manually repaired host self-healing.
  if emit_project_network_rules "$project_id" | run_project_network_nft -f -; then
    return 0
  fi
  configure_project_network_table
  {
    emit_project_metadata_rules
    emit_project_startup_network_rules
    emit_project_network_rules "$project_id"
  } | run_project_network_nft -f -
}

emit_project_startup_network_rules() {
  local path level marker="cocalc-project-network-startup"
  path="${PROJECT_STARTUP_CGROUP_DEFAULT#/sys/fs/cgroup/}"
  level="$(awk -F/ '{print NF}' <<< "$path")"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ip daddr %s tcp dport %s counter drop comment "%s-ipv4"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_METADATA_IPV4" "$PROJECT_METADATA_TCP_PORTS" "$marker"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ip6 daddr %s tcp dport %s counter drop comment "%s-ipv6"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_METADATA_IPV6" "$PROJECT_METADATA_TCP_PORTS" "$marker"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" meta l4proto tcp tcp flags & (fin | syn | rst | ack) == syn limit rate over %s/second burst %s packets counter drop comment "%s-tcp"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_TCP_NEW_RATE" "$PROJECT_TCP_NEW_BURST" "$marker"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" meta l4proto udp ct state new limit rate over %s/second burst %s packets counter drop comment "%s-udp"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_UDP_NEW_RATE" "$PROJECT_UDP_NEW_BURST" "$marker"
  # Pasta creates its published-port listener sockets before the runtime is
  # migrated out of this cgroup. Socket cgroup identity is fixed at creation,
  # so permit replies on established inbound connections from those listeners.
  # New outbound connections remain blocked by the final deny rule.
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ct state established,related counter accept comment "%s-established"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
  # A temporary runtime leaf has no project-specific policy identity. Deny
  # all traffic until verified migration into the final per-project cgroup;
  # retries made by the project daemon resume under its normal/exam policy.
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" counter drop comment "%s-deny"\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
}

emit_project_metadata_rules() {
  local path level marker="cocalc-project-network-metadata"
  path="$(project_network_pool_cgroup_path)"
  level="$(awk -F/ '{print NF}' <<< "$path")"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ip daddr %s tcp dport %s counter drop comment "%s-ipv4"\\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_METADATA_IPV4" "$PROJECT_METADATA_TCP_PORTS" "$marker"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ip6 daddr %s tcp dport %s counter drop comment "%s-ipv6"\\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_METADATA_IPV6" "$PROJECT_METADATA_TCP_PORTS" "$marker"
}

emit_project_network_rules() {
  local project_id="$1" path level marker policy
  path="$(project_network_cgroup_path "$project_id")"
  level="$(project_network_cgroup_level "$project_id")"
  marker="$(project_network_rule_marker "$project_id")"
  policy="$(project_network_policy "$project_id")"
  if [ "$policy" = "disabled" ]; then
    printf 'add rule inet %s %s socket cgroupv2 level %s "%s" meta l4proto { tcp, udp } th dport 53 counter reject comment "%s-disabled-dns"\\n' \
      "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
    printf 'add rule inet %s %s socket cgroupv2 level %s "%s" fib daddr type local counter accept comment "%s-disabled-local"\\n' \
      "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
    printf 'add rule inet %s %s socket cgroupv2 level %s "%s" ct state established,related counter accept comment "%s-disabled-established"\\n' \
      "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
    printf 'add rule inet %s %s socket cgroupv2 level %s "%s" counter reject comment "%s-disabled-reject"\\n' \
      "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" "$marker"
    return
  fi
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" meta l4proto tcp tcp flags & (fin | syn | rst | ack) == syn limit rate over %s/second burst %s packets counter drop comment "%s-tcp"\\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_TCP_NEW_RATE" "$PROJECT_TCP_NEW_BURST" "$marker"
  printf 'add rule inet %s %s socket cgroupv2 level %s "%s" meta l4proto udp ct state new limit rate over %s/second burst %s packets counter drop comment "%s-udp"\\n' \
    "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" "$level" "$path" \
    "$PROJECT_UDP_NEW_RATE" "$PROJECT_UDP_NEW_BURST" "$marker"
}

apply_pasta_resource_limits() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  /usr/bin/prlimit --pid "$pid" \
    --nofile="${PROJECT_PASTA_NOFILE_LIMIT}:${PROJECT_PASTA_NOFILE_LIMIT}"
}

project_cgroup_has_processes() {
  local cgroup="$1" pid=""
  [ -r "$cgroup/cgroup.procs" ] || return 1
  read -r pid < "$cgroup/cgroup.procs" || true
  [ -n "$pid" ]
}

verify_project_network_limits() {
  local project_id="$1" marker rules metadata_ipv4_count metadata_ipv6_count startup_established_count startup_deny_count tcp_count udp_count disabled_dns_count disabled_local_count disabled_established_count disabled_reject_count policy pid found=0 limits
  is_project_uuid "$project_id" || deny "project-id-invalid" "$project_id"
  require_project_network_tools
  marker="$(project_network_rule_marker "$project_id")"
  if ! rules="$(run_project_network_nft list chain inet "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN" 2>/dev/null)"; then
    echo "project network nftables chain is missing" >&2
    return 1
  fi
  metadata_ipv4_count="$(grep -Fc 'comment "cocalc-project-network-metadata-ipv4"' <<< "$rules" || true)"
  metadata_ipv6_count="$(grep -Fc 'comment "cocalc-project-network-metadata-ipv6"' <<< "$rules" || true)"
  startup_established_count="$(grep -Fc 'comment "cocalc-project-network-startup-established"' <<< "$rules" || true)"
  startup_deny_count="$(grep -Fc 'comment "cocalc-project-network-startup-deny"' <<< "$rules" || true)"
  tcp_count="$(grep -Fc "comment \\\"${marker}-tcp\\\"" <<< "$rules" || true)"
  udp_count="$(grep -Fc "comment \\\"${marker}-udp\\\"" <<< "$rules" || true)"
  disabled_dns_count="$(grep -Fc "comment \\\"${marker}-disabled-dns\\\"" <<< "$rules" || true)"
  disabled_local_count="$(grep -Fc "comment \\\"${marker}-disabled-local\\\"" <<< "$rules" || true)"
  disabled_established_count="$(grep -Fc "comment \\\"${marker}-disabled-established\\\"" <<< "$rules" || true)"
  disabled_reject_count="$(grep -Fc "comment \\\"${marker}-disabled-reject\\\"" <<< "$rules" || true)"
  policy="$(project_network_policy "$project_id")"
  if [ "$metadata_ipv4_count" -ne 1 ] || [ "$metadata_ipv6_count" -ne 1 ] || [ "$startup_established_count" -ne 1 ] || [ "$startup_deny_count" -ne 1 ]; then
    echo "project shared network rules are missing or duplicated: metadata_ipv4=${metadata_ipv4_count} metadata_ipv6=${metadata_ipv6_count} startup_established=${startup_established_count} startup_deny=${startup_deny_count}" >&2
    return 1
  fi
  if [ "$policy" = "disabled" ]; then
    if [ "$tcp_count" -ne 0 ] || [ "$udp_count" -ne 0 ] || [ "$disabled_dns_count" -ne 1 ] || [ "$disabled_local_count" -ne 1 ] || [ "$disabled_established_count" -ne 1 ] || [ "$disabled_reject_count" -ne 1 ]; then
      echo "disabled project network rules are missing or duplicated: dns=${disabled_dns_count} local=${disabled_local_count} established=${disabled_established_count} reject=${disabled_reject_count} tcp=${tcp_count} udp=${udp_count}" >&2
      return 1
    fi
  elif [ "$tcp_count" -ne 1 ] || [ "$udp_count" -ne 1 ] || [ "$disabled_dns_count" -ne 0 ] || [ "$disabled_local_count" -ne 0 ] || [ "$disabled_established_count" -ne 0 ] || [ "$disabled_reject_count" -ne 0 ]; then
    echo "normal project network rules are missing or duplicated: tcp=${tcp_count} udp=${udp_count} dns=${disabled_dns_count} local=${disabled_local_count} established=${disabled_established_count} reject=${disabled_reject_count}" >&2
    return 1
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    found=1
    limits="$(awk '$1 == "Max" && $2 == "open" && $3 == "files" {print $4 " " $5}' "/proc/${pid}/limits" 2>/dev/null || true)"
    if [ "$limits" != "${PROJECT_PASTA_NOFILE_LIMIT} ${PROJECT_PASTA_NOFILE_LIMIT}" ]; then
      echo "pasta nofile limit mismatch: pid=${pid} limits=${limits:-missing}" >&2
      return 1
    fi
  done < <(find_pasta_pids_for_project "$project_id")
  if [ "$found" -ne 1 ]; then
    echo "project pasta process is missing" >&2
    return 1
  fi
}

render_project_network_rules() {
  local snapshot="$1" cgroup project_id
  {
    # Add a complete fresh rule set before deleting the handles observed in
    # the snapshot. The nft batch is atomic, so containment is never absent.
    # Rules appended by a concurrent project start are not in the snapshot
    # and survive. A concurrent cleanup can only make this batch retry.
    emit_project_metadata_rules
    emit_project_startup_network_rules
    for cgroup in "${PROJECT_POOL_CGROUP_DEFAULT}"/project-*; do
      [ -d "$cgroup" ] || continue
      project_cgroup_has_processes "$cgroup" || continue
      project_id="${cgroup##*/project-}"
      is_project_uuid "$project_id" || continue
      emit_project_network_rules "$project_id"
    done
    awk -v table="$PROJECT_NETWORK_TABLE" -v chain="$PROJECT_NETWORK_CHAIN" '
      index($0, "comment \\"cocalc-project-network-") {
        for (i = 1; i < NF; i++) {
          if ($i == "handle" && $(i + 1) ~ /^[0-9]+$/) {
            printf "delete rule inet %s %s handle %s\\n", table, chain, $(i + 1)
          }
        }
      }
    ' <<< "$snapshot"
  }
}

apply_project_network_process_limits() {
  local pid actual pool_relative
  pool_relative="${PROJECT_POOL_CGROUP_DEFAULT#/sys/fs/cgroup}"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
    case "$actual" in
      "${pool_relative}/project-"*) apply_pasta_resource_limits "$pid" ;;
    esac
  done < <(find_pasta_pids)
}

reconcile_project_network_limits() {
  local attempt snapshot rules
  # During early boot, systemd may still be settling the cgroup v2 tree. nft
  # resolves socket cgroup paths while parsing the batch and rejects rules
  # whose paths are not visible yet. Recreate the hierarchy on every attempt
  # and give it time to become stable instead of aborting host bootstrap.
  for attempt in $(seq 1 "$PROJECT_NETWORK_BOOT_RECONCILE_ATTEMPTS"); do
    configure_project_pool_hierarchy
    configure_project_network_table
    snapshot="$(run_project_network_nft -a list chain inet "$PROJECT_NETWORK_TABLE" "$PROJECT_NETWORK_CHAIN")"
    rules="$(render_project_network_rules "$snapshot")"
    if printf '%s\\n' "$rules" | run_project_network_nft -f -; then
      apply_project_network_process_limits
      return 0
    fi
    sleep "$PROJECT_NETWORK_BOOT_RECONCILE_DELAY_SECONDS"
  done
  echo "project network nftables reconciliation failed after ${PROJECT_NETWORK_BOOT_RECONCILE_ATTEMPTS} attempts" >&2
  return 1
}

find_bees_pid() {
  local mountpoint="$1" proc pid
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    if [ "$pid" = "$$" ]; then
      continue
    fi
    if [ ! -r "$proc/comm" ] || [ ! -r "$proc/cmdline" ]; then
      continue
    fi
    if [ "$(cat "$proc/comm" 2>/dev/null || true)" != "bees" ]; then
      continue
    fi
    if [ "$(tr '\\0' '\\n' <"$proc/cmdline" 2>/dev/null | tail -n 1)" = "$mountpoint" ]; then
      printf '%s\\n' "$pid"
      return 0
    fi
  done
  return 0
}

apply_bees_runtime_policy() {
  local pid="$1" mountpoint="$2" pool task tid
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  pool="$(bees_cgroup)"
  configure_bees_cgroup "$pool" "$mountpoint"
  attach_pid_to_project_pool_storage "$pid" "$pool" || true
  for task in "/proc/${pid}/task/"[0-9]*; do
    [ -d "$task" ] || continue
    tid="${task##*/}"
    /usr/bin/renice -n 19 -p "$tid" >/dev/null 2>&1 || true
    /usr/bin/ionice -c3 -p "$tid" >/dev/null 2>&1 || true
  done
}

emit_bees_status() {
  local mountpoint="$1" pid pool
  pid="$(find_bees_pid "$mountpoint")"
  pool="$(bees_cgroup)"
  /usr/bin/python3 - "$mountpoint" "$pid" "$pool" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

mountpoint, raw_pid, cgroup = sys.argv[1:4]
beeshome = os.path.join(mountpoint, ".beeshome")


def read_text(path, limit=1024 * 1024):
    try:
        with open(path, "rb") as handle:
            return handle.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return None


def file_status(path, include_hash=False):
    try:
        stat = os.stat(path)
    except OSError:
        return {"exists": False}
    result = {
        "exists": True,
        "mtime_ms": int(stat.st_mtime * 1000),
        "size_bytes": stat.st_size,
    }
    if include_hash:
        digest = hashlib.sha256()
        try:
            with open(path, "rb") as handle:
                while chunk := handle.read(128 * 1024):
                    digest.update(chunk)
            result["sha256"] = digest.hexdigest()
        except OSError:
            pass
    return result


def parse_number(value):
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def parse_key_value_lines(text):
    result = {}
    for line in (text or "").splitlines():
        words = line.split()
        if len(words) == 2:
            result[words[0]] = parse_number(words[1])
    return result


def parse_stats(text):
    total = {}
    progress = []
    in_total = False
    in_progress = False
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped == "TOTAL:":
            in_total = True
            continue
        if stripped == "RATES:":
            in_total = False
            continue
        if stripped.startswith("extsz"):
            in_progress = True
        if in_progress:
            progress.append(line.rstrip())
        if not in_total:
            continue
        for word in stripped.split():
            if "=" not in word:
                continue
            key, value = word.split("=", 1)
            total[key] = parse_number(value)
    return {"total": total, "progress": "\\n".join(progress)[:32768]}


stats_path = os.path.join(beeshome, "beesstats.txt")
crawl_path = os.path.join(beeshome, "beescrawl.dat")
stats_text = read_text(stats_path)
crawl_text = read_text(crawl_path)
stats = file_status(stats_path)
stats.update(parse_stats(stats_text))
crawl = file_status(crawl_path, include_hash=True)
crawl["root_count"] = sum(
    1 for line in (crawl_text or "").splitlines() if line.startswith("root ")
)

pid = int(raw_pid) if raw_pid.isdigit() and int(raw_pid) > 1 else None
process_cgroup = None
if pid is not None:
    process_cgroup = read_text(f"/proc/{pid}/cgroup", 64 * 1024)
    if process_cgroup is not None:
        process_cgroup = process_cgroup.strip()

result = {
    "sampled_at": datetime.now(timezone.utc).isoformat(),
    "pid": pid,
    "process_cgroup": process_cgroup,
    "stats": stats,
    "crawl": crawl,
    "cgroup": {
        "path": cgroup,
        "cpu_max": (read_text(os.path.join(cgroup, "cpu.max")) or "").strip() or None,
        "cpu_weight": parse_number((read_text(os.path.join(cgroup, "cpu.weight")) or "").strip()),
        "cpu_stat": parse_key_value_lines(read_text(os.path.join(cgroup, "cpu.stat"))),
        "cpu_pressure": (read_text(os.path.join(cgroup, "cpu.pressure")) or "").strip() or None,
        "io_weight": (read_text(os.path.join(cgroup, "io.weight")) or "").strip() or None,
        "io_max": (read_text(os.path.join(cgroup, "io.max")) or "").strip() or None,
        "io_stat": (read_text(os.path.join(cgroup, "io.stat")) or "").strip() or None,
        "io_pressure": (read_text(os.path.join(cgroup, "io.pressure")) or "").strip() or None,
        "memory_current": parse_number((read_text(os.path.join(cgroup, "memory.current")) or "").strip()),
        "memory_high": parse_number((read_text(os.path.join(cgroup, "memory.high")) or "").strip()),
        "memory_max": parse_number((read_text(os.path.join(cgroup, "memory.max")) or "").strip()),
        "memory_peak": parse_number((read_text(os.path.join(cgroup, "memory.peak")) or "").strip()),
        "memory_events": parse_key_value_lines(read_text(os.path.join(cgroup, "memory.events"))),
        "memory_pressure": (read_text(os.path.join(cgroup, "memory.pressure")) or "").strip() or None,
        "pids_current": parse_number((read_text(os.path.join(cgroup, "pids.current")) or "").strip()),
        "pids_max": parse_number((read_text(os.path.join(cgroup, "pids.max")) or "").strip()),
    },
}
json.dump(result, sys.stdout, separators=(",", ":"))
sys.stdout.write("\\n")
PY
}

lexical_absolute_path_is_safe() {
  local path="$1" part
  case "$path" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$path" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  IFS='/' read -r -a _path_parts <<< "${path#/}"
  for part in "${_path_parts[@]}"; do
    case "$part" in
      ""|"."|"..") return 1 ;;
    esac
  done
  return 0
}

# Resolve an absolute caller path to a fixed root plus a relative path.  The
# fixed roots are selected here, never supplied by the sudo caller.  Mutating
# operations pass these values to the native openat2 helper below, so a caller
# cannot escape by replacing a checked directory with a symlink after validation.
set_allowed_path_parts() {
  local path="$1"
  lexical_absolute_path_is_safe "$path" || return 1
  ALLOWED_PATH_ROOT=""
  ALLOWED_PATH_REL=""
  case "$path" in
    /mnt/cocalc-scratch)
      ALLOWED_PATH_ROOT="/mnt/cocalc-scratch"; ALLOWED_PATH_REL="." ;;
    /mnt/cocalc-scratch/*)
      ALLOWED_PATH_ROOT="/mnt/cocalc-scratch"; ALLOWED_PATH_REL="${path#/mnt/cocalc-scratch/}" ;;
    /mnt/cocalc)
      ALLOWED_PATH_ROOT="/mnt/cocalc"; ALLOWED_PATH_REL="." ;;
    /mnt/cocalc/*)
      ALLOWED_PATH_ROOT="/mnt/cocalc"; ALLOWED_PATH_REL="${path#/mnt/cocalc/}" ;;
    /var/lib/cocalc/cocalc.img|/var/lib/cocalc/btrfs.img)
      ALLOWED_PATH_ROOT="/var/lib/cocalc"; ALLOWED_PATH_REL="${path#/var/lib/cocalc/}" ;;
    /var/lib/cocalc/star/project-host/0/cache)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/cache"; ALLOWED_PATH_REL="." ;;
    /var/lib/cocalc/star/project-host/0/cache/*)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/cache"; ALLOWED_PATH_REL="${path#/var/lib/cocalc/star/project-host/0/cache/}" ;;
    /var/lib/cocalc/star/project-host/0/secrets/rustic/rootfs-images)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/secrets/rustic"; ALLOWED_PATH_REL="rootfs-images" ;;
    /var/lib/cocalc/star/project-host/0/secrets/rustic/rootfs-images/*)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/secrets/rustic"; ALLOWED_PATH_REL="${path#/var/lib/cocalc/star/project-host/0/secrets/rustic/}" ;;
    /var/lib/cocalc/star/project-host/0/secrets/rustic/project-*.toml)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/secrets/rustic"; ALLOWED_PATH_REL="${path#/var/lib/cocalc/star/project-host/0/secrets/rustic/}" ;;
    /var/lib/cocalc/star/project-host/0/secrets/rustic/project-site-migrations/*/repo.toml)
      ALLOWED_PATH_ROOT="/var/lib/cocalc/star/project-host/0/secrets/rustic"; ALLOWED_PATH_REL="${path#/var/lib/cocalc/star/project-host/0/secrets/rustic/}" ;;
    /opt/cocalc/project-host)
      ALLOWED_PATH_ROOT="/opt/cocalc/project-host"; ALLOWED_PATH_REL="." ;;
    /opt/cocalc/project-host/*)
      ALLOWED_PATH_ROOT="/opt/cocalc/project-host"; ALLOWED_PATH_REL="${path#/opt/cocalc/project-host/}" ;;
    /opt/cocalc/container-runtime)
      ALLOWED_PATH_ROOT="/opt/cocalc/container-runtime"; ALLOWED_PATH_REL="." ;;
    /opt/cocalc/container-runtime/*)
      ALLOWED_PATH_ROOT="/opt/cocalc/container-runtime"; ALLOWED_PATH_REL="${path#/opt/cocalc/container-runtime/}" ;;
    /opt/cocalc/project-bundles)
      ALLOWED_PATH_ROOT="/opt/cocalc/project-bundles"; ALLOWED_PATH_REL="." ;;
    /opt/cocalc/project-bundles/*)
      ALLOWED_PATH_ROOT="/opt/cocalc/project-bundles"; ALLOWED_PATH_REL="${path#/opt/cocalc/project-bundles/}" ;;
    /opt/cocalc/tools)
      ALLOWED_PATH_ROOT="/opt/cocalc/tools"; ALLOWED_PATH_REL="." ;;
    /opt/cocalc/tools/*)
      ALLOWED_PATH_ROOT="/opt/cocalc/tools"; ALLOWED_PATH_REL="${path#/opt/cocalc/tools/}" ;;
    /dev/loop[0-9]*)
      ALLOWED_PATH_ROOT="/dev"; ALLOWED_PATH_REL="${path#/dev/}" ;;
    *) return 1 ;;
  esac
  return 0
}

allow_path() {
  set_allowed_path_parts "${1//\\\\:/:}"
}

require_allowed_path_parts() {
  local path="$1"
  if ! set_allowed_path_parts "$path"; then
    deny "path-not-allowed" "$path"
  fi
}

path_helper() {
  /usr/local/libexec/cocalc-runtime-storage-path-helper "$@"
}

allow_overlay_mountpoint() {
  local path="${1//\\\\:/:}"
  case "$path" in
    /mnt/cocalc/data/cache/project-roots/*|/var/lib/cocalc/star/project-host/0/cache/project-roots/*)
      ;;
    *)
      return 1
      ;;
  esac
  local base
  base="$(basename "$path")"
  # project ids are UUID-like; keep this strict to avoid broad mount targets.
  if ! echo "$base" | grep -Eq '^[0-9a-fA-F-]{32,64}$'; then
    return 1
  fi
  return 0
}

allow_privileged_delete_root() {
  local path="${1//\\\\:/:}"
  lexical_absolute_path_is_safe "$path" || return 1
  echo "$path" | grep -Eq '^/mnt/cocalc/project-[0-9a-fA-F-]{32,64}(-scratch)?$'
}

project_id_from_delete_root() {
  local root="${1//\\\\:/:}" base project_id
  allow_privileged_delete_root "$root" || return 1
  base="$(basename "$root")"
  project_id="${base#project-}"
  project_id="${project_id%-scratch}"
  is_project_uuid "$project_id" || return 1
  printf '%s\n' "$project_id"
}

attach_storage_worker_to_project() {
  local root="$1" project_id target io_class="standard"
  project_id="$(project_id_from_delete_root "$root")" || deny "storage-worker-project-invalid" "$root"
  acquire_project_cgroup_lock
  configure_project_pool_hierarchy
  require_finite_project_pool_memory_max
  target="$(project_cgroup "$project_id")"
  if [ ! -d "$target" ]; then
    if [ -r "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}" ]; then
      io_class="$(cat "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}")"
    fi
    configure_project_cgroup \
      "$target" "$PROJECT_STORAGE_WORKER_MEMORY_MAX" "$PROJECT_STORAGE_WORKER_MEMORY_HIGH" 0 0 64 \
      100000 100000 50 100 "$io_class"
  fi
  [ -d "$target" ] || deny "storage-worker-cgroup-missing" "$target"
  printf '%s\n' "$$" > "$target/cgroup.procs"
  verify_project_pid_in_pool "$project_id" "$$" || deny "storage-worker-cgroup-mismatch" "$project_id"
  release_project_lock
}

attach_maintenance_worker() {
  local actual
  acquire_project_cgroup_lock
  configure_maintenance_cgroup
  printf '%s\n' "$$" > "${MAINTENANCE_CGROUP_DEFAULT}/cgroup.procs"
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/$$/cgroup" 2>/dev/null || true)"
  if [ "$actual" != "${MAINTENANCE_CGROUP_DEFAULT#/sys/fs/cgroup}" ]; then
    deny "maintenance-worker-cgroup-mismatch" "${actual:-missing}"
  fi
  release_project_lock
}

check_relative_delete_path() {
  local rel="$1"
  if [ -z "$rel" ]; then
    return 1
  fi
  case "$rel" in
    /*)
      return 1
      ;;
  esac
  IFS='/' read -r -a _parts <<< "$rel"
  for _part in "${_parts[@]}"; do
    case "$_part" in
      ""|"."|"..")
        return 1
        ;;
    esac
  done
  return 0
}

check_args() {
  local arg value
  for arg in "$@"; do
    if [[ "$arg" == /* ]]; then
      if ! allow_path "$arg"; then
        deny "path-not-allowed" "$arg"
      fi
      continue
    fi
    if [[ "$arg" == *=/* ]]; then
      value="${arg#*=}"
      IFS=':' read -r -a _parts <<< "$value"
      for _part in "${_parts[@]}"; do
        [ -z "$_part" ] && continue
        if [[ "$_part" == /* ]] && ! allow_path "$_part"; then
          deny "path-not-allowed" "$_part"
        fi
      done
      continue
    fi
    if [[ "$arg" == */* ]] && [[ "$arg" != -* ]]; then
      deny "relative-path-not-allowed" "$arg"
    fi
  done
}

set_rustic_profile_parts() {
  local profile="$1"
  if [[ "$profile" != *.toml ]]; then
    profile="${profile}.toml"
  fi
  if ! [[ "$profile" =~ ^/mnt/cocalc/data/secrets/rustic/project-[0-9a-fA-F-]{32,64}\\.toml$|^/mnt/cocalc/data/secrets/rustic/rootfs-images/[0-9a-fA-F]{64}\\.toml$|^/mnt/cocalc/data/secrets/rustic/project-site-migrations/[0-9a-fA-F-]{32,64}/repo\\.toml$|^/var/lib/cocalc/star/project-host/0/secrets/rustic/project-[0-9a-fA-F-]{32,64}\\.toml$|^/var/lib/cocalc/star/project-host/0/secrets/rustic/rootfs-images/[0-9a-fA-F]{64}\\.toml$|^/var/lib/cocalc/star/project-host/0/secrets/rustic/project-site-migrations/[0-9a-fA-F-]{32,64}/repo\\.toml$ ]]; then
    deny "rustic-profile-path-not-allowed" "$profile"
  fi
  require_allowed_path_parts "$profile"
  RUSTIC_PROFILE_ROOT="$ALLOWED_PATH_ROOT"
  RUSTIC_PROFILE_REL="$ALLOWED_PATH_REL"
}

escape_overlay_path() {
  local path="$1"
  # Escape backslash/colon/comma for overlay mount option parsing.
  # Using sed here avoids fragile nested escaping through Python -> bash.
  printf '%s' "$path" | /usr/bin/sed -e 's/[\\\\,:]/\\\\&/g'
}

case "$cmd" in
  attach-backup-browser-cgroup)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage attach-backup-browser-cgroup <pid>" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    attach_backup_browser_pid "$1"
    release_project_lock
    ;;
  remove-backup-browser-cgroup)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage remove-backup-browser-cgroup <pid>" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    remove_backup_browser_cgroup "$1"
    release_project_lock
    ;;
  attach-host-service-cgroup)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage attach-host-service-cgroup <pid>" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    attach_host_service_pid "$1"
    release_project_lock
    ;;
  verify-host-service-cgroup)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage verify-host-service-cgroup <pid>" >&2
      exit 2
    fi
    require_host_service_pid "$1"
    host_service_cgroup_ready || deny "host-service-cgroup-not-ready" "$HOST_SERVICE_CGROUP_DEFAULT"
    actual="$(awk -F: '$1 == "0" {print $3}' "/proc/$1/cgroup" 2>/dev/null || true)"
    [ "$actual" = "${HOST_SERVICE_CGROUP_DEFAULT#/sys/fs/cgroup}" ] ||
      deny "host-service-cgroup-mismatch" "pid=$1,actual=${actual:-missing}"
    ;;
  reconcile-host-service-cgroup)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage reconcile-host-service-cgroup" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    reconcile_host_service_cgroup
    release_project_lock
    ;;
  prepare-project-startup-cgroup)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage prepare-project-startup-cgroup <project-id> <launcher-pid>" >&2
      exit 2
    fi
    project_id="$1"
    launcher_pid="$2"
    require_runtime_owned_pid "$launcher_pid"
    acquire_project_cgroup_shared_lock
    if ! project_startup_cgroup_ready; then
      release_project_lock
      acquire_project_cgroup_lock
      configure_project_startup_cgroup
    fi
    printf '%s\n' "$launcher_pid" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/cgroup.procs"
    printf '%s\n' "$PROJECT_PROCESS_OOM_SCORE_ADJ" > "/proc/${launcher_pid}/oom_score_adj"
    actual_startup_cgroup="$(awk -F: '$1 == "0" {print $3}' "/proc/${launcher_pid}/cgroup" 2>/dev/null || true)"
    [ "$actual_startup_cgroup" = "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT#/sys/fs/cgroup}" ] ||
      deny "project-startup-cgroup-verification-failed" "pid=${launcher_pid},actual=${actual_startup_cgroup:-missing}"
    release_project_lock
    ;;
  prepare-project-cgroup)
    if [ "$#" -ne 11 ] && [ "$#" -ne 12 ] && [ "$#" -ne 13 ]; then
      echo "usage: cocalc-runtime-storage prepare-project-cgroup <project-id> <launcher-pid> <memory-max> <memory-high> <memory-low> <memory-swap-max> <pids-max> <cpu-quota|max> <cpu-period> <cpu-weight> <io-weight> <io-class> [<startup-io-weight>]" >&2
      exit 2
    fi
    project_id="$1"
    launcher_pid="$2"
    memory_max="$3"
    memory_high="$4"
    memory_low="$5"
    memory_swap_max="$6"
    pids_max="$7"
    cpu_quota="$8"
    cpu_period="$9"
    cpu_weight="${10}"
    io_weight="${11}"
    # Bootstrap helpers may converge before the project-host artifact. Keep
    # the old caller safe during that window by selecting the lowest class.
    io_class="${12:-standard}"
    startup_io_weight="${13:-$io_weight}"
    if ! is_project_uuid "$project_id"; then
      deny "project-id-invalid" "$project_id"
    fi
    require_runtime_owned_pid "$launcher_pid"
    # Starts operate on distinct project leaves, so they can safely share the
    # hierarchy lock. Take the exclusive repair path only when the parent
    # hierarchy has drifted or has not yet been initialized.
    acquire_project_cgroup_shared_lock
    if ! project_pool_hierarchy_ready; then
      release_project_lock
      acquire_project_cgroup_lock
      configure_project_pool_hierarchy
    fi
    require_finite_project_pool_memory_max
    pool="$(project_cgroup "$project_id")"
    configure_project_cgroup \
      "$pool" "$memory_max" "$memory_high" "$memory_low" \
      "$memory_swap_max" "$pids_max" "$cpu_quota" "$cpu_period" \
      "$cpu_weight" "$io_weight" "$io_class"
    if ! valid_positive_cgroup_limit "$startup_io_weight" || [ "$startup_io_weight" -gt 10000 ]; then
      deny "project-cgroup-io-weight-invalid" "$startup_io_weight"
    fi
    if [ -w "$pool/io.weight" ]; then
      printf 'default %s\n' "$startup_io_weight" > "$pool/io.weight"
    fi
    printf '%s\n' "$launcher_pid" > "$pool/cgroup.procs"
    printf '%s\n' "$PROJECT_PROCESS_OOM_SCORE_ADJ" > "/proc/${launcher_pid}/oom_score_adj"
    verify_project_pid_in_pool "$project_id" "$launcher_pid"
    release_project_lock
    ensure_project_network_rule "$project_id"
    ;;
  prepare-project-startup-runtime-cgroup)
    if [ "$#" -ne 13 ]; then
      echo "usage: cocalc-runtime-storage prepare-project-startup-runtime-cgroup <project-id> <launcher-pid> <memory-max> <memory-high> <memory-low> <memory-swap-max> <pids-max> <cpu-quota|max> <cpu-period> <final-cpu-weight> <final-io-weight> <io-class> <startup-io-weight>" >&2
      exit 2
    fi
    project_id="$1"
    launcher_pid="$2"
    memory_max="$3"
    memory_high="$4"
    memory_low="$5"
    memory_swap_max="$6"
    pids_max="$7"
    cpu_quota="$8"
    cpu_period="$9"
    final_cpu_weight="${10}"
    final_io_weight="${11}"
    io_class="${12}"
    startup_io_weight="${13}"
    if ! is_project_uuid "$project_id"; then
      deny "project-id-invalid" "$project_id"
    fi
    require_runtime_owned_pid "$launcher_pid"
    if ! valid_positive_cgroup_limit "$startup_io_weight" || [ "$startup_io_weight" -gt 10000 ]; then
      deny "project-cgroup-io-weight-invalid" "$startup_io_weight"
    fi
    acquire_project_cgroup_shared_lock
    if ! project_pool_hierarchy_ready || ! project_startup_cgroup_ready; then
      release_project_lock
      acquire_project_cgroup_lock
      configure_project_pool_hierarchy
    fi
    require_finite_project_pool_memory_max
    pool="$(project_cgroup "$project_id")"
    startup_pool="$(project_startup_runtime_cgroup "$project_id")"
    if [ -d "$startup_pool" ] && project_cgroup_has_processes "$startup_pool"; then
      deny "project-startup-runtime-already-active" "$project_id"
    fi
    configure_project_cgroup \
      "$pool" "$memory_max" "$memory_high" "$memory_low" \
      "$memory_swap_max" "$pids_max" "$cpu_quota" "$cpu_period" \
      "$final_cpu_weight" "$final_io_weight" "$io_class"
    configure_project_startup_runtime_leaf \
      "$startup_pool" "$memory_max" "$memory_high" "$memory_low" \
      "$memory_swap_max" "$pids_max" "$cpu_quota" "$cpu_period" \
      "$PROJECT_STARTUP_CGROUP_CPU_WEIGHT" "$startup_io_weight" "$io_class"
    printf '%s\n' "$launcher_pid" > "$startup_pool/cgroup.procs"
    printf '%s\n' "$PROJECT_PROCESS_OOM_SCORE_ADJ" > "/proc/${launcher_pid}/oom_score_adj"
    verify_project_pid_in_startup_runtime "$project_id" "$launcher_pid"
    # The launcher cannot exec Podman until this helper returns. Mark it as
    # active first so concurrent finalization cannot release the reservation
    # between the active-start check and applying the reduced pool ceiling.
    reserve_project_startup_io_capacity
    release_project_lock
    # This also repairs the startup deny rule before the launcher can exec.
    ensure_project_network_rule "$project_id"
    ;;
  enter-project-cgroup)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage enter-project-cgroup <project-id> <launcher-pid>" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    configure_project_pool_hierarchy
    require_finite_project_pool_memory_max
    attach_project_launcher "$1" "$2"
    release_project_lock
    ;;
  verify-project-pool)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage verify-project-pool <project-id> <pid>" >&2
      exit 2
    fi
    # Container init uses a subordinate UID under rootless keep-id. This is a
    # read-only containment check, so only require a live PID here.
    require_live_pid "$2"
    verify_project_pid_in_pool "$1" "$2"
    ;;
  attach-project-cgroup)
    if [ "$#" -ne 11 ] && [ "$#" -ne 12 ]; then
      echo "usage: cocalc-runtime-storage attach-project-cgroup <project-id> <podman-netns-path|-> <memory-max> <memory-high> <memory-low> <memory-swap-max> <pids-max> <cpu-quota|max> <cpu-period> <cpu-weight> <io-weight> <io-class>" >&2
      exit 2
    fi
    project_id="$1"
    netns_path="$2"
    memory_max="$3"
    memory_high="$4"
    memory_low="$5"
    memory_swap_max="$6"
    pids_max="$7"
    cpu_quota="$8"
    cpu_period="$9"
    cpu_weight="${10}"
    io_weight="${11}"
    io_class="${12:-standard}"
    if ! is_project_uuid "$project_id"; then
      deny "project-id-invalid" "$project_id"
    fi
    if [ "$netns_path" != "-" ]; then
      case "$netns_path" in
        /mnt/cocalc/data/tmp/cocalc-podman-runtime-*/netns/netns-*|/run/user/*/netns/netns-*) ;;
        *) deny "podman-netns-path-invalid" "$netns_path" ;;
      esac
    fi
    acquire_project_cgroup_lock
    configure_project_pool_hierarchy
    require_finite_project_pool_memory_max
    pool="$(project_cgroup "$project_id")"
    configure_project_cgroup \
      "$pool" "$memory_max" "$memory_high" "$memory_low" \
      "$memory_swap_max" "$pids_max" "$cpu_quota" "$cpu_period" \
      "$cpu_weight" "$io_weight" "$io_class"
    release_project_lock
    # Process discovery and migration can be slow for a project with a very
    # large process tree. The cgroup now exists with its final limits, so keep
    # that work outside the global hierarchy lock; cleanup races are harmless
    # because these attachments are already best effort.
    while IFS= read -r conmon_pid; do
      attach_pid_tree_to_project_pool_storage "$conmon_pid" "$pool" || true
    done < <(find_project_conmon_pids "$project_id")
    if [ "$netns_path" != "-" ]; then
      while IFS= read -r pasta_pid; do
        attach_pid_to_project_pool_storage "$pasta_pid" "$pool" || true
        apply_pasta_resource_limits "$pasta_pid"
      done < <(find_pasta_pids_for_netns "$netns_path")
    fi
    ;;
  attach-prepared-project-runtime)
    if [ "$#" -ne 2 ] && [ "$#" -ne 4 ] && [ "$#" -ne 5 ] && [ "$#" -ne 6 ]; then
      echo "usage: cocalc-runtime-storage attach-prepared-project-runtime <project-id> <podman-netns-path|-> [<init-pid> <conmon-pid> [<final-cpu-weight> [<final-io-weight>]]]" >&2
      exit 2
    fi
    project_id="$1"
    netns_path="$2"
    init_pid="${3:-}"
    conmon_pid="${4:-}"
    final_cpu_weight="${5:-}"
    final_io_weight="${6:-}"
    if ! is_project_uuid "$project_id"; then
      deny "project-id-invalid" "$project_id"
    fi
    if [ "$netns_path" != "-" ]; then
      case "$netns_path" in
        /mnt/cocalc/data/tmp/cocalc-podman-runtime-*/netns/netns-*|/run/user/*/netns/netns-*) ;;
        *) deny "podman-netns-path-invalid" "$netns_path" ;;
      esac
    fi
    # The pre-exec launcher creates this leaf and applies its final policy
    # before Podman starts. Do not repeat global hierarchy convergence here:
    # concurrent starts otherwise serialize on the global cgroup lock.
    require_finite_project_pool_memory_max
    pool="$(project_cgroup "$project_id")"
    [ -d "$pool" ] || deny "project-cgroup-missing" "$pool"
    if [ -n "$init_pid" ]; then
      # The enhanced caller obtains these PIDs from one Podman inspect. Check
      # identity and ownership before using them so an untrusted PID can never
      # be migrated into another project's cgroup.
      require_live_pid "$init_pid"
      require_runtime_owned_pid "$conmon_pid"
      conmon_exe="$(readlink -f "/proc/${conmon_pid}/exe" 2>/dev/null || true)"
      is_trusted_conmon_executable "$conmon_exe" ||
        deny "project-conmon-executable-invalid" "pid=${conmon_pid},exe=${conmon_exe:-missing}"
      conmon_cmdline="$(tr '\\0' ' ' < "/proc/${conmon_pid}/cmdline" 2>/dev/null || true)"
      case " $conmon_cmdline " in
        *" -n project-${project_id} "*) ;;
        *) deny "project-conmon-name-mismatch" "pid=${conmon_pid},project=${project_id}" ;;
      esac
      startup_pool="$(project_startup_runtime_cgroup "$project_id")"
      if [ -d "$startup_pool" ]; then
        move_project_startup_runtime_to_pool "$project_id" "$pool"
        release_project_startup_io_capacity
      elif ! project_pid_is_in_pool "$project_id" "$init_pid" ||
        ! project_pid_is_in_pool "$project_id" "$conmon_pid"; then
        attach_pid_tree_to_project_pool_storage "$conmon_pid" "$pool" || true
      fi
    else
      # Compatibility with project-host versions deployed before helper v18.
      while IFS= read -r discovered_conmon_pid; do
        attach_pid_tree_to_project_pool_storage "$discovered_conmon_pid" "$pool" || true
      done < <(find_project_conmon_pids "$project_id")
    fi
    if [ "$netns_path" != "-" ]; then
      while IFS= read -r pasta_pid; do
        attach_pid_to_project_pool_storage "$pasta_pid" "$pool" || true
        apply_pasta_resource_limits "$pasta_pid"
      done < <(find_pasta_pids_for_netns "$netns_path")
    fi
    if [ -n "$init_pid" ]; then
      verify_project_pid_in_pool "$project_id" "$init_pid" ||
        deny "project-cgroup-verification-failed" "pid=${init_pid},project=${project_id}"
      verify_project_pid_in_pool "$project_id" "$conmon_pid" ||
        deny "project-cgroup-verification-failed" "pid=${conmon_pid},project=${project_id}"
    fi
    if [ -n "$final_cpu_weight" ]; then
      if ! valid_positive_cgroup_limit "$final_cpu_weight" || [ "$final_cpu_weight" -gt 10000 ]; then
        deny "project-cgroup-cpu-weight-invalid" "$final_cpu_weight"
      fi
      printf '%s\n' "$final_cpu_weight" > "$pool/cpu.weight"
      actual_cpu_weight="$(cat "$pool/cpu.weight" 2>/dev/null || true)"
      [ "$actual_cpu_weight" = "$final_cpu_weight" ] ||
        deny "project-cgroup-cpu-weight-mismatch" "expected=${final_cpu_weight},actual=${actual_cpu_weight:-missing}"
    fi
    if [ -n "$final_io_weight" ]; then
      if ! valid_positive_cgroup_limit "$final_io_weight" || [ "$final_io_weight" -gt 10000 ]; then
        deny "project-cgroup-io-weight-invalid" "$final_io_weight"
      fi
      if [ -w "$pool/io.weight" ]; then
        printf 'default %s\n' "$final_io_weight" > "$pool/io.weight"
        actual_io_weight="$(awk '$1 == "default" {print $2; exit}' "$pool/io.weight" 2>/dev/null || true)"
        [ "$actual_io_weight" = "$final_io_weight" ] ||
          deny "project-cgroup-io-weight-mismatch" "expected=${final_io_weight},actual=${actual_io_weight:-missing}"
      fi
    fi
    ;;
  finish-project-startup-cgroup)
    if [ "$#" -ne 2 ]; then
      echo "usage: cocalc-runtime-storage finish-project-startup-cgroup <project-id> <cpu-weight>" >&2
      exit 2
    fi
    project_id="$1"
    cpu_weight="$2"
    if ! is_project_uuid "$project_id"; then
      deny "project-id-invalid" "$project_id"
    fi
    if ! valid_positive_cgroup_limit "$cpu_weight" || [ "$cpu_weight" -gt 10000 ]; then
      deny "project-cgroup-cpu-weight-invalid" "$cpu_weight"
    fi
    pool="$(project_cgroup "$project_id")"
    [ -d "$pool" ] || deny "project-cgroup-missing" "$pool"
    printf '%s\n' "$cpu_weight" > "$pool/cpu.weight"
    actual_cpu_weight="$(cat "$pool/cpu.weight" 2>/dev/null || true)"
    [ "$actual_cpu_weight" = "$cpu_weight" ] ||
      deny "project-cgroup-cpu-weight-mismatch" "expected=${cpu_weight},actual=${actual_cpu_weight:-missing}"
    ;;
  verify-project-io-limits)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage verify-project-io-limits <project-id> <io-class>" >&2
      exit 2
    fi
    fields="$(project_io_policy_fields "$2")" || deny "project-io-policy-invalid" "$2"
    IFS=$'\t' read -r io_mode io_mountpoint _pool_rbps _pool_wbps _pool_riops _pool_wiops rbps wbps riops wiops _weight io_class _policy_version _policy_profile _capacity_source _capacity_mode <<< "$fields"
    if [ "$io_mode" = "enforce" ]; then
      acquire_project_io_reservation_shared_lock
      pool_scope="$(current_project_pool_io_scope)"
      verify_io_max "$PROJECT_POOL_CGROUP_DEFAULT" "$pool_scope"
      release_project_io_reservation_lock
      verify_io_max "$(project_cgroup "$1")" "$io_class" "$io_class"
    fi
    ;;
  verify-project-io-policy)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage verify-project-io-policy" >&2
      exit 2
    fi
    fields="$(project_io_policy_fields standard)" || deny "project-io-policy-invalid" "pool"
    IFS=$'\t' read -r io_mode io_mountpoint pool_rbps pool_wbps pool_riops pool_wiops _leaf_rbps _leaf_wbps _leaf_riops _leaf_wiops _weight _class policy_version policy_profile capacity_source capacity_mode <<< "$fields"
    if [ "$io_mode" = "enforce" ]; then
      acquire_project_io_reservation_shared_lock
      pool_scope="$(current_project_pool_io_scope)"
      verify_io_max "$PROJECT_POOL_CGROUP_DEFAULT" "$pool_scope"
      release_project_io_reservation_lock
      verify_io_max "$MAINTENANCE_CGROUP_DEFAULT" "maintenance"
    fi
    ;;
  project-io-status)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage project-io-status" >&2
      exit 2
    fi
    fields="$(project_io_policy_fields standard)" || deny "project-io-policy-invalid" "status"
    IFS=$'\t' read -r io_mode io_mountpoint pool_rbps pool_wbps pool_riops pool_wiops _rest <<< "$fields"
    policy_status="$(project_io_policy_status)" || deny "project-io-policy-invalid" "status"
    acquire_project_io_reservation_shared_lock
    pool_scope="$(current_project_pool_io_scope)"
    startup_runtime_active_count="$(project_startup_runtime_active_count)"
    pressure_protection_enabled="false"
    project_io_pressure_protection_enabled && pressure_protection_enabled="true"
    if [ "$io_mode" = "enforce" ]; then
      verify_io_max "$PROJECT_POOL_CGROUP_DEFAULT" "$pool_scope"
    fi
    release_project_io_reservation_lock
    pool_io_max="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/io.max" 2>/dev/null || true)"
    pool_pressure="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/io.pressure" 2>/dev/null || true)"
    legacy_processes="$(cat "$(project_legacy_cgroup)/cgroup.procs" 2>/dev/null || true)"
    pool_io_weight="$(cat "${PROJECT_POOL_CGROUP_DEFAULT}/io.weight" 2>/dev/null || true)"
    maintenance_io_max="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/io.max" 2>/dev/null || true)"
    maintenance_pressure="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/io.pressure" 2>/dev/null || true)"
    maintenance_io_weight="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/io.weight" 2>/dev/null || true)"
    maintenance_processes="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/cgroup.procs" 2>/dev/null || true)"
    maintenance_cpu_max="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/cpu.max" 2>/dev/null || true)"
    maintenance_memory_high="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/memory.high" 2>/dev/null || true)"
    maintenance_memory_max="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/memory.max" 2>/dev/null || true)"
    maintenance_pids_max="$(cat "${MAINTENANCE_CGROUP_DEFAULT}/pids.max" 2>/dev/null || true)"
    /usr/bin/python3 - "$policy_status" "$pool_io_max" "$pool_io_weight" "$pool_pressure" "$legacy_processes" "$maintenance_io_max" "$maintenance_io_weight" "$maintenance_pressure" "$maintenance_processes" "$maintenance_cpu_max" "$maintenance_memory_high" "$maintenance_memory_max" "$maintenance_pids_max" "$pool_scope" "$startup_runtime_active_count" "$pressure_protection_enabled" <<'PY'
import json
import sys

(
    status_json,
    io_max,
    io_weight,
    pressure,
    legacy,
    maintenance_io_max,
    maintenance_io_weight,
    maintenance_pressure,
    maintenance_processes,
    maintenance_cpu_max,
    maintenance_memory_high,
    maintenance_memory_max,
    maintenance_pids_max,
    pool_scope,
    startup_runtime_active_count,
    pressure_protection_enabled,
) = sys.argv[1:]
result = json.loads(status_json)
discovery_error = result.pop("discovery_error", None)
if discovery_error:
    result["capability"] = "unsupported"
    result["capability_reason"] = discovery_error
elif result["policy_mode"] == "enforce":
    result["capability"] = "validated"
else:
    result["capability"] = "available"

pressure_values = {}
def parse_pressure(raw, prefix):
    values_out = {}
    for row in raw.splitlines():
        columns = row.split()
        if not columns:
            continue
        kind = columns[0]
        values = dict(
            column.split("=", 1)
            for column in columns[1:]
            if "=" in column
        )
        if "avg10" in values:
            values_out[f"{prefix}{kind}_percent"] = float(values["avg10"])
        if "total" in values:
            values_out[f"{prefix}{kind}_total"] = int(values["total"])
    return values_out

pressure_values.update(parse_pressure(pressure, "pressure_"))
maintenance_pressure_values = parse_pressure(
    maintenance_pressure, "maintenance_pressure_"
)

result.update({
    "pool_cgroup": "/sys/fs/cgroup/cocalc-project-pool",
    "pool_io_max": io_max.strip(),
    "pool_io_weight": io_weight.strip(),
    "pool_limit_scope": pool_scope,
    "startup_runtime_active_count": int(startup_runtime_active_count),
    "pressure_protection_enabled": pressure_protection_enabled == "true",
    "legacy_process_count": len(legacy.split()),
    "maintenance_cgroup": "/sys/fs/cgroup/cocalc-maintenance",
    "maintenance_io_max": maintenance_io_max.strip(),
    "maintenance_io_weight": maintenance_io_weight.strip(),
    "maintenance_process_count": len(maintenance_processes.split()),
    "maintenance_cpu_max": maintenance_cpu_max.strip(),
    "maintenance_memory_high": maintenance_memory_high.strip(),
    "maintenance_memory_max": maintenance_memory_max.strip(),
    "maintenance_pids_max": maintenance_pids_max.strip(),
    **pressure_values,
    **maintenance_pressure_values,
})
print(json.dumps(result, separators=(",", ":")))
PY
    ;;
  reconcile-project-io-policy)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage reconcile-project-io-policy" >&2
      exit 2
    fi
    reconcile_project_io_policy
    ;;
  set-project-pool-pressure-mode)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage set-project-pool-pressure-mode <normal|protect>" >&2
      exit 2
    fi
    set_project_pool_pressure_mode "$1"
    ;;
  verify-project-network-limits)
    if [ "$#" -ne 1 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage verify-project-network-limits <project-id>" >&2
      exit 2
    fi
    verify_project_network_limits "$1"
    ;;
  reconcile-project-network-limits)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage reconcile-project-network-limits" >&2
      exit 2
    fi
    reconcile_project_network_limits
    ;;
  prepare-project-network-policy)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage prepare-project-network-policy <project-id> <normal|disabled>" >&2
      exit 2
    fi
    # Startup has not created the project cgroup yet. Persisting the policy is
    # sufficient: prepare-project-startup-runtime-cgroup installs its rule
    # before the launcher can exec Podman.
    set_project_network_policy "$1" "$2"
    ;;
  set-project-network-policy)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage set-project-network-policy <project-id> <normal|disabled>" >&2
      exit 2
    fi
    set_project_network_policy "$1" "$2"
    reconcile_project_network_limits
    ;;
  verify-project-network-policy)
    if [ "$#" -ne 2 ] || ! is_project_uuid "$1"; then
      echo "usage: cocalc-runtime-storage verify-project-network-policy <project-id> <normal|disabled>" >&2
      exit 2
    fi
    actual="$(project_network_policy "$1")"
    if [ "$actual" != "$2" ]; then
      echo "project network policy mismatch: expected=$2 actual=$actual" >&2
      exit 1
    fi
    verify_project_network_limits "$1"
    ;;
  set-current-exam-run)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage set-current-exam-run <run-id>" >&2
      exit 2
    fi
    set_current_exam_run "$1"
    ;;
  clear-current-exam-run)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage clear-current-exam-run <run-id>" >&2
      exit 2
    fi
    clear_current_exam_run "$1"
    ;;
  poweroff-exam-host)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage poweroff-exam-host <run-id>" >&2
      exit 2
    fi
    poweroff_exam_host "$1"
    ;;
  cleanup-project-cgroup)
    if [ "$#" -ne 1 ] || ! is_project_uuid "$1"; then
      deny "project-id-invalid" "${1:-missing}"
    fi
    acquire_project_cgroup_lock
    pool="$(project_cgroup "$1")"
    startup_pool="$(project_startup_runtime_cgroup "$1")"
    if [ -d "$startup_pool" ]; then
      if [ -w "$startup_pool/cgroup.kill" ]; then
        printf '1\n' > "$startup_pool/cgroup.kill" 2>/dev/null || true
      fi
      for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        rmdir "$startup_pool" 2>/dev/null && break
        sleep 0.1
      done
      if [ -d "$startup_pool" ]; then
        deny "project-startup-runtime-cleanup-failed" "$1"
      fi
      release_project_startup_io_capacity
    fi
    if [ -d "$pool" ]; then
      if [ -w "$pool/cgroup.kill" ]; then
        printf '1\n' > "$pool/cgroup.kill" 2>/dev/null || true
      fi
      for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        rmdir "$pool" 2>/dev/null && break
        sleep 0.1
      done
      if [ -d "$pool" ]; then
        deny "project-cgroup-cleanup-failed" "$1"
      fi
    fi
    release_project_lock
    # Periodic reconciliation removes the now-stale socket-cgroup rules.
    # Avoid a global foreground nftables lock and start/stop deletion races.
    ;;
  attach-pasta-cgroups)
    if [ "$#" -ne 0 ]; then
      echo "usage: cocalc-runtime-storage attach-pasta-cgroups" >&2
      exit 2
    fi
    acquire_project_cgroup_lock
    configure_project_pool_hierarchy
    pool="$(project_legacy_cgroup)"
    while IFS= read -r pasta_pid; do
      actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pasta_pid}/cgroup" 2>/dev/null || true)"
      case "$actual" in
        "$(project_pool_relative_path)/project-"*) ;;
        *) attach_pid_to_project_pool_storage "$pasta_pid" "$pool" || true ;;
      esac
    done < <(find_pasta_pids)
    release_project_lock
    reconcile_project_network_limits
    ;;
  btrfs|btrfs-maintenance)
    check_args "$@"
    if [ "$cmd" = "btrfs-maintenance" ]; then
      attach_maintenance_worker
    fi
    exec /usr/bin/btrfs "$@"
    ;;
  mkfs.btrfs)
    check_args "$@"
    if command -v /usr/sbin/mkfs.btrfs >/dev/null 2>&1; then
      exec /usr/sbin/mkfs.btrfs "$@"
    fi
    exec /sbin/mkfs.btrfs "$@"
    ;;
  mount-overlay-project)
    if [ "$#" -ne 4 ]; then
      echo "usage: cocalc-runtime-storage mount-overlay-project <lowerdir> <upperdir> <workdir> <merged>" >&2
      exit 2
    fi
    lowerdir="$1"
    upperdir="$2"
    workdir="$3"
    merged="$4"
    if ! allow_overlay_mountpoint "$merged"; then
      deny "overlay-mountpoint-not-allowed" "$merged"
    fi
    require_allowed_path_parts "$lowerdir"
    lower_root="$ALLOWED_PATH_ROOT"
    lower_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$upperdir"
    upper_root="$ALLOWED_PATH_ROOT"
    upper_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$workdir"
    work_root="$ALLOWED_PATH_ROOT"
    work_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$merged"
    merged_root="$ALLOWED_PATH_ROOT"
    merged_rel="$ALLOWED_PATH_REL"
    # Use the xattr-capable OverlayFS mode:
    # - metacopy=on avoids copying full file contents into upperdir for
    #   metadata-only changes, which keeps environment overlays smaller.
    # - redirect_dir=on makes lowerdir-backed directory renames behave normally
    #   instead of forcing expensive EXDEV-style fallbacks.
    # - index=off keeps the upperdir portable across hosts / equivalent lowers.
    #   With index=on, overlayfs stamps trusted.overlay.origin onto the upper
    #   root itself, which makes the entire upperdir fail to remount against a
    #   replaced-but-equivalent lower tree with "Stale file handle".
    # Tradeoff: copied-up lower hardlinks may lose hardlink identity, but that
    # is preferable to making project RootFS deltas non-portable.
    # Backup/restore of project overlay data must still preserve
    # trusted.overlay.* xattrs via the dedicated privileged rustic wrapper path.
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      mount-overlay-project \
      --lower-root "$lower_root" --lower-path "$lower_rel" \
      --upper-root "$upper_root" --upper-path "$upper_rel" \
      --work-root "$work_root" --work-path "$work_rel" \
      --merged-root "$merged_root" --merged-path "$merged_rel"
    ;;
  umount-overlay-project)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage umount-overlay-project <merged>" >&2
      exit 2
    fi
    merged="$1"
    if ! allow_overlay_mountpoint "$merged"; then
      deny "overlay-mountpoint-not-allowed" "$merged"
    fi
    require_allowed_path_parts "$merged"
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      umount-overlay-project \
      --merged-root "$ALLOWED_PATH_ROOT" --merged-path "$ALLOWED_PATH_REL"
    ;;
  losetup)
    check_args "$@"
    if command -v /usr/sbin/losetup >/dev/null 2>&1; then
      exec /usr/sbin/losetup "$@"
    fi
    exec /sbin/losetup "$@"
    ;;
  mknod)
    if [ "$#" -ne 5 ] || [ "$1" != "-m660" ] || [ "$3" != "b" ] || [ "$4" != "7" ]; then
      deny "mknod-args-invalid" "$*"
    fi
    if ! echo "$2" | grep -Eq '^/dev/loop[0-9]+$' || ! echo "$5" | grep -Eq '^[0-9]+$'; then
      deny "mknod-loop-invalid" "$*"
    fi
    exec /usr/bin/mknod "$@"
    ;;
  chown)
    if [ "$#" -lt 2 ]; then
      deny "chown-args-invalid" "$*"
    fi
    owner="$1"
    shift
    case "$owner" in
      *:*) owner_user="${owner%%:*}"; owner_group="${owner#*:}" ;;
      *) deny "chown-owner-invalid" "$owner" ;;
    esac
    if echo "$owner_user" | grep -Eq '^[0-9]+$'; then
      owner_uid="$owner_user"
    else
      owner_uid="$(id -u "$owner_user" 2>/dev/null || true)"
    fi
    if echo "$owner_group" | grep -Eq '^[0-9]+$'; then
      owner_gid="$owner_group"
    else
      owner_gid="$(getent group "$owner_group" | cut -d: -f3 || true)"
    fi
    if ! echo "$owner_uid" | grep -Eq '^[0-9]+$' || ! echo "$owner_gid" | grep -Eq '^[0-9]+$'; then
      deny "chown-owner-invalid" "$owner"
    fi
    runtime_uid="$(id -u "$RUNTIME_USER")"
    runtime_gid="$(id -g "$RUNTIME_USER")"
    if [ "$owner_uid" != "$runtime_uid" ] || [ "$owner_gid" != "$runtime_gid" ]; then
      deny "chown-owner-not-runtime-user" "$owner"
    fi
    for path in "$@"; do
      if echo "$path" | grep -Eq '^/dev/loop[0-9]+$'; then
        /bin/chown "$owner_uid:$owner_gid" -- "$path"
        continue
      fi
      require_allowed_path_parts "$path"
      path_helper chown --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL" --uid "$owner_uid" --gid "$owner_gid"
    done
    ;;
  chmod)
    if [ "$#" -lt 2 ] || ! echo "$1" | grep -Eq '^([0-7]{3}|0[0-7]{3})$'; then
      deny "chmod-args-invalid" "$*"
    fi
    mode="$1"
    shift
    for path in "$@"; do
      require_allowed_path_parts "$path"
      path_helper chmod --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL" --mode "$mode"
    done
    ;;
  chattr)
    if [ "$#" -ne 2 ] || [ "$1" != "+C" ]; then
      deny "chattr-args-invalid" "$*"
    fi
    require_allowed_path_parts "$2"
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper chattr-cow --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL"
    ;;
  truncate)
    if [ "$#" -ne 3 ] || [ "$1" != "-s" ]; then
      deny "truncate-args-invalid" "$*"
    fi
    length="$(numfmt --from=iec "$2" 2>/dev/null || true)"
    if ! echo "$length" | grep -Eq '^[0-9]+$'; then
      deny "truncate-length-invalid" "$2"
    fi
    require_allowed_path_parts "$3"
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper truncate --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL" --length "$length"
    ;;
  mkdir)
    recursive=false
    if [ "${1:-}" = "-p" ]; then
      recursive=true
      shift
    fi
    if [ "$#" -lt 1 ]; then
      deny "mkdir-args-invalid" "$*"
    fi
    for path in "$@"; do
      require_allowed_path_parts "$path"
      if [ "$ALLOWED_PATH_REL" = "." ]; then
        if [ "$recursive" = true ] && [ -d "$ALLOWED_PATH_ROOT" ]; then
          continue
        fi
        deny "mkdir-root-not-allowed" "$path"
      fi
      helper_args=(mkdir --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL" --mode 0755)
      if [ "$recursive" = true ]; then
        helper_args+=(--recursive)
      fi
      path_helper "${helper_args[@]}"
    done
    ;;
  mv)
    if [ "$#" -ne 2 ]; then
      deny "mv-args-invalid" "$*"
    fi
    require_allowed_path_parts "$1"
    source_root="$ALLOWED_PATH_ROOT"
    source_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$2"
    if [ "$source_root" != "$ALLOWED_PATH_ROOT" ]; then
      deny "mv-cross-root-not-allowed" "$1 -> $2"
    fi
    if [ "$source_rel" = "." ] || [ "$ALLOWED_PATH_REL" = "." ]; then
      deny "mv-root-not-allowed" "$1 -> $2"
    fi
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper rename --root "$source_root" --path "$source_rel" --dest "$ALLOWED_PATH_REL"
    ;;
  rm)
    recursive=false
    force=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -rf|-fr)
          recursive=true; force=true; shift ;;
        -r|-R|--recursive)
          recursive=true; shift ;;
        -f|--force)
          force=true; shift ;;
        --)
          shift; break ;;
        -*)
          deny "rm-option-invalid" "$1" ;;
        *)
          break ;;
      esac
    done
    if [ "$#" -lt 1 ]; then
      deny "rm-args-invalid" "$*"
    fi
    for path in "$@"; do
      require_allowed_path_parts "$path"
      if [ "$ALLOWED_PATH_REL" = "." ]; then
        deny "rm-root-not-allowed" "$path"
      fi
      helper_args=(rm --root "$ALLOWED_PATH_ROOT" --path "$ALLOWED_PATH_REL")
      if [ "$recursive" = true ]; then helper_args+=(--recursive); fi
      if [ "$force" = true ]; then helper_args+=(--force); fi
      path_helper "${helper_args[@]}"
    done
    ;;
  sandbox-rm)
    if [ "$#" -lt 2 ]; then
      echo "usage: cocalc-runtime-storage sandbox-rm <root> <relative-path> [--recursive] [--force]" >&2
      exit 2
    fi
    root="$1"
    rel="$2"
    shift 2
    check_args "$root"
    if ! allow_privileged_delete_root "$root"; then
      deny "sandbox-delete-root-not-allowed" "$root"
    fi
    if ! check_relative_delete_path "$rel"; then
      deny "sandbox-delete-path-invalid" "$rel"
    fi
    attach_storage_worker_to_project "$root"
    project_rel="${root#/mnt/cocalc/}"
    helper=(/usr/local/libexec/cocalc-runtime-storage-path-helper rm --root /mnt/cocalc --path "${project_rel}/${rel}")
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --recursive|--force)
          helper+=("$1")
          ;;
        *)
          deny "sandbox-delete-option-invalid" "$1"
          ;;
      esac
      shift
    done
    exec "${helper[@]}"
    ;;
  sandbox-rmdir)
    if [ "$#" -lt 2 ]; then
      echo "usage: cocalc-runtime-storage sandbox-rmdir <root> <relative-path> [--recursive]" >&2
      exit 2
    fi
    root="$1"
    rel="$2"
    shift 2
    check_args "$root"
    if ! allow_privileged_delete_root "$root"; then
      deny "sandbox-delete-root-not-allowed" "$root"
    fi
    if ! check_relative_delete_path "$rel"; then
      deny "sandbox-delete-path-invalid" "$rel"
    fi
    attach_storage_worker_to_project "$root"
    project_rel="${root#/mnt/cocalc/}"
    helper=(/usr/local/libexec/cocalc-runtime-storage-path-helper rmdir --root /mnt/cocalc --path "${project_rel}/${rel}")
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --recursive)
          helper+=("$1")
          ;;
        *)
          deny "sandbox-delete-option-invalid" "$1"
          ;;
      esac
      shift
    done
    exec "${helper[@]}"
    ;;
  copy-tree-preserve)
    if [ "$#" -ne 2 ]; then
      echo "usage: cocalc-runtime-storage copy-tree-preserve <src> <dest>" >&2
      exit 2
    fi
    src="$1"
    dest="$2"
    require_allowed_path_parts "$src"
    source_root="$ALLOWED_PATH_ROOT"
    source_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$dest"
    # Do not preserve hardlinks when copying from a merged overlayfs view.
    # Rsync's -H inference can misidentify unrelated files as hardlinked when
    # inode identity comes from overlayfs, which corrupts published child
    # RootFS trees.
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      copy-tree-preserve \
      --root "$source_root" \
      --path "$source_rel" \
      --dest-root "$ALLOWED_PATH_ROOT" \
      --dest "$ALLOWED_PATH_REL"
    ;;
  copy-tree-reflink)
    if [ "$#" -ne 2 ]; then
      echo "usage: cocalc-runtime-storage copy-tree-reflink <src> <dest>" >&2
      exit 2
    fi
    src="$1"
    dest="$2"
    require_allowed_path_parts "$src"
    source_root="$ALLOWED_PATH_ROOT"
    source_rel="$ALLOWED_PATH_REL"
    require_allowed_path_parts "$dest"
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      copy-tree-reflink \
      --root "$source_root" \
      --path "$source_rel" \
      --dest-root "$ALLOWED_PATH_ROOT" \
      --dest "$ALLOWED_PATH_REL"
    ;;
  normalize-rootfs)
    skip_ownership_bridge=false
    ownership_source="${COCALC_ROOTFS_OWNERSHIP_SOURCE:-keep-id}"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --skip-ownership-bridge)
          skip_ownership_bridge=true
          shift
          ;;
        --ownership-source)
          if [ "$#" -lt 2 ]; then
            echo "usage: cocalc-runtime-storage normalize-rootfs [--skip-ownership-bridge] [--ownership-source keep-id|oci-extract] <rootfs>" >&2
            exit 2
          fi
          ownership_source="$2"
          shift 2
          ;;
        --ownership-source=*)
          ownership_source="${1#--ownership-source=}"
          shift
          ;;
        --)
          shift
          break
          ;;
        -*)
          echo "usage: cocalc-runtime-storage normalize-rootfs [--skip-ownership-bridge] [--ownership-source keep-id|oci-extract] <rootfs>" >&2
          exit 2
          ;;
        *)
          break
          ;;
      esac
    done
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage normalize-rootfs [--skip-ownership-bridge] [--ownership-source keep-id|oci-extract] <rootfs>" >&2
      exit 2
    fi
    rootfs="$1"
    require_allowed_path_parts "$rootfs"
    case "${COCALC_ROOTFS_SKIP_OWNERSHIP_BRIDGE:-}" in
      1|true|TRUE|yes|YES|on|ON)
        skip_ownership_bridge=true
        ;;
    esac
    case "$ownership_source" in
      keep-id|oci-extract) ;;
      *) deny "rootfs-ownership-source-invalid" "$ownership_source" ;;
    esac
    podman_user="${SUDO_USER:-}"
    if [ -z "$podman_user" ] || [ "$podman_user" != "$RUNTIME_USER" ]; then
      deny "rootfs-podman-user-mismatch" "${podman_user:-missing}"
    fi
    helper_args=(
      normalize-rootfs
      --root "$ALLOWED_PATH_ROOT"
      --path "$ALLOWED_PATH_REL"
      --ownership-source "$ownership_source"
      --podman-user "$podman_user"
    )
    if [ "$skip_ownership_bridge" = true ]; then
      helper_args+=(--skip-ownership-bridge)
    fi
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper "${helper_args[@]}"
    ;;
  _normalize-rootfs-anchored)
    skip_ownership_bridge=false
    ownership_source="keep-id"
    podman_user=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --skip-ownership-bridge)
          skip_ownership_bridge=true
          shift
          ;;
        --ownership-source)
          [ "$#" -ge 2 ] || deny "rootfs-anchored-args-invalid" "ownership-source"
          ownership_source="$2"
          shift 2
          ;;
        --podman-user)
          [ "$#" -ge 2 ] || deny "rootfs-anchored-args-invalid" "podman-user"
          podman_user="$2"
          shift 2
          ;;
        --)
          shift
          break
          ;;
        -*) deny "rootfs-anchored-args-invalid" "$1" ;;
        *) break ;;
      esac
    done
    if [ "$#" -ne 1 ] || [ "$podman_user" != "$RUNTIME_USER" ]; then
      deny "rootfs-anchored-args-invalid" "$*"
    fi
    rootfs="$1"
    case "$rootfs" in
      /run/cocalc-rootfs-normalize/rootfs-*) ;;
      *) deny "rootfs-anchored-path-invalid" "$rootfs" ;;
    esac
    if [ ! -d "$rootfs" ] || [ -L "$rootfs" ] || ! /usr/bin/mountpoint -q "$rootfs"; then
      deny "rootfs-anchored-mount-invalid" "$rootfs"
    fi
    runtime_dir="$(dirname "$rootfs")"
    runtime_dir_uid="$(stat -c '%u' "$runtime_dir")"
    runtime_dir_mode="$(stat -c '%a' "$runtime_dir")"
    if [ "$runtime_dir_uid" != "0" ] || \
       ! echo "$runtime_dir_mode" | grep -Eq '^[0-7]{3,4}$' || \
       [ "$((8#$runtime_dir_mode & 022))" -ne 0 ]; then
      deny "rootfs-anchored-owner-invalid" "$rootfs"
    fi
    case "$ownership_source" in
      keep-id|oci-extract) ;;
      *) deny "rootfs-ownership-source-invalid" "$ownership_source" ;;
    esac
    unset COCALC_ROOTFS_OWNERSHIP_SOURCE COCALC_ROOTFS_SKIP_OWNERSHIP_BRIDGE
    shell_path=""
    if [ -x "$rootfs/bin/bash" ]; then
      shell_path="/bin/bash"
    elif [ -x "$rootfs/bin/sh" ]; then
      shell_path="/bin/sh"
    else
      deny "rootfs-shell-missing" "$rootfs"
    fi
    fail() {
      echo "$1" >&2
      exit "${2:-1}"
    }
    case "$ownership_source" in
      keep-id|oci-extract)
        ;;
      *)
        fail "rootfs preflight failed: unsupported ownership source '$ownership_source'" 78
        ;;
    esac
    remap_rootfs_ids_script="$(mktemp)"
    rewrite_uid_map_file="$(mktemp)"
    rewrite_gid_map_file="$(mktemp)"
    cat >"$remap_rootfs_ids_script" <<'EOF_COCALC_REWRITE_ROOTFS_IDS'
#!/usr/bin/env python3
import os
import stat
import sys

mode = sys.argv[1]
rootfs = sys.argv[2]
runtime_uid = int(sys.argv[3])
runtime_gid = int(sys.argv[4])
uid_map_path = sys.argv[5]
gid_map_path = sys.argv[6]
ownership_source = sys.argv[7]

def parse_map(path: str) -> list[tuple[int, int, int]]:
    ranges: list[tuple[int, int, int]] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.split()
            if len(parts) != 3:
                continue
            ranges.append((int(parts[0]), int(parts[1]), int(parts[2])))
    if not ranges:
        raise RuntimeError(f"missing uid/gid map in {path}")
    return ranges

uid_ranges = parse_map(uid_map_path)
gid_ranges = parse_map(gid_map_path)

def map_keep_id(identifier: int, runtime_id: int) -> int:
    if identifier < 0:
        return identifier
    if identifier < runtime_id:
        return identifier + 1
    if identifier == runtime_id:
        return 0
    return identifier

def reverse_keep_id(identifier: int, runtime_id: int) -> int:
    if identifier < 0:
        return identifier
    if identifier == 0:
        return runtime_id
    if 0 < identifier <= runtime_id:
        return identifier - 1
    return identifier

def host_to_intermediate(identifier: int, ranges: list[tuple[int, int, int]]) -> int:
    for ns_start, host_start, length in ranges:
        if host_start <= identifier < host_start + length:
            return ns_start + (identifier - host_start)
    raise RuntimeError(
        f"id {identifier} is not covered by the current rootless podman host map; the host subuid/subgid allocation is too small for this image"
    )

def extracted_to_intermediate(identifier: int, ranges: list[tuple[int, int, int]]) -> int:
    try:
        return host_to_intermediate(identifier, ranges)
    except RuntimeError:
        return identifier

def intermediate_to_host(identifier: int, ranges: list[tuple[int, int, int]]) -> int:
    for ns_start, host_start, length in ranges:
        if ns_start <= identifier < ns_start + length:
            return host_start + (identifier - ns_start)
    raise RuntimeError(
        f"id {identifier} is not covered by the rootless podman map; the host subuid/subgid allocation is too small for this image"
    )

def current_host_to_canonical(identifier: int, ranges: list[tuple[int, int, int]], runtime_id: int) -> int:
    try:
        intermediate = host_to_intermediate(identifier, ranges)
    except RuntimeError:
        return identifier
    if ownership_source == "oci-extract":
        return intermediate
    if ownership_source != "keep-id":
        raise RuntimeError(f"unknown ownership source {ownership_source}")
    return reverse_keep_id(intermediate, runtime_id)

def remap(path: str) -> None:
    st = os.lstat(path)
    if mode == "to-canonical":
        mapped_uid = current_host_to_canonical(st.st_uid, uid_ranges, runtime_uid)
        mapped_gid = current_host_to_canonical(st.st_gid, gid_ranges, runtime_gid)
    elif mode == "to-host":
        mapped_uid = intermediate_to_host(
            map_keep_id(extracted_to_intermediate(st.st_uid, uid_ranges), runtime_uid),
            uid_ranges,
        )
        mapped_gid = intermediate_to_host(
            map_keep_id(extracted_to_intermediate(st.st_gid, gid_ranges), runtime_gid),
            gid_ranges,
        )
    else:
        raise RuntimeError(f"unknown remap mode: {mode}")
    if mapped_uid == st.st_uid and mapped_gid == st.st_gid:
        pass
    else:
        file_mode = stat.S_IMODE(st.st_mode)
        os.lchown(path, mapped_uid, mapped_gid)
        if not stat.S_ISLNK(st.st_mode) and (st.st_mode & 0o6000):
            os.chmod(path, file_mode, follow_symlinks=False)
    if stat.S_ISDIR(st.st_mode):
        with os.scandir(path) as entries:
            for entry in entries:
                remap(entry.path)

remap(rootfs)
EOF_COCALC_REWRITE_ROOTFS_IDS
chmod 0755 "$remap_rootfs_ids_script"
    cleanup_rewrite_script() {
      rm -f "$remap_rootfs_ids_script"
      rm -f "$rewrite_uid_map_file"
      rm -f "$rewrite_gid_map_file"
    }
    trap cleanup_rewrite_script EXIT
    fix_setid_runtime_helpers_script="$(cat <<'EOF_COCALC_FIX_SETID_RUNTIME_HELPERS'
set -euo pipefail
runtime_uid="${COCALC_RUNTIME_UID:?}"
runtime_gid="${COCALC_RUNTIME_GID:?}"
for dir in /bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /usr/libexec; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -type f '(' -perm -4000 -o -perm -2000 ')' \
    -uid "$runtime_uid" -gid "$runtime_gid" -print0 |
  while IFS= read -r -d '' path; do
    mode="$(stat -c '%a' "$path")"
    chown root:root "$path"
    chmod "$mode" "$path"
  done
done
for sudo_path in /usr/bin/sudo /bin/sudo; do
  [ -e "$sudo_path" ] || continue
  chown root:root "$sudo_path"
  chmod 4755 "$sudo_path"
done
for sudo_conf_path in /etc/sudo.conf /etc/sudoers /etc/sudoers.d; do
  [ -e "$sudo_conf_path" ] || continue
  chown root:root "$sudo_conf_path"
done
if [ -d /etc/sudoers.d ]; then
  find /etc/sudoers.d -mindepth 1 -maxdepth 1 -exec chown root:root {} +
fi
EOF_COCALC_FIX_SETID_RUNTIME_HELPERS
)"
    normalize_runtime_package_state_rootfs() {
      case "$package_manager" in
        apt-get)
          root_owner_uid="$(stat -c '%u' "$rootfs/etc")"
          root_owner_gid="$(stat -c '%g' "$rootfs/etc")"
          for dir in \
            "$rootfs/var/lib/apt/lists" \
            "$rootfs/var/cache/apt/archives"
          do
            [ -d "$dir" ] || continue
            chown -R "$root_owner_uid:$root_owner_gid" "$dir"
          done
          mkdir -p \
            "$rootfs/var/lib/apt/lists/partial" \
            "$rootfs/var/lib/apt/lists/auxfiles" \
            "$rootfs/var/cache/apt/archives/partial"
          chmod 0755 \
            "$rootfs/var/lib/apt/lists" \
            "$rootfs/var/lib/apt/lists/auxfiles" \
            "$rootfs/var/cache/apt/archives" || true
          chmod 0700 \
            "$rootfs/var/lib/apt/lists/partial" \
            "$rootfs/var/cache/apt/archives/partial" || true
          ;;
      esac
    }
    has_ca_certificates_rootfs() {
      [ -d "$rootfs/etc/ssl/certs" ] || \
        [ -f "$rootfs/etc/ssl/cert.pem" ] || \
        [ -f "$rootfs/etc/pki/tls/certs/ca-bundle.crt" ] || \
        [ -f "$rootfs/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" ] || \
        [ -f "$rootfs/etc/ssl/ca-bundle.pem" ]
    }
    sudo_present=false
    if [ -x "$rootfs/usr/bin/sudo" ] || [ -x "$rootfs/bin/sudo" ]; then
      sudo_present=true
    fi
    ca_certificates_present=false
    if has_ca_certificates_rootfs; then
      ca_certificates_present=true
    fi
    distro_family="unknown"
    package_manager="none"
    if [ -x "$rootfs/usr/bin/apt-get" ] || [ -x "$rootfs/bin/apt-get" ]; then
      distro_family="debian"
      package_manager="apt-get"
    elif [ -x "$rootfs/usr/bin/dnf" ] || [ -x "$rootfs/bin/dnf" ]; then
      distro_family="rhel"
      package_manager="dnf"
    elif [ -x "$rootfs/usr/bin/microdnf" ] || [ -x "$rootfs/bin/microdnf" ]; then
      distro_family="rhel"
      package_manager="microdnf"
    elif [ -x "$rootfs/usr/bin/yum" ] || [ -x "$rootfs/bin/yum" ]; then
      distro_family="rhel"
      package_manager="yum"
    elif [ -x "$rootfs/usr/bin/zypper" ] || [ -x "$rootfs/bin/zypper" ]; then
      distro_family="sles"
      package_manager="zypper"
    fi
    if [ ! -e "$rootfs/lib64/ld-linux-x86-64.so.2" ] && \
       [ ! -e "$rootfs/lib/x86_64-linux-gnu/libc.so.6" ] && \
       [ ! -e "$rootfs/lib/ld-linux-aarch64.so.1" ] && \
       [ ! -e "$rootfs/lib64/ld-linux-aarch64.so.1" ] && \
       [ ! -e "$rootfs/lib/aarch64-linux-gnu/libc.so.6" ]; then
      fail "rootfs preflight failed: glibc is required" 43
    fi
    if [ "$sudo_present" = false ] || [ "$ca_certificates_present" = false ]; then
      if [ "$package_manager" = "none" ]; then
        fail "rootfs preflight failed: startup bootstrap requires sudo and CA certificates, but this image has neither a supported package manager nor the required packages preinstalled" 44
      fi
    fi
    mkdir -p "$rootfs/home" "$rootfs/home/user" "$rootfs/tmp" "$rootfs/var/tmp" "$rootfs/run" "$rootfs/etc" "$rootfs/var"
    chmod 1777 "$rootfs/tmp" "$rootfs/var/tmp" || true
    if [ -e "$rootfs/var/run" ] && [ ! -L "$rootfs/var/run" ]; then
      rm -rf "$rootfs/var/run"
    fi
    ln -snf /run "$rootfs/var/run"
    if [ -e "$rootfs/etc/mtab" ] && [ ! -L "$rootfs/etc/mtab" ]; then
      rm -f "$rootfs/etc/mtab"
    fi
    ln -snf /proc/mounts "$rootfs/etc/mtab"
    : >"$rootfs/run/podman-init"
    chmod 0755 "$rootfs/run/podman-init" || true
    : >"$rootfs/run/.containerenv"
    chmod 0644 "$rootfs/run/.containerenv" || true
    if [ "$skip_ownership_bridge" = false ]; then
      run_rootfs_podman_as_user "$podman_user" \
        unshare cat /proc/self/uid_map >"$rewrite_uid_map_file"
      run_rootfs_podman_as_user "$podman_user" \
        unshare cat /proc/self/gid_map >"$rewrite_gid_map_file"
      /usr/bin/python3 "$remap_rootfs_ids_script" \
        "to-canonical" \
        "$rootfs" \
        "2001" \
        "2001" \
        "$rewrite_uid_map_file" \
        "$rewrite_gid_map_file" \
        "$ownership_source"
      /usr/bin/python3 "$remap_rootfs_ids_script" \
        "to-host" \
        "$rootfs" \
        "2001" \
        "2001" \
        "$rewrite_uid_map_file" \
        "$rewrite_gid_map_file" \
        "$ownership_source"
      normalize_runtime_package_state_rootfs
      run_rootfs_podman_as_user "$podman_user" \
        run --rm --network host \
          --userns=keep-id:uid=2001,gid=2001 \
          --user 0:0 \
          --workdir / \
          -e HOME=/root \
          -e USER=root \
          -e LOGNAME=root \
          -e COCALC_RUNTIME_UID=2001 \
          -e COCALC_RUNTIME_GID=2001 \
          --security-opt label=disable \
          --rootfs "$rootfs" "$shell_path" -lc \
          "$fix_setid_runtime_helpers_script" >/dev/null
    fi
    normalize_result="$(printf '{"ok":true,"distro_family":"%s","package_manager":"%s","shell":"%s","glibc":true,"sudo_present":%s,"ca_certificates_present":%s}\n' \
      "$distro_family" "$package_manager" "$shell_path" "$sudo_present" "$ca_certificates_present")"
    printf '%s\n' "$normalize_result"
    exit 0
    ;;
  rootfs-rustic-backup)
    if [ "$#" -lt 3 ]; then
      echo "usage: cocalc-runtime-storage rootfs-rustic-backup <src> <repo-profile> <host> [rustic args...]" >&2
      exit 2
    fi
    src="$1"
    repo_profile="$2"
    host_name="$3"
    shift 3
    tag_args=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --tag)
          if [ "$#" -lt 2 ]; then
            deny "rootfs-rustic-backup-bad-args" "missing-tag-value"
          fi
          tag_args+=("$1" "$2")
          shift 2
          ;;
        *)
          deny "rootfs-rustic-backup-bad-args" "$1"
          ;;
      esac
    done
    require_allowed_path_parts "$src"
    source_root="$ALLOWED_PATH_ROOT"
    source_rel="$ALLOWED_PATH_REL"
    set_rustic_profile_parts "$repo_profile"
    prepare_privileged_rustic_cache
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      rustic-rootfs-backup \
      --root "$source_root" \
      --path "$source_rel" \
      --profile-root "$RUSTIC_PROFILE_ROOT" \
      --profile-path "$RUSTIC_PROFILE_REL" \
      --host "$host_name" \
      "${tag_args[@]}"
    ;;
  rootfs-rustic-restore)
    if [ "$#" -lt 3 ]; then
      echo "usage: cocalc-runtime-storage rootfs-rustic-restore <repo-profile> <snapshot> <dest> [rustic args...]" >&2
      exit 2
    fi
    repo_profile="$1"
    snapshot="$2"
    dest="$3"
    shift 3
    delete_args=()
    if [ "$#" -gt 0 ]; then
      if [ "$#" -ne 1 ] || [ "$1" != "--delete" ]; then
        deny "rootfs-rustic-restore-bad-args" "$*"
      fi
      delete_args=("--delete")
    fi
    require_allowed_path_parts "$dest"
    dest_root="$ALLOWED_PATH_ROOT"
    dest_rel="$ALLOWED_PATH_REL"
    set_rustic_profile_parts "$repo_profile"
    prepare_privileged_rustic_cache
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      rustic-rootfs-restore \
      --root "$dest_root" \
      --path "$dest_rel" \
      --profile-root "$RUSTIC_PROFILE_ROOT" \
      --profile-path "$RUSTIC_PROFILE_REL" \
      --snapshot "$snapshot" \
      "${delete_args[@]}"
    ;;
  project-rustic-backup|project-rustic-backup-maintenance)
    if [ "$#" -lt 3 ]; then
      echo "usage: cocalc-runtime-storage project-rustic-backup <src> <repo-profile> <host> [--tag <tag>] [--parent <snapshot>]..." >&2
      exit 2
    fi
    src="$1"
    repo_profile="$2"
    host_name="$3"
    shift 3
    case "$host_name" in
      -*)
        deny "project-rustic-backup-bad-host" "$host_name"
        ;;
    esac
    tag_args=()
    parent_args=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --tag)
          if [ "$#" -lt 2 ]; then
            deny "project-rustic-backup-bad-args" "missing-tag-value"
          fi
          tag_args+=("$1" "$2")
          shift 2
          ;;
        --parent)
          if [ "$#" -lt 2 ]; then
            deny "project-rustic-backup-bad-args" "missing-parent-value"
          fi
          case "$2" in
            -*)
              deny "project-rustic-backup-bad-parent" "$2"
              ;;
          esac
          parent_args+=("$1" "$2")
          shift 2
          ;;
        *)
          deny "project-rustic-backup-bad-args" "$1"
          ;;
      esac
    done
    require_allowed_path_parts "$src"
    source_root="$ALLOWED_PATH_ROOT"
    source_rel="$ALLOWED_PATH_REL"
    set_rustic_profile_parts "$repo_profile"
    if [ "$cmd" = "project-rustic-backup-maintenance" ]; then
      attach_maintenance_worker
    fi
    prepare_privileged_rustic_cache
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      rustic-project-backup \
      --root "$source_root" \
      --path "$source_rel" \
      --profile-root "$RUSTIC_PROFILE_ROOT" \
      --profile-path "$RUSTIC_PROFILE_REL" \
      --host "$host_name" \
      "${tag_args[@]}" \
      "${parent_args[@]}"
    ;;
  project-rustic-restore)
    if [ "$#" -ne 3 ]; then
      echo "usage: cocalc-runtime-storage project-rustic-restore <repo-profile> <snapshot> <dest>" >&2
      exit 2
    fi
    repo_profile="$1"
    snapshot="$2"
    dest="$3"
    case "$snapshot" in
      -*)
        deny "project-rustic-restore-bad-snapshot" "$snapshot"
        ;;
    esac
    require_allowed_path_parts "$dest"
    dest_root="$ALLOWED_PATH_ROOT"
    dest_rel="$ALLOWED_PATH_REL"
    set_rustic_profile_parts "$repo_profile"
    prepare_privileged_rustic_cache
    exec /usr/local/libexec/cocalc-runtime-storage-path-helper \
      rustic-project-restore \
      --root "$dest_root" \
      --path "$dest_rel" \
      --profile-root "$RUSTIC_PROFILE_ROOT" \
      --profile-path "$RUSTIC_PROFILE_REL" \
      --snapshot "$snapshot"
    ;;
  rootfs-manifest)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage rootfs-manifest <path>" >&2
      exit 2
    fi
    tree="$1"
    check_args "$tree"
    exec /bin/bash -lc 'set -euo pipefail; python3 - "$1" <<'"'"'PY'"'"'
import hashlib
import json
import os
import stat
import sys
from datetime import datetime, timezone

root = sys.argv[1]
records = []
hardlink_paths = {}
counts = {
    "entry_count": 0,
    "regular_file_count": 0,
    "directory_count": 0,
    "symlink_count": 0,
    "other_count": 0,
    "total_regular_bytes": 0,
}


def detect_type(st):
    mode = st.st_mode
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISBLK(mode):
        return "block"
    if stat.S_ISCHR(mode):
        return "char"
    if stat.S_ISFIFO(mode):
        return "fifo"
    if stat.S_ISSOCK(mode):
        return "socket"
    return "other"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_line(record, hardlink_group="", hardlink_group_size=1):
    return json.dumps(
        [
            record["type"],
            record["path"],
            record["mode"],
            record["uid"],
            record["gid"],
            record["size"],
            record.get("sha256", ""),
            record.get("target", ""),
            hardlink_group,
            hardlink_group_size,
            record.get("rdev", ""),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def walk(path, relative_path):
    st = os.lstat(path)
    file_type = detect_type(st)
    is_root_entry = relative_path == "."
    record = {
        "type": file_type,
        "path": relative_path,
        # The mounted/cache root directory itself is transport scaffolding, not
        # semantic RootFS content, so normalize its ownership/mode fields.
        "mode": "0000" if is_root_entry else format(stat.S_IMODE(st.st_mode), "04o"),
        "uid": "0" if is_root_entry else str(st.st_uid),
        "gid": "0" if is_root_entry else str(st.st_gid),
        # Directory and special-file st_size values are allocator details, not
        # semantic tree content, and differ between overlay views and restored
        # standalone trees.
        "size": "0",
    }
    counts["entry_count"] += 1
    if file_type == "file":
        counts["regular_file_count"] += 1
        counts["total_regular_bytes"] += int(st.st_size)
        record["size"] = str(st.st_size)
        record["sha256"] = sha256_file(path)
        if st.st_nlink > 1:
            key = f"{st.st_dev}:{st.st_ino}"
            record["hardlink_key"] = key
            hardlink_paths.setdefault(key, []).append(relative_path)
    elif file_type == "directory":
        counts["directory_count"] += 1
    elif file_type == "symlink":
        counts["symlink_count"] += 1
        record["target"] = os.readlink(path)
    else:
        counts["other_count"] += 1
        record["rdev"] = str(st.st_rdev)
    records.append(record)
    if file_type != "directory":
        return
    with os.scandir(path) as entries:
        names = sorted(entry.name for entry in entries)
    for name in names:
        child_path = os.path.join(path, name)
        child_relative = name if relative_path == "." else f"{relative_path}/{name}"
        walk(child_path, child_relative)


walk(root, ".")

hardlink_groups = {}
hardlink_group_count = 0
hardlink_member_count = 0
for key, paths in hardlink_paths.items():
    if len(paths) <= 1:
        continue
    paths.sort()
    hardlink_groups[key] = {
        "group_id": paths[0],
        "visible_count": len(paths),
    }
    hardlink_group_count += 1
    hardlink_member_count += len(paths)

lines = []
for record in records:
    group = hardlink_groups.get(record.get("hardlink_key", ""))
    lines.append(
        manifest_line(
            record,
            group["group_id"] if group else "",
            group["visible_count"] if group else 1,
        )
    )

manifest_text = ("\\n".join(lines) + "\\n") if lines else "\\n"
hardlink_lines = [
    json.dumps(
        [group["group_id"], group["visible_count"]],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    for group in hardlink_groups.values()
]
hardlink_text = ("\\n".join(hardlink_lines) + "\\n") if hardlink_lines else ""

result = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "manifest_sha256": hashlib.sha256(manifest_text.encode("utf-8")).hexdigest(),
    "hardlink_sha256": hashlib.sha256(hardlink_text.encode("utf-8")).hexdigest(),
    "entry_count": counts["entry_count"],
    "regular_file_count": counts["regular_file_count"],
    "directory_count": counts["directory_count"],
    "symlink_count": counts["symlink_count"],
    "other_count": counts["other_count"],
    "hardlink_group_count": hardlink_group_count,
    "hardlink_member_count": hardlink_member_count,
    "total_regular_bytes": counts["total_regular_bytes"],
}
json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
sys.stdout.write("\\n")
PY' bash "$tree"
    ;;
  tar-sha256-tree)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage tar-sha256-tree <path>" >&2
      exit 2
    fi
    tree="$1"
    check_args "$tree"
    exec /bin/bash -lc 'set -euo pipefail; tar --sort=name --mtime='"'"'UTC 1970-01-01'"'"' --numeric-owner --owner=0 --group=0 --format=posix --acls --xattrs --xattrs-include='"'"'*'"'"' -cf - -C "$1" . | sha256sum | awk '"'"'{print $1}'"'"'' bash "$tree"
    ;;
  du-bytes)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage du-bytes <path>" >&2
      exit 2
    fi
    path="$1"
    check_args "$path"
    exec /usr/bin/du -sb "$path"
    ;;
  df)
    check_args "$@"
    exec /bin/df "$@"
    ;;
  reconcile-bees)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage reconcile-bees <mountpoint>" >&2
      exit 2
    fi
    mountpoint="$1"
    check_args "$mountpoint"
    case "$mountpoint" in
      /mnt/cocalc|/mnt/cocalc/*)
        ;;
      *)
        deny "bees-mountpoint-not-allowed" "$mountpoint"
        ;;
    esac
    existing_pid="$(find_bees_pid "$mountpoint")"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      apply_bees_runtime_policy "$existing_pid" "$mountpoint"
      echo "BEES_POLICY_RECONCILED mountpoint=${mountpoint} pid=${existing_pid}" >&2
    else
      echo "BEES_NOT_RUNNING mountpoint=${mountpoint}" >&2
    fi
    ;;
  bees-status)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage bees-status <mountpoint>" >&2
      exit 2
    fi
    mountpoint="$1"
    check_args "$mountpoint"
    case "$mountpoint" in
      /mnt/cocalc|/mnt/cocalc/*)
        ;;
      *)
        deny "bees-mountpoint-not-allowed" "$mountpoint"
        ;;
    esac
    emit_bees_status "$mountpoint"
    ;;
  bees)
    check_args "$@"
    mountpoint=""
    for arg in "$@"; do
      mountpoint="$arg"
    done
    case "$mountpoint" in
      /mnt/cocalc|/mnt/cocalc/*)
        ;;
      *)
        deny "bees-mountpoint-not-allowed" "$mountpoint"
        ;;
    esac
    beeshome="$mountpoint/.beeshome"
    if [ ! -d "$beeshome" ]; then
      deny "bees-home-missing" "$beeshome"
    fi
    if ! command -v flock >/dev/null 2>&1; then
      deny "flock-missing" "flock"
    fi
    existing_pid="$(find_bees_pid "$mountpoint")"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      apply_bees_runtime_policy "$existing_pid" "$mountpoint"
      echo "BEES_ALREADY_RUNNING mountpoint=${mountpoint} pid=${existing_pid}" >&2
      exit 75
    fi
    lock_path="$beeshome/cocalc-bees.lock"
    exec 9>"$lock_path"
    if ! flock -n 9; then
      echo "BEES_ALREADY_RUNNING mountpoint=${mountpoint} lock=${lock_path}" >&2
      exit 75
    fi
    pool="$(bees_cgroup)"
    configure_bees_cgroup "$pool" "$mountpoint"
    attach_pid_to_project_pool_storage "$$" "$pool" || true
    echo "BEES_STARTING mountpoint=${mountpoint} pid=$$" >&2
    if [ -x /usr/local/libexec/cocalc-bees ]; then
      exec /usr/bin/ionice -c3 /usr/bin/nice -n 19 /usr/local/libexec/cocalc-bees "$@"
    fi
    if command -v /usr/bin/bees >/dev/null 2>&1; then
      exec /usr/bin/ionice -c3 /usr/bin/nice -n 19 /usr/bin/bees "$@"
    fi
    exec /usr/bin/ionice -c3 /usr/bin/nice -n 19 /bin/bees "$@"
    ;;
  grow-btrfs)
    if [ "$#" -gt 1 ]; then
      deny "grow-btrfs-bad-args" "too-many-arguments"
    fi
    if [ "$#" -eq 1 ] && ! echo "$1" | grep -Eq '^[0-9]+$'; then
      deny "grow-btrfs-bad-args" "non-numeric-argument"
    fi
    /usr/local/sbin/cocalc-grow-btrfs "$@"
    reconcile_project_io_policy
    ;;
  grow-shared-scratch)
    if [ "$#" -gt 1 ]; then
      deny "grow-shared-scratch-bad-args" "too-many-arguments"
    fi
    if [ "$#" -eq 1 ] && ! echo "$1" | grep -Eq '^[0-9]+$'; then
      deny "grow-shared-scratch-bad-args" "non-numeric-argument"
    fi
    scratch_target_gib="${1:-}"
    scratch_mount="/mnt/cocalc-scratch"
    if ! mountpoint -q "$scratch_mount"; then
      deny "shared-scratch-not-mounted" "$scratch_mount"
    fi
    scratch_source="$(findmnt -n -o SOURCE "$scratch_mount" 2>/dev/null || true)"
    case "$scratch_source" in
      /dev/*)
        ;;
      *)
        deny "shared-scratch-source-not-allowed" "$scratch_source"
        ;;
    esac
    scratch_source="$(readlink -f "$scratch_source" 2>/dev/null || printf '%s' "$scratch_source")"
    scratch_parent_name="$(lsblk -no PKNAME "$scratch_source" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    scratch_part_num="$(lsblk -no PARTN "$scratch_source" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    if [ -n "$scratch_parent_name" ]; then
      scratch_parent="/dev/$scratch_parent_name"
    else
      scratch_parent="$scratch_source"
    fi
    scratch_base="$(basename "$scratch_parent")"
    scratch_rescan="/sys/class/block/$scratch_base/device/rescan"
    if [ -w "$scratch_rescan" ]; then
      echo 1 > "$scratch_rescan" || true
    fi
    blockdev --rereadpt "$scratch_parent" >/dev/null 2>&1 || true
    if command -v partprobe >/dev/null 2>&1; then
      partprobe "$scratch_parent" >/dev/null 2>&1 || true
    fi
    if command -v udevadm >/dev/null 2>&1; then
      udevadm settle >/dev/null 2>&1 || true
    fi
    if [ -n "$scratch_part_num" ]; then
      if ! command -v growpart >/dev/null 2>&1; then
        deny "growpart-missing" "cloud-guest-utils"
      fi
      growpart "$scratch_parent" "$scratch_part_num" >/dev/null 2>&1 || true
      blockdev --rereadpt "$scratch_parent" >/dev/null 2>&1 || true
      if command -v partprobe >/dev/null 2>&1; then
        partprobe "$scratch_parent" >/dev/null 2>&1 || true
      fi
      if command -v udevadm >/dev/null 2>&1; then
        udevadm settle >/dev/null 2>&1 || true
      fi
    fi
    resize2fs "$scratch_source"
    if [ -n "$scratch_target_gib" ]; then
      scratch_actual_bytes="$(blockdev --getsize64 "$scratch_parent" 2>/dev/null || blockdev --getsize64 "$scratch_source" 2>/dev/null || printf '0')"
      scratch_target_bytes=$((scratch_target_gib * 1024 * 1024 * 1024))
      if [ "$scratch_actual_bytes" -lt "$scratch_target_bytes" ]; then
        deny "shared-scratch-grow-incomplete" "device_size_bytes=${scratch_actual_bytes} target_gib=${scratch_target_gib}"
      fi
    fi
    chmod 1777 "$scratch_mount"
    reconcile_project_io_policy
    ;;
  unmount-shared-scratch)
    if [ "$#" -ne 0 ]; then
      deny "unmount-shared-scratch-bad-args" "too-many-arguments"
    fi
    scratch_mount="/mnt/cocalc-scratch"
    if mountpoint -q "$scratch_mount"; then
      umount "$scratch_mount"
    fi
    if [ -f /etc/fstab ]; then
      sed -i.bak '/# cocalc-scratch$/d' /etc/fstab
    fi
    ;;
  sync)
    exec /bin/sync "$@"
    ;;
  *)
    deny "unsupported-command" "$cmd"
    ;;
esac
"""
    mount_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-mount-data must run as root" >&2
  exit 1
fi
exec /bin/mount /mnt/cocalc
"""
    cloud_ctl_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-cloudflared-ctl must run as root" >&2
  exit 1
fi
cmd="${1:-status}"
service="cocalc-cloudflared.service"
case "$cmd" in
  start|stop|restart|status)
    exec /bin/systemctl "$cmd" "$service"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
"""
    cloud_logs_wrapper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-cloudflared-logs must run as root" >&2
  exit 1
fi
service="cocalc-cloudflared.service"
lines="${1:-200}"
if ! echo "$lines" | grep -Eq '^[0-9]+$'; then
  lines="200"
fi
if [ "$lines" -lt 1 ]; then
  lines=1
elif [ "$lines" -gt 5000 ]; then
  lines=5000
fi
mode="${2:-snapshot}"
case "$mode" in
  snapshot)
    exec /bin/journalctl -u "$service" -o short-iso-precise --no-pager -n "$lines"
    ;;
  follow)
    exec /bin/journalctl -u "$service" -o short-iso-precise -f -n "$lines"
    ;;
  *)
    echo "usage: ${0} [lines] {snapshot|follow}" >&2
    exit 2
    ;;
esac
"""
    storage_wrapper = storage_wrapper.replace(
        "__PROJECT_POOL_CGROUP__", DEFAULT_PROJECT_POOL_CGROUP
    )
    storage_wrapper = storage_wrapper.replace("__RUNTIME_USER__", cfg.ssh_user)
    storage_wrapper = storage_wrapper.replace(
        "__CONTAINER_RUNTIME_REQUIRED__",
        "1" if cfg.container_runtime_bundle is not None else "0",
    )
    storage_path_helper = RUNTIME_STORAGE_PATH_HELPER.replace(
        "__ALLOW_LOOPBACK_RUSTIC_REST__",
        "1" if cfg.allow_loopback_rustic_rest else "0",
    )
    wrappers = {
        "/usr/local/libexec/cocalc-runtime-storage-path-helper": storage_path_helper,
        "/usr/local/libexec/cocalc-project-io-policy": PROJECT_IO_POLICY_HELPER,
        "/usr/local/sbin/cocalc-runtime-storage": storage_wrapper,
        "/usr/local/sbin/cocalc-mount-data": mount_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-ctl": cloud_ctl_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-logs": cloud_logs_wrapper,
    }
    for path, content in wrappers.items():
        p = Path(path)
        text_write_atomic(p, content, default_mode=0o755)
        os.chown(p, 0, 0)
        p.chmod(0o755)

    write_project_io_configuration(cfg)


def reconcile_bees_runtime_policy(cfg: BootstrapConfig) -> None:
    run_best_effort(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-bees",
            "/mnt/cocalc",
        ],
        "reconcile BEES runtime policy",
    )


def reconcile_project_network_limits(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-project-network-limits",
        ],
        "reconcile per-project network containment",
        timeout=60,
    )


def reconcile_project_io_policy(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-project-io-policy",
        ],
        "reconcile per-project I/O containment",
        timeout=120,
    )


def reconcile_host_service_cgroup(cfg: BootstrapConfig) -> None:
    run_cmd(
        cfg,
        [
            "/usr/local/sbin/cocalc-runtime-storage",
            "reconcile-host-service-cgroup",
        ],
        "reconcile project-host service priority",
        timeout=30,
    )


def reconcile_storage_and_containment(cfg: BootstrapConfig) -> None:
    # Network reconciliation creates the project-pool hierarchy, which also
    # applies io.max. Establish every required writable mount before that
    # fail-closed policy can inspect the capacity manifest.
    ensure_cocalc_mount(cfg)
    setup_shared_scratch(cfg)
    ensure_btrfs_data(cfg)
    reconcile_bees_runtime_policy(cfg)
    reconcile_project_network_limits(cfg)
    reconcile_project_io_policy(cfg)
    reconcile_host_service_cgroup(cfg)


def ensure_btrfs_data(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: ensuring /mnt/cocalc/data subvolume")
    try:
        run_cmd(cfg, ["btrfs", "subvolume", "show", "/mnt/cocalc/data"], "btrfs subvolume show", check=False)
    except Exception:
        pass
    if not Path("/mnt/cocalc/data").exists():
        try:
            run_cmd(cfg, ["btrfs", "subvolume", "create", "/mnt/cocalc/data"], "btrfs subvolume create", check=False)
        except Exception:
            Path("/mnt/cocalc/data").mkdir(parents=True, exist_ok=True)
    Path("/mnt/cocalc/data/secrets").mkdir(parents=True, exist_ok=True)
    Path("/mnt/cocalc/data/tmp").mkdir(parents=True, exist_ok=True)
    os.chmod("/mnt/cocalc/data/tmp", 0o1777)
    for path in ["/mnt/cocalc/data", "/mnt/cocalc/data/secrets", "/mnt/cocalc/data/tmp"]:
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", path],
            f"chown {path}",
        )
    repair_host_data_ownership(cfg)


def project_host_runtime_is_active() -> bool:
    markers = (b"project-host:app", b"cocalc-project-podman", b"/conmon")
    proc = Path("/proc")
    try:
        entries = proc.iterdir()
    except OSError:
        return True
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
            continue
        if any(marker in cmdline for marker in markers):
            return True
    return False


def configured_podman_runroot(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None
    match = re.search(r'^\s*runroot\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else None


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
    migration_pending = Path(
        "/mnt/cocalc/data/containers/runroot-migration-pending"
    )
    if (
        current_rootless_run
        and current_rootless_run != str(rootless_run)
        and project_host_runtime_is_active()
    ):
        migration_pending.parent.mkdir(parents=True, exist_ok=True)
        migration_pending.write_text(
            f"current={current_rootless_run}\ndesired={rootless_run}\n",
            encoding="utf-8",
        )
        log_line(
            cfg,
            "bootstrap: deferring Podman runroot migration until the next safe host boot",
        )
        return

    Path("/mnt/cocalc/data/containers/root/storage").mkdir(parents=True, exist_ok=True)
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
        'graphroot = "/mnt/cocalc/data/containers/root/storage"\n',
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
        user_config_root.mkdir(parents=True, exist_ok=True)
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(user_config_root)],
            "chown user config",
        )
        user_config.mkdir(parents=True, exist_ok=True)
        rootless_storage.mkdir(parents=True, exist_ok=True)
        rootless_run.mkdir(parents=True, exist_ok=True)
        run_best_effort(
            cfg,
            [
                "chown",
                f"{cfg.ssh_user}:{cfg.ssh_user}",
                str(user_config),
            ],
            "chown rootless podman config",
        )
        run_best_effort(
            cfg,
            [
                "chown",
                f"{cfg.ssh_user}:{cfg.ssh_user}",
                str(rootless_root),
                str(rootless_storage),
            ],
            "chown rootless podman persistent paths",
        )
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
        (user_config / "storage.conf").write_text(
            '[storage]\n'
            'driver = "overlay"\n'
            f'runroot = "{rootless_run}"\n'
            f'graphroot = "{rootless_storage}"\n',
            encoding="utf-8",
        )
        run_best_effort(
            cfg,
            [
                "chown",
                f"{cfg.ssh_user}:{cfg.ssh_user}",
                str(user_config / "storage.conf"),
            ],
            "chown storage.conf",
        )
        (user_config / "containers.conf").write_text(
            '[engine]\n'
            'cgroup_manager = "cgroupfs"\n',
            encoding="utf-8",
        )
        run_best_effort(
            cfg,
            [
                "chown",
                f"{cfg.ssh_user}:{cfg.ssh_user}",
                str(user_config / "containers.conf"),
            ],
            "chown containers.conf",
        )
    migration_pending.unlink(missing_ok=True)


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
    local_env_path = env_path.with_name(
        env_path.name[:-4] + ".local.env"
        if env_path.name.endswith(".env")
        else "project-host.local.env"
    )
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
        Path(runtime_dir).mkdir(parents=True, exist_ok=True)
        run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", runtime_dir], "chown runtime dir")
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


def upsert_managed_bashrc_block(path: Path, lines: list[str]) -> None:
    existing_lines = []
    if path.exists():
        existing_lines = path.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    in_block = False
    for line in existing_lines:
        if line == PODMAN_BASHRC_BLOCK_START:
            in_block = True
            continue
        if line == PODMAN_BASHRC_BLOCK_END:
            in_block = False
            continue
        if not in_block:
            out.append(line)
    while out and out[-1] == "":
        out.pop()
    if out:
        out.append("")
    out.extend(
        [
            PODMAN_BASHRC_BLOCK_START,
            "# Added by CoCalc project-host bootstrap so rootless podman works in login shells.",
            *lines,
            PODMAN_BASHRC_BLOCK_END,
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out), encoding="utf-8")


def configure_runtime_shell_env(cfg: BootstrapConfig) -> None:
    if not cfg.ssh_user or cfg.ssh_user == "root":
        return
    lines = runtime_podman_env_lines(cfg)
    if not lines:
        return
    bashrc = Path(runtime_home(cfg)) / ".bashrc"
    upsert_managed_bashrc_block(bashrc, lines)
    run_best_effort(
        cfg,
        ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(bashrc)],
        "chown runtime bashrc podman env",
    )


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
    path = Path("/mnt/cocalc/data/secrets/master-conat-token")
    if path.exists():
        log_line(cfg, "bootstrap: master conat token already present")
        if cfg.ssh_user and cfg.ssh_user != "root":
            run_best_effort(
                cfg,
                ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(path)],
                "chown master conat token",
            )
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return
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
            data = resp.read()
        path.write_bytes(data)
    except Exception as err:
        log_line(cfg, f"bootstrap: master-conat-token fetch failed via urllib ({err}); trying curl")
        if shutil.which("curl") is None:
            raise
        run_cmd(
            cfg,
            [
                "curl",
                "-fsSL",
                "-o",
                str(path),
                "-H",
                f"Authorization: Bearer {cfg.bootstrap_token}",
                "-H",
                "User-Agent: cocalc-bootstrap/1.0 (master-conat-token)",
                "-H",
                "Accept: text/plain,*/*",
                cfg.conat_url,
            ],
            "fetch master conat token via curl",
        )
    os.chmod(path, 0o600)
    if cfg.ssh_user and cfg.ssh_user != "root":
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(path)],
            "chown master conat token",
        )


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


def extract_bundle(cfg: BootstrapConfig, bundle: BundleSpec) -> BundleSpec:
    bundle = resolve_bundle_spec(cfg, bundle)
    Path(cfg.bootstrap_tmp).mkdir(parents=True, exist_ok=True)
    if cfg.bootstrap_user and cfg.bootstrap_user != "root":
        run_best_effort(
            cfg,
            ["chown", f"{cfg.bootstrap_user}:{cfg.bootstrap_user}", cfg.bootstrap_tmp],
            "chown bootstrap tmp",
        )
    Path(bundle.root).mkdir(parents=True, exist_ok=True)
    desired_dir = Path(bundle.dir)
    current_path = Path(bundle.current)
    if desired_dir.exists():
        if current_path.is_symlink():
            try:
                if current_path.resolve() == desired_dir.resolve():
                    log_line(
                        cfg,
                        f"bootstrap: bundle already current version={bundle.version or desired_dir.name} root={bundle.root}",
                    )
                    prune_bundle_versions(cfg, bundle)
                    return bundle
            except Exception:
                pass
        log_line(
            cfg,
            f"bootstrap: reusing existing bundle version={bundle.version or desired_dir.name} root={bundle.root}",
        )
    else:
        download_file(cfg, bundle.url, bundle.remote)
        verify_sha256(cfg, bundle.remote, bundle.sha256)
        if desired_dir.exists():
            shutil.rmtree(desired_dir)
        desired_dir.mkdir(parents=True, exist_ok=True)
        run_cmd(
            cfg,
            ["tar", "-xJf", bundle.remote, "--strip-components=1", "-C", bundle.dir],
            f"extract {bundle.url}",
        )
    if cfg.ssh_user and cfg.ssh_user != "root":
        run_best_effort(
            cfg,
            ["chown", "-R", f"{cfg.ssh_user}:{cfg.ssh_user}", bundle.dir],
            f"chown {bundle.dir}",
        )
    if current_path.is_symlink() or current_path.exists():
        if current_path.is_dir() and not current_path.is_symlink():
            shutil.rmtree(current_path)
        else:
            current_path.unlink()
    current_path.symlink_to(desired_dir, target_is_directory=True)
    prune_bundle_versions(cfg, bundle)
    return bundle


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


def install_node(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: installing node via nvm")
    nvm_dir = f"{runtime_home(cfg)}/.nvm"
    install_cmd = (
        f'export NVM_DIR="{nvm_dir}"; '
        f'if [ ! -s "$NVM_DIR/nvm.sh" ] || '
        f'! ( . "$NVM_DIR/nvm.sh"; [ "$(nvm --version)" = "{NVM_VERSION}" ] ); then '
        f'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v{NVM_VERSION}/install.sh | PROFILE=/dev/null bash; '
        f'fi; '
        f'. "$NVM_DIR/nvm.sh"; '
        f'nvm install {cfg.node_version}; '
        f'nvm alias default {cfg.node_version}'
    )
    run_cmd(cfg, ["bash", "-lc", install_cmd], "install node", as_user=cfg.ssh_user)


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
    if shutil.which("setcap") is None:
        raise RuntimeError(
            "setcap is required for the unprivileged project-host HTTPS listener"
        )
    nvm_dir = Path(runtime_home(cfg)) / ".nvm"
    result = run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            f'export NVM_DIR="{nvm_dir}"; . "$NVM_DIR/nvm.sh"; nvm which default',
        ],
        "resolve project-host node binary",
        as_user=cfg.ssh_user,
    )
    output_lines = [line.strip() for line in (result.stdout or "").splitlines()]
    node_path = Path(output_lines[-1]).resolve() if output_lines else None
    versions_root = (nvm_dir / "versions" / "node").resolve()
    if (
        node_path is None
        or not node_path.is_file()
        or not node_path.is_relative_to(versions_root)
    ):
        raise RuntimeError("unable to resolve the project-host nvm node binary")
    run_cmd(
        cfg,
        ["setcap", "cap_net_bind_service=+ep", str(node_path)],
        "allow project-host node to bind HTTPS port 443",
    )


def write_wrapper(cfg: BootstrapConfig) -> None:
    host_dir = project_host_runtime_root(cfg)
    bin_dir = host_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    bundle_root = cfg.project_host_bundle.current
    if not bundle_root:
        bundle_root = str(host_dir / "bundles" / "current")
    bundle_entry = f"{bundle_root}/bundle/index.js"
    runtime_home_dir = runtime_home(cfg)
    node_glob = f'$NVM_DIR/versions/node/v{cfg.node_version}*/bin/node'
    wrapper = f"""#!/usr/bin/env bash
set -euo pipefail
RUNTIME_HOME="{runtime_home_dir}"
export NVM_DIR="$RUNTIME_HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  shopt -s nullglob
  NODE_CANDIDATES=( {node_glob} )
  shopt -u nullglob
  if [ "${{#NODE_CANDIDATES[@]}}" -gt 0 ] && [ -x "${{NODE_CANDIDATES[0]}}" ]; then
    NODE_BIN="${{NODE_CANDIDATES[0]}}"
  else
    echo "node not found for project-host wrapper (looked in PATH and {node_glob})" >&2
    exit 127
  fi
fi
exec "$NODE_BIN" "{bundle_entry}" "$@"
"""
    wrapper_path = bin_dir / "project-host"
    wrapper_path.write_text(wrapper, encoding="utf-8")
    wrapper_path.chmod(0o755)
    if cfg.ssh_user and cfg.ssh_user != "root":
        run_best_effort(
            cfg,
            ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(bin_dir), str(wrapper_path)],
            "chown project-host wrapper",
        )


def write_helpers(cfg: BootstrapConfig) -> None:
    runtime_root = project_host_runtime_root(cfg)
    bin_dir = runtime_root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    rootctl_path = project_host_rootctl_path(cfg)
    core_handler_path = rootctl_path.with_name("cocalc-project-host-core-handler")
    ctl = """#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
shift || true
RUNTIME_ROOT="__RUNTIME_ROOT__"
bin="$RUNTIME_ROOT/bin/project-host"
pid_file="/mnt/cocalc/data/daemon.pid"
rootctl="__ROOTCTL__"
case "${cmd}" in
  start|ensure|restart|stop)
    exec sudo -n "${rootctl}" "${cmd}" "$@"
    ;;
  status)
    pid=""
    if [ -r "${pid_file}" ]; then
      pid="$(cat "${pid_file}" 2>/dev/null || true)"
    elif command -v sudo >/dev/null 2>&1; then
      pid="$(sudo -n cat "${pid_file}" 2>/dev/null || true)"
    fi
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "project-host running (pid ${pid})"
    else
      echo "project-host not running"
      exit 1
    fi
    ;;
  doctor)
    exec sudo -n "${rootctl}" doctor "$@"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|ensure|status|doctor}" >&2
    exit 2
    ;;
esac
"""
    ctl = ctl.replace("__RUNTIME_ROOT__", str(runtime_root))
    ctl = ctl.replace("__ROOTCTL__", str(rootctl_path))
    start_ph = """#!/usr/bin/env bash
set -euo pipefail
RUNTIME_ROOT="__RUNTIME_ROOT__"
CTL="$RUNTIME_ROOT/bin/ctl"
WATCHDOG_LOG="/mnt/cocalc/data/logs/project-host-watchdog.log"
for attempt in $(seq 1 60); do
  if mountpoint -q /mnt/cocalc; then
    mkdir -p "$(dirname "$WATCHDOG_LOG")"
    exec >>"$WATCHDOG_LOG" 2>&1
    if [ -x /usr/local/sbin/cocalc-runtime-storage ]; then
      sudo -n /usr/local/sbin/cocalc-runtime-storage grow-btrfs || true
    fi
    exec "$CTL" ensure
  fi
  echo "waiting for /mnt/cocalc mount (attempt $attempt/60)"
  sudo -n /usr/local/sbin/cocalc-mount-data || true
  sleep 5
done
echo "timeout waiting for /mnt/cocalc mount"
exit 1
"""
    logs_script = """#!/usr/bin/env bash
set -euo pipefail
lines="${1:-200}"
log_file="/mnt/cocalc/data/log"
if [ -r "$log_file" ]; then
  exec tail -n "$lines" -f "$log_file"
fi
if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$log_file" >/dev/null 2>&1; then
  exec sudo -n tail -n "$lines" -f "$log_file"
fi
if [ -e "$log_file" ]; then
  echo "project-host log exists but is not readable: $log_file" >&2
else
  echo "project-host log not found at $log_file" >&2
fi
exit 1
"""
    acp_status_script = """#!/usr/bin/env bash
set -euo pipefail
data_dir="${DATA:-${COCALC_DATA:-/btrfs/data}}"
pid_file="$data_dir/acp-worker.pid"
log_file="$data_dir/logs/acp-worker.log"

echo "ACP worker status"
echo "================="
echo "data dir: $data_dir"
echo "pid file: $pid_file"
echo "log file: $log_file"
echo

if [ -f "$pid_file" ]; then
  pid="$(tr -d '[:space:]' < "$pid_file")"
  echo "worker pid: $pid"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "worker state: running"
    ps -fp "$pid" || true
  else
    echo "worker state: pid file exists but process is not running"
  fi
else
  echo "worker state: pid file missing"
fi

echo
if [ -f "$log_file" ]; then
  echo "worker log: present"
  ls -lh "$log_file"
  echo
  echo "recent worker log lines:"
  tail -n 20 "$log_file" || true
else
  echo "worker log: missing"
fi

echo
if command -v podman >/dev/null 2>&1; then
  echo "codex containers:"
  podman ps -a --format "table {{.Names}}\\t{{.Status}}" | awk 'NR == 1 || $1 ~ /^codex-/'
else
  echo "podman not installed"
fi
"""
    acp_logs_script = """#!/usr/bin/env bash
set -euo pipefail
data_dir="${DATA:-${COCALC_DATA:-/btrfs/data}}"
log_file="$data_dir/logs/acp-worker.log"
lines="${1:-80}"
if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "usage: ${0} [lines]" >&2
  exit 1
fi
if [ -f "$log_file" ]; then
  exec tail -n "$lines" -f "$log_file"
fi
echo "ACP worker log not found: $log_file" >&2
exit 1
"""
    logs_cf_script = """#!/usr/bin/env bash
set -euo pipefail
service="cocalc-cloudflared.service"
if ! command -v journalctl >/dev/null 2>&1; then
  echo "journalctl not found" >&2
  exit 1
fi
if ! sudo -n /usr/local/sbin/cocalc-cloudflared-ctl status >/dev/null 2>&1; then
  echo "cloudflared service not enabled on this host ($service)" >&2
  exit 1
fi
exec sudo -n /usr/local/sbin/cocalc-cloudflared-logs 200 follow
"""
    ctl_cf_script = """#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
service="cocalc-cloudflared.service"
case "$cmd" in
  start|stop|restart|status)
    exec sudo -n /usr/local/sbin/cocalc-cloudflared-ctl "$cmd"
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
"""
    core_handler = """#!/usr/bin/env bash
set -euo pipefail
pid="${1:-}"
uid="${2:-}"
gid="${3:-}"
signal="${4:-}"
timestamp="${5:-}"
executable="${6:-project-host}"
runtime_user="__RUNTIME_USER__"
pid_file="/mnt/cocalc/data/project-host-app.pid"
core_dir="/mnt/cocalc/data/forensics/core-dumps"
max_bytes=$((1024 * 1024 * 1024))

if ! [[ "${pid}" =~ ^[0-9]+$ ]] || ! [[ "${uid}" =~ ^[0-9]+$ ]]; then
  exit 0
fi
expected_uid="$(id -u "${runtime_user}" 2>/dev/null || true)"
expected_pid="$(cat "${pid_file}" 2>/dev/null || true)"
if [ -z "${expected_uid}" ] || [ "${uid}" != "${expected_uid}" ] || [ "${pid}" != "${expected_pid}" ]; then
  exit 0
fi
supervisor_pid="$(tr '\\0' '\\n' < "/proc/${pid}/environ" 2>/dev/null | sed -n 's/^COCALC_PROJECT_HOST_SUPERVISOR_PID=//p' | tail -n1 || true)"
parent_pid="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/${pid}/status" 2>/dev/null || true)"
if ! [[ "${supervisor_pid}" =~ ^[0-9]+$ ]] || [ "${parent_pid}" != "${supervisor_pid}" ]; then
  exit 0
fi

install -d -o root -g root -m 0700 "${core_dir}"
exec 9>"${core_dir}/capture.lock"
flock -x 9
safe_executable="$(printf '%s' "${executable}" | tr -cd 'A-Za-z0-9._:-' | cut -c1-48)"
[ -n "${safe_executable}" ] || safe_executable="project-host"
[[ "${timestamp}" =~ ^[0-9]+$ ]] || timestamp="$(date +%s)"
base="core.${safe_executable}.${pid}.${timestamp}"
tmp="$(mktemp "${core_dir}/.${base}.XXXXXX")"
chmod 0600 "${tmp}"
dd iflag=fullblock bs=1048576 count=1024 conv=sparse of="${tmp}" status=none || true
if [ ! -s "${tmp}" ]; then
  rm -f "${tmp}"
  exit 0
fi
mv "${tmp}" "${core_dir}/${base}"
cat > "${core_dir}/${base}.meta" <<META
captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pid=${pid}
uid=${uid}
gid=${gid}
signal=${signal}
executable=${safe_executable}
supervisor_pid=${supervisor_pid}
max_bytes=${max_bytes}
META
chmod 0600 "${core_dir}/${base}" "${core_dir}/${base}.meta"

kept=0
while IFS= read -r name; do
  kept=$((kept + 1))
  if [ "${kept}" -gt 3 ]; then
    rm -f -- "${core_dir}/${name}" "${core_dir}/${name}.meta"
  fi
done < <(find "${core_dir}" -maxdepth 1 -type f -name 'core.*' ! -name '*.meta' -printf '%T@ %f\\n' | sort -nr | cut -d' ' -f2-)
"""
    core_handler = core_handler.replace("__RUNTIME_USER__", cfg.ssh_user)
    rootctl = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-project-host-rootctl must run as root" >&2
  exit 1
fi
cmd="${1:-ensure}"
shift || true
cd /
RUNTIME_ROOT="__RUNTIME_ROOT__"
RUNTIME_USER="__RUNTIME_USER__"
RUNTIME_BIN="$RUNTIME_ROOT/bin/project-host"
PID_FILE="/mnt/cocalc/data/daemon.pid"
HOST_AGENT_PID_FILE="/mnt/cocalc/data/host-agent.pid"
CONAT_ROUTER_PID_FILE="/mnt/cocalc/data/conat-router.pid"
CONAT_PERSIST_PID_FILE="/mnt/cocalc/data/conat-persist.pid"
DAEMON_CONTROL_LOCK="/mnt/cocalc/data/tmp/project-host-daemon-control.lock"
DAEMON_CONTROL_LOCK_WAIT_SECONDS="${COCALC_PROJECT_HOST_CONTROL_LOCK_WAIT_SECONDS:-30}"
BOOTSTRAP_USER="__BOOTSTRAP_USER__"
BOOTSTRAP_LIFECYCLE_LOCK="__BOOTSTRAP_LIFECYCLE_LOCK__"
BOOTSTRAP_LIFECYCLE_LOCK_WAIT_SECONDS="${COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS:-300}"
FORENSICS_ROOT="/var/lib/cocalc-project-host-forensics"
MAX_FORENSICS_DURATION_SECONDS="30"
MAX_FORENSICS_FILE_BLOCKS="65536"
OOM_ADJ="${COCALC_PROJECT_HOST_OOM_SCORE_ADJ:__OOM_ADJ_LITERAL__}"
PROJECT_OOM_ADJ="500"
ENV_FILE="/etc/cocalc/project-host.env"
LOCAL_ENV_FILE="/etc/cocalc/project-host.local.env"
PROJECT_POOL_CGROUP_DEFAULT="__PROJECT_POOL_CGROUP__"
PROJECT_POOL_MEMORY_RESERVE_MB_DEFAULT="__PROJECT_POOL_MEMORY_RESERVE_MB__"
PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB="__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB__"
PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB="__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB__"
MIN_PROJECT_POOL_MEMORY_MB="__MIN_PROJECT_POOL_MEMORY_MB__"
PROJECT_POOL_CPU_RESERVE_CORES_DEFAULT="__PROJECT_POOL_CPU_RESERVE_CORES__"
PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES="__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES__"
PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES="__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES__"
PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR="__PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR__"
MIN_PROJECT_POOL_CPU_CORES="__MIN_PROJECT_POOL_CPU_CORES__"
PROJECT_POOL_CPU_PERIOD_US="__PROJECT_POOL_CPU_PERIOD_US__"
SYSCTL_CONFIG_PATH="/etc/sysctl.d/90-cocalc-project-host.conf"
CORE_SYSCTL_CONFIG_PATH="/etc/sysctl.d/91-cocalc-project-host-core.conf"
LEGACY_CORE_SUDOERS_CONFIG_PATH="/etc/sudoers.d/cocalc-project-host-core"
CORE_HANDLER="/usr/local/sbin/cocalc-project-host-core-handler"
CORE_ORIGINAL_PATTERN="/var/lib/cocalc/project-host-core-pattern.original"
CORE_ORIGINAL_PIPE_LIMIT="/var/lib/cocalc/project-host-core-pipe-limit.original"
CORE_PATTERN="|/usr/local/sbin/cocalc-project-host-core-handler %P %u %g %s %t %e"
HELPER_SCHEMA_VERSION="__HELPER_SCHEMA_VERSION__"

deny() {
  local code="$1"
  local detail="$2"
  echo "SECURITY_DENY code=${code} detail=${detail}" >&2
  exit 2
}

run_daemon() {
  cd /
  sudo -n -u "${RUNTIME_USER}" -H "${RUNTIME_BIN}" daemon "$@"
}

acquire_daemon_control_lock() {
  install -d -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0700 "$(dirname "${DAEMON_CONTROL_LOCK}")"
  exec 8>"${DAEMON_CONTROL_LOCK}"
  if ! flock -x -w "${DAEMON_CONTROL_LOCK_WAIT_SECONDS}" 8; then
    echo "timed out waiting for project-host daemon control lock" >&2
    exit 1
  fi
}

acquire_bootstrap_lifecycle_lock() {
  install -d -o "${BOOTSTRAP_USER}" -g "${BOOTSTRAP_USER}" -m 0700 \
    "$(dirname "${BOOTSTRAP_LIFECYCLE_LOCK}")"
  touch "${BOOTSTRAP_LIFECYCLE_LOCK}"
  chown "${BOOTSTRAP_USER}:${BOOTSTRAP_USER}" "${BOOTSTRAP_LIFECYCLE_LOCK}"
  chmod 0600 "${BOOTSTRAP_LIFECYCLE_LOCK}"
  exec 7>>"${BOOTSTRAP_LIFECYCLE_LOCK}"
  if ! flock -x -w "${BOOTSTRAP_LIFECYCLE_LOCK_WAIT_SECONDS}" 7; then
    echo "timed out waiting for bootstrap lifecycle lock" >&2
    exit 1
  fi
}

apply_project_host_sysctls() {
  rm -f \
    /etc/sysctl.d/60-cocalc-project-host-keyring.conf \
    /etc/sysctl.d/60-cocalc-project-host-inotify.conf
  cat > "${SYSCTL_CONFIG_PATH}" <<'SYSCTL'
# Managed by CoCalc project-host.
# Keep these limits high enough for many rootless project containers,
# but low enough that drift is visible before one project can dominate.
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 2097152
fs.inotify.max_queued_events = 65536
kernel.keys.maxkeys = 20000
kernel.keys.maxbytes = 25000000
# Project listeners use 30,000-59,999. Exclude those ports from ephemeral
# client allocation while preserving a large ephemeral pool around them.
net.ipv4.ip_local_port_range = 10000 65535
net.ipv4.ip_local_reserved_ports = 30000-59999
SYSCTL
  chmod 0644 "${SYSCTL_CONFIG_PATH}"
  sysctl -p "${SYSCTL_CONFIG_PATH}"
}

read_env_file_value() {
  local file="$1" key="$2"
  if [ -r "${file}" ]; then
    grep -E "^${key}=" "${file}" | tail -n1 | cut -d= -f2- || true
  fi
}

read_env_value() {
  local key="$1"
  if [ -r "${LOCAL_ENV_FILE}" ] && grep -qE "^${key}=" "${LOCAL_ENV_FILE}"; then
    read_env_file_value "${LOCAL_ENV_FILE}" "${key}"
    return
  fi
  read_env_file_value "${ENV_FILE}" "${key}"
}

env_value_is_true() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

reconcile_app_core_dumps() {
  local desired current original original_pipe_limit
  rm -f "${LEGACY_CORE_SUDOERS_CONFIG_PATH}"
  desired="$(read_env_value COCALC_PROJECT_HOST_APP_CORE_DUMPS)"
  current="$(cat /proc/sys/kernel/core_pattern 2>/dev/null || true)"
  if env_value_is_true "${desired}"; then
    if [ ! -x "${CORE_HANDLER}" ]; then
      echo "missing project-host core handler: ${CORE_HANDLER}" >&2
      return 1
    fi
    install -d -o root -g root -m 0755 "$(dirname "${CORE_ORIGINAL_PATTERN}")"
    if [ ! -e "${CORE_ORIGINAL_PATTERN}" ]; then
      printf '%s\n' "${current}" > "${CORE_ORIGINAL_PATTERN}"
      chmod 0600 "${CORE_ORIGINAL_PATTERN}"
    fi
    if [ ! -e "${CORE_ORIGINAL_PIPE_LIMIT}" ]; then
      cat /proc/sys/kernel/core_pipe_limit > "${CORE_ORIGINAL_PIPE_LIMIT}"
      chmod 0600 "${CORE_ORIGINAL_PIPE_LIMIT}"
    fi
    cat > "${CORE_SYSCTL_CONFIG_PATH}" <<SYSCTL
# Managed by CoCalc project-host. The handler accepts only the supervised app PID.
kernel.core_pattern = ${CORE_PATTERN}
kernel.core_pipe_limit = 4
SYSCTL
    chmod 0644 "${CORE_SYSCTL_CONFIG_PATH}"
    sysctl -w "kernel.core_pattern=${CORE_PATTERN}" >/dev/null
    sysctl -w kernel.core_pipe_limit=4 >/dev/null
    return
  fi
  if [ -e "${CORE_SYSCTL_CONFIG_PATH}" ] || [ "${current}" = "${CORE_PATTERN}" ]; then
    rm -f "${CORE_SYSCTL_CONFIG_PATH}"
    original="$(cat "${CORE_ORIGINAL_PATTERN}" 2>/dev/null || true)"
    if [ -n "${original}" ]; then
      sysctl -w "kernel.core_pattern=${original}" >/dev/null
    fi
    original_pipe_limit="$(cat "${CORE_ORIGINAL_PIPE_LIMIT}" 2>/dev/null || true)"
    if [[ "${original_pipe_limit}" =~ ^[0-9]+$ ]]; then
      sysctl -w "kernel.core_pipe_limit=${original_pipe_limit}" >/dev/null
    fi
    rm -f "${CORE_ORIGINAL_PATTERN}" "${CORE_ORIGINAL_PIPE_LIMIT}"
  fi
}

runtime_uid() {
  id -u "${RUNTIME_USER}"
}

runtime_gid() {
  id -g "${RUNTIME_USER}"
}

runtime_user_run_dir() {
  printf '/run/user/%s\n' "$(runtime_uid)"
}

default_podman_runtime_dir() {
  printf '/mnt/cocalc/data/tmp/cocalc-podman-runtime-%s\n' "$(runtime_uid)"
}

podman_runtime_dir() {
  local value
  value="$(read_env_value COCALC_PODMAN_RUNTIME_DIR)"
  if [ -z "${value}" ]; then
    value="$(read_env_value XDG_RUNTIME_DIR)"
  fi
  if [ -n "${value}" ]; then
    printf '%s\n' "${value}"
  else
    default_podman_runtime_dir
  fi
}

container_runtime_current() {
  local value
  value="$(read_env_value COCALC_CONTAINER_RUNTIME_CURRENT)"
  if [ -z "${value}" ]; then
    value="/opt/cocalc/container-runtime/current"
  fi
  if [ -x "${value}/bin/podman" ]; then
    printf '%s\n' "${value}"
  fi
}

run_podman_as_runtime() {
  local timeout_value="$1" runtime_dir="$2" cgroup_manager="$3"
  local container_runtime podman_bin
  local -a timeout_args=() podman_prefix=()
  shift 3
  if [ "${timeout_value}" != "0" ]; then
    timeout_args=(/usr/bin/timeout "${timeout_value}")
  fi
  # Ubuntu's unprivileged-userns restriction grants Podman access through the
  # distro AppArmor profile. Our versioned Podman binary lives under /opt, so
  # explicitly enter that profile when it is available.
  if command -v aa-exec >/dev/null 2>&1 && \
     grep -q '^podman ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    podman_prefix=(aa-exec -p podman --)
  fi
  container_runtime="$(container_runtime_current)"
  if [ -n "${container_runtime}" ]; then
    podman_bin="${container_runtime}/bin/podman"
    "${timeout_args[@]}" sudo -n -u "${RUNTIME_USER}" -H env \
      XDG_RUNTIME_DIR="${runtime_dir}" \
      COCALC_PODMAN_RUNTIME_DIR="${runtime_dir}" \
      CONTAINERS_CGROUP_MANAGER="${cgroup_manager}" \
      CONTAINERS_CONF_OVERRIDE="${container_runtime}/etc/containers/containers.conf" \
      PATH="${container_runtime}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      "${podman_prefix[@]}" "${podman_bin}" "$@"
    return
  fi
  "${timeout_args[@]}" sudo -n -u "${RUNTIME_USER}" -H env \
    XDG_RUNTIME_DIR="${runtime_dir}" \
    COCALC_PODMAN_RUNTIME_DIR="${runtime_dir}" \
    CONTAINERS_CGROUP_MANAGER="${cgroup_manager}" \
    "${podman_prefix[@]}" podman "$@"
}

ensure_owned_runtime_dir() {
  local path="$1" uid gid
  uid="$(runtime_uid)"
  gid="$(runtime_gid)"
  install -d -o "${uid}" -g "${gid}" -m 0700 "${path}"
  chown "${uid}:${gid}" "${path}"
  chmod 0700 "${path}"
}

ensure_podman_runroot() {
  local uid gid runroot
  uid="$(runtime_uid)"
  gid="$(runtime_gid)"
  install -d -o root -g root -m 0711 \
    /run/cocalc \
    /run/cocalc/containers \
    /run/cocalc/containers/rootless
  runroot="/run/cocalc/containers/rootless/${RUNTIME_USER}"
  install -d -o "${uid}" -g "${gid}" -m 0700 "${runroot}"
  chown "${uid}:${gid}" "${runroot}"
  chmod 0700 "${runroot}"
}

repair_runtime_environment() {
  local uid run_dir runtime_dir service
  uid="$(runtime_uid)"
  run_dir="/run/user/${uid}"
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "${RUNTIME_USER}" >/dev/null 2>&1 || true
  fi
  ensure_owned_runtime_dir "${run_dir}"
  if command -v systemctl >/dev/null 2>&1; then
    service="user@${uid}.service"
    systemctl reset-failed "${service}" >/dev/null 2>&1 || true
    systemctl start "${service}" >/dev/null 2>&1 || true
  fi
  ensure_owned_runtime_dir "${run_dir}"
  ensure_owned_runtime_dir "${run_dir}/containers"
  ensure_podman_runroot
  runtime_dir="$(podman_runtime_dir)"
  if [ -n "${runtime_dir}" ]; then
    ensure_owned_runtime_dir "${runtime_dir}"
  fi
}

podman_info_once() {
  local runtime_dir="$1" cgroup_manager="$2"
  run_podman_as_runtime 0 "${runtime_dir}" "${cgroup_manager}" \
    info >/dev/null
}

podman_ps_once() {
  local runtime_dir="$1" cgroup_manager="$2"
  run_podman_as_runtime 15s "${runtime_dir}" "${cgroup_manager}" \
    ps -a --format '{{.ID}}' >/dev/null
}

podman_runtime_namespace_error() {
  grep -qiE 'cannot re-exec process to join the existing user namespace|cannot join.*user namespace|failed to reexec|invalid internal status' <<< "$1"
}

project_host_app_running() {
  local pid
  pid="$(read_pid_file "${PID_FILE}")"
  [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

remove_safe_runtime_dir() {
  local path="$1" uid run_dir legacy_dir
  if [ -z "${path}" ]; then
    return 0
  fi
  uid="$(runtime_uid)"
  run_dir="/run/user/${uid}"
  legacy_dir="/mnt/cocalc/data/tmp/cocalc-podman-runtime-${uid}"
  case "${path}" in
    "${run_dir}/cocalc-podman-runtime"|${legacy_dir})
      rm -rf --one-file-system "${path}"
      ;;
    *)
      echo "refusing to remove unsafe Podman runtime dir: ${path}" >&2
      ;;
  esac
}

cleanup_podman_runtime_state() {
  local runtime_dir runroot legacy_runroot
  if project_host_app_running; then
    echo "project-host app is running; refusing to clean Podman runtime state" >&2
    return 1
  fi
  runtime_dir="$(podman_runtime_dir)"
  remove_safe_runtime_dir "${runtime_dir}"
  runroot="/run/cocalc/containers/rootless/${RUNTIME_USER}"
  if [ -e "${runroot}" ]; then
    rm -rf --one-file-system "${runroot}"
  fi
  legacy_runroot="/mnt/cocalc/data/containers/rootless/${RUNTIME_USER}/run"
  if [ -e "${legacy_runroot}" ]; then
    rm -rf --one-file-system "${legacy_runroot}"
  fi
  repair_runtime_environment
}

project_runtime_processes_active() {
  local proc comm
  for proc in /proc/[0-9]*; do
    comm="$(cat "${proc}/comm" 2>/dev/null || true)"
    case "${comm}" in
      conmon|crun|podman|podman-init|project-host:ap*|project-host:ho*)
        echo "project runtime process active: pid=${proc##*/} comm=${comm}" >&2
        return 0
        ;;
    esac
  done
  return 1
}

wait_for_project_runtime_processes_idle() {
  local active deadline
  if ! active="$(project_runtime_processes_active 2>&1)"; then
    return 0
  fi
  echo "project runtime process observed during boot preparation; waiting for transient startup work" >&2
  deadline="$((SECONDS + 30))"
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    sleep 1
    if ! active="$(project_runtime_processes_active 2>&1)"; then
      return 0
    fi
  done
  printf '%s\n' "${active}" >&2
  return 1
}

migrate_podman_database_runroot() {
  local db_path="$1" desired_runroot="$2" legacy_runroot="$3"
  if [ ! -f "${db_path}" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to migrate the Podman database runroot" >&2
    return 1
  fi
  (
    cd /tmp
    sudo -n -u "${RUNTIME_USER}" -H python3 - \
      "${db_path}" "${desired_runroot}" "${legacy_runroot}" <<'PY'
import sqlite3
import sys

db_path, desired_runroot, legacy_runroot = sys.argv[1:]
conn = sqlite3.connect(f"file:{db_path}?mode=rw", uri=True, timeout=30)
try:
    conn.execute("PRAGMA busy_timeout = 30000")
    if conn.execute("PRAGMA quick_check").fetchone() != ("ok",):
        raise RuntimeError("Podman database quick_check failed")
    conn.execute("BEGIN IMMEDIATE")
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(DBConfig)").fetchall()
    }
    if "ID" not in columns or "RunRoot" not in columns:
        raise RuntimeError("Podman DBConfig schema does not contain ID and RunRoot")
    rows = conn.execute("SELECT ID, RunRoot FROM DBConfig").fetchall()
    if len(rows) != 1 or rows[0][0] != 1:
        raise RuntimeError(f"unexpected Podman DBConfig rows: {rows!r}")
    current_runroot = rows[0][1]
    if current_runroot == desired_runroot:
        conn.commit()
    elif current_runroot == legacy_runroot:
        cursor = conn.execute(
            "UPDATE DBConfig SET RunRoot = ? WHERE ID = 1 AND RunRoot = ?",
            (desired_runroot, legacy_runroot),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("Podman DBConfig runroot update did not affect one row")
        conn.commit()
        print(
            f"migrated Podman database runroot from {legacy_runroot} "
            f"to {desired_runroot}"
        )
    else:
        raise RuntimeError(
            f"refusing unexpected Podman database runroot {current_runroot!r}"
        )
finally:
    conn.close()
PY
  )
}

require_podman_boot_preparation_not_failed() {
  if command -v systemctl >/dev/null 2>&1 && \
     systemctl is-failed --quiet cocalc-project-host-prepare.service; then
    echo "Podman boot preparation failed; refusing to start project-host" >&2
    return 1
  fi
}

prepare_podman_boot() {
  local home config_dir storage_conf desired_runroot legacy_runroot current_runroot
  local runtime_dir cgroup_manager tmp graphroot db_path reported_runroot
  local status _attempt probe_errors
  if ! mountpoint -q /mnt/cocalc; then
    echo "/mnt/cocalc is not mounted; refusing Podman boot preparation" >&2
    return 1
  fi
  if ! wait_for_project_runtime_processes_idle; then
    echo "project runtime processes are active; refusing Podman boot preparation" >&2
    return 1
  fi
  home="$(getent passwd "${RUNTIME_USER}" | cut -d: -f6)"
  if [ -z "${home}" ]; then
    echo "unable to resolve home directory for ${RUNTIME_USER}" >&2
    return 1
  fi
  config_dir="${home}/.config/containers"
  storage_conf="${config_dir}/storage.conf"
  desired_runroot="/run/cocalc/containers/rootless/${RUNTIME_USER}"
  legacy_runroot="/mnt/cocalc/data/containers/rootless/${RUNTIME_USER}/run"
  graphroot="/mnt/cocalc/data/containers/rootless/${RUNTIME_USER}/storage"
  db_path="${graphroot}/db.sql"
  current_runroot="$(sed -n 's/^[[:space:]]*runroot[[:space:]]*=[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${storage_conf}" 2>/dev/null | head -n1)"
  case "${current_runroot}" in
    ""|"${desired_runroot}"|"${legacy_runroot}")
      ;;
    *)
      echo "refusing unexpected Podman runroot migration from ${current_runroot}" >&2
      return 1
      ;;
  esac

  runtime_dir="$(podman_runtime_dir)"
  remove_safe_runtime_dir "${runtime_dir}"
  rm -rf --one-file-system "${desired_runroot}"
  rm -rf --one-file-system "${legacy_runroot}"
  repair_runtime_environment

  install -d -o "${RUNTIME_USER}" -g "${RUNTIME_USER}" -m 0700 "${config_dir}"
  tmp="$(mktemp "${config_dir}/storage.conf.tmp.XXXXXX")"
  cat > "${tmp}" <<EOF
[storage]
driver = "overlay"
runroot = "${desired_runroot}"
graphroot = "${graphroot}"
EOF
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${tmp}"
  chmod 0600 "${tmp}"
  mv -f "${tmp}" "${storage_conf}"
  rm -f /mnt/cocalc/data/containers/runroot-migration-pending

  migrate_podman_database_runroot \
    "${db_path}" "${desired_runroot}" "${legacy_runroot}"

  cgroup_manager="$(read_env_value CONTAINERS_CGROUP_MANAGER)"
  if [ -z "${cgroup_manager}" ]; then
    cgroup_manager="cgroupfs"
  fi
  run_podman_as_runtime 60s "${runtime_dir}" "${cgroup_manager}" system migrate
  # `system migrate` tears down the rootless pause process, and on Ubuntu the
  # next Podman invocation is transitioned into the unprivileged_userns
  # AppArmor profile, where re-executing /proc/self/exe is denied.  The
  # following attempt always succeeds, so retry once before giving up.
  # Keep stderr out of the captured value: a successful `podman info` may still
  # warn (rootless storage, cgroups), and merging that into stdout would corrupt
  # the runroot comparison below.
  reported_runroot=""
  status=0
  probe_errors="$(mktemp)"
  for _attempt in 1 2; do
    set +e
    reported_runroot="$(
      run_podman_as_runtime 60s "${runtime_dir}" "${cgroup_manager}" \
        info --format '{{.Store.RunRoot}}' 2>"${probe_errors}"
    )"
    status="$?"
    set -e
    if [ "${status}" -eq 0 ]; then
      break
    fi
    podman_runtime_namespace_error "$(cat "${probe_errors}")" || break
  done
  if [ "${status}" -ne 0 ]; then
    cat "${probe_errors}" >&2
    rm -f "${probe_errors}"
    return "${status}"
  fi
  rm -f "${probe_errors}"
  if [ "${reported_runroot}" != "${desired_runroot}" ]; then
    echo "Podman runroot validation failed: expected=${desired_runroot} reported=${reported_runroot}" >&2
    return 1
  fi
  podman_ps_once "${runtime_dir}" "${cgroup_manager}"
}

preflight_podman_runtime() {
  local runtime_dir cgroup_manager output status
  if [ -z "$(container_runtime_current)" ] && \
     ! command -v podman >/dev/null 2>&1; then
    echo "podman not found" >&2
    exit 1
  fi
  runtime_dir="$(podman_runtime_dir)"
  cgroup_manager="$(read_env_value CONTAINERS_CGROUP_MANAGER)"
  if [ -z "${cgroup_manager}" ]; then
    cgroup_manager="cgroupfs"
  fi
  set +e
  output="$(podman_info_once "${runtime_dir}" "${cgroup_manager}" 2>&1)"
  status="$?"
  set -e
  if [ "${status}" -eq 0 ]; then
    return 0
  fi
  if podman_runtime_namespace_error "${output}"; then
    echo "podman info failed with stale user namespace state; cleaning runtime state and retrying once" >&2
    cleanup_podman_runtime_state || true
    runtime_dir="$(podman_runtime_dir)"
    set +e
    output="$(podman_info_once "${runtime_dir}" "${cgroup_manager}" 2>&1)"
    status="$?"
    set -e
    if [ "${status}" -eq 0 ]; then
      return 0
    fi
  fi
  printf '%s\n' "${output}" >&2
  return "${status}"
}

project_pool_cgroup() {
  local value
  value="$(read_env_value COCALC_PROJECT_POOL_CGROUP)"
  if [ -n "${value}" ]; then
    printf '%s\n' "${value}"
  else
    printf '%s\n' "${PROJECT_POOL_CGROUP_DEFAULT}"
  fi
}

project_pool_memory_max_bytes() {
  local reserve_mb total_kb total_mb total_bytes reserve_bytes min_pool_bytes pool_bytes max_dynamic min_dynamic
  reserve_mb="$(read_env_value COCALC_PROJECT_POOL_MEMORY_RESERVE_MB)"
  total_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  if ! echo "${total_kb}" | grep -Eq '^[0-9]+$'; then
    printf '%s\n' "max"
    return
  fi
  total_mb="$((total_kb / 1024))"
  if [ -z "${reserve_mb}" ] || [ "${reserve_mb}" = "auto" ]; then
    min_dynamic="${PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB}"
    max_dynamic="${PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB}"
    reserve_mb="$((total_mb / 8))"
    if [ "${reserve_mb}" -lt "${min_dynamic}" ]; then
      reserve_mb="${min_dynamic}"
    fi
    if [ "${reserve_mb}" -gt "${max_dynamic}" ]; then
      reserve_mb="${max_dynamic}"
    fi
    if [ "$((total_mb - reserve_mb))" -lt "${MIN_PROJECT_POOL_MEMORY_MB}" ]; then
      reserve_mb="$((total_mb - MIN_PROJECT_POOL_MEMORY_MB))"
      if [ "${reserve_mb}" -lt 0 ]; then
        reserve_mb=0
      fi
    fi
  elif ! echo "${reserve_mb}" | grep -Eq '^[0-9]+$'; then
    reserve_mb="${PROJECT_POOL_MEMORY_RESERVE_MB_DEFAULT}"
    if [ "${reserve_mb}" = "auto" ]; then
      reserve_mb="${PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB}"
    fi
  fi
  total_bytes="$((total_kb * 1024))"
  reserve_bytes="$((reserve_mb * 1024 * 1024))"
  min_pool_bytes="$((MIN_PROJECT_POOL_MEMORY_MB * 1024 * 1024))"
  pool_bytes="$((total_bytes - reserve_bytes))"
  if [ "${pool_bytes}" -lt "${min_pool_bytes}" ]; then
    if [ "${total_bytes}" -le "${min_pool_bytes}" ]; then
      pool_bytes="${total_bytes}"
    else
      pool_bytes="${min_pool_bytes}"
    fi
  fi
  if [ "${pool_bytes}" -ge "${total_bytes}" ]; then
    printf '%s\n' "max"
    return
  fi
  printf '%s\n' "${pool_bytes}"
}

project_pool_memory_high_bytes() {
  local max_bytes="$1"
  if ! echo "${max_bytes}" | grep -Eq '^[0-9]+$'; then
    printf '%s\n' "max"
    return
  fi
  printf '%s\n' "$((max_bytes * 95 / 100))"
}

project_pool_cpu_max_value() {
  local reserve_cores cpu_count pool_cores quota
  reserve_cores="$(read_env_value COCALC_PROJECT_POOL_CPU_RESERVE_CORES)"
  cpu_count="$(nproc 2>/dev/null || true)"
  if ! echo "${cpu_count}" | grep -Eq '^[0-9]+$' || [ "${cpu_count}" -le 0 ]; then
    printf '%s\n' "max"
    return
  fi
  if [ -z "${reserve_cores}" ] || [ "${reserve_cores}" = "auto" ]; then
    reserve_cores="$((cpu_count / PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR))"
    if [ "${reserve_cores}" -lt "${PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES}" ]; then
      reserve_cores="${PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES}"
    fi
    if [ "${reserve_cores}" -gt "${PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES}" ]; then
      reserve_cores="${PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES}"
    fi
  elif ! echo "${reserve_cores}" | grep -Eq '^[0-9]+$'; then
    reserve_cores="${PROJECT_POOL_CPU_RESERVE_CORES_DEFAULT}"
    if [ "${reserve_cores}" = "auto" ]; then
      reserve_cores="${PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES}"
    fi
  fi
  if [ "${reserve_cores}" -le 0 ]; then
    printf '%s\n' "max"
    return
  fi
  pool_cores="$((cpu_count - reserve_cores))"
  if [ "${pool_cores}" -lt "${MIN_PROJECT_POOL_CPU_CORES}" ]; then
    pool_cores="${MIN_PROJECT_POOL_CPU_CORES}"
  fi
  if [ "${pool_cores}" -ge "${cpu_count}" ]; then
    printf '%s\n' "max"
    return
  fi
  quota="$((pool_cores * PROJECT_POOL_CPU_PERIOD_US))"
  printf '%s %s\n' "${quota}" "${PROJECT_POOL_CPU_PERIOD_US}"
}

enable_project_pool_controllers() {
  local parent="$1" controller
  [ -w "${parent}/cgroup.subtree_control" ] || return 0
  for controller in cpu memory pids io; do
    if grep -qw "${controller}" "${parent}/cgroup.controllers"; then
      printf '+%s\n' "${controller}" > "${parent}/cgroup.subtree_control"
    fi
  done
}

configure_project_pool_cgroup() {
  local pool legacy max_bytes high_bytes cpu_max pid attempt remaining
  pool="$(project_pool_cgroup)"
  legacy="${pool}/legacy"
  enable_project_pool_controllers /sys/fs/cgroup
  mkdir -p "${pool}"
  max_bytes="$(project_pool_memory_max_bytes)"
  high_bytes="$(project_pool_memory_high_bytes "${max_bytes}")"
  printf '%s\n' "${max_bytes}" > "${pool}/memory.max"
  printf '%s\n' "${high_bytes}" > "${pool}/memory.high"
  cpu_max="$(project_pool_cpu_max_value)"
  if [ -w "${pool}/cpu.max" ]; then
    printf '%s\n' "${cpu_max}" > "${pool}/cpu.max" || true
  fi
  mkdir -p "${legacy}"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    while IFS= read -r pid; do
      [ -n "${pid}" ] || continue
      printf '%s\n' "${pid}" > "${legacy}/cgroup.procs" || true
    done < "${pool}/cgroup.procs"
    remaining="$(cat "${pool}/cgroup.procs")"
    [ -z "${remaining}" ] && break
    sleep 0.05
  done
  if [ -n "${remaining:-}" ]; then
    echo "project pool still has internal processes: ${remaining}" >&2
    return 1
  fi
  enable_project_pool_controllers "${pool}"
}

attach_pid_to_project_pool() {
  local pid="$1" target="${2:-}"
  if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  if [ -z "${target}" ]; then
    target="$(project_pool_cgroup)/legacy"
  fi
  if ! printf '%s\n' "${pid}" > "${target}/cgroup.procs" 2>/dev/null; then
    local marker="/run/cocalc-runtime-storage-cgroup-attach-warning"
    local now last=0
    now="$(date +%s)"
    if [ -e "${marker}" ]; then
      last="$(stat -c %Y "${marker}" 2>/dev/null || echo 0)"
    fi
    if [ $((now - last)) -ge 60 ]; then
      echo "cgroup attach failed: pid=${pid} target=${target}" >&2
      touch "${marker}" 2>/dev/null || true
    fi
    return 1
  fi
  printf '%s\n' "${PROJECT_OOM_ADJ}" > "/proc/${pid}/oom_score_adj" 2>/dev/null || true
}

pid_in_project_pool() {
  local pid="$1" actual pool
  actual="$(awk -F: '$1 == "0" {print $3}' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  pool="${PROJECT_POOL_CGROUP_DEFAULT#/sys/fs/cgroup}"
  case "$actual" in
    "$pool"|"$pool"/*) return 0 ;;
    *) return 1 ;;
  esac
}

attach_pid_tree_to_project_pool() {
  local root_pid="$1" target="${2:-}" pending pid child children_file children
  if [ -z "${root_pid}" ] || ! kill -0 "${root_pid}" 2>/dev/null; then
    return 0
  fi
  pending="${root_pid}"
  while [ -n "${pending}" ]; do
    pid="${pending%% *}"
    if [ "${pending}" = "${pid}" ]; then
      pending=""
    else
      pending="${pending#* }"
    fi
    attach_pid_to_project_pool "${pid}" "${target}" || true
    children_file="/proc/${pid}/task/${pid}/children"
    children=""
    if [ -r "${children_file}" ]; then
      read -r children < "${children_file}" || true
    fi
    for child in ${children}; do
      [ -n "${child}" ] || continue
      pending="${pending:+${pending} }${child}"
    done
  done
}

attach_external_pid_tree_to_project_pool() {
  local root_pid="$1" target="$2"
  if [ -z "$root_pid" ] || ! kill -0 "$root_pid" 2>/dev/null; then
    return 0
  fi
  pid_in_project_pool "$root_pid" && return 0
  attach_pid_tree_to_project_pool "$root_pid" "$target"
}

read_pid_file() {
  local file="$1"
  if [ -r "${file}" ]; then
    tr -d '[:space:]' < "${file}" 2>/dev/null || true
  fi
}

first_running_pid() {
  local pid=""
  for file in "$@"; do
    pid="$(read_pid_file "${file}")"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      printf '%s\n' "${pid}"
      return 0
    fi
  done
  return 1
}

protect_pid() {
  local pid=""
  pid="$(first_running_pid "${PID_FILE}" "${HOST_AGENT_PID_FILE}" || true)"
  if [ -z "${pid}" ]; then
    echo "project-host pid not found at ${PID_FILE} or ${HOST_AGENT_PID_FILE}" >&2
    exit 1
  fi
  if [ -x /usr/bin/choom ]; then
    /usr/bin/choom -n "${OOM_ADJ}" -p "${pid}" >/dev/null
  else
    printf '%s\\n' "${OOM_ADJ}" > "/proc/${pid}/oom_score_adj"
  fi
}

attach_running_project_processes() {
  local runtime_dir cgroup_manager cid line project_pid conmon_pid legacy
  configure_project_pool_cgroup
  legacy="$(project_pool_cgroup)/legacy"
  runtime_dir="$(podman_runtime_dir)"
  cgroup_manager="$(read_env_value CONTAINERS_CGROUP_MANAGER)"
  if [ -z "${cgroup_manager}" ]; then
    cgroup_manager="cgroupfs"
  fi
  if [ -z "${runtime_dir}" ]; then
    return 0
  fi
  while IFS= read -r cid; do
    [ -n "${cid}" ] || continue
    line="$(
      run_podman_as_runtime 0 "${runtime_dir}" "${cgroup_manager}" \
        inspect --format '{{.State.Pid}} {{.State.ConmonPid}}' "${cid}" 2>/dev/null || true
    )"
    project_pid="$(printf '%s\n' "${line}" | awk '{print $1}')"
    conmon_pid="$(printf '%s\n' "${line}" | awk '{print $2}')"
    attach_external_pid_tree_to_project_pool "${conmon_pid}" "${legacy}" || true
    attach_external_pid_tree_to_project_pool "${project_pid}" "${legacy}" || true
  done < <(
    run_podman_as_runtime 0 "${runtime_dir}" "${cgroup_manager}" \
      ps -q 2>/dev/null || true
  )
}

forensics_pid_file() {
  case "$1" in
    project-host) printf '%s\\n' "${PID_FILE}" ;;
    conat-router) printf '%s\\n' "${CONAT_ROUTER_PID_FILE}" ;;
    conat-persist) printf '%s\\n' "${CONAT_PERSIST_PID_FILE}" ;;
    *) return 1 ;;
  esac
}

require_forensics_pid() {
  local component="$1" pid="$2" pid_file expected_pid actual_uid title
  pid_file="$(forensics_pid_file "${component}")" || deny "forensics-component-invalid" "${component}"
  expected_pid="$(read_pid_file "${pid_file}" || true)"
  if [ -z "${expected_pid}" ] || [ "${expected_pid}" != "${pid}" ]; then
    deny "forensics-pid-mismatch" "component=${component} requested=${pid} expected=${expected_pid:-missing}"
  fi
  if ! kill -0 "${pid}" 2>/dev/null; then
    deny "forensics-pid-not-running" "${pid}"
  fi
  actual_uid="$(awk '/^Uid:/ {print $2}' "/proc/${pid}/status" 2>/dev/null || true)"
  if [ "${actual_uid}" != "$(runtime_uid)" ]; then
    deny "forensics-pid-owner-mismatch" "pid=${pid} uid=${actual_uid:-missing}"
  fi
  title="$(tr '\\0' '\\n' < "/proc/${pid}/cmdline" 2>/dev/null | head -n1 || true)"
  case "${component}:${title}" in
    project-host:project-host:app|conat-router:project-host:conat-router|conat-persist:project-host:conat-persist) ;;
    *) deny "forensics-process-title-mismatch" "component=${component} title=${title:-missing}" ;;
  esac
}

prepare_forensics_root() {
  if [ "$(stat -c %u /var/lib)" != "0" ] || [ "$((8#$(stat -c %a /var/lib) & 8#022))" -ne 0 ]; then
    deny "forensics-parent-insecure" "/var/lib"
  fi
  if [ -L "${FORENSICS_ROOT}" ]; then
    deny "forensics-root-symlink" "${FORENSICS_ROOT}"
  fi
  /usr/bin/install -d -o root -g "${RUNTIME_USER}" -m 0750 "${FORENSICS_ROOT}"
  if [ "$(readlink -f "${FORENSICS_ROOT}")" != "${FORENSICS_ROOT}" ] || [ "$(stat -c %u "${FORENSICS_ROOT}")" != "0" ]; then
    deny "forensics-root-invalid" "${FORENSICS_ROOT}"
  fi
}

capture_forensics() {
  local component="$1"
  local pid="$2"
  local duration_seconds="$3"
  local capture_dir status=0 task_dir task_file tid task_count=0
  case "${component}" in
    project-host|conat-router|conat-persist)
      ;;
    *)
      echo "invalid component '${component}'" >&2
      exit 2
      ;;
  esac
  if ! echo "${pid}" | grep -Eq '^[0-9]+$' || [ "${pid}" -le 0 ]; then
    echo "invalid pid '${pid}'" >&2
    exit 2
  fi
  if ! echo "${duration_seconds}" | grep -Eq '^[0-9]+$' || [ "${duration_seconds}" -le 0 ] || [ "${duration_seconds}" -gt "${MAX_FORENSICS_DURATION_SECONDS}" ]; then
    echo "invalid duration '${duration_seconds}'" >&2
    exit 2
  fi
  require_forensics_pid "${component}" "${pid}"
  prepare_forensics_root
  capture_dir="$(mktemp -d -p "${FORENSICS_ROOT}" "${component}-pid${pid}-XXXXXXXX")"
  chmod 0700 "${capture_dir}"
  printf 'CAPTURE_DIR=%s\\n' "${capture_dir}"

  if [ -r "/proc/${pid}/cmdline" ]; then
    {
      tr '\\0' ' ' < "/proc/${pid}/cmdline"
      printf '\\n'
    } > "${capture_dir}/cmdline.txt"
  else
    printf 'ERROR: unable to read /proc/%s/cmdline\\n' "${pid}" > "${capture_dir}/cmdline.txt"
  fi
  chmod 600 "${capture_dir}/cmdline.txt" || true

  if ! cat "/proc/${pid}/stack" > "${capture_dir}/proc-stack.txt" 2>&1; then
    :
  fi
  chmod 600 "${capture_dir}/proc-stack.txt" || true

  task_dir="/proc/${pid}/task"
  {
    if [ -d "${task_dir}" ]; then
      for task_file in "${task_dir}"/*; do
        [ -e "${task_file}" ] || continue
        task_count="$((task_count + 1))"
        if [ "${task_count}" -gt 256 ]; then
          printf 'ERROR: task stack capture truncated at 256 threads\\n'
          break
        fi
        tid="$(basename "${task_file}")"
        printf '===== %s =====\\n' "${tid}"
        if ! cat "${task_file}/stack" 2>&1; then
          :
        fi
        printf '\\n'
      done
    else
      printf 'ERROR: unable to read %s\\n' "${task_dir}"
    fi
  } > "${capture_dir}/task-stacks.txt"
  chmod 600 "${capture_dir}/task-stacks.txt" || true

  ps -L -p "${pid}" -o pid,tid,pcpu,pmem,stat,wchan,comm > "${capture_dir}/ps-threads.txt" 2>&1 || true
  chmod 600 "${capture_dir}/ps-threads.txt" || true

  if command -v lsof >/dev/null 2>&1; then
    (ulimit -f "${MAX_FORENSICS_FILE_BLOCKS}"; lsof -p "${pid}") > "${capture_dir}/lsof.txt" 2>&1 || true
  else
    printf 'ERROR: lsof not installed\\n' > "${capture_dir}/lsof.txt"
  fi
  chmod 600 "${capture_dir}/lsof.txt" || true

  # Recheck immediately before ptrace to reject stale/reused pids.  Use one
  # bounded trace file instead of one unbounded file per thread.
  require_forensics_pid "${component}" "${pid}"
  set +e
  (ulimit -f "${MAX_FORENSICS_FILE_BLOCKS}"; /usr/bin/timeout "${duration_seconds}s" strace -f -ttt -T -s 256 -yy -o "${capture_dir}/strace.txt" -p "${pid}") > "${capture_dir}/strace-run.txt" 2>&1
  status="$?"
  set -e
  chmod 600 "${capture_dir}/strace-run.txt" || true
  chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${capture_dir}" >/dev/null 2>&1 || true
  exit "${status}"
}

doctor_pid_status() {
  local label="$1" file="$2" pid=""
  pid="$(read_pid_file "${file}" || true)"
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    printf '%s: running pid=%s\n' "${label}" "${pid}"
    return 0
  fi
  if [ -n "${pid}" ]; then
    printf '%s: stale pid=%s file=%s\n' "${label}" "${pid}" "${file}"
  else
    printf '%s: missing file=%s\n' "${label}" "${file}"
  fi
  return 1
}

doctor() {
  local status=0 runtime_dir cgroup_manager output
  printf 'helper_schema_version: %s\n' "${HELPER_SCHEMA_VERSION}"
  printf 'runtime_user: %s uid=%s gid=%s\n' "${RUNTIME_USER}" "$(runtime_uid)" "$(runtime_gid)"
  if mountpoint -q /mnt/cocalc; then
    printf 'mount /mnt/cocalc: mounted\n'
  else
    printf 'mount /mnt/cocalc: not-mounted\n'
    status=1
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "user@$(runtime_uid).service"; then
      printf 'user@%s.service: active\n' "$(runtime_uid)"
    else
      printf 'user@%s.service: inactive\n' "$(runtime_uid)"
      status=1
    fi
  fi
  doctor_pid_status "project-host app" "${PID_FILE}" || status=1
  doctor_pid_status "project-host host-agent" "${HOST_AGENT_PID_FILE}" || status=1
  runtime_dir="$(podman_runtime_dir)"
  cgroup_manager="$(read_env_value CONTAINERS_CGROUP_MANAGER)"
  if [ -z "${cgroup_manager}" ]; then
    cgroup_manager="cgroupfs"
  fi
  printf 'podman_runtime_dir: %s\n' "${runtime_dir}"
  if env_value_is_true "$(read_env_value COCALC_PROJECT_HOST_APP_CORE_DUMPS)"; then
    if [ "$(cat /proc/sys/kernel/core_pattern 2>/dev/null || true)" = "${CORE_PATTERN}" ]; then
      printf 'project-host app core dumps: enabled\n'
    else
      printf 'project-host app core dumps: misconfigured\n'
      status=1
    fi
  else
    printf 'project-host app core dumps: disabled\n'
  fi
  output="$(podman_info_once "${runtime_dir}" "${cgroup_manager}" 2>&1)" || {
    printf 'podman info: failed\n%s\n' "${output}"
    status=1
    return "${status}"
  }
  printf 'podman info: ok\n'
  output="$(podman_ps_once "${runtime_dir}" "${cgroup_manager}" 2>&1)" || {
    printf 'podman ps: failed\n%s\n' "${output}"
    status=1
    return "${status}"
  }
  printf 'podman ps: ok\n'
  return "${status}"
}

case "${cmd}" in
  start|ensure|restart|stop|protect|prepare-podman-boot)
    acquire_daemon_control_lock
    ;;
esac

if [ "${cmd}" = "prepare-podman-boot" ]; then
  acquire_bootstrap_lifecycle_lock
fi

case "${cmd}" in
  start|ensure)
    require_podman_boot_preparation_not_failed
    repair_runtime_environment
    preflight_podman_runtime
    reconcile_app_core_dumps
    run_daemon "${cmd}" "$@"
    protect_pid
    attach_running_project_processes || true
    ;;
  restart)
    require_podman_boot_preparation_not_failed
    repair_runtime_environment
    preflight_podman_runtime
    reconcile_app_core_dumps
    run_daemon stop "$@" || true
    run_daemon start "$@"
    protect_pid
    attach_running_project_processes || true
    ;;
  protect)
    repair_runtime_environment
    preflight_podman_runtime
    reconcile_app_core_dumps
    protect_pid
    attach_running_project_processes || true
    ;;
  capture-forensics)
    if [ "$#" -ne 3 ]; then
      echo "usage: ${0} capture-forensics <component> <pid> <duration-seconds>" >&2
      exit 2
    fi
    capture_forensics "$1" "$2" "$3"
    ;;
  apply-sysctls)
    apply_project_host_sysctls
    reconcile_app_core_dumps
    ;;
  prepare-podman-boot)
    prepare_podman_boot
    ;;
  noop)
    exit 0
    ;;
  stop)
    repair_runtime_environment
    run_daemon stop "$@"
    ;;
  status)
    repair_runtime_environment
    preflight_podman_runtime
    pid="$(first_running_pid "${PID_FILE}" "${HOST_AGENT_PID_FILE}" || true)"
    if [ -n "${pid}" ]; then
      if [ -r "${PID_FILE}" ] && [ "$(read_pid_file "${PID_FILE}")" = "${pid}" ]; then
        echo "project-host running (pid ${pid})"
      else
        echo "project-host host-agent running (pid ${pid})"
      fi
    else
      echo "project-host not running"
      exit 1
    fi
    ;;
  doctor)
    doctor
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|ensure|status|doctor|protect|capture-forensics|apply-sysctls|prepare-podman-boot|noop}" >&2
    exit 2
    ;;
esac
"""
    start_ph = start_ph.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_USER__", cfg.ssh_user)
    rootctl = rootctl.replace("__BOOTSTRAP_USER__", cfg.bootstrap_user)
    rootctl = rootctl.replace(
        "__BOOTSTRAP_LIFECYCLE_LOCK__", str(bootstrap_lock_path(cfg))
    )
    rootctl = rootctl.replace(
        "__OOM_ADJ_LITERAL__", f"--{abs(HOST_CRITICAL_OOM_SCORE_ADJ)}"
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CGROUP__", DEFAULT_PROJECT_POOL_CGROUP
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_MB__",
        str(DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB__",
        str(DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB),
    )
    rootctl = rootctl.replace(
        "__MIN_PROJECT_POOL_MEMORY_MB__",
        str(MIN_PROJECT_POOL_MEMORY_MB),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_CORES__",
        str(DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_MIN_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_MAX_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR__",
        str(DYNAMIC_PROJECT_POOL_CPU_RESERVE_DIVISOR),
    )
    rootctl = rootctl.replace(
        "__MIN_PROJECT_POOL_CPU_CORES__",
        str(MIN_PROJECT_POOL_CPU_CORES),
    )
    rootctl = rootctl.replace(
        "__PROJECT_POOL_CPU_PERIOD_US__",
        str(PROJECT_POOL_CPU_PERIOD_US),
    )
    rootctl = rootctl.replace("__HELPER_SCHEMA_VERSION__", HELPER_SCHEMA_VERSION)
    (bin_dir / "ctl").write_text(ctl, encoding="utf-8")
    (bin_dir / "start-project-host").write_text(start_ph, encoding="utf-8")
    (bin_dir / "logs").write_text(logs_script, encoding="utf-8")
    (bin_dir / "acp-status").write_text(acp_status_script, encoding="utf-8")
    (bin_dir / "acp-logs").write_text(acp_logs_script, encoding="utf-8")
    (bin_dir / "logs-cf").write_text(logs_cf_script, encoding="utf-8")
    (bin_dir / "ctl-cf").write_text(ctl_cf_script, encoding="utf-8")
    rootctl_path.parent.mkdir(parents=True, exist_ok=True)
    rootctl_path.write_text(rootctl, encoding="utf-8")
    core_handler_path.parent.mkdir(parents=True, exist_ok=True)
    core_handler_path.write_text(core_handler, encoding="utf-8")
    for name in [
        "ctl",
        "start-project-host",
        "logs",
        "acp-status",
        "acp-logs",
        "logs-cf",
        "ctl-cf",
    ]:
        (bin_dir / name).chmod(0o755)
    rootctl_path.chmod(0o755)
    core_handler_path.chmod(0o755)
    if cfg.ssh_user and cfg.ssh_user != "root":
        helper_paths = [
            bin_dir / "ctl",
            bin_dir / "start-project-host",
            bin_dir / "logs",
            bin_dir / "acp-status",
            bin_dir / "acp-logs",
            bin_dir / "logs-cf",
            bin_dir / "ctl-cf",
        ]
        chown_paths_best_effort(
            cfg,
            cfg.ssh_user,
            [bin_dir, *helper_paths],
            "chown runtime helper scripts",
        )

    bootstrap_dir = Path(cfg.bootstrap_dir)
    bootstrap_py = bootstrap_dir / "bootstrap.py"
    fetch_project_bundle = f"""#!/usr/bin/env bash
set -euo pipefail
exec python3 "{bootstrap_py}" --bootstrap-dir "{bootstrap_dir}" --only project_bundle
"""
    fetch_project_host = f"""#!/usr/bin/env bash
set -euo pipefail
exec python3 "{bootstrap_py}" --bootstrap-dir "{bootstrap_dir}" --only project_host_bundle
"""
    fetch_tools = f"""#!/usr/bin/env bash
set -euo pipefail
exec python3 "{bootstrap_py}" --bootstrap-dir "{bootstrap_dir}" --only tools_bundle
"""
    (bin_dir / "fetch-project-bundle.sh").write_text(fetch_project_bundle, encoding="utf-8")
    (bin_dir / "fetch-project-host.sh").write_text(fetch_project_host, encoding="utf-8")
    (bin_dir / "fetch-tools.sh").write_text(fetch_tools, encoding="utf-8")
    for name in ["fetch-project-bundle.sh", "fetch-project-host.sh", "fetch-tools.sh"]:
        (bin_dir / name).chmod(0o755)
    if cfg.ssh_user and cfg.ssh_user != "root":
        fetch_paths = [
            bin_dir / "fetch-project-bundle.sh",
            bin_dir / "fetch-project-host.sh",
            bin_dir / "fetch-tools.sh",
        ]
        chown_paths_best_effort(
            cfg,
            cfg.ssh_user,
            fetch_paths,
            "chown runtime fetch helpers",
        )

    admin_root = Path(cfg.bootstrap_root)
    if admin_root != runtime_root:
        admin_bin = admin_root / "bin"
        admin_bin.mkdir(parents=True, exist_ok=True)
        for name in [
            "ctl",
            "start-project-host",
            "logs",
            "acp-status",
            "acp-logs",
            "logs-cf",
            "ctl-cf",
            "fetch-project-bundle.sh",
            "fetch-project-host.sh",
            "fetch-tools.sh",
        ]:
            script = (
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f'RUNTIME_USER="{cfg.ssh_user}"\n'
                f'RUNTIME_SCRIPT="{runtime_root / "bin" / name}"\n'
                'if [ "$(id -un)" = "$RUNTIME_USER" ]; then\n'
                '  exec "$RUNTIME_SCRIPT" "$@"\n'
                "fi\n"
                "cd /\n"
                'exec sudo -n -u "$RUNTIME_USER" -H "$RUNTIME_SCRIPT" "$@"\n'
            )
            target = admin_bin / name
            target.write_text(script, encoding="utf-8")
            target.chmod(0o755)
        if cfg.bootstrap_user and cfg.bootstrap_user != "root":
            admin_paths = [
                admin_bin / "ctl",
                admin_bin / "start-project-host",
                admin_bin / "logs",
                admin_bin / "acp-status",
                admin_bin / "acp-logs",
                admin_bin / "logs-cf",
                admin_bin / "ctl-cf",
                admin_bin / "fetch-project-bundle.sh",
                admin_bin / "fetch-project-host.sh",
                admin_bin / "fetch-tools.sh",
            ]
            chown_paths_best_effort(
                cfg,
                cfg.bootstrap_user,
                [admin_bin, *admin_paths],
                "chown admin helper scripts",
            )


def configure_autostart(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring project-host autostart")
    runtime_root = project_host_runtime_root(cfg)
    rootctl = project_host_rootctl_path(cfg)
    watchdog_log = "/mnt/cocalc/data/logs/project-host-watchdog.log"
    watchdog_lock = "/mnt/cocalc/data/tmp/project-host-watchdog.lock"
    watchdog_command = (
        "mkdir -p /mnt/cocalc/data/logs /mnt/cocalc/data/tmp; "
        f"flock -n -E 0 {watchdog_lock} {runtime_root}/bin/ctl ensure "
        f">> {watchdog_log} 2>&1"
    )
    watchdog_service = f"""[Unit]
Description=CoCalc project-host watchdog
After=network-online.target
Wants=network-online.target
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart=/bin/bash -lc "{watchdog_command}"
KillMode=process
TimeoutStartSec=180
"""
    watchdog_timer = """[Unit]
Description=Run CoCalc project-host watchdog every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=15s
Persistent=true
Unit=cocalc-project-host-watchdog.service

[Install]
WantedBy=timers.target
"""
    prepare_service = f"""[Unit]
Description=Prepare CoCalc Podman runtime after boot
After=mnt-cocalc.mount
Before=cocalc-project-host-start.service podman-restart.service
Before=google-startup-scripts.service
Conflicts=podman-restart.service
RequiresMountsFor=/mnt/cocalc

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/
ExecStart={rootctl} prepare-podman-boot
TimeoutStartSec=180
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    boot_service = f"""[Unit]
Description=Start CoCalc project-host after boot
After=network-online.target cocalc-project-host-prepare.service
Wants=network-online.target
Requires=cocalc-project-host-prepare.service
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart={runtime_root}/bin/start-project-host
ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"
TimeoutStartSec=360
TimeoutStopSec=25
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    shutdown_service = f"""[Unit]
Description=Notify CoCalc before project host shutdown
After=network-online.target cocalc-project-host-start.service
Wants=network-online.target
ConditionPathIsMountPoint=/mnt/cocalc

[Service]
Type=oneshot
User={cfg.ssh_user}
Group={cfg.ssh_user}
WorkingDirectory=/
ExecStart=/bin/true
ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"
TimeoutStopSec=25
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/cocalc-project-host-watchdog.service").write_text(
        watchdog_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-watchdog.timer").write_text(
        watchdog_timer, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-prepare.service").write_text(
        prepare_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-start.service").write_text(
        boot_service, encoding="utf-8"
    )
    Path("/etc/systemd/system/cocalc-project-host-shutdown.service").write_text(
        shutdown_service, encoding="utf-8"
    )
    os.chmod("/etc/systemd/system/cocalc-project-host-watchdog.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-watchdog.timer", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-prepare.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-start.service", 0o644)
    os.chmod("/etc/systemd/system/cocalc-project-host-shutdown.service", 0o644)
    run_best_effort(cfg, ["systemctl", "daemon-reload"], "reload systemd")
    # The distribution unit manages rootful containers and races with CoCalc's
    # dedicated rootless runtime during boot. Managed hosts must never use it.
    run_best_effort(
        cfg,
        ["systemctl", "disable", "podman-restart.service"],
        "disable system Podman container restart service",
    )
    run_best_effort(
        cfg,
        ["systemctl", "mask", "podman-restart.service"],
        "mask system Podman container restart service",
    )
    run_best_effort(
        cfg,
        [
            "systemctl",
            "reset-failed",
            "podman-restart.service",
            "cocalc-project-host-prepare.service",
        ],
        "clear stale Podman boot preparation failures",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "cocalc-project-host-prepare.service"],
        "enable Podman boot preparation service",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "cocalc-project-host-start.service"],
        "enable project-host boot service",
    )
    run_best_effort(
        cfg,
        [
            "systemctl",
            "enable",
            "--now",
            "cocalc-project-host-shutdown.service",
        ],
        "enable project-host shutdown notifier",
    )
    run_best_effort(
        cfg,
        ["systemctl", "enable", "--now", "cocalc-project-host-watchdog.timer"],
        "enable project-host watchdog timer",
    )
    run_best_effort(
        cfg,
        ["rm", "-f", "/etc/cron.d/cocalc-project-host"],
        "remove legacy project-host cron watchdog",
    )


def configure_runtime_sudoers(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    log_line(cfg, f"bootstrap: configuring sudoers whitelist for {user}")
    project_host_rootctl = project_host_rootctl_path(cfg)
    rules = f"""Defaults:{user} !requiretty
Defaults:{user} secure_path=/usr/sbin:/usr/bin:/sbin:/bin
Cmnd_Alias COCALC_RUNTIME_STORAGE = /usr/local/sbin/cocalc-runtime-storage
Cmnd_Alias COCALC_RUNTIME_CLOUD = /usr/local/sbin/cocalc-cloudflared-ctl, /usr/local/sbin/cocalc-cloudflared-logs, /usr/local/sbin/cocalc-mount-data
Cmnd_Alias COCALC_RUNTIME_PROJECT_HOST = {project_host_rootctl}
{user} ALL=(root) NOPASSWD: COCALC_RUNTIME_STORAGE, COCALC_RUNTIME_CLOUD, COCALC_RUNTIME_PROJECT_HOST
"""
    path = Path("/etc/sudoers.d/cocalc-project-host-runtime")
    path.write_text(rules, encoding="utf-8")
    os.chmod(path, 0o440)
    if shutil.which("visudo"):
        run_cmd(
            cfg,
            ["visudo", "-c", "-f", str(path)],
            "validate runtime sudoers",
        )


def verify_runtime_sudoers(cfg: BootstrapConfig) -> None:
    user = cfg.ssh_user
    if not user or user == "root":
        return
    log_line(cfg, f"bootstrap: verifying sudo whitelist behavior for {user}")
    run_cmd(
        cfg,
        ["sudo", "-n", "/usr/local/sbin/cocalc-runtime-storage", "sync"],
        "runtime sudo allowlist check",
        as_user=user,
    )
    run_cmd(
        cfg,
        ["sudo", "-n", str(project_host_rootctl_path(cfg)), "noop"],
        "runtime project-host sudo allowlist check",
        as_user=user,
    )
    denied = run_cmd(
        cfg,
        ["sudo", "-n", "/bin/true"],
        "runtime sudo denylist check",
        as_user=user,
        check=False,
    )
    if denied.returncode == 0:
        raise RuntimeError(
            "runtime sudo policy too broad: non-whitelisted command /bin/true was allowed"
        )
    mount_denied = run_cmd(
        cfg,
        [
            "sudo",
            "-n",
            "/usr/local/sbin/cocalc-runtime-storage",
            "mount",
            "-t",
            "overlay",
            "overlay",
            "/mnt/cocalc/data",
        ],
        "runtime generic mount command denied check",
        as_user=user,
        check=False,
    )
    if mount_denied.returncode == 0:
        raise RuntimeError(
            "runtime storage wrapper still allows generic mount command; expected deny"
        )


def configure_critical_service_oom_protection(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: protecting host critical services from OOM kills")
    services = ["ssh.service", "sshd.service"]
    if cfg.cloudflared.enabled:
        services.append("cocalc-cloudflared.service")
    dropin_text = f"""[Service]
OOMScoreAdjust={HOST_CRITICAL_OOM_SCORE_ADJ}
"""
    for service in services:
        dropin_dir = Path("/etc/systemd/system") / f"{service}.d"
        dropin_dir.mkdir(parents=True, exist_ok=True)
        dropin_path = dropin_dir / "cocalc-oom-protect.conf"
        dropin_path.write_text(dropin_text, encoding="utf-8")
    run_best_effort(cfg, ["systemctl", "daemon-reload"], "reload systemd after OOM drop-ins")
    run_best_effort(
        cfg,
        [
            "bash",
            "-lc",
            (
                f'for pid in $(pgrep -x sshd 2>/dev/null || true); do '
                f'/usr/bin/choom -n {HOST_CRITICAL_OOM_SCORE_ADJ} -p "$pid" >/dev/null 2>&1 || '
                f'printf "%s\\n" {HOST_CRITICAL_OOM_SCORE_ADJ} >"/proc/$pid/oom_score_adj" 2>/dev/null || true; '
                "done"
            ),
        ],
        "protect sshd from OOM kills",
    )
    if cfg.cloudflared.enabled:
        run_best_effort(
            cfg,
            [
                "bash",
                "-lc",
                (
                    'pid="$(systemctl show -p MainPID --value cocalc-cloudflared.service 2>/dev/null || true)"; '
                    'if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; then '
                    f'/usr/bin/choom -n {HOST_CRITICAL_OOM_SCORE_ADJ} -p "$pid" >/dev/null 2>&1 || '
                    f'printf "%s\\n" {HOST_CRITICAL_OOM_SCORE_ADJ} >"/proc/$pid/oom_score_adj" 2>/dev/null || true; '
                    "fi"
                ),
            ],
            "protect cloudflared from OOM kills",
        )


def configure_cloudflared(cfg: BootstrapConfig) -> None:
    if not cfg.cloudflared.enabled:
        return
    configure_cloudflared_with_options(cfg, install_package=True)


def configure_cloudflared_with_options(
    cfg: BootstrapConfig, *, install_package: bool
) -> None:
    if not cfg.cloudflared.enabled:
        return
    cloudflared_missing = shutil.which("cloudflared") is None
    should_install = install_package or cloudflared_missing
    if not should_install:
        installed = run_cmd(
            cfg,
            ["/usr/bin/cloudflared", "--version"],
            "inspect cloudflared version",
            check=False,
            timeout=15,
        )
        match = re.search(r"cloudflared version\s+([^\s(]+)", installed.stdout or "")
        installed_version = match.group(1) if match else "unknown"
        should_install = installed_version != CLOUDFLARED_VERSION
        if should_install:
            log_line(
                cfg,
                f"bootstrap: upgrading cloudflared version drift installed={installed_version} expected={CLOUDFLARED_VERSION}",
            )
    service_changed = should_install
    if should_install:
        log_line(cfg, f"bootstrap: installing cloudflared {CLOUDFLARED_VERSION}")
        arch = cfg.expected_arch
        expected_sha256 = CLOUDFLARED_DEB_SHA256.get(arch)
        if not expected_sha256:
            raise RuntimeError(f"unsupported cloudflared architecture: {arch}")
        deb_name = f"cloudflared-linux-{arch}.deb"
        download_file(
            cfg,
            f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{deb_name}",
            "/tmp/cloudflared.deb",
            attempts=6,
        )
        verify_sha256(cfg, "/tmp/cloudflared.deb", expected_sha256)
        run_cmd(cfg, ["dpkg", "-i", "/tmp/cloudflared.deb"], "install cloudflared")
    else:
        log_line(cfg, "bootstrap: reconciling cloudflared config")
    cloudflared_dir = Path("/etc/cloudflared")
    cloudflared_dir.mkdir(parents=True, exist_ok=True)
    credentials_path = cloudflared_dir / f"{cfg.cloudflared.tunnel_id}.json"
    token_path = cloudflared_dir / "token"

    def read_legacy_token_env() -> str | None:
        env_path = cloudflared_dir / "token.env"
        if not env_path.exists():
            return None
        for line in env_path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "CLOUDFLARED_TOKEN":
                token = value.strip()
                return token or None
        return None

    def write_text_if_changed(path: Path, content: str) -> bool:
        existing: str | None = None
        try:
            existing = path.read_text(encoding="utf-8")
            if existing == content:
                return False
        except OSError:
            pass
        old_sha = (
            hashlib.sha256(existing.encode("utf-8")).hexdigest()[:12]
            if existing is not None
            else "missing"
        )
        new_sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]
        log_line(
            cfg,
            f"bootstrap: updating cloudflared file path={path} old_sha={old_sha} new_sha={new_sha}",
        )
        path.write_text(content, encoding="utf-8")
        return True

    token = cfg.cloudflared.token
    if cfg.cloudflared.creds_json:
        service_changed = (
            write_text_if_changed(credentials_path, cfg.cloudflared.creds_json)
            or service_changed
        )
        os.chmod(credentials_path, 0o600)
    use_credentials = credentials_path.exists()
    if not use_credentials:
        token = token or read_legacy_token_env()
        if not token:
            raise RuntimeError(
                "cloudflared enabled but no tunnel credentials JSON or token is available"
            )
        service_changed = (
            write_text_if_changed(token_path, token + "\n") or service_changed
        )
        os.chmod(token_path, 0o600)
    def yaml_quote(value: str) -> str:
        return json.dumps(value)

    ingress_lines = [
        "ingress:",
        f"  - hostname: {yaml_quote(cfg.cloudflared.hostname)}",
        f"    service: http://localhost:{cfg.cloudflared.port}",
    ]
    if (
        cfg.cloudflared.app_public_wildcard
        and cfg.cloudflared.app_public_wildcard != cfg.cloudflared.hostname
    ):
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.app_public_wildcard)}",
                f"    service: http://localhost:{cfg.cloudflared.port}",
            ]
        )
    if (
        cfg.cloudflared.exam_hostname
        and cfg.cloudflared.exam_hostname != cfg.cloudflared.hostname
    ):
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.exam_hostname)}",
                f"    service: http://localhost:{cfg.cloudflared.port}",
            ]
        )
    if cfg.cloudflared.ssh_hostname and cfg.cloudflared.ssh_port:
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.ssh_hostname)}",
                f"    service: ssh://localhost:{cfg.cloudflared.ssh_port}",
            ]
        )
    ingress_lines.append("  - service: http_status:404")
    ingress = "\n".join(ingress_lines)
    config_lines = [
        f"protocol: {cfg.cloudflared.protocol}",
        f"grace-period: {cfg.cloudflared.grace_period_seconds}s",
    ]
    if use_credentials:
        config_lines.append(f"tunnel: {cfg.cloudflared.tunnel_id}")
        config_lines.append(f"credentials-file: {credentials_path}")
    config_lines.append(ingress)
    service_changed = (
        write_text_if_changed(
            Path("/etc/cloudflared/config.yml"), "\n".join(config_lines) + "\n"
        )
        or service_changed
    )
    unit = """[Unit]
Description=Cloudflare Tunnel for CoCalc Project Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
"""
    unit += "ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run"
    if not use_credentials:
        unit += f" --token-file {token_path}"
    unit += "\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n"
    unit_changed = write_text_if_changed(
        Path("/etc/systemd/system/cocalc-cloudflared.service"), unit
    )
    recovery_dropin_dir = Path(
        "/etc/systemd/system/cocalc-cloudflared.service.d"
    )
    recovery_dropin_dir.mkdir(parents=True, exist_ok=True)
    recovery_dropin_changed = write_text_if_changed(
        recovery_dropin_dir / "cocalc-recovery.conf",
        "[Service]\nTimeoutStopSec=30\n",
    )
    service_changed = unit_changed or service_changed
    if unit_changed or recovery_dropin_changed:
        run_cmd(cfg, ["systemctl", "daemon-reload"], "daemon-reload", timeout=30)
    run_cmd(cfg, ["systemctl", "enable", "cocalc-cloudflared"], "enable cloudflared")
    active = run_cmd(
        cfg,
        ["systemctl", "is-active", "--quiet", "cocalc-cloudflared"],
        "check cloudflared status",
        check=False,
        timeout=15,
    )
    if service_changed or active.returncode != 0:
        run_cmd(
            cfg,
            ["systemctl", "restart", "cocalc-cloudflared"],
            "restart cloudflared",
            timeout=45,
        )
    else:
        log_line(cfg, "bootstrap: cloudflared config unchanged; keeping tunnel running")


def install_gpu_support(cfg: BootstrapConfig) -> None:
    if not cfg.has_gpu:
        return
    log_line(cfg, "bootstrap: installing nvidia container toolkit")
    apt_run(cfg, ["apt-get", "-y", "install", "ca-certificates", "gnupg"], "install nvidia deps", retries=3, timeout=120)
    run_best_effort(cfg, ["rm", "-f", "/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg"], "remove old nvidia keyring")
    run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | "
            "gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
        ],
        "import nvidia key",
    )
    run_cmd(
        cfg,
        [
            "bash",
            "-lc",
            "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | "
            "sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | "
            "tee /etc/apt/sources.list.d/nvidia-container-toolkit.list",
        ],
        "write nvidia repo",
    )
    apt_run(cfg, ["apt-get", "-y", "update"], "apt-get update (nvidia)", retries=3, timeout=60)
    apt_run(
        cfg,
        [
            "apt-get",
            "-y",
            "--allow-change-held-packages",
            "install",
            "nvidia-container-toolkit",
        ],
        "install nvidia-container-toolkit",
        retries=3,
        timeout=180,
    )
    run_best_effort(cfg, ["ldconfig"], "ldconfig")
    install_nvidia_cdi_normalizer()
    run_best_effort(cfg, ["nvidia-ctk", "cdi", "generate", "--output=/etc/cdi/nvidia.yaml"], "nvidia cdi generate")
    normalize_nvidia_cdi_for_podman(cfg)
    run_best_effort(cfg, ["usermod", "-aG", "video,render", cfg.ssh_user], "usermod nvidia groups")
    helper = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  exit 0
fi
if [ ! -x /usr/bin/nvidia-ctk ]; then
  exit 0
fi
if [ -f /etc/cdi/nvidia.yaml ]; then
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
  exit 0
fi
ldconfig || true
if command -v nvidia-smi >/dev/null 2>&1 || ldconfig -p 2>/dev/null | grep -q libnvidia-ml.so.1; then
  /usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml || exit 0
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
fi
exit 0
"""
    Path("/usr/local/sbin/cocalc-nvidia-cdi").write_text(helper, encoding="utf-8")
    os.chmod("/usr/local/sbin/cocalc-nvidia-cdi", 0o755)
    Path("/etc/cron.d/cocalc-nvidia-cdi").write_text(
        "*/5 * * * * root /usr/local/sbin/cocalc-nvidia-cdi >/dev/null 2>&1\n",
        encoding="utf-8",
    )
    os.chmod("/etc/cron.d/cocalc-nvidia-cdi", 0o644)


def start_project_host(cfg: BootstrapConfig) -> None:
    ctl_path = str(project_host_runtime_root(cfg) / "bin" / "ctl")
    ctl_cwd = runtime_home(cfg)
    # Sanity check: bundle must contain a compiled entrypoint.
    bundle_candidates = [
        Path(cfg.project_host_bundle.current) if cfg.project_host_bundle.current else None,
        Path(cfg.project_host_bundle.dir) if cfg.project_host_bundle.dir else None,
    ]
    bundle_candidates = [p for p in bundle_candidates if p]
    entry_candidates = [
        Path("bundle") / "index.js",
        Path("main") / "index.js",
        Path("dist") / "main.js",
    ]
    entry_found = None
    for root in bundle_candidates:
        for rel in entry_candidates:
            candidate = root / rel
            if candidate.exists():
                entry_found = candidate
                break
        if entry_found:
            break
    if not entry_found:
        roots = ", ".join(str(p) for p in bundle_candidates if p) or "unknown"
        log_line(cfg, f"bootstrap: missing project-host entrypoint (searched: bundle/index.js, main/index.js, dist/main.js) in {roots}")
        log_line(cfg, "bootstrap: project-host bundle appears incomplete; re-run bundle build/publish and re-bootstrap")
        raise RuntimeError("project-host bundle missing entrypoint")
    ensure_runtime_user_manager(cfg)
    if Path(ctl_path).exists():
        run_cmd(
            cfg,
            [ctl_path, "stop"],
            "project-host stop",
            check=False,
            as_user=cfg.ssh_user,
            cwd=ctl_cwd,
        )
    result = run_cmd(
        cfg,
        [ctl_path, "start"],
        "project-host start",
        check=False,
        as_user=cfg.ssh_user,
        cwd=ctl_cwd,
    )
    if result.returncode == 0:
        return
    output = result.stdout or ""
    if "already running" in output:
        log_line(
            cfg,
            "bootstrap: project-host reported already running after start; "
            "verifying current instance with daemon ensure",
        )
        run_cmd(
            cfg,
            [ctl_path, "ensure"],
            "project-host ensure",
            as_user=cfg.ssh_user,
            cwd=ctl_cwd,
        )
        return
    status = run_cmd(
        cfg,
        [ctl_path, "status"],
        "project-host status after failed start",
        check=False,
        as_user=cfg.ssh_user,
        cwd=ctl_cwd,
    )
    if status.returncode == 0:
        log_line(
            cfg,
            "bootstrap: project-host start failed, but status reports running; "
            "treating the daemon as healthy",
        )
        return
    raise RuntimeError(f"project-host start failed with exit code {result.returncode}")


def touch_paths(paths: list[str]) -> None:
    for path in paths:
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).touch()
        except Exception:
            pass


def run_provision(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting provision")
    report_bootstrap_status(cfg, "running", "Preparing bootstrap environment")
    record_operation_start(cfg, "provision")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        ensure_platform(cfg)
        image_size_gb = compute_image_size(cfg)
        disable_unattended(cfg)
        report_bootstrap_status(cfg, "running", "Installing Ubuntu packages")
        apt_update_install(cfg)
        configure_kernel_module_hardening(cfg)
        configure_kernel_key_limits(cfg)
        configure_inotify_limits(cfg)
        report_bootstrap_status(cfg, "running", "Configuring storage and containers")
        install_gpu_support(cfg)
        configure_chrony(cfg)
        configure_journald_limits(cfg)
        configure_rsyslog_limits(cfg)
        enable_userns(cfg)
        ensure_subuids(cfg)
        enable_linger(cfg)
        ensure_runtime_user_manager(cfg)
        prepare_dirs(cfg)
        setup_btrfs(cfg, image_size_gb)
        setup_shared_scratch(cfg)
        record_operation_success(cfg, "provision")
        log_line(cfg, "bootstrap: provision completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "provision", str(exc))
        raise


def run_reconcile(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting reconcile")
    report_bootstrap_status(cfg, "running", "Reconciling host software")
    record_operation_start(cfg, "reconcile")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        ensure_automatic_security_updates(cfg)
        configure_daily_root_cleanup(cfg)
        configure_kernel_module_hardening(cfg)
        configure_kernel_key_limits(cfg)
        configure_inotify_limits(cfg)
        configure_journald_limits(cfg)
        configure_rsyslog_limits(cfg)
        image_size_gb = compute_image_size(cfg)
        install_btrfs_helper(cfg)
        install_privileged_wrappers(cfg)
        reconcile_storage_and_containment(cfg)
        ensure_subuids(cfg)
        ensure_runtime_user_manager(cfg)
        if cfg.container_runtime_bundle is not None:
            report_bootstrap_status(
                cfg, "running", "Installing container runtime"
            )
            extract_bundle(cfg, cfg.container_runtime_bundle)
        configure_podman(cfg)
        verify_runtime_user_contract(cfg)
        write_env(cfg, image_size_gb)
        ensure_runtime_user_manager(cfg)
        configure_runtime_shell_env(cfg)
        setup_master_conat_token(cfg)
        report_bootstrap_status(cfg, "running", "Downloading CoCalc software bundles")
        extract_bundle(cfg, cfg.project_host_bundle)
        extract_bundle(cfg, cfg.project_bundle)
        tools_bundle = extract_bundle(cfg, cfg.tools_bundle)
        install_privileged_tool_binaries(cfg, tools_bundle)
        report_bootstrap_status(cfg, "running", "Installing runtime tools")
        install_node(cfg)
        configure_node_bind_service_capability(cfg)
        write_wrapper(cfg)
        write_helpers(cfg)
        configure_runtime_sudoers(cfg)
        verify_runtime_sudoers(cfg)
        configure_cloudflared_with_options(cfg, install_package=False)
        configure_critical_service_oom_protection(cfg)
        configure_autostart(cfg)
        report_bootstrap_status(cfg, "running", "Restarting project-host services")
        start_project_host(cfg)
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(cfg, "done", "Host software reconciled")
        log_line(cfg, "bootstrap: reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_reconcile_helpers(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting helper-only reconcile")
    report_bootstrap_status(cfg, "running", "Reconciling privileged host helpers")
    record_operation_start(cfg, "reconcile")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        configure_rsyslog_limits(cfg)
        configure_daily_root_cleanup(cfg)
        install_privileged_wrappers(cfg)
        install_privileged_tool_binaries(cfg)
        write_helpers(cfg)
        configure_runtime_sudoers(cfg)
        verify_runtime_sudoers(cfg)
        configure_autostart(cfg)
        reconcile_bees_runtime_policy(cfg)
        reconcile_project_network_limits(cfg)
        reconcile_project_io_policy(cfg)
        reconcile_host_service_cgroup(cfg)
        configure_cloudflared_with_options(cfg, install_package=False)
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(cfg, "done", "Privileged host helpers reconciled")
        log_line(cfg, "bootstrap: helper-only reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_reconcile_environment(cfg: BootstrapConfig) -> int:
    log_line(cfg, "bootstrap: starting environment-only reconcile")
    report_bootstrap_status(
        cfg, "running", "Reconciling managed project-host environment"
    )
    record_operation_start(cfg, "reconcile")
    try:
        ensure_runtime_user(cfg)
        ensure_bootstrap_paths(cfg)
        image_size_gb = compute_image_size(cfg)
        write_env(cfg, image_size_gb)
        write_bootstrap_state_files(cfg)
        record_operation_success(cfg, "reconcile")
        report_bootstrap_status(
            cfg, "done", "Managed project-host environment reconciled"
        )
        log_line(cfg, "bootstrap: environment-only reconcile completed successfully")
        return 0
    except Exception as exc:
        record_operation_failure(cfg, "reconcile", str(exc))
        raise


def run_bootstrap(cfg: BootstrapConfig) -> int:
    run_provision(cfg)
    run_reconcile(cfg)
    report_bootstrap_status(cfg, "running", "Starting project-host services")
    start_project_host(cfg)
    report_bootstrap_status(cfg, "running", "Finalizing bootstrap")
    touch_paths(cfg.bootstrap_done_paths)
    write_bootstrap_state_files(cfg)
    log_line(cfg, "bootstrap: completed successfully")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        nargs="?",
        default="bootstrap",
        choices=[
            "bootstrap",
            "provision",
            "reconcile",
            "helpers",
            "environment",
            "status",
        ],
    )
    parser.add_argument("--bootstrap-dir")
    parser.add_argument("--config", help=argparse.SUPPRESS)
    parser.add_argument(
        "--only",
        help="Comma-separated subset (container_runtime_bundle, project_bundle, project_host_bundle, tools_bundle, cloudflared)",
    )
    args = parser.parse_args(argv)
    bootstrap_dir = args.bootstrap_dir
    if not bootstrap_dir and args.config:
        bootstrap_dir = str(Path(args.config).resolve().parent)
    if not bootstrap_dir:
        parser.error("one of --bootstrap-dir or --config is required")
    cfg = load_config(bootstrap_dir)
    only = parse_only(args.only)
    log_line(cfg, "bootstrap: starting python bootstrap")
    log_line(cfg, f"bootstrap: user={cfg.bootstrap_user} home={cfg.bootstrap_home} root={cfg.bootstrap_root}")
    try:
        if only:
            with bootstrap_operation_lock(cfg):
                ensure_runtime_user(cfg)
                ensure_bootstrap_paths(cfg)
                write_bootstrap_state_files(cfg)
                log_line(cfg, f"bootstrap: running subset {sorted(only)}")
                if "project_host_bundle" in only:
                    extract_bundle(cfg, cfg.project_host_bundle)
                    write_wrapper(cfg)
                    write_helpers(cfg)
                if (
                    "container_runtime_bundle" in only
                    and cfg.container_runtime_bundle is not None
                ):
                    extract_bundle(cfg, cfg.container_runtime_bundle)
                if "project_bundle" in only:
                    extract_bundle(cfg, cfg.project_bundle)
                if "tools_bundle" in only:
                    tools_bundle = extract_bundle(cfg, cfg.tools_bundle)
                    install_privileged_tool_binaries(cfg, tools_bundle)
                if "cloudflared" in only:
                    configure_cloudflared_with_options(cfg, install_package=False)
                write_bootstrap_state_files(cfg)
                return 0
        if args.mode == "status":
            write_bootstrap_state_files(cfg)
            sys.stdout.write(
                json.dumps(json_load(bootstrap_state_path(cfg)), indent=2, sort_keys=True)
                + "\n"
            )
            return 0
        if args.mode == "provision":
            with bootstrap_operation_lock(cfg):
                return run_provision(cfg)
        if args.mode == "reconcile":
            with bootstrap_operation_lock(cfg):
                return run_reconcile(cfg)
        if args.mode == "helpers":
            with bootstrap_operation_lock(cfg):
                return run_reconcile_helpers(cfg)
        if args.mode == "environment":
            with bootstrap_operation_lock(cfg):
                return run_reconcile_environment(cfg)
        with bootstrap_operation_lock(cfg):
            return run_bootstrap(cfg)
    except Exception as exc:
        log_line(cfg, f"bootstrap: failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
