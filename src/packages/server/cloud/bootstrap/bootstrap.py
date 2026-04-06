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
  9) Start project-host, re-enable unattended upgrades, mark bootstrap done.
"""

from __future__ import annotations

import argparse
import grp
import hashlib
import json
import os
import pwd
import shutil
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STATE_SCHEMA_VERSION = 1
HELPER_SCHEMA_VERSION = "20260330-v1"
RUNTIME_WRAPPER_VERSION = "20260404-v6"
BOOTSTRAP_LOG_MAX_BYTES = 4 * 1024 * 1024
BUNDLE_RETENTION_COUNT = 3
ROOTLESS_SUBID_MIN_TOTAL = 4 * 1024 * 1024
ROOTLESS_SUBID_ALIGNMENT = 65536
PROJECT_HOST_RUNTIME_UID = 1002
PROJECT_HOST_RUNTIME_GID = 1003
HOST_CRITICAL_OOM_SCORE_ADJ = -900
PROJECT_HOST_RUNTIME_SUBID_RANGES = (
    (231072, ROOTLESS_SUBID_ALIGNMENT),
    (327680, ROOTLESS_SUBID_MIN_TOTAL - ROOTLESS_SUBID_ALIGNMENT),
)


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
    ssh_hostname: str | None = None
    ssh_port: int | None = None
    token: str | None = None
    tunnel_id: str | None = None
    creds_json: str | None = None


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


def load_config(bootstrap_dir: str) -> BootstrapConfig:
    facts_path = Path(bootstrap_dir) / "bootstrap-host-facts.json"
    desired_path = Path(bootstrap_dir) / "bootstrap-desired-state.json"
    facts = json_load(facts_path)
    desired = json_load(desired_path)
    _require(bool(facts), f"missing bootstrap host facts: {facts_path}")
    _require(bool(desired), f"missing bootstrap desired state: {desired_path}")
    bundle_host = desired.get("project_host_bundle") or {}
    bundle_project = desired.get("project_bundle") or {}
    bundle_tools = desired.get("tools_bundle") or {}
    cloudflared = desired.get("cloudflared") or {}
    bootstrap_meta = desired.get("bootstrap") or {}
    bootstrap_connection = desired.get("bootstrap_connection") or {}
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
            desired.get("root_reserve_gb_raw") or "15",
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
            ssh_hostname=cloudflared.get("sshHostname")
            or cloudflared.get("ssh_hostname"),
            ssh_port=cloudflared.get("sshPort") or cloudflared.get("ssh_port"),
            token=cloudflared.get("token"),
            tunnel_id=cloudflared.get("tunnelId") or cloudflared.get("tunnel_id"),
            creds_json=cloudflared.get("credsJson") or cloudflared.get("creds_json"),
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
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


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


def expected_runtime_userns_map(cfg: BootstrapConfig) -> tuple[list[str], list[str]]:
    uid_map = [f"0 {PROJECT_HOST_RUNTIME_UID} 1"]
    gid_map = [f"0 {PROJECT_HOST_RUNTIME_GID} 1"]
    inside = 1
    for start, length in PROJECT_HOST_RUNTIME_SUBID_RANGES:
        uid_map.append(f"{inside} {start} {length}")
        gid_map.append(f"{inside} {start} {length}")
        inside += length
    return uid_map, gid_map


def expected_runtime_user_contract(cfg: BootstrapConfig) -> dict[str, Any]:
    uid_map, gid_map = expected_runtime_userns_map(cfg)
    subid_ranges = [f"{start}:{length}" for start, length in PROJECT_HOST_RUNTIME_SUBID_RANGES]
    return {
        "user": cfg.ssh_user,
        "identity": f"{cfg.ssh_user}:{PROJECT_HOST_RUNTIME_UID}:{PROJECT_HOST_RUNTIME_GID}",
        "host_uid": PROJECT_HOST_RUNTIME_UID,
        "host_gid": PROJECT_HOST_RUNTIME_GID,
        "subuid_ranges": subid_ranges,
        "subgid_ranges": subid_ranges,
        "uid_map": uid_map,
        "gid_map": gid_map,
        "fingerprint": runtime_userns_map_fingerprint(uid_map, gid_map),
    }


def read_user_subid_ranges(path: Path, user: str) -> list[tuple[int, int]]:
    _raw_lines, entries = parse_subid_entries(path)
    return [(start, length) for name, start, length in entries if name == user]


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
    podman = shutil.which("podman")
    if not podman:
        return contract
    if os.geteuid() == 0 and cfg.ssh_user != "root":
        prefix = ["sudo", "-u", cfg.ssh_user, "-H"]
    else:
        prefix = []
    uid_proc = subprocess.run(
        prefix + ["bash", "-lc", f'cd "$HOME" && exec {podman} unshare cat /proc/self/uid_map'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    gid_proc = subprocess.run(
        prefix + ["bash", "-lc", f'cd "$HOME" && exec {podman} unshare cat /proc/self/gid_map'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if uid_proc.returncode == 0 and gid_proc.returncode == 0:
        uid_map = normalize_map_lines(uid_proc.stdout.splitlines())
        gid_map = normalize_map_lines(gid_proc.stdout.splitlines())
        contract["uid_map"] = uid_map
        contract["gid_map"] = gid_map
        contract["fingerprint"] = runtime_userns_map_fingerprint(uid_map, gid_map)
    return contract


def helper_schema_installed(cfg: BootstrapConfig) -> str | None:
    path = project_host_runtime_root(cfg) / "bin" / "fetch-tools.sh"
    return HELPER_SCHEMA_VERSION if path.exists() else None


def runtime_wrapper_version_installed() -> str | None:
    return (
        RUNTIME_WRAPPER_VERSION
        if Path("/usr/local/sbin/cocalc-runtime-storage").exists()
        else None
    )


def build_host_facts(cfg: BootstrapConfig) -> dict[str, Any]:
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
        "runtime_user_host_uid": PROJECT_HOST_RUNTIME_UID,
        "runtime_user_host_gid": PROJECT_HOST_RUNTIME_GID,
        "project_host_bundle_root": cfg.project_host_bundle.root,
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
    return {
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
            "port": cfg.cloudflared.port,
            "ssh_hostname": cfg.cloudflared.ssh_hostname,
            "ssh_port": cfg.cloudflared.ssh_port,
            "tunnel_id": cfg.cloudflared.tunnel_id,
        },
    }


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
    }
    return state


def write_bootstrap_state_files(cfg: BootstrapConfig) -> None:
    json_write_atomic(bootstrap_host_facts_path(cfg), build_host_facts(cfg))
    json_write_atomic(bootstrap_desired_state_path(cfg), build_desired_state(cfg))
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    json_write_atomic(bootstrap_state_path(cfg), state)


def record_operation_start(cfg: BootstrapConfig, operation: str) -> None:
    write_bootstrap_state_files(cfg)
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_started_at"] = now_iso()
    state[f"last_{operation}_result"] = "running"
    state["current_operation"] = operation
    state["last_error"] = None
    json_write_atomic(bootstrap_state_path(cfg), state)


def record_operation_success(cfg: BootstrapConfig, operation: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "success"
    state["current_operation"] = None
    state["last_error"] = None
    if operation == "provision":
        state["provisioned"] = True
    json_write_atomic(bootstrap_state_path(cfg), state)


def record_operation_failure(cfg: BootstrapConfig, operation: str, error: str) -> None:
    state = refresh_installed_state(cfg, json_load(bootstrap_state_path(cfg)))
    state[f"last_{operation}_finished_at"] = now_iso()
    state[f"last_{operation}_result"] = "error"
    state["current_operation"] = None
    state["last_error"] = error
    json_write_atomic(bootstrap_state_path(cfg), state)


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
) -> subprocess.CompletedProcess[str]:
    cmd = args
    if as_user and os.geteuid() == 0 and as_user != "root":
        cmd = ["sudo", "-u", as_user, "-H"] + args
    log_line(cfg, f"bootstrap: running {desc}: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        env=env,
    )
    if result.stdout:
        for line in result.stdout.splitlines():
            log_line(cfg, line)
    if check and result.returncode != 0:
        raise RuntimeError(f"{desc} failed with exit code {result.returncode}")
    return result


def run_best_effort(cfg: BootstrapConfig, args: list[str], desc: str) -> None:
    try:
        run_cmd(cfg, args, desc, check=False)
    except Exception as exc:
        log_line(cfg, f"bootstrap: {desc} failed (ignored): {exc}")


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
    log_line(cfg, "bootstrap: disabling unattended upgrades")
    run_best_effort(cfg, ["systemctl", "stop", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"], "stop unattended-upgrades")
    run_best_effort(cfg, ["systemctl", "stop", "apt-daily.timer", "apt-daily-upgrade.timer"], "stop apt timers")
    run_best_effort(cfg, ["pkill", "-9", "apt-get"], "kill apt-get")
    run_best_effort(cfg, ["pkill", "-f", "-9", "unattended-upgrade"], "kill unattended-upgrade")
    run_best_effort(cfg, ["apt-get", "remove", "-y", "unattended-upgrades"], "remove unattended-upgrades")


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


def apt_update_install(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: updating apt package lists")
    apt_opts = [
        "-y",
        "-o",
        "Acquire::ForceIPv4=true",
        "-o",
        "Acquire::Retries=3",
        "-o",
        "Acquire::http::Timeout=20",
        "-o",
        "Acquire::https::Timeout=20",
        "-o",
        "Acquire::ftp::Timeout=20",
    ]
    apt_run(cfg, ["apt-get", *apt_opts, "update"], "apt-get update", retries=3, timeout=30)
    log_line(cfg, "bootstrap: installing base packages")
    apt_install_opts = apt_opts + ["--no-install-recommends", "install"] + cfg.apt_packages
    apt_run(cfg, ["apt-get", *apt_install_opts], "apt-get install", retries=3, timeout=120)


def configure_chrony(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring time sync")
    run_best_effort(cfg, ["systemctl", "disable", "--now", "systemd-timesyncd"], "disable timesyncd")
    run_best_effort(cfg, ["systemctl", "enable", "--now", "chrony"], "enable chrony")
    chrony_conf = "pool pool.ntp.org iburst maxsources 4\nmakestep 1.0 -1\nrtcsync\n"
    Path("/etc/chrony/chrony.conf").write_text(chrony_conf, encoding="utf-8")
    run_best_effort(cfg, ["systemctl", "restart", "chrony"], "restart chrony")


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
    desired_uid = PROJECT_HOST_RUNTIME_UID
    desired_gid = PROJECT_HOST_RUNTIME_GID
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
        raise RuntimeError(
            "runtime userns contract mismatch; reprovision the host or reset "
            f"the {cfg.ssh_user} rootless Podman state ({'; '.join(mismatches)})"
        )


def enable_linger(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: enabling linger for {cfg.ssh_user}")
    if shutil.which("loginctl") is None:
        raise RuntimeError("loginctl not available; cannot ensure /run/user")
    run_cmd(cfg, ["loginctl", "enable-linger", cfg.ssh_user], "enable linger")


def prepare_dirs(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: preparing cocalc directories")
    for path in ["/opt/cocalc", "/var/lib/cocalc", "/etc/cocalc", "/mnt/cocalc"]:
        Path(path).mkdir(parents=True, exist_ok=True)
    run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", "/opt/cocalc", "/var/lib/cocalc"], "chown cocalc dirs")


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


def pick_data_disk(cfg: BootstrapConfig, devices: list[str]) -> str | None:
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
        if mountpoints and "/mnt/cocalc" in mountpoints:
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
        if size_bytes and size_bytes < 10 * 1024 * 1024 * 1024:
            log_line(cfg, f"bootstrap: skipping {dev} (size {size_bytes}B too small)")
            continue
        return dev
    return None


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


def update_fstab(line: str) -> None:
    fstab = Path("/etc/fstab")
    existing = fstab.read_text(encoding="utf-8") if fstab.exists() else ""
    lines = [
        l
        for l in existing.splitlines()
        if "cocalc-btrfs" not in l
        and " /btrfs " not in l
        and " /mnt/cocalc " not in l
    ]
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


def install_privileged_wrappers(cfg: BootstrapConfig) -> None:
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

deny() {
  local code="$1"
  local detail="$2"
  echo "SECURITY_DENY code=${code} detail=${detail}" >&2
  exit 2
}

allow_path() {
  local path="${1//\\\\:/:}"
  case "$path" in
    /mnt/cocalc|/mnt/cocalc/*|/dev/loop*|/var/lib/cocalc/cocalc.img|/var/lib/cocalc/btrfs.img|/opt/cocalc/project-host|/opt/cocalc/project-host/*|/opt/cocalc/project-bundles|/opt/cocalc/project-bundles/*|/opt/cocalc/tools|/opt/cocalc/tools/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

allow_overlay_mountpoint() {
  local path="${1//\\\\:/:}"
  case "$path" in
    /mnt/cocalc/data/cache/project-roots/*)
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
  case "$path" in
    /mnt/cocalc|/mnt/cocalc/*)
      ;;
    *)
      return 1
      ;;
  esac
  local base
  base="$(basename "$path")"
  if ! echo "$base" | grep -Eq '^project-[0-9a-fA-F-]{32,64}(-scratch)?$'; then
    return 1
  fi
  return 0
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
    fi
  done
}

escape_overlay_path() {
  local path="$1"
  # Escape backslash/colon/comma for overlay mount option parsing.
  # Using sed here avoids fragile nested escaping through Python -> bash.
  printf '%s' "$path" | /usr/bin/sed -e 's/[\\\\,:]/\\\\&/g'
}

case "$cmd" in
  btrfs)
    check_args "$@"
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
    check_args "$lowerdir" "$upperdir" "$workdir" "$merged"
    if ! allow_overlay_mountpoint "$merged"; then
      deny "overlay-mountpoint-not-allowed" "$merged"
    fi
    lowerdir_escaped="$(escape_overlay_path "$lowerdir")"
    upperdir_escaped="$(escape_overlay_path "$upperdir")"
    workdir_escaped="$(escape_overlay_path "$workdir")"
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
    exec /bin/mount -t overlay overlay -o "lowerdir=${lowerdir_escaped},upperdir=${upperdir_escaped},workdir=${workdir_escaped},xino=off,metacopy=on,redirect_dir=on,index=off" "$merged"
    ;;
  umount-overlay-project)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage umount-overlay-project <merged>" >&2
      exit 2
    fi
    merged="$1"
    check_args "$merged"
    if ! allow_overlay_mountpoint "$merged"; then
      deny "overlay-mountpoint-not-allowed" "$merged"
    fi
    exec /bin/umount -l "$merged"
    ;;
  losetup)
    check_args "$@"
    if command -v /usr/sbin/losetup >/dev/null 2>&1; then
      exec /usr/sbin/losetup "$@"
    fi
    exec /sbin/losetup "$@"
    ;;
  mknod)
    check_args "$@"
    exec /usr/bin/mknod "$@"
    ;;
  chown)
    check_args "$@"
    exec /bin/chown "$@"
    ;;
  chmod)
    check_args "$@"
    exec /bin/chmod "$@"
    ;;
  chattr)
    check_args "$@"
    exec /usr/bin/chattr "$@"
    ;;
  truncate)
    check_args "$@"
    exec /usr/bin/truncate "$@"
    ;;
  mkdir)
    check_args "$@"
    exec /bin/mkdir "$@"
    ;;
  mv)
    check_args "$@"
    exec /bin/mv "$@"
    ;;
  rm)
    check_args "$@"
    exec /bin/rm "$@"
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
    helper=(/opt/cocalc/project-host/bin/project-host privileged-rm-helper rm --root "$root" --path "$rel")
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
    helper=(/opt/cocalc/project-host/bin/project-host privileged-rm-helper rmdir --root "$root" --path "$rel")
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
    check_args "$src" "$dest"
    # Do not preserve hardlinks when copying from a merged overlayfs view.
    # Rsync's -H inference can misidentify unrelated files as hardlinked when
    # inode identity comes from overlayfs, which corrupts published child
    # RootFS trees.
    exec /usr/bin/rsync -aAX --numeric-ids "$src"/ "$dest"/
    ;;
  normalize-rootfs)
    if [ "$#" -ne 1 ]; then
      echo "usage: cocalc-runtime-storage normalize-rootfs <rootfs>" >&2
      exit 2
    fi
    rootfs="$1"
    check_args "$rootfs"
    if [ ! -d "$rootfs" ]; then
      deny "rootfs-not-found" "$rootfs"
    fi
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
    skip_ownership_bridge=false
    case "${COCALC_ROOTFS_SKIP_OWNERSHIP_BRIDGE:-}" in
      1|true|TRUE|yes|YES|on|ON)
        skip_ownership_bridge=true
        ;;
    esac
    ownership_source="${COCALC_ROOTFS_OWNERSHIP_SOURCE:-keep-id}"
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
    podman_user="${SUDO_USER:-}"
    if [ -z "$podman_user" ]; then
      fail "rootfs preflight failed: normalize-rootfs must be invoked via sudo from the rootless podman user" 77
    fi
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
EOF_COCALC_FIX_SETID_RUNTIME_HELPERS
)"
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
      /usr/bin/sudo -u "$podman_user" -H bash -lc "cd ~ && /usr/bin/podman unshare cat /proc/self/uid_map" >"$rewrite_uid_map_file"
      /usr/bin/sudo -u "$podman_user" -H bash -lc "cd ~ && /usr/bin/podman unshare cat /proc/self/gid_map" >"$rewrite_gid_map_file"
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
      fix_setid_runtime_helpers_escaped="$(printf '%q' "$fix_setid_runtime_helpers_script")"
      /usr/bin/sudo -u "$podman_user" -H bash -lc "
          cd ~ &&
          /usr/bin/podman run --rm --network host \
            --userns=keep-id:uid=2001,gid=2001 \
            --user 0:0 \
            --workdir / \
            -e HOME=/root \
            -e USER=root \
            -e LOGNAME=root \
            -e COCALC_RUNTIME_UID='2001' \
            -e COCALC_RUNTIME_GID='2001' \
            --security-opt label=disable \
            --rootfs '$rootfs' '$shell_path' -lc $fix_setid_runtime_helpers_escaped
        " >/dev/null
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
    check_args "$src" "$repo_profile"
    if [[ "$repo_profile" == *.toml ]]; then
      repo_profile="${repo_profile%.toml}"
    fi
    rustic_cmd=(/opt/cocalc/tools/current/rustic -P "$repo_profile")
    if ! "${rustic_cmd[@]}" repoinfo >/dev/null 2>&1; then
      if ! "${rustic_cmd[@]}" --no-progress init >/dev/null 2>&1; then
        # Another process may have initialized the repo concurrently; accept
        # that case and only fail if the repository is still unusable.
        "${rustic_cmd[@]}" repoinfo >/dev/null 2>&1
      fi
    fi
    cd "$src"
    exec "${rustic_cmd[@]}" backup --json --no-scan --host "$host_name" "$@" .
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
    check_args "$repo_profile" "$dest"
    if [[ "$repo_profile" == *.toml ]]; then
      repo_profile="${repo_profile%.toml}"
    fi
    exec /opt/cocalc/tools/current/rustic -P "$repo_profile" restore "$@" "$snapshot" "$dest"
    ;;
  project-rustic-backup)
    if [ "$#" -lt 3 ]; then
      echo "usage: cocalc-runtime-storage project-rustic-backup <src> <repo-profile> <host> [--tag <tag>]..." >&2
      exit 2
    fi
    src="$1"
    repo_profile="$2"
    host_name="$3"
    shift 3
    check_args "$src" "$repo_profile"
    case "$host_name" in
      -*)
        deny "project-rustic-backup-bad-host" "$host_name"
        ;;
    esac
    tag_args=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --tag)
          if [ "$#" -lt 2 ]; then
            deny "project-rustic-backup-bad-args" "missing-tag-value"
          fi
          tag_args+=("$1" "$2")
          shift 2
          ;;
        *)
          deny "project-rustic-backup-bad-args" "$1"
          ;;
      esac
    done
    if [[ "$repo_profile" == *.toml ]]; then
      repo_profile="${repo_profile%.toml}"
    fi
    rustic_cmd=(/opt/cocalc/tools/current/rustic -P "$repo_profile")
    if ! "${rustic_cmd[@]}" repoinfo >/dev/null 2>&1; then
      if ! "${rustic_cmd[@]}" --no-progress init >/dev/null 2>&1; then
        "${rustic_cmd[@]}" repoinfo >/dev/null 2>&1
      fi
    fi
    cd "$src"
    exec "${rustic_cmd[@]}" backup -x --json --no-scan --host "$host_name" "${tag_args[@]}" .
    ;;
  project-rustic-restore)
    if [ "$#" -ne 3 ]; then
      echo "usage: cocalc-runtime-storage project-rustic-restore <repo-profile> <snapshot> <dest>" >&2
      exit 2
    fi
    repo_profile="$1"
    snapshot="$2"
    dest="$3"
    check_args "$repo_profile" "$dest"
    case "$snapshot" in
      -*)
        deny "project-rustic-restore-bad-snapshot" "$snapshot"
        ;;
    esac
    if [[ "$repo_profile" == *.toml ]]; then
      repo_profile="${repo_profile%.toml}"
    fi
    exec /opt/cocalc/tools/current/rustic -P "$repo_profile" restore "$snapshot" "$dest"
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
  bees)
    check_args "$@"
    if [ -x /opt/cocalc/tools/current/bees ]; then
      exec /opt/cocalc/tools/current/bees "$@"
    fi
    if command -v /usr/bin/bees >/dev/null 2>&1; then
      exec /usr/bin/bees "$@"
    fi
    exec /bin/bees "$@"
    ;;
  grow-btrfs)
    if [ "$#" -gt 1 ]; then
      deny "grow-btrfs-bad-args" "too-many-arguments"
    fi
    if [ "$#" -eq 1 ] && ! echo "$1" | grep -Eq '^[0-9]+$'; then
      deny "grow-btrfs-bad-args" "non-numeric-argument"
    fi
    exec /usr/local/sbin/cocalc-grow-btrfs "$@"
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
exec /bin/journalctl -u "$service" -o cat -f -n "$lines"
"""
    wrappers = {
        "/usr/local/sbin/cocalc-runtime-storage": storage_wrapper,
        "/usr/local/sbin/cocalc-mount-data": mount_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-ctl": cloud_ctl_wrapper,
        "/usr/local/sbin/cocalc-cloudflared-logs": cloud_logs_wrapper,
    }
    for path, content in wrappers.items():
        p = Path(path)
        p.write_text(content, encoding="utf-8")
        p.chmod(0o755)


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


