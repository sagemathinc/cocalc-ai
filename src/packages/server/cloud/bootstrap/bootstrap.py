#!/usr/bin/env python3
"""Python-first project-host bootstrap.

This script replaces the legacy monolithic shell bootstrap. It is stdlib-only
and driven by a JSON config written by bootstrap-host.ts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BundleSpec:
    url: str
    sha256: str | None
    remote: str
    root: str
    dir: str
    current: str
    version: str | None = None


@dataclass(frozen=True)
class CloudflaredSpec:
    enabled: bool
    hostname: str | None = None
    port: int | None = None
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
    data_disk_devices: str
    data_disk_candidates: str
    apt_packages: list[str]
    has_gpu: bool
    ssh_user: str
    env_file: str
    env_lines: list[str]
    node_version: str
    project_host_bundle: BundleSpec
    project_bundle: BundleSpec
    tools_bundle: BundleSpec
    cloudflared: CloudflaredSpec
    conat_url: str | None
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


def load_config(path: str) -> BootstrapConfig:
    with open(path, "r", encoding="utf-8") as handle:
        raw: dict[str, Any] = json.load(handle)
    bundle_host = raw.get("project_host_bundle") or {}
    bundle_project = raw.get("project_bundle") or {}
    bundle_tools = raw.get("tools_bundle") or {}
    cloudflared = raw.get("cloudflared") or {}
    return BootstrapConfig(
        bootstrap_user=_ensure_str(raw.get("bootstrap_user"), "bootstrap_user"),
        bootstrap_home=_ensure_str(raw.get("bootstrap_home"), "bootstrap_home"),
        bootstrap_root=_ensure_str(raw.get("bootstrap_root"), "bootstrap_root"),
        bootstrap_dir=_ensure_str(raw.get("bootstrap_dir"), "bootstrap_dir"),
        bootstrap_tmp=_ensure_str(raw.get("bootstrap_tmp"), "bootstrap_tmp"),
        log_file=_ensure_str(raw.get("log_file"), "log_file"),
        expected_os=_ensure_str(raw.get("expected_os"), "expected_os"),
        expected_arch=_ensure_str(raw.get("expected_arch"), "expected_arch"),
        image_size_gb_raw=_ensure_str(raw.get("image_size_gb_raw"), "image_size_gb_raw"),
        data_disk_devices=_ensure_str(
            raw.get("data_disk_devices") or "", "data_disk_devices"
        ),
        data_disk_candidates=_ensure_str(
            raw.get("data_disk_candidates") or "", "data_disk_candidates"
        ),
        apt_packages=[str(p) for p in _ensure_list(raw.get("apt_packages"), "apt_packages")],
        has_gpu=_ensure_bool(raw.get("has_gpu"), "has_gpu"),
        ssh_user=_ensure_str(raw.get("ssh_user"), "ssh_user"),
        env_file=_ensure_str(raw.get("env_file"), "env_file"),
        env_lines=[str(line) for line in _ensure_list(raw.get("env_lines"), "env_lines")],
        node_version=_ensure_str(raw.get("node_version"), "node_version"),
        project_host_bundle=BundleSpec(
            url=_ensure_str(bundle_host.get("url"), "project_host_bundle.url"),
            sha256=bundle_host.get("sha256") or None,
            remote=_ensure_str(bundle_host.get("remote"), "project_host_bundle.remote"),
            root=_ensure_str(bundle_host.get("root"), "project_host_bundle.root"),
            dir=_ensure_str(bundle_host.get("dir"), "project_host_bundle.dir"),
            current=_ensure_str(bundle_host.get("current"), "project_host_bundle.current"),
            version=bundle_host.get("version"),
        ),
        project_bundle=BundleSpec(
            url=_ensure_str(bundle_project.get("url"), "project_bundle.url"),
            sha256=bundle_project.get("sha256") or None,
            remote=_ensure_str(bundle_project.get("remote"), "project_bundle.remote"),
            root=_ensure_str(bundle_project.get("root"), "project_bundle.root"),
            dir=_ensure_str(bundle_project.get("dir"), "project_bundle.dir"),
            current=_ensure_str(bundle_project.get("current"), "project_bundle.current"),
            version=bundle_project.get("version"),
        ),
        tools_bundle=BundleSpec(
            url=_ensure_str(bundle_tools.get("url"), "tools_bundle.url"),
            sha256=bundle_tools.get("sha256") or None,
            remote=_ensure_str(bundle_tools.get("remote"), "tools_bundle.remote"),
            root=_ensure_str(bundle_tools.get("root"), "tools_bundle.root"),
            dir=_ensure_str(bundle_tools.get("dir"), "tools_bundle.dir"),
            current=_ensure_str(bundle_tools.get("current"), "tools_bundle.current"),
            version=bundle_tools.get("version"),
        ),
        cloudflared=CloudflaredSpec(
            enabled=_ensure_bool(cloudflared.get("enabled"), "cloudflared.enabled"),
            hostname=cloudflared.get("hostname"),
            port=cloudflared.get("port"),
            token=cloudflared.get("token"),
            tunnel_id=cloudflared.get("tunnelId") or cloudflared.get("tunnel_id"),
            creds_json=cloudflared.get("credsJson") or cloudflared.get("creds_json"),
        ),
        conat_url=raw.get("conat_url"),
        bootstrap_token=raw.get("bootstrap_token"),
        ca_cert_path=raw.get("ca_cert_path"),
        bootstrap_done_paths=[str(p) for p in _ensure_list(raw.get("bootstrap_done_paths"), "bootstrap_done_paths")],
    )


def log_line(cfg: BootstrapConfig, message: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"{ts} {message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if cfg.log_file:
        Path(cfg.log_file).parent.mkdir(parents=True, exist_ok=True)
        with open(cfg.log_file, "a", encoding="utf-8") as handle:
            handle.write(line)


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


def compute_image_size(cfg: BootstrapConfig) -> int:
    raw = cfg.image_size_gb_raw
    if raw and raw != "auto":
        try:
            return max(5, int(raw))
        except ValueError:
            pass
    usage = shutil.disk_usage("/")
    total_gb = int(usage.total / (1024**3))
    target = total_gb - 15
    if target < 5:
        target = 5
    log_line(cfg, f"bootstrap: computed btrfs image size {target}G (disk {total_gb}G)")
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


def ensure_subuids(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: ensuring subuid/subgid ranges for {cfg.ssh_user}")
    run_best_effort(cfg, ["usermod", "--add-subuids", "100000-165535", "--add-subgids", "100000-165535", cfg.ssh_user], "usermod subuids")


def enable_linger(cfg: BootstrapConfig) -> None:
    log_line(cfg, f"bootstrap: enabling linger for {cfg.ssh_user}")
    if shutil.which("loginctl") is None:
        raise RuntimeError("loginctl not available; cannot ensure /run/user")
    run_cmd(cfg, ["loginctl", "enable-linger", cfg.ssh_user], "enable linger")


def prepare_dirs(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: preparing cocalc directories")
    for path in ["/opt/cocalc", "/var/lib/cocalc", "/etc/cocalc", "/btrfs"]:
        Path(path).mkdir(parents=True, exist_ok=True)
    run_best_effort(cfg, ["chown", "-R", f"{cfg.ssh_user}:{cfg.ssh_user}", "/opt/cocalc", "/var/lib/cocalc"], "chown cocalc dirs")


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
        if mountpoints and "/btrfs" in mountpoints:
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
        if not Path("/btrfs").is_mount():
            run_cmd(cfg, ["mount", data_disk, "/btrfs"], "mount data disk")
        uuid = subprocess.check_output(["blkid", "-s", "UUID", "-o", "value", data_disk], text=True).strip()
        fstab_line = f"UUID={uuid} /btrfs btrfs defaults,nofail 0 0"
        update_fstab(fstab_line)
        return
    log_line(cfg, "bootstrap: no data disk found; using loopback image")
    image_path = Path("/var/lib/cocalc/btrfs.img")
    image_path.parent.mkdir(parents=True, exist_ok=True)
    if not image_path.exists():
        run_cmd(cfg, ["truncate", "-s", f"{image_size_gb}G", str(image_path)], "truncate btrfs image")
        run_cmd(cfg, ["mkfs.btrfs", "-f", str(image_path)], "mkfs.btrfs image")
    if not Path("/btrfs").is_mount():
        run_cmd(cfg, ["mount", "-o", "loop", str(image_path), "/btrfs"], "mount btrfs image")
    fstab_line = f"{image_path} /btrfs btrfs loop,defaults,nofail 0 0 # cocalc-btrfs"
    update_fstab(fstab_line)


def update_fstab(line: str) -> None:
    fstab = Path("/etc/fstab")
    existing = fstab.read_text(encoding="utf-8") if fstab.exists() else ""
    lines = [l for l in existing.splitlines() if "cocalc-btrfs" not in l]
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
IMAGE="/var/lib/cocalc/btrfs.img"
MOUNTPOINT="/btrfs"
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


def ensure_btrfs_data(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: ensuring /btrfs/data subvolume")
    try:
        run_cmd(cfg, ["btrfs", "subvolume", "show", "/btrfs/data"], "btrfs subvolume show", check=False)
    except Exception:
        pass
    if not Path("/btrfs/data").exists():
        try:
            run_cmd(cfg, ["btrfs", "subvolume", "create", "/btrfs/data"], "btrfs subvolume create", check=False)
        except Exception:
            Path("/btrfs/data").mkdir(parents=True, exist_ok=True)
    Path("/btrfs/data/secrets").mkdir(parents=True, exist_ok=True)
    Path("/btrfs/data/tmp").mkdir(parents=True, exist_ok=True)
    os.chmod("/btrfs/data/tmp", 0o1777)
    run_best_effort(cfg, ["chown", "-R", f"{cfg.ssh_user}:{cfg.ssh_user}", "/btrfs/data"], "chown btrfs data")


def configure_podman(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring podman storage")
    Path("/btrfs/data/containers/root/storage").mkdir(parents=True, exist_ok=True)
    Path("/btrfs/data/containers/root/run").mkdir(parents=True, exist_ok=True)
    Path("/etc/containers").mkdir(parents=True, exist_ok=True)
    Path("/etc/containers/storage.conf").write_text(
        '[storage]\n'
        'driver = "overlay"\n'
        'runroot = "/btrfs/data/containers/root/run"\n'
        'graphroot = "/btrfs/data/containers/root/storage"\n',
        encoding="utf-8",
    )
    if cfg.ssh_user != "root":
        user_config = Path(cfg.bootstrap_home) / ".config/containers"
        user_config.mkdir(parents=True, exist_ok=True)
        Path(f"/btrfs/data/containers/rootless/{cfg.ssh_user}/storage").mkdir(parents=True, exist_ok=True)
        Path(f"/btrfs/data/containers/rootless/{cfg.ssh_user}/run").mkdir(parents=True, exist_ok=True)
        run_best_effort(cfg, ["chown", "-R", f"{cfg.ssh_user}:{cfg.ssh_user}", f"/btrfs/data/containers/rootless/{cfg.ssh_user}"], "chown rootless storage")
        (user_config / "storage.conf").write_text(
            '[storage]\n'
            'driver = "overlay"\n'
            f'runroot = "/btrfs/data/containers/rootless/{cfg.ssh_user}/run"\n'
            f'graphroot = "/btrfs/data/containers/rootless/{cfg.ssh_user}/storage"\n',
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
        runtime_dir = f"/btrfs/data/tmp/cocalc-podman-runtime-{uid}"
        Path(runtime_dir).mkdir(parents=True, exist_ok=True)
        run_best_effort(cfg, ["chown", f"{cfg.ssh_user}:{cfg.ssh_user}", runtime_dir], "chown runtime dir")
        upsert_env(cfg.env_file, "COCALC_PODMAN_RUNTIME_DIR", runtime_dir)
    if cfg.image_size_gb_raw == "auto":
        upsert_env(cfg.env_file, "COCALC_BTRFS_IMAGE_GB", str(image_size_gb))


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


def setup_conat_password(cfg: BootstrapConfig) -> None:
    if not cfg.conat_url or not cfg.bootstrap_token:
        return
    path = Path("/btrfs/data/secrets/conat-password")
    if path.exists():
        log_line(cfg, "bootstrap: conat password already present")
        return
    log_line(cfg, "bootstrap: fetching conat password")
    headers = {"Authorization": f"Bearer {cfg.bootstrap_token}"}
    request = urllib.request.Request(cfg.conat_url, headers=headers)
    context = None
    if cfg.ca_cert_path:
        try:
            context = ssl.create_default_context(cafile=cfg.ca_cert_path)
        except Exception:
            context = None
    with urllib.request.urlopen(request, context=context) as resp:
        data = resp.read()
    path.write_bytes(data)
    os.chmod(path, 0o600)


def download_file(cfg: BootstrapConfig, url: str, dest: str) -> None:
    log_line(cfg, f"bootstrap: downloading {url}")
    with urllib.request.urlopen(url) as resp:
        data = resp.read()
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    Path(dest).write_bytes(data)


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


def extract_bundle(cfg: BootstrapConfig, bundle: BundleSpec) -> None:
    download_file(cfg, bundle.url, bundle.remote)
    verify_sha256(cfg, bundle.remote, bundle.sha256)
    Path(bundle.root).mkdir(parents=True, exist_ok=True)
    if Path(bundle.dir).exists():
        shutil.rmtree(bundle.dir)
    Path(bundle.dir).mkdir(parents=True, exist_ok=True)
    run_cmd(cfg, ["tar", "-xJf", bundle.remote, "--strip-components=1", "-C", bundle.dir], f"extract {bundle.url}")
    current_path = Path(bundle.current)
    if current_path.is_symlink() or current_path.exists():
        if current_path.is_dir() and not current_path.is_symlink():
            shutil.rmtree(current_path)
        else:
            current_path.unlink()
    current_path.symlink_to(Path(bundle.dir), target_is_directory=True)


def install_node(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: installing node via nvm")
    nvm_dir = f"{cfg.bootstrap_home}/.nvm"
    install_cmd = (
        f"export NVM_DIR=\\\"{nvm_dir}\\\"; "
        f"if [ ! -s \\\"$NVM_DIR/nvm.sh\\\" ]; then "
        f"curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash; "
        f"fi; "
        f". \\\"$NVM_DIR/nvm.sh\\\"; "
        f"nvm install {cfg.node_version}; "
        f"nvm alias default {cfg.node_version}"
    )
    run_cmd(cfg, ["bash", "-lc", install_cmd], "install node", as_user=cfg.ssh_user)


def write_wrapper(cfg: BootstrapConfig) -> None:
    host_dir = Path(cfg.bootstrap_root)
    bin_dir = host_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = f"""#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi
