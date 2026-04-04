#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from collections import namedtuple
from dataclasses import replace
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
        root_reserve_gb_raw="15",
        data_disk_devices="",
        data_disk_candidates="",
        apt_packages=[],
        has_gpu=False,
        ssh_user="missing-runtime-user",
        env_file=str(base / "project-host.env"),
        env_lines=[],
        node_version="20",
        bootstrap_selector="latest",
        bootstrap_py_url="https://example.invalid/software/bootstrap/latest/bootstrap.py",
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


class BootstrapBundleManifestResolutionTest(unittest.TestCase):
    def test_resolves_latest_tools_bundle_from_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            bundle = bootstrap.BundleSpec(
                url="https://example.invalid/software/tools/old/tools-linux-amd64.tar.xz",
                sha256="oldsha",
                remote=str(Path(tmpdir) / "tools.tar.xz"),
                root="/opt/cocalc/tools",
                dir="/opt/cocalc/tools/old",
                current="/opt/cocalc/tools/current",
                version="old",
                manifest_url="https://example.invalid/software/tools/latest-linux-amd64.json",
            )

            original = bootstrap.fetch_json
            bootstrap.fetch_json = lambda _cfg, _url: {
                "url": "https://example.invalid/software/tools/1774551251773/tools-linux-amd64.tar.xz",
                "sha256": "newsha",
                "version": "1774551251773",
            }
            try:
                resolved = bootstrap.resolve_bundle_spec(cfg, bundle)
            finally:
                bootstrap.fetch_json = original

            self.assertEqual(
                resolved.url,
                "https://example.invalid/software/tools/1774551251773/tools-linux-amd64.tar.xz",
            )
            self.assertEqual(resolved.sha256, "newsha")
            self.assertEqual(resolved.version, "1774551251773")
            self.assertEqual(resolved.dir, "/opt/cocalc/tools/1774551251773")
            self.assertEqual(
                resolved.manifest_url,
                "https://example.invalid/software/tools/latest-linux-amd64.json",
            )


class BootstrapSizingTest(unittest.TestCase):
    def test_compute_image_size_respects_configured_root_reserve(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            cfg = replace(cfg, image_size_gb_raw="auto", root_reserve_gb_raw="24")

            original_disk_usage = bootstrap.shutil.disk_usage
            DiskUsage = namedtuple("usage", ["total", "used", "free"])
            bootstrap.shutil.disk_usage = lambda _path: DiskUsage(
                100 * (1024**3), 0, 100 * (1024**3)
            )
            try:
                self.assertEqual(bootstrap.compute_image_size(cfg), 76)
            finally:
                bootstrap.shutil.disk_usage = original_disk_usage

class BootstrapSubidAllocationTest(unittest.TestCase):
    def test_rewrites_user_subid_ranges_to_the_exact_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "subuid"
            path.write_text("ubuntu:100000:65536\n", encoding="utf-8")

            changed = bootstrap.ensure_exact_subid_file(
                path, "cocalc-host", bootstrap.PROJECT_HOST_RUNTIME_SUBID_RANGES
            )

            self.assertTrue(changed)
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "ubuntu:100000:65536")
            self.assertEqual(lines[1], "cocalc-host:231072:65536")
            self.assertEqual(lines[2], "cocalc-host:327680:4128768")

    def test_keeps_existing_exact_subid_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "subgid"
            path.write_text(
                "cocalc-host:231072:65536\ncocalc-host:327680:4128768\n",
                encoding="utf-8",
            )

            changed = bootstrap.ensure_exact_subid_file(
                path, "cocalc-host", bootstrap.PROJECT_HOST_RUNTIME_SUBID_RANGES
            )

            self.assertFalse(changed)
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                "cocalc-host:231072:65536\ncocalc-host:327680:4128768\n",
            )

    def test_replaces_non_contract_ranges_for_runtime_user(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "subuid"
            path.write_text(
                "ubuntu:100000:65536\ncocalc-host:100000:65536\n",
                encoding="utf-8",
            )

            changed = bootstrap.ensure_exact_subid_file(
                path, "cocalc-host", bootstrap.PROJECT_HOST_RUNTIME_SUBID_RANGES
            )

            self.assertTrue(changed)
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "ubuntu:100000:65536")
            self.assertEqual(lines[1], "cocalc-host:231072:65536")
            self.assertEqual(lines[2], "cocalc-host:327680:4128768")