def configure_podman(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring podman storage")
    Path("/mnt/cocalc/data/containers/root/storage").mkdir(parents=True, exist_ok=True)
    Path("/mnt/cocalc/data/containers/root/run").mkdir(parents=True, exist_ok=True)
    Path("/etc/containers").mkdir(parents=True, exist_ok=True)
    Path("/etc/containers/storage.conf").write_text(
        '[storage]\n'
        'driver = "overlay"\n'
        'runroot = "/mnt/cocalc/data/containers/root/run"\n'
        'graphroot = "/mnt/cocalc/data/containers/root/storage"\n',
        encoding="utf-8",
    )
    if cfg.ssh_user != "root":
        user_config_root = Path(runtime_home(cfg)) / ".config"
        user_config = user_config_root / "containers"
        rootless_root = Path(f"/mnt/cocalc/data/containers/rootless/{cfg.ssh_user}")
        rootless_storage = rootless_root / "storage"
        rootless_run = rootless_root / "run"
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
                str(rootless_root),
                str(rootless_storage),
                str(rootless_run),
            ],
            "chown rootless podman paths",
        )
        (user_config / "storage.conf").write_text(
            '[storage]\n'
            'driver = "overlay"\n'
            f'runroot = "{rootless_run}"\n'
            f'graphroot = "{rootless_storage}"\n',
            encoding="utf-8",
        )
        run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", str(user_config / "storage.conf")], "chown storage.conf")