node "$HOME/cocalc-host/bundle/index.js" "$@"
"""
    wrapper_path = bin_dir / "project-host"
    wrapper_path.write_text(wrapper, encoding="utf-8")
    wrapper_path.chmod(0o755)


def write_helpers(cfg: BootstrapConfig) -> None:
    bin_dir = Path(cfg.bootstrap_root) / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    ctl = """#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-status}"
BOOTSTRAP_HOME="${BOOTSTRAP_HOME:-$HOME}"
BOOTSTRAP_ROOT="${BOOTSTRAP_HOME}/cocalc-host"
bin="$BOOTSTRAP_ROOT/bin/project-host"
pid_file="/btrfs/data/daemon.pid"
case "${cmd}" in
  start|stop)
    "${bin}" daemon "${cmd}"
    ;;
  restart)
    "${bin}" daemon stop || true
    "${bin}" daemon start
    ;;
  status)
    if [ -f "${pid_file}" ] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
      echo "project-host running (pid $(cat "${pid_file}"))"
    else
      echo "project-host not running"
      exit 1
    fi
    ;;
  *)
    echo "usage: ${0} {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
"""
    start_ph = """#!/usr/bin/env bash
set -euo pipefail
BOOTSTRAP_HOME="${BOOTSTRAP_HOME:-$HOME}"
BOOTSTRAP_ROOT="${BOOTSTRAP_HOME}/cocalc-host"
CTL="$BOOTSTRAP_ROOT/bin/ctl"
for attempt in $(seq 1 60); do
  if mountpoint -q /btrfs; then
    if [ -x /usr/local/sbin/cocalc-grow-btrfs ]; then
      sudo /usr/local/sbin/cocalc-grow-btrfs || true
    fi
    exec "$CTL" start
  fi
  echo "waiting for /btrfs mount (attempt $attempt/60)"
  sudo mount /btrfs || true
  sleep 5
