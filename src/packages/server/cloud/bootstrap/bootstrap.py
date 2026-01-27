#!/usr/bin/env python3
"""
Python-first project-host bootstrap (work in progress).

This file is intentionally stdlib-only. It will eventually replace the
monolithic shell bootstrap with a structured, observable, and parallelized
implementation. For now it is a scaffold so we can iterate safely.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import subprocess


@dataclass(frozen=True)
class BootstrapConfig:
    bootstrap_user: str
    bootstrap_home: str
    bootstrap_root: str
    bootstrap_dir: str
    bootstrap_tmp: str | None = None
    log_file: str | None = None
    parallel: bool = True
    legacy_bootstrap_script: str | None = None
    fetch_project_host_script: str | None = None
    fetch_project_bundle_script: str | None = None
    fetch_tools_script: str | None = None
    install_service_script: str | None = None
    bootstrap_done_paths: list[str] | None = None


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_config(path: str) -> BootstrapConfig:
    with open(path, "r", encoding="utf-8") as handle:
        raw: dict[str, Any] = json.load(handle)
    _require(isinstance(raw.get("bootstrap_user"), str), "bootstrap_user missing")
    _require(isinstance(raw.get("bootstrap_home"), str), "bootstrap_home missing")
    _require(isinstance(raw.get("bootstrap_root"), str), "bootstrap_root missing")
    _require(isinstance(raw.get("bootstrap_dir"), str), "bootstrap_dir missing")
    log_file = raw.get("log_file")
    if log_file is not None and not isinstance(log_file, str):
        raise RuntimeError("log_file must be a string if provided")
    parallel = raw.get("parallel", True)
    if not isinstance(parallel, bool):
        raise RuntimeError("parallel must be boolean if provided")
    bootstrap_tmp = raw.get("bootstrap_tmp")
    if bootstrap_tmp is not None and not isinstance(bootstrap_tmp, str):
        raise RuntimeError("bootstrap_tmp must be a string if provided")
    legacy_bootstrap_script = raw.get("legacy_bootstrap_script")
    if legacy_bootstrap_script is not None and not isinstance(
        legacy_bootstrap_script, str
    ):
        raise RuntimeError("legacy_bootstrap_script must be a string if provided")
    fetch_project_host_script = raw.get("fetch_project_host_script")
    if fetch_project_host_script is not None and not isinstance(
        fetch_project_host_script, str
    ):
        raise RuntimeError("fetch_project_host_script must be a string if provided")
    fetch_project_bundle_script = raw.get("fetch_project_bundle_script")
    if fetch_project_bundle_script is not None and not isinstance(
        fetch_project_bundle_script, str
    ):
        raise RuntimeError("fetch_project_bundle_script must be a string if provided")
    fetch_tools_script = raw.get("fetch_tools_script")
    if fetch_tools_script is not None and not isinstance(fetch_tools_script, str):
        raise RuntimeError("fetch_tools_script must be a string if provided")
    install_service_script = raw.get("install_service_script")
    if install_service_script is not None and not isinstance(
        install_service_script, str
    ):
        raise RuntimeError("install_service_script must be a string if provided")
    bootstrap_done_paths = raw.get("bootstrap_done_paths")
    if bootstrap_done_paths is not None:
        if not isinstance(bootstrap_done_paths, list) or not all(
            isinstance(p, str) for p in bootstrap_done_paths
        ):
            raise RuntimeError("bootstrap_done_paths must be a list of strings")
    return BootstrapConfig(
        bootstrap_user=raw["bootstrap_user"],
        bootstrap_home=raw["bootstrap_home"],
        bootstrap_root=raw["bootstrap_root"],
        bootstrap_dir=raw["bootstrap_dir"],
        bootstrap_tmp=bootstrap_tmp,
        log_file=log_file,
        parallel=parallel,
        legacy_bootstrap_script=legacy_bootstrap_script,
        fetch_project_host_script=fetch_project_host_script,
        fetch_project_bundle_script=fetch_project_bundle_script,
        fetch_tools_script=fetch_tools_script,
        install_service_script=install_service_script,
        bootstrap_done_paths=bootstrap_done_paths,
    )


def log_line(cfg: BootstrapConfig, message: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"{ts} {message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if cfg.log_file:
        with open(cfg.log_file, "a", encoding="utf-8") as handle:
            handle.write(line)


def ensure_parent(path: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def build_env(cfg: BootstrapConfig) -> dict[str, str]:
    env = os.environ.copy()
    env["BOOTSTRAP_USER"] = cfg.bootstrap_user
    env["BOOTSTRAP_HOME"] = cfg.bootstrap_home
    env["BOOTSTRAP_ROOT"] = cfg.bootstrap_root
    env["BOOTSTRAP_DIR"] = cfg.bootstrap_dir
    if cfg.bootstrap_tmp:
        env["BOOTSTRAP_TMP"] = cfg.bootstrap_tmp
    return env


def run_cmd(
    cfg: BootstrapConfig,
    args: list[str],
    desc: str,
    as_user: str | None = None,
) -> None:
    start = time.time()
    cmd = args
    env = build_env(cfg)
    if as_user and os.geteuid() == 0 and as_user != "root":
        cmd = ["sudo", "-u", as_user, "-H"] + args
    log_line(cfg, f"bootstrap: starting {desc}: {' '.join(cmd)}")
    ensure_parent(cfg.log_file or "/var/tmp/cocalc-bootstrap.log")
    with subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    ) as proc:
        if proc.stdout:
            for line in proc.stdout:
                log_line(cfg, line.rstrip())
        ret = proc.wait()
    elapsed = time.time() - start
    if ret != 0:
        raise RuntimeError(f"{desc} failed with exit code {ret}")
    log_line(cfg, f"bootstrap: finished {desc} in {elapsed:.1f}s")


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
    log_line(cfg, "bootstrap: starting python orchestrator")
    log_line(
        cfg,
        f"bootstrap: user={cfg.bootstrap_user} home={cfg.bootstrap_home} root={cfg.bootstrap_root} dir={cfg.bootstrap_dir}",
    )
    try:
        if cfg.legacy_bootstrap_script:
            run_cmd(cfg, ["/bin/bash", cfg.legacy_bootstrap_script], "legacy bootstrap")
        if cfg.fetch_project_host_script:
            run_cmd(
                cfg,
                ["/bin/bash", cfg.fetch_project_host_script],
                "fetch project-host bundle",
                as_user=cfg.bootstrap_user,
            )
        if cfg.fetch_project_bundle_script:
            run_cmd(
                cfg,
                ["/bin/bash", cfg.fetch_project_bundle_script],
                "fetch project bundle",
                as_user=cfg.bootstrap_user,
            )
        if cfg.fetch_tools_script:
            run_cmd(
                cfg,
                ["/bin/bash", cfg.fetch_tools_script],
                "fetch tools",
                as_user=cfg.bootstrap_user,
            )
        if cfg.install_service_script:
            run_cmd(
                cfg,
                ["/bin/bash", cfg.install_service_script],
                "install service",
            )
        if cfg.bootstrap_done_paths:
            touch_paths(cfg.bootstrap_done_paths)
        log_line(cfg, "bootstrap: completed successfully")
        return 0
    except Exception as exc:
        log_line(cfg, f"bootstrap: failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