def write_env(cfg: BootstrapConfig, image_size_gb: int) -> None:
    log_line(cfg, f"bootstrap: writing project-host env to {cfg.env_file}")
    substitute_public_ip(cfg)
    Path(cfg.env_file).parent.mkdir(parents=True, exist_ok=True)
    Path(cfg.env_file).write_text("\n".join(cfg.env_lines) + "\n", encoding="utf-8")
    uid = pwd.getpwnam(cfg.ssh_user).pw_uid if cfg.ssh_user else None
    if uid is not None:
        runtime_dir = f"/mnt/cocalc/data/tmp/cocalc-podman-runtime-{uid}"
        Path(runtime_dir).mkdir(parents=True, exist_ok=True)
        run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", runtime_dir], "chown runtime dir")
        upsert_env(cfg.env_file, "COCALC_PODMAN_RUNTIME_DIR", runtime_dir)
    upsert_env(cfg.env_file, "COCALC_BTRFS_ROOT_RESERVE_GB", str(compute_root_reserve_gb(cfg)))
    if cfg.image_size_gb_raw == "auto":
        upsert_env(cfg.env_file, "COCALC_BTRFS_IMAGE_AUTO", "1")
        upsert_env(cfg.env_file, "COCALC_BTRFS_IMAGE_GB", str(image_size_gb))
    else:
        upsert_env(cfg.env_file, "COCALC_BTRFS_IMAGE_AUTO", "0")


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
            runtime_dir = f"/mnt/cocalc/data/tmp/cocalc-podman-runtime-{uid}"
    if not runtime_dir:
        return []
    return [
        f'export XDG_RUNTIME_DIR="{runtime_dir}"',
        f'export COCALC_PODMAN_RUNTIME_DIR="{runtime_dir}"',
        'export CONTAINERS_CGROUP_MANAGER="cgroupfs"',
    ]


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
    lines = []
    found = False
    if Path(path).exists():
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}")
    Path(path).write_text("\n".join(new_lines) + "\n", encoding="utf-8")


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