done
echo "timeout waiting for /btrfs mount"
exit 1
"""
    (bin_dir / "ctl").write_text(ctl, encoding="utf-8")
    (bin_dir / "start-project-host").write_text(start_ph, encoding="utf-8")
    (bin_dir / "logs").write_text("tail -n 200 /btrfs/data/log -f\n", encoding="utf-8")
    (bin_dir / "logs-cf").write_text("sudo journalctl -u cocalc-cloudflared.service -o cat -f -n 200\n", encoding="utf-8")
    (bin_dir / "ctl-cf").write_text("sudo systemctl ${1-status} cocalc-cloudflared\n", encoding="utf-8")
    for name in ["ctl", "start-project-host", "logs", "logs-cf", "ctl-cf"]:
        (bin_dir / name).chmod(0o755)


def configure_autostart(cfg: BootstrapConfig) -> None:
    log_line(cfg, "bootstrap: configuring project-host autostart")
    cron_line = f"@reboot {cfg.ssh_user} /bin/bash -lc '$HOME/cocalc-host/bin/start-project-host'"
    Path("/etc/cron.d/cocalc-project-host").write_text(cron_line + "\n", encoding="utf-8")
    os.chmod("/etc/cron.d/cocalc-project-host", 0o644)
    run_best_effort(cfg, ["systemctl", "enable", "--now", "cron"], "enable cron")


def configure_cloudflared(cfg: BootstrapConfig) -> None:
    if not cfg.cloudflared.enabled:
        return
    log_line(cfg, "bootstrap: installing cloudflared")
    arch = cfg.expected_arch
    deb_name = f"cloudflared-linux-{arch}.deb"
    run_cmd(cfg, ["curl", "-fsSL", "-o", "/tmp/cloudflared.deb", f"https://github.com/cloudflare/cloudflared/releases/latest/download/{deb_name}"], "download cloudflared")
    run_cmd(cfg, ["dpkg", "-i", "/tmp/cloudflared.deb"], "install cloudflared")
    Path("/etc/cloudflared").mkdir(parents=True, exist_ok=True)
    if cfg.cloudflared.token:
        Path("/etc/cloudflared/token.env").write_text(f"CLOUDFLARED_TOKEN={cfg.cloudflared.token}\n", encoding="utf-8")
        os.chmod("/etc/cloudflared/token.env", 0o600)
    if cfg.cloudflared.creds_json:
        Path(f"/etc/cloudflared/{cfg.cloudflared.tunnel_id}.json").write_text(cfg.cloudflared.creds_json, encoding="utf-8")
        os.chmod(f"/etc/cloudflared/{cfg.cloudflared.tunnel_id}.json", 0o600)
    ingress = f"""ingress:
  - hostname: {cfg.cloudflared.hostname}
    service: http://localhost:{cfg.cloudflared.port}
  - service: http_status:404