class BootstrapStateFilesTest(unittest.TestCase):
    def test_writes_split_state_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            cfg = replace(
                cfg,
                conat_url="https://hub.example.invalid/conat/master-token",
                status_url="https://hub.example.invalid/bootstrap/status",
                bootstrap_token="bootstrap-secret",
                ca_cert_path="/etc/ssl/cocalc-ca.pem",
                project_host_bundle=replace(
                    cfg.project_host_bundle,
                    root="/opt/cocalc/project-host/bundles",
                ),
                project_bundle=replace(
                    cfg.project_bundle,
                    root="/opt/cocalc/project/bundles",
                ),
                tools_bundle=replace(
                    cfg.tools_bundle,
                    root="/opt/cocalc/tools",
                ),
            )
            bootstrap.write_bootstrap_state_files(cfg)

            facts = json.loads(
                (Path(cfg.bootstrap_dir) / "bootstrap-host-facts.json").read_text(
                    encoding="utf-8"
                )
            )
            desired = json.loads(
                (Path(cfg.bootstrap_dir) / "bootstrap-desired-state.json").read_text(
                    encoding="utf-8"
                )
            )
            state = json.loads(
                (Path(cfg.bootstrap_dir) / "bootstrap-state.json").read_text(
                    encoding="utf-8"
                )
            )

            self.assertEqual(facts["runtime_user"], "missing-runtime-user")
            self.assertEqual(desired["bootstrap"]["selector"], "latest")
            self.assertEqual(
                desired["bootstrap_connection"]["conat_url"],
                "https://hub.example.invalid/conat/master-token",
            )
            self.assertEqual(
                desired["bootstrap_connection"]["bootstrap_token"],
                "bootstrap-secret",
            )
            self.assertEqual(
                desired["project_host_bundle"]["root"],
                "/opt/cocalc/project-host/bundles",
            )
            self.assertEqual(
                desired["runtime_user_contract"]["identity"],
                "missing-runtime-user:1002:1003",
            )
            self.assertEqual(
                desired["runtime_user_contract"]["fingerprint"],
                bootstrap.runtime_userns_map_fingerprint(
                    [
                        "0 1002 1",
                        "1 231072 65536",
                        "65537 327680 4128768",
                    ],
                    [
                        "0 1003 1",
                        "1 231072 65536",
                        "65537 327680 4128768",
                    ],
                ),
            )
            self.assertEqual(state["runtime_user_contract"]["user"], "missing-runtime-user")
            self.assertIn("installed", state)