def download_file(cfg: BootstrapConfig, url: str, dest: str) -> None:
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
    try:
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, context=context) as resp:
            data = resp.read()
        Path(dest).write_bytes(data)
        return
    except Exception as err:
        log_line(cfg, f"bootstrap: download failed via urllib ({err}); trying curl")
    if shutil.which("curl") is None:
        raise RuntimeError("curl not available for download fallback")
    run_cmd(cfg, ["curl", "-fsSL", "-o", dest, url], f"download {url} via curl")


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


def install_node(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: installing node via nvm")
    nvm_dir = f"{runtime_home(cfg)}/.nvm"
    install_cmd = (
        f'export NVM_DIR="{nvm_dir}"; '
        f'if [ ! -s "$NVM_DIR/nvm.sh" ]; then '
        f'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash; '
        f'fi; '
        f'. "$NVM_DIR/nvm.sh"; '
        f'nvm install {cfg.node_version}; '
        f'nvm alias default {cfg.node_version}'
    )
    run_cmd(cfg, ["bash", "-lc", install_cmd], "install node", as_user=cfg.ssh_user)


def write_wrapper(cfg: BootstrapConfig) -> None:
    host_dir = project_host_runtime_root(cfg)
    bin_dir = host_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    bundle_root = cfg.project_host_bundle.current
    if not bundle_root:
        bundle_root = str(host_dir / "bundles" / "current")
    bundle_entry = f"{bundle_root}/bundle/index.js"
    runtime_home_dir = runtime_home(cfg)
    node_bin = f"{runtime_home_dir}/.nvm/versions/node/v{cfg.node_version}/bin/node"
    wrapper = f"""#!/usr/bin/env bash
set -euo pipefail
RUNTIME_HOME="{runtime_home_dir}"
export NVM_DIR="$RUNTIME_HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "{node_bin}" ]; then
  NODE_BIN="{node_bin}"
else
  echo "node not found for project-host wrapper (looked in PATH and {node_bin})" >&2
  exit 127
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
    ctl = """#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
shift || true
RUNTIME_ROOT="__RUNTIME_ROOT__"
bin="$RUNTIME_ROOT/bin/project-host"
pid_file="/mnt/cocalc/data/daemon.pid"
rootctl="__ROOTCTL__"
case "${cmd}" in
  start|ensure|restart)
    exec sudo -n "${rootctl}" "${cmd}" "$@"
    ;;
  stop)
    "${bin}" daemon stop "$@"
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
  *)
    echo "usage: ${0} {start|stop|restart|ensure|status}" >&2
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
exec sudo -n /usr/local/sbin/cocalc-cloudflared-logs 200
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
    rootctl = """#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-project-host-rootctl must run as root" >&2
  exit 1
fi
cmd="${1:-ensure}"
shift || true
RUNTIME_ROOT="__RUNTIME_ROOT__"
RUNTIME_USER="__RUNTIME_USER__"
RUNTIME_BIN="$RUNTIME_ROOT/bin/project-host"
PID_FILE="/mnt/cocalc/data/daemon.pid"
OOM_ADJ="${COCALC_PROJECT_HOST_OOM_SCORE_ADJ:__OOM_ADJ__}"

run_daemon() {
  sudo -n -u "${RUNTIME_USER}" -H "${RUNTIME_BIN}" daemon "$@"
}

protect_pid() {
  local pid=""
  if [ -r "${PID_FILE}" ]; then
    pid="$(tr -d '[:space:]' < "${PID_FILE}" 2>/dev/null || true)"
  fi
  if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
    echo "project-host pid not found at ${PID_FILE}" >&2
    exit 1
  fi
  if [ -x /usr/bin/choom ]; then
    /usr/bin/choom -n "${OOM_ADJ}" -p "${pid}" >/dev/null
  else
    printf '%s\\n' "${OOM_ADJ}" > "/proc/${pid}/oom_score_adj"
  fi
}

case "${cmd}" in
  start|ensure)
    run_daemon "${cmd}" "$@"
    protect_pid
    ;;
  restart)
    run_daemon stop "$@" || true
    run_daemon start "$@"
    protect_pid
    ;;
  protect)
    protect_pid
    ;;
  noop)
    exit 0
    ;;
  stop)
    run_daemon stop "$@"
    ;;
  status)
    pid=""
    if [ -r "${PID_FILE}" ]; then
      pid="$(tr -d '[:space:]' < "${PID_FILE}" 2>/dev/null || true)"
    fi
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "project-host running (pid ${pid})"
    else
      echo "project-host not running"
      exit 1
    fi
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|ensure|status|protect|noop}" >&2
    exit 2
    ;;
esac
"""
    start_ph = start_ph.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_ROOT__", str(runtime_root))
    rootctl = rootctl.replace("__RUNTIME_USER__", cfg.ssh_user)
    rootctl = rootctl.replace("__OOM_ADJ__", str(HOST_CRITICAL_OOM_SCORE_ADJ))
    (bin_dir / "ctl").write_text(ctl, encoding="utf-8")
    (bin_dir / "start-project-host").write_text(start_ph, encoding="utf-8")
    (bin_dir / "logs").write_text(logs_script, encoding="utf-8")
    (bin_dir / "acp-status").write_text(acp_status_script, encoding="utf-8")
    (bin_dir / "acp-logs").write_text(acp_logs_script, encoding="utf-8")
    (bin_dir / "logs-cf").write_text(logs_cf_script, encoding="utf-8")
    (bin_dir / "ctl-cf").write_text(ctl_cf_script, encoding="utf-8")
    rootctl_path.parent.mkdir(parents=True, exist_ok=True)
    rootctl_path.write_text(rootctl, encoding="utf-8")
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
    watchdog_log = "/mnt/cocalc/data/logs/project-host-watchdog.log"
    cron_lines = [
        f"@reboot {cfg.ssh_user} /bin/bash -lc '{runtime_root}/bin/start-project-host'",
        (
            f"* * * * * {cfg.ssh_user} /bin/bash -lc "
            f"'if mountpoint -q /mnt/cocalc; then mkdir -p /mnt/cocalc/data/logs; "
            f"{runtime_root}/bin/ctl ensure >> {watchdog_log} 2>&1; fi'"
        ),
    ]
    Path("/etc/cron.d/cocalc-project-host").write_text(
        "\n".join(cron_lines) + "\n", encoding="utf-8"
    )
    os.chmod("/etc/cron.d/cocalc-project-host", 0o644)
    run_best_effort(cfg, ["systemctl", "enable", "--now", "cron"], "enable cron")


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
    if install_package or cloudflared_missing:
        log_line(cfg, "bootstrap: installing cloudflared")
        arch = cfg.expected_arch
        deb_name = f"cloudflared-linux-{arch}.deb"
        run_cmd(
            cfg,
            [
                "curl",
                "-fsSL",
                "-o",
                "/tmp/cloudflared.deb",
                f"https://github.com/cloudflare/cloudflared/releases/latest/download/{deb_name}",
            ],
            "download cloudflared",
        )
        run_cmd(cfg, ["dpkg", "-i", "/tmp/cloudflared.deb"], "install cloudflared")
    else:
        log_line(cfg, "bootstrap: reconciling cloudflared config")
    Path("/etc/cloudflared").mkdir(parents=True, exist_ok=True)
    if cfg.cloudflared.token:
        Path("/etc/cloudflared/token.env").write_text(f"CLOUDFLARED_TOKEN={cfg.cloudflared.token}\n", encoding="utf-8")
        os.chmod("/etc/cloudflared/token.env", 0o600)
    if cfg.cloudflared.creds_json:
        Path(f"/etc/cloudflared/{cfg.cloudflared.tunnel_id}.json").write_text(cfg.cloudflared.creds_json, encoding="utf-8")
        os.chmod(f"/etc/cloudflared/{cfg.cloudflared.tunnel_id}.json", 0o600)
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
    if cfg.cloudflared.ssh_hostname and cfg.cloudflared.ssh_port:
        ingress_lines.extend(
            [
                f"  - hostname: {yaml_quote(cfg.cloudflared.ssh_hostname)}",
                f"    service: ssh://localhost:{cfg.cloudflared.ssh_port}",
            ]
        )
    ingress_lines.append("  - service: http_status:404")
    ingress = "\n".join(ingress_lines)
    config_lines = []
    if not cfg.cloudflared.token:
        config_lines.append(f"tunnel: {cfg.cloudflared.tunnel_id}")
        config_lines.append(f"credentials-file: /etc/cloudflared/{cfg.cloudflared.tunnel_id}.json")
    config_lines.append(ingress)
    Path("/etc/cloudflared/config.yml").write_text("\n".join(config_lines) + "\n", encoding="utf-8")
    unit = """[Unit]
Description=Cloudflare Tunnel for CoCalc Project Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
"""
    if cfg.cloudflared.token:
        unit += "EnvironmentFile=/etc/cloudflared/token.env\n"
    unit += "ExecStart=/usr/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run"
    if cfg.cloudflared.token:
        unit += " --token $CLOUDFLARED_TOKEN"
    unit += "\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n"
    Path("/etc/systemd/system/cocalc-cloudflared.service").write_text(unit, encoding="utf-8")
    run_cmd(cfg, ["systemctl", "daemon-reload"], "daemon-reload")
    run_cmd(cfg, ["systemctl", "enable", "cocalc-cloudflared"], "enable cloudflared")
    run_cmd(cfg, ["systemctl", "restart", "cocalc-cloudflared"], "restart cloudflared")


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
        ["apt-get", "-y", "install", "nvidia-container-toolkit"],
        "install nvidia-container-toolkit",
        retries=3,
        timeout=180,
    )
    run_best_effort(cfg, ["ldconfig"], "ldconfig")
    run_best_effort(cfg, ["nvidia-ctk", "cdi", "generate", "--output=/etc/cdi/nvidia.yaml"], "nvidia cdi generate")
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
  exit 0