"""
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
    run_cmd(cfg, ["systemctl", "enable", "--now", "cocalc-cloudflared"], "enable cloudflared")


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
    bin_path = f"{cfg.bootstrap_root}/bin/project-host"
    if Path(bin_path).exists():
        run_cmd(cfg, [bin_path, "daemon", "stop"], "project-host stop", check=False, as_user=cfg.ssh_user)
    run_cmd(cfg, [bin_path, "daemon", "start"], "project-host start", as_user=cfg.ssh_user)


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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    log_line(cfg, "bootstrap: starting python bootstrap")
    log_line(cfg, f"bootstrap: user={cfg.bootstrap_user} home={cfg.bootstrap_home} root={cfg.bootstrap_root}")
    try:
        ensure_platform(cfg)
        image_size_gb = compute_image_size(cfg)
        disable_unattended(cfg)
        apt_update_install(cfg)
        install_gpu_support(cfg)
        configure_chrony(cfg)
        enable_userns(cfg)
        ensure_subuids(cfg)
        enable_linger(cfg)
        prepare_dirs(cfg)
        setup_btrfs(cfg, image_size_gb)
        install_btrfs_helper(cfg)
        ensure_btrfs_data(cfg)
        configure_podman(cfg)
        write_env(cfg, image_size_gb)
        setup_conat_password(cfg)
        extract_bundle(cfg, cfg.project_host_bundle)
        extract_bundle(cfg, cfg.project_bundle)
        extract_bundle(cfg, cfg.tools_bundle)
        install_node(cfg)
        write_wrapper(cfg)
        write_helpers(cfg)
        configure_cloudflared(cfg)
        configure_autostart(cfg)
        start_project_host(cfg)
        reenable_unattended(cfg)
        touch_paths(cfg.bootstrap_done_paths)
        log_line(cfg, "bootstrap: completed successfully")
        return 0
    except Exception as exc:
        log_line(cfg, f"bootstrap: failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
