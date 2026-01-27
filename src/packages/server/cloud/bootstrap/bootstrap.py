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
from typing import Any


@dataclass(frozen=True)
class BootstrapConfig:
    bootstrap_user: str
    bootstrap_root: str
    bootstrap_dir: str
    log_file: str | None = None
    parallel: bool = True


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_config(path: str) -> BootstrapConfig:
    with open(path, "r", encoding="utf-8") as handle:
        raw: dict[str, Any] = json.load(handle)
    _require(isinstance(raw.get("bootstrap_user"), str), "bootstrap_user missing")
    _require(isinstance(raw.get("bootstrap_root"), str), "bootstrap_root missing")
    _require(isinstance(raw.get("bootstrap_dir"), str), "bootstrap_dir missing")
    log_file = raw.get("log_file")
    if log_file is not None and not isinstance(log_file, str):
        raise RuntimeError("log_file must be a string if provided")
    parallel = raw.get("parallel", True)
    if not isinstance(parallel, bool):
        raise RuntimeError("parallel must be boolean if provided")
    return BootstrapConfig(
        bootstrap_user=raw["bootstrap_user"],
        bootstrap_root=raw["bootstrap_root"],
        bootstrap_dir=raw["bootstrap_dir"],
        log_file=log_file,
        parallel=parallel,
    )


def log_line(cfg: BootstrapConfig, message: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = f"{ts} {message}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if cfg.log_file:
        with open(cfg.log_file, "a", encoding="utf-8") as handle:
            handle.write(line)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    log_line(cfg, f"bootstrap: python scaffold loaded (user={cfg.bootstrap_user})")
    log_line(cfg, f"bootstrap: root={cfg.bootstrap_root} dir={cfg.bootstrap_dir}")
    log_line(cfg, "bootstrap: python implementation not wired yet; exiting")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
