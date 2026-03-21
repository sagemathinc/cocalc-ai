#!/usr/bin/env python3

import tempfile
import unittest
from pathlib import Path

import bootstrap


def make_cfg(tmpdir: str) -> bootstrap.BootstrapConfig:
    base = Path(tmpdir)
    return bootstrap.BootstrapConfig(
        bootstrap_user="ubuntu",
        bootstrap_home=str(base / "home"),
        bootstrap_root=str(base / "bootstrap-root"),
        bootstrap_dir=str(base / "bootstrap-dir"),
        bootstrap_tmp=str(base / "bootstrap-tmp"),
        log_file=str(base / "bootstrap.log"),
        expected_os="linux",
        expected_arch="amd64",
        image_size_gb_raw="10",
        data_disk_devices="",
        data_disk_candidates="",
        apt_packages=[],
        has_gpu=False,
        ssh_user="missing-runtime-user",
        env_file=str(base / "project-host.env"),
        env_lines=[],
        node_version="20",
        project_host_bundle=bootstrap.BundleSpec("", None, "", "", "", ""),
        project_bundle=bootstrap.BundleSpec("", None, "", "", "", ""),
        tools_bundle=bootstrap.BundleSpec("", None, "", "", "", ""),
        cloudflared=bootstrap.CloudflaredSpec(False),
        conat_url=None,
        status_url=None,
        bootstrap_token=None,
        ca_cert_path=None,
        bootstrap_done_paths=[],
    )


class BootstrapRuntimeShellEnvTest(unittest.TestCase):
    def test_writes_and_replaces_managed_bashrc_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            env_file = Path(cfg.env_file)
            env_file.write_text(
                "COCALC_PODMAN_RUNTIME_DIR=/tmp/cocalc-podman-runtime-1001\n",
                encoding="utf-8",
            )
            home = Path(cfg.bootstrap_home)
            home.mkdir(parents=True, exist_ok=True)
            bashrc = home / ".bashrc"
            bashrc.write_text("# existing line\n", encoding="utf-8")

            original = bootstrap.run_best_effort
            bootstrap.run_best_effort = lambda *args, **kwargs: None
            try:
                bootstrap.configure_runtime_shell_env(cfg)
                bootstrap.configure_runtime_shell_env(cfg)
            finally:
                bootstrap.run_best_effort = original

            text = bashrc.read_text(encoding="utf-8")
            self.assertIn("# existing line\n", text)
            self.assertEqual(text.count(bootstrap.PODMAN_BASHRC_BLOCK_START), 1)
            self.assertEqual(text.count(bootstrap.PODMAN_BASHRC_BLOCK_END), 1)
            self.assertIn(
                'export XDG_RUNTIME_DIR="/tmp/cocalc-podman-runtime-1001"', text
            )
            self.assertIn(
                'export COCALC_PODMAN_RUNTIME_DIR="/tmp/cocalc-podman-runtime-1001"',
                text,
            )
            self.assertIn('export CONTAINERS_CGROUP_MANAGER="cgroupfs"', text)


if __name__ == "__main__":
    unittest.main()