fi
ldconfig || true
if command -v nvidia-smi >/dev/null 2>&1 || ldconfig -p 2>/dev/null | grep -q libnvidia-ml.so.1; then
  /usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml || exit 0
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
    if Path(ctl_path).exists():
        run_cmd(cfg, [ctl_path, "stop"], "project-host stop", check=False, as_user=cfg.ssh_user)
    result = run_cmd(
        cfg,
        [ctl_path, "start"],
        "project-host start",
        check=False,
        as_user=cfg.ssh_user,
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
        )
        return
    raise RuntimeError(f"project-host start failed with exit code {result.returncode}")


def reenable_unattended(cfg: BootstrapConfig) -> None:
    run_best_effort(cfg, ["apt-get", "install", "-y", "unattended-upgrades"], "install unattended-upgrades")
    run_best_effort(cfg, ["systemctl", "enable", "--now", "apt-daily.timer", "apt-daily-upgrade.timer", "unattended-upgrades.service"], "enable unattended-upgrades")


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
        report_bootstrap_status(cfg, "running", "Configuring storage and containers")
        install_gpu_support(cfg)
        configure_chrony(cfg)
        enable_userns(cfg)
        ensure_subuids(cfg)
        enable_linger(cfg)
        prepare_dirs(cfg)
        setup_btrfs(cfg, image_size_gb)
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
        image_size_gb = compute_image_size(cfg)
        install_btrfs_helper(cfg)
        install_privileged_wrappers(cfg)
        ensure_cocalc_mount(cfg)
        ensure_btrfs_data(cfg)
        ensure_subuids(cfg)
        configure_podman(cfg)
        verify_runtime_user_contract(cfg)
        write_env(cfg, image_size_gb)
        configure_runtime_shell_env(cfg)
        setup_master_conat_token(cfg)
        report_bootstrap_status(cfg, "running", "Downloading CoCalc software bundles")
        extract_bundle(cfg, cfg.project_host_bundle)
        extract_bundle(cfg, cfg.project_bundle)
        extract_bundle(cfg, cfg.tools_bundle)
        report_bootstrap_status(cfg, "running", "Installing runtime tools")
        install_node(cfg)
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