class BootstrapRuntimeUserContractTest(unittest.TestCase):
    def test_verify_runtime_user_contract_raises_on_drift(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        original_expected = bootstrap.expected_runtime_user_contract
        original_read = bootstrap.read_current_runtime_user_contract
        try:
            bootstrap.expected_runtime_user_contract = lambda _cfg: {
                "identity": "cocalc-host:1002:1003",
                "subuid_ranges": ["231072:65536", "327680:4128768"],
                "subgid_ranges": ["231072:65536", "327680:4128768"],
                "uid_map": ["0 1002 1", "1 231072 65536", "65537 327680 4128768"],
                "gid_map": ["0 1003 1", "1 231072 65536", "65537 327680 4128768"],
                "fingerprint": "expected",
            }
            bootstrap.read_current_runtime_user_contract = lambda _cfg: {
                "identity": "cocalc-host:1002:1003",
                "subuid_ranges": ["231072:65536", "327680:4128768"],
                "subgid_ranges": ["231072:65536", "327680:4128768"],
                "uid_map": ["0 1002 1", "1 231072 65536", "65537 327680 4128768"],
                "gid_map": ["0 1003 1", "1 231072 65536", "65537 327680 4128768"],
                "fingerprint": "different",
            }
            with self.assertRaisesRegex(RuntimeError, "runtime userns contract mismatch"):
                bootstrap.verify_runtime_user_contract(cfg)
        finally:
            bootstrap.expected_runtime_user_contract = original_expected
            bootstrap.read_current_runtime_user_contract = original_read


class BootstrapLogRotationTest(unittest.TestCase):
    def test_rotates_large_bootstrap_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            log_path = Path(cfg.log_file)
            log_path.write_text("x" * (bootstrap.BOOTSTRAP_LOG_MAX_BYTES + 1), encoding="utf-8")

            bootstrap.rotate_bootstrap_log(cfg)

            self.assertFalse(log_path.exists())
            self.assertTrue(log_path.with_name("bootstrap.log.1").exists())


class BootstrapBundleRetentionTest(unittest.TestCase):
    def test_prunes_old_bundle_versions_but_keeps_current_and_desired(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            root = Path(tmpdir) / "bundles"
            root.mkdir(parents=True, exist_ok=True)
            created: list[Path] = []
            for index in range(1, 8):
                version_dir = root / f"v{index}"
                version_dir.mkdir()
                (version_dir / "README.txt").write_text(f"v{index}\n", encoding="utf-8")
                os.utime(version_dir, (index, index))
                created.append(version_dir)
            current = root / "current"
            current.symlink_to(created[5], target_is_directory=True)
            bundle = bootstrap.BundleSpec(
                url="",
                sha256=None,
                remote="",
                root=str(root),
                dir=str(created[6]),
                current=str(current),
                version="v7",
            )

            bootstrap.prune_bundle_versions(cfg, bundle, keep=3)

            remaining = sorted(
                child.name
                for child in root.iterdir()
                if child.is_dir() and not child.is_symlink()
            )
            self.assertEqual(remaining, ["v5", "v6", "v7"])


class BootstrapOwnershipScopeTest(unittest.TestCase):
    def test_ensure_bootstrap_paths_does_not_recurse_over_bootstrap_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_geteuid = bootstrap.os.geteuid
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.os.geteuid = lambda: 0
                bootstrap.ensure_bootstrap_paths(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.os.geteuid = original_geteuid

            self.assertTrue(recorded)
            for args, _desc in recorded:
                self.assertNotIn("-R", args)
            self.assertIn(
                (
                    [
                        "chown",
                        "ubuntu:ubuntu",
                        cfg.bootstrap_root,
                        cfg.bootstrap_dir,
                        cfg.bootstrap_tmp,
                        str(Path(cfg.log_file).parent),
                    ],
                    "chown bootstrap-owner dirs",
                ),
                recorded,
            )

    def test_ensure_btrfs_data_does_not_recurse_over_entire_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_run_cmd = bootstrap.run_cmd
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.run_cmd = lambda *args, **kwargs: None
                # The function targets absolute paths, so just assert on the commands
                # it would have run rather than trying to mount a fake tree.
                original_exists = Path.exists
                original_mkdir = Path.mkdir
                original_chmod = bootstrap.os.chmod
                Path.exists = lambda self: True  # type: ignore[method-assign]
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.ensure_btrfs_data(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.run_cmd = original_run_cmd
                Path.exists = original_exists  # type: ignore[method-assign]
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            self.assertTrue(recorded)
            for args, _desc in recorded:
                self.assertNotIn("-R", args)
            self.assertIn(
                (["chown", "missing-runtime-user:missing-runtime-user", "/mnt/cocalc/data"], "chown /mnt/cocalc/data"),
                recorded,
            )

    def test_configure_podman_chowns_rootless_storage_children(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_runtime_home = bootstrap.runtime_home
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.runtime_home = lambda _cfg: str(Path(tmpdir) / "home")
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, _text, encoding="utf-8": 0  # type: ignore[method-assign]
                bootstrap.configure_podman(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.runtime_home = original_runtime_home
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]

            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(Path(tmpdir) / "home" / ".config" / "containers"),
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user/storage",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user/run",
                    ],
                    "chown rootless podman paths",
                ),
                recorded,
            )


class BootstrapWrapperScriptTest(unittest.TestCase):
    def test_storage_wrapper_uses_xattr_overlay_mounts_and_project_rustic_commands(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            captured: dict[str, str] = {}

            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.os.chmod

            def capture_write(self, data, encoding="utf-8"):
                captured[str(self)] = data
                return len(data)

            try:
                bootstrap.Path.write_text = capture_write
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.install_privileged_wrappers(cfg)
            finally:
                bootstrap.Path.write_text = original_write_text
                bootstrap.os.chmod = original_chmod

            script = captured["/usr/local/sbin/cocalc-runtime-storage"]
            self.assertIn("metacopy=on,redirect_dir=on,index=off", script)
            self.assertIn("project-rustic-backup)", script)
            self.assertIn("project-rustic-restore)", script)
            self.assertIn("normalize-rootfs)", script)
            self.assertIn("sandbox-rm)", script)
            self.assertIn("sandbox-rmdir)", script)
            self.assertIn("allow_privileged_delete_root", script)
            self.assertIn("privileged-rm-helper", script)
            self.assertIn("podman unshare cat /proc/self/uid_map", script)
            self.assertIn('"to-canonical"', script)
            self.assertIn('"to-host"', script)
            self.assertIn("reverse_keep_id", script)
            self.assertIn('"2001"', script)
            self.assertIn("sudo_present", script)
            self.assertIn("ca_certificates_present", script)
            self.assertIn(
                "startup bootstrap requires sudo and CA certificates",
                script,
            )
            self.assertIn('mkdir -p "$rootfs/home" "$rootfs/home/user"', script)
            self.assertIn('ln -snf /proc/mounts "$rootfs/etc/mtab"', script)
            self.assertIn('find "$dir" -xdev -type f', script)
            self.assertIn("COCALC_RUNTIME_UID", script)
            self.assertIn("--userns=keep-id:uid=2001,gid=2001", script)
            self.assertIn(': >"$rootfs/run/podman-init"', script)
            self.assertIn(': >"$rootfs/run/.containerenv"', script)
            wrapper_path = Path(tmpdir) / "cocalc-runtime-storage"
            wrapper_path.write_text(script, encoding="utf-8")
            subprocess.run(["bash", "-n", str(wrapper_path)], check=True)

    def test_write_helpers_chowns_only_targeted_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_runtime_root = bootstrap.project_host_runtime_root
            original_geteuid = bootstrap.os.geteuid
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.project_host_runtime_root = lambda _cfg: Path(tmpdir) / "runtime-root"
                bootstrap.os.geteuid = lambda: 0
                bootstrap.write_helpers(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.project_host_runtime_root = original_runtime_root
                bootstrap.os.geteuid = original_geteuid

            self.assertTrue(recorded)
            for args, _desc in recorded:
                self.assertNotIn("-R", args)
            runtime_bin = Path(tmpdir) / "runtime-root" / "bin"
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(runtime_bin),
                        str(runtime_bin / "ctl"),
                        str(runtime_bin / "start-project-host"),
                        str(runtime_bin / "logs"),
                        str(runtime_bin / "acp-status"),
                        str(runtime_bin / "acp-logs"),
                        str(runtime_bin / "logs-cf"),
                        str(runtime_bin / "ctl-cf"),
                    ],
                    "chown runtime helper scripts",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(runtime_bin / "fetch-project-bundle.sh"),
                        str(runtime_bin / "fetch-project-host.sh"),
                        str(runtime_bin / "fetch-tools.sh"),
                    ],
                    "chown runtime fetch helpers",
                ),
                recorded,
            )

    def test_write_wrapper_uses_runtime_home_for_node_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            captured = {}

            original_runtime_root = bootstrap.project_host_runtime_root
            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.Path.chmod
            original_run_best_effort = bootstrap.run_best_effort
            try:
                bootstrap.project_host_runtime_root = lambda _cfg: Path(tmpdir) / "runtime-root"
                bootstrap.Path.write_text = (
                    lambda self, data, encoding="utf-8": captured.__setitem__(str(self), data)
                    or len(data)
                )
                bootstrap.Path.chmod = lambda *_args, **_kwargs: None
                bootstrap.run_best_effort = lambda *_args, **_kwargs: None
                bootstrap.write_wrapper(cfg)
            finally:
                bootstrap.project_host_runtime_root = original_runtime_root
                bootstrap.Path.write_text = original_write_text
                bootstrap.Path.chmod = original_chmod
                bootstrap.run_best_effort = original_run_best_effort

            script = captured[str(Path(tmpdir) / "runtime-root" / "bin" / "project-host")]
            self.assertIn(f'RUNTIME_HOME="{cfg.bootstrap_home}"', script)
            self.assertIn('export NVM_DIR="$RUNTIME_HOME/.nvm"', script)
            self.assertIn(
                f'elif [ -x "{cfg.bootstrap_home}/.nvm/versions/node/v20/bin/node" ]; then',
                script,
            )
            self.assertIn('exec "$NODE_BIN"', script)

    def test_configure_autostart_only_writes_cron_and_enables_service(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            runtime_root = Path(tmpdir) / "runtime-root"
            recorded = []
            writes = []

            original_run_best_effort = bootstrap.run_best_effort
            original_runtime_root = bootstrap.project_host_runtime_root
            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.project_host_runtime_root = lambda _cfg: runtime_root
                bootstrap.Path.write_text = (
                    lambda self, data, encoding="utf-8": writes.append(
                        (str(self), data, encoding)
                    )
                    or len(data)
                )
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_autostart(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.project_host_runtime_root = original_runtime_root
                bootstrap.Path.write_text = original_write_text
                bootstrap.os.chmod = original_chmod

            self.assertIn(
                (
                    "/etc/cron.d/cocalc-project-host",
                    (
                        f"@reboot {cfg.ssh_user} /bin/bash -lc '{runtime_root}/bin/start-project-host'\n"
                        f"* * * * * {cfg.ssh_user} /bin/bash -lc 'if mountpoint -q /mnt/cocalc; then mkdir -p /mnt/cocalc/data/logs; {runtime_root}/bin/ctl ensure >> /mnt/cocalc/data/logs/project-host-watchdog.log 2>&1; fi'\n"
                    ),
                    "utf-8",
                ),
                writes,
            )
            self.assertIn(
                (
                    ["systemctl", "enable", "--now", "cron"],
                    "enable cron",
                ),
                recorded,
            )
            self.assertNotIn(
                (
                    [
                        "sudo",
                        "-u",
                        cfg.ssh_user,
                        "-H",
                        "/bin/bash",
                        "-lc",
                        f"{runtime_root}/bin/start-project-host",
                    ],
                    "start project-host now",
                ),
                recorded,
            )

    def test_reconcile_cloudflared_installs_binary_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(
                    True,
                    hostname="host.example.test",
                    port=9002,
                    ssh_hostname="ssh.example.test",
                    ssh_port=2222,
                    token="token",
                ),
            )
            recorded = []

            original_run_cmd = bootstrap.run_cmd
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append((args, desc))
                )
                bootstrap.shutil.which = lambda name: None if name == "cloudflared" else original_which(name)
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, _text, encoding="utf-8": 0  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_cloudflared_with_options(
                    cfg, install_package=False
                )
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            self.assertIn(
                (
                    [
                        "curl",
                        "-fsSL",
                        "-o",
                        "/tmp/cloudflared.deb",
                        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb",
                    ],
                    "download cloudflared",
                ),
                recorded,
            )
            self.assertIn((["dpkg", "-i", "/tmp/cloudflared.deb"], "install cloudflared"), recorded)


