#!/usr/bin/env python3
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