def run_bootstrap(cfg: BootstrapConfig) -> int:
    run_provision(cfg)
    run_reconcile(cfg)
    report_bootstrap_status(cfg, "running", "Starting project-host services")
    start_project_host(cfg)
    report_bootstrap_status(cfg, "running", "Finalizing bootstrap")
    reenable_unattended(cfg)
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
        choices=["bootstrap", "provision", "reconcile", "status"],
    )
    parser.add_argument("--bootstrap-dir")
    parser.add_argument("--config", help=argparse.SUPPRESS)
    parser.add_argument(
        "--only",
        help="Comma-separated subset (project_bundle, project_host_bundle, tools_bundle, cloudflared)",
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
            ensure_runtime_user(cfg)
            ensure_bootstrap_paths(cfg)
            write_bootstrap_state_files(cfg)
            log_line(cfg, f"bootstrap: running subset {sorted(only)}")
            if "project_host_bundle" in only:
                extract_bundle(cfg, cfg.project_host_bundle)
                write_wrapper(cfg)
                write_helpers(cfg)
            if "project_bundle" in only:
                extract_bundle(cfg, cfg.project_bundle)
            if "tools_bundle" in only:
                extract_bundle(cfg, cfg.tools_bundle)
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
            return run_provision(cfg)
        if args.mode == "reconcile":
            return run_reconcile(cfg)
        return run_bootstrap(cfg)
    except Exception as exc:
        log_line(cfg, f"bootstrap: failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
