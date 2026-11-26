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
  7) Install Node (root-owned, /opt/cocalc/node), write wrapper + helper scripts.
  8) Optional cloudflared setup, GPU setup, and autostart cron.
  9) Start project-host, enable managed security updates, mark bootstrap done.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import grp
import hashlib
import json
import os
import posixpath
import pwd
import re
import shlex
import signal
import shutil
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any, Callable

STATE_SCHEMA_VERSION = 1
HELPER_SCHEMA_VERSION = "20261120-r24"
HOST_INTRUSION_SNAPSHOT_HELPER = r'''
@@bootstrap-include embedded/host-intrusion-snapshot.py@@
'''
RUNTIME_WRAPPER_VERSION = "20260926-v19"
BOOTSTRAP_LIFECYCLE_EXPORT_DIR = Path("/var/lib/cocalc/bootstrap-lifecycle")
NVM_VERSION = "0.40.4"
# Node for the project-host services: installed and owned by root, so the
# runtime user (which the services run as) can't modify the program it runs
# or the node runtime mounted into projects.
NODE_ROOT = Path("/opt/cocalc/node")
NODE_DIST_URL = "https://nodejs.org/dist"
NODE_KEEP_VERSIONS = 3
# Compatibility libraries mounted into projects next to node (root-owned;
# project-runner uses them when current, see prepareNodeRuntimeCompatLibs).
NODE_RUNTIME_LIBS_ROOT = Path("/opt/cocalc/runtime-libs")
HOST_LIBATOMIC_CANDIDATES = (
    "/lib/x86_64-linux-gnu/libatomic.so.1",
    "/usr/lib/x86_64-linux-gnu/libatomic.so.1",
    "/lib/aarch64-linux-gnu/libatomic.so.1",
    "/usr/lib/aarch64-linux-gnu/libatomic.so.1",
    "/lib64/libatomic.so.1",
    "/usr/lib64/libatomic.so.1",
)
CLOUDFLARED_VERSION = "2026.10.3"
CLOUDFLARED_DEB_SHA256 = {
    "amd64": "297d906a8fef396ec888b51571e783d594bde280f3b44d63e8fa343ef2c4cc4e",
    "arm64": "9382c5406c5cb64821114360550b8903c600b20052e9e82359acf343834be2b7",
}
BOOTSTRAP_LOG_MAX_BYTES = 4 * 1024 * 1024
BUNDLE_RETENTION_COUNT = 3
BUNDLE_REFERENCE_SCAN_SECONDS = 10
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
# Host uids for project containers that run with a separate runtime uid
# (project_runtime_uid_mode "separate"). The block is appended after the
# container ranges, so their rootless inner ids don't move, and it sits far
# above the ranges useradd allocates (SUB_UID_MAX/SUB_GID_MAX are pinned below
# it). The first uid is the shared project runtime uid.
PROJECT_RUNTIME_UID_BLOCK = (1 << 30, 65536)
PROJECT_RUNTIME_SEPARATE_UID = PROJECT_RUNTIME_UID_BLOCK[0]
PROJECT_RUNTIME_UID_MODES = ("keep-id", "separate")
LOGIN_DEFS_PATH = Path("/etc/login.defs")
APT_RETRIES = 5
APT_ACQUIRE_TIMEOUT_S = 60
APT_LOCK_TIMEOUT_S = 120
APT_UPDATE_TIMEOUT_S = 180
APT_INSTALL_TIMEOUT_S = 600
RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S = 10
RUNTIME_TREE_REMOVE_TIMEOUT_S = 120
APPARMOR_PROFILE_PROBE_TIMEOUT_S = 2
PODMAN_STALE_BOOT_ERROR_PATTERNS = (
    re.compile(r"current system boot ID differs from cached boot ID", re.IGNORECASE),
    re.compile(
        r"cannot re-exec process to join the existing user namespace", re.IGNORECASE
    ),
    re.compile(r"cannot join.*user namespace", re.IGNORECASE),
    # setns into the namespace of a stale pause.pid that names a reused PID.
    re.compile(r"cannot set user namespace(?! mode)", re.IGNORECASE),
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
DATA_ROOT = "/mnt/cocalc/data"
# The bay's startup script keeps bootstrap state (this script, host facts, the
# desired state with the bootstrap token, the log) in this root-only directory
# and trusts only root-owned markers to skip first boot. Older scripts kept it
# in DATA_ROOT/.host-bootstrap, which the runtime user can rename.
BOOTSTRAP_STATE_ROOT = "/var/lib/cocalc-host-bootstrap"
OLD_BOOTSTRAP_STATE_NAME = ".host-bootstrap"
FINGERPRINT_MAX_FILE_BYTES = 1 << 20
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
HOST_OWNED_SQLITE_RE = re.compile(
    r"^(sqlite\.db|sync-fs\.sqlite|sync-fs-snapshots\.sqlite)(?:-(?:wal|shm))?$"
)
ENV_ASSIGNMENT_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PROJECT_IO_POLICY_HELPER = r'''
@@bootstrap-include embedded/project-io-policy.py@@
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
    # Used only when the desired version is neither installed nor downloadable
    # (the server keeps a desired version the store no longer serves when the
    # host reported it as installed, but that report can be stale).
    fallback_manifest_url: str | None = None


COCALC_INSTALL_ROOT = Path("/opt/cocalc")
COCALC_INSTALL_OWNER = (0, 0)
# Root keeps its state here and mounts the loop image from here by name.
COCALC_STATE_ROOT = Path("/var/lib/cocalc")


@dataclass(frozen=True)
class CloudflaredSpec:
    enabled: bool
    hostname: str | None = None
    port: int | None = None
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
    # "keep-id" (today) or "separate": whether the host's subuid allocation
    # includes PROJECT_RUNTIME_UID_BLOCK. Nothing runs projects with it yet.
    project_runtime_uid_mode: str = "keep-id"
    # Standalone (CoCalc Star) hosts only: run without the per-project network
    # policy when the kernel cannot express it, instead of refusing projects.
    allow_unenforceable_project_network: bool = False


@dataclass(frozen=True)
class PrivilegedWrapperConfig:
    """Minimal configuration needed outside managed cloud-host bootstrap."""

    ssh_user: str
    project_io_capacity: dict[str, Any]
    project_io_policy: dict[str, Any]
    container_runtime_bundle: BundleSpec | None = None
    allow_loopback_rustic_rest: bool = False
    # Standalone (CoCalc Star) hosts only: run without the per-project network
    # policy when the kernel cannot express it, instead of refusing projects.
    allow_unenforceable_project_network: bool = False


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
        allow_unenforceable_project_network=True,
    )