class BootstrapModesTest(unittest.TestCase):
    def test_reconcile_mode_records_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            bootstrap_dir = Path(cfg.bootstrap_dir)
            bootstrap_dir.mkdir(parents=True, exist_ok=True)
            (bootstrap_dir / "bootstrap-host-facts.json").write_text(
                json.dumps(
                    {
                        "bootstrap_user": cfg.bootstrap_user,
                        "bootstrap_home": cfg.bootstrap_home,
                        "bootstrap_root": cfg.bootstrap_root,
                        "bootstrap_dir": cfg.bootstrap_dir,
                        "bootstrap_tmp": cfg.bootstrap_tmp,
                        "log_file": cfg.log_file,
                        "expected_os": cfg.expected_os,
                        "expected_arch": cfg.expected_arch,
                        "data_disk_devices": cfg.data_disk_devices,
                        "data_disk_candidates": cfg.data_disk_candidates,
                        "has_gpu": cfg.has_gpu,
                        "runtime_user": cfg.ssh_user,
                        "env_file": cfg.env_file,
                    }
                ),
                encoding="utf-8",
            )
            (bootstrap_dir / "bootstrap-desired-state.json").write_text(
                json.dumps(
                    {
                        "image_size_gb_raw": cfg.image_size_gb_raw,
                        "root_reserve_gb_raw": cfg.root_reserve_gb_raw,
                        "apt_packages": cfg.apt_packages,
                        "env_lines": cfg.env_lines,
                        "node_version": cfg.node_version,
                        "bootstrap_done_paths": [],
                        "bootstrap": {
                            "selector": cfg.bootstrap_selector,
                            "url": cfg.bootstrap_py_url,
                        },
                        "bootstrap_connection": {
                            "conat_url": None,
                            "status_url": None,
                            "bootstrap_token": None,
                            "ca_cert_path": None,
                        },
                        "project_host_bundle": {
                            "url": "",
                            "sha256": None,
                            "remote": "",
                            "root": str(Path(tmpdir) / "project-host"),
                            "dir": str(Path(tmpdir) / "project-host" / "v1"),
                            "current": str(Path(tmpdir) / "project-host" / "current"),
                        },
                        "project_bundle": {
                            "url": "",
                            "sha256": None,
                            "remote": "",
                            "root": str(Path(tmpdir) / "project"),
                            "dir": str(Path(tmpdir) / "project" / "v1"),
                            "current": str(Path(tmpdir) / "project" / "current"),
                        },
                        "tools_bundle": {
                            "url": "",
                            "sha256": None,
                            "remote": "",
                            "root": str(Path(tmpdir) / "tools"),
                            "dir": str(Path(tmpdir) / "tools" / "v1"),
                            "current": str(Path(tmpdir) / "tools" / "current"),
                        },
                        "cloudflared": {"enabled": False},
                    }
                ),
                encoding="utf-8",
            )

            originals = {}

            def patch(name: str, replacement) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(bootstrap, name, replacement)

            patch("ensure_runtime_user", lambda _cfg: None)
            patch("ensure_bootstrap_paths", lambda _cfg: None)
            patch("compute_image_size", lambda _cfg: 10)
            patch("install_btrfs_helper", lambda _cfg: None)
            patch("install_privileged_wrappers", lambda _cfg: None)
            patch("ensure_cocalc_mount", lambda _cfg: None)
            patch("ensure_btrfs_data", lambda _cfg: None)
            patch("ensure_subuids", lambda _cfg: None)
            patch("configure_podman", lambda _cfg: None)
            patch("verify_runtime_user_contract", lambda _cfg: None)
            patch("write_env", lambda _cfg, _size: None)
            patch("configure_runtime_shell_env", lambda _cfg: None)
            patch("setup_master_conat_token", lambda _cfg: None)
            patch("extract_bundle", lambda _cfg, bundle: bundle)
            patch("install_node", lambda _cfg: None)
            patch("write_wrapper", lambda _cfg: None)
            patch("write_helpers", lambda _cfg: None)
            patch("configure_runtime_sudoers", lambda _cfg: None)
            patch("verify_runtime_sudoers", lambda _cfg: None)
            patch("configure_cloudflared_with_options", lambda _cfg, install_package=False: None)
            patch("configure_autostart", lambda _cfg: None)
            patch("start_project_host", lambda _cfg: None)
            patch("report_bootstrap_status", lambda _cfg, _status, _message=None: None)

            try:
                result = bootstrap.main(
                    ["reconcile", "--bootstrap-dir", str(bootstrap_dir)]
                )
            finally:
                for name, original in originals.items():
                    setattr(bootstrap, name, original)

            self.assertEqual(result, 0)
            state = json.loads(
                (Path(cfg.bootstrap_dir) / "bootstrap-state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["last_reconcile_result"], "success")


if __name__ == "__main__":
    unittest.main()
