#!/usr/bin/env python3

import io
import json
import os
import pwd
import subprocess
import sys
import tempfile
import tarfile
import time
import unittest
from collections import namedtuple
from dataclasses import replace
from pathlib import Path
from unittest import mock

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
        root_reserve_gb_raw="25",
        data_disk_devices="",
        data_disk_candidates="",
        shared_scratch_enabled=False,
        shared_scratch_devices="",
        shared_scratch_mount="/mnt/cocalc-scratch",
        shared_scratch_project_mount="/scratch",
        shared_scratch_filesystem="ext4",
        project_io_capacity={
            "version": 1,
            "provider": "gcp",
            "targets": [
                {
                    "mountpoint": "/mnt/cocalc",
                    "discovery": "btrfs",
                    "disk_type": "balanced",
                    "required": True,
                }
            ],
        },
        project_io_policy={
            "version": 1,
            "mode": "enforce",
            "mountpoint": "/mnt/cocalc",
            "profile": "gcp-pd-balanced-btrfs-headroom",
            "capacitySource": "gcp-pd-balanced-btrfs-headroom-2026-08-04",
            "capacity": {"mode": "gcp-pd-balanced"},
            "pool": {
                "rbps": 67108864,
                "wbps": 33554432,
                "riops": 2000,
                "wiops": 1000,
            },
            "leafClasses": {
                "standard": {
                    "weight": 100,
                    "rbps": 16777216,
                    "wbps": 8388608,
                    "riops": 500,
                    "wiops": 250,
                },
                "member": {
                    "weight": 200,
                    "rbps": 33554432,
                    "wbps": 16777216,
                    "riops": 1000,
                    "wiops": 500,
                },
                "premium": {
                    "weight": 400,
                    "rbps": 50331648,
                    "wbps": 25165824,
                    "riops": 1500,
                    "wiops": 750,
                },
            },
            "adaptive": {
                "enabled": False,
                "sampleMs": 5000,
                "enterSamples": 6,
                "recoverSamples": 24,
            },
            "ioCost": {"mode": "disabled"},
        },
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


class RuntimeStoragePathHelperTest(unittest.TestCase):
    def helper_namespace(self):
        namespace = {"__name__": "runtime_storage_path_helper_test"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, namespace)
        return namespace

    def helper_run(self):
        return self.helper_namespace()["run"]

    def test_tree_copy_uses_anchored_directories(self) -> None:
        run = self.helper_run()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "source"
            preserve_dest = root / "preserve-dest"
            reflink_dest = root / "reflink-dest"
            outside = root / "outside"
            source.mkdir()
            preserve_dest.mkdir()
            outside.mkdir()
            (source / "marker").write_text("marker\n", encoding="utf-8")

            allowed_roots = {str(root)}
            run(
                [
                    "copy-tree-preserve",
                    "--root",
                    str(root),
                    "--path",
                    "source",
                    "--dest-root",
                    str(root),
                    "--dest",
                    "preserve-dest",
                ],
                allowed_roots=allowed_roots,
            )
            run(
                [
                    "copy-tree-reflink",
                    "--root",
                    str(root),
                    "--path",
                    "source",
                    "--dest-root",
                    str(root),
                    "--dest",
                    "reflink-dest",
                ],
                allowed_roots=allowed_roots,
            )
            self.assertEqual(
                (preserve_dest / "marker").read_text(encoding="utf-8"),
                "marker\n",
            )
            self.assertEqual(
                (reflink_dest / "marker").read_text(encoding="utf-8"),
                "marker\n",
            )

            (root / "source-link").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                run(
                    [
                        "copy-tree-preserve",
                        "--root",
                        str(root),
                        "--path",
                        "source-link",
                        "--dest-root",
                        str(root),
                        "--dest",
                        "preserve-dest",
                    ],
                    allowed_roots=allowed_roots,
                )

            (root / "dest-link").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                run(
                    [
                        "copy-tree-reflink",
                        "--root",
                        str(root),
                        "--path",
                        "source",
                        "--dest-root",
                        str(root),
                        "--dest",
                        "dest-link",
                    ],
                    allowed_roots=allowed_roots,
                )
            self.assertEqual(list(outside.iterdir()), [])

    def test_overlay_uses_anchored_directories(self) -> None:
        namespace = self.helper_namespace()
        run_overlay = namespace["run_overlay"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            for name in ("lower", "upper", "work", "merged", "outside"):
                (root / name).mkdir()
            with mock.patch.object(namespace["subprocess"], "run") as run:
                run_overlay(
                    [
                        "mount-overlay-project",
                        "--lower-root",
                        str(root),
                        "--lower-path",
                        "lower",
                        "--upper-root",
                        str(root),
                        "--upper-path",
                        "upper",
                        "--work-root",
                        str(root),
                        "--work-path",
                        "work",
                        "--merged-root",
                        str(root),
                        "--merged-path",
                        "merged",
                    ],
                    allowed_roots={str(root)},
                )
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ["/bin/mount", "-t", "overlay", "overlay"])
            self.assertIn("metacopy=on,redirect_dir=on,index=off", args[5])
            self.assertRegex(args[-1], r"^/proc/self/fd/[0-9]+$")

            (root / "lower").rmdir()
            (root / "lower").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaises(OSError):
                run_overlay(
                    [
                        "mount-overlay-project",
                        "--lower-root",
                        str(root),
                        "--lower-path",
                        "lower",
                        "--upper-root",
                        str(root),
                        "--upper-path",
                        "upper",
                        "--work-root",
                        str(root),
                        "--work-path",
                        "work",
                        "--merged-root",
                        str(root),
                        "--merged-path",
                        "merged",
                    ],
                    allowed_roots={str(root)},
                )

    def test_normalize_rootfs_uses_private_bind_mount(self) -> None:
        namespace = self.helper_namespace()
        run_normalize_rootfs = namespace["run_normalize_rootfs"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "rootfs").mkdir()
            runtime_root = root / "run"
            with mock.patch.object(namespace["subprocess"], "run") as run:
                run_normalize_rootfs(
                    [
                        "normalize-rootfs",
                        "--root",
                        str(root),
                        "--path",
                        "rootfs",
                        "--ownership-source",
                        "keep-id",
                        "--podman-user",
                        "cocalc-host",
                    ],
                    allowed_roots={str(root)},
                    runtime_root=str(runtime_root),
                    runtime_root_uid=os.getuid(),
                )
            invocations = [call.args[0] for call in run.call_args_list]
            self.assertEqual(invocations[0][:2], ["/bin/mount", "--bind"])
            self.assertEqual(
                invocations[1][:2],
                [
                    "/usr/local/sbin/cocalc-runtime-storage",
                    "_normalize-rootfs-anchored",
                ],
            )
            self.assertEqual(invocations[2][:2], ["/bin/umount", "-l"])

            (root / "rootfs").rmdir()
            (root / "rootfs").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaises(OSError):
                run_normalize_rootfs(
                    [
                        "normalize-rootfs",
                        "--root",
                        str(root),
                        "--path",
                        "rootfs",
                        "--ownership-source",
                        "keep-id",
                        "--podman-user",
                        "cocalc-host",
                    ],
                    allowed_roots={str(root)},
                    runtime_root=str(runtime_root),
                    runtime_root_uid=os.getuid(),
                )

    def test_rustic_rejects_executable_profile_configuration(self) -> None:
        run_rustic = self.helper_namespace()["run_rustic"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "source").mkdir()
            (root / "profile.toml").write_text(
                """[repository]
repository = "opendal:s3"
password-command = "id"
""",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                run_rustic(
                    [
                        "rustic-project-backup",
                        "--root",
                        str(root),
                        "--path",
                        "source",
                        "--profile-root",
                        str(root),
                        "--profile-path",
                        "profile.toml",
                        "--host",
                        "project-test",
                    ],
                    allowed_roots={str(root)},
                    rustic_candidates=[str(root / "not-used")],
                    profile_run_dir=str(root / "run"),
                    profile_run_dir_uid=os.getuid(),
                )

    def test_rustic_allows_loopback_rest_only_when_enabled(self) -> None:
        run_rustic = self.helper_namespace()["run_rustic"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "source").mkdir()
            profile = root / "profile.toml"
            profile.write_text(
                """[repository]
repository = "rest:http://user:secret@127.0.0.1:9345/rootfs-images"
password = "audit-password"
""",
                encoding="utf-8",
            )
            fake_rustic = root / "rustic"
            fake_rustic.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake_rustic.chmod(0o755)
            args = [
                "rustic-rootfs-backup",
                "--root",
                str(root),
                "--path",
                "source",
                "--profile-root",
                str(root),
                "--profile-path",
                "profile.toml",
                "--host",
                "rootfs-test",
            ]

            with self.assertRaisesRegex(
                ValueError, "managed opendal:s3 backend"
            ):
                run_rustic(
                    args,
                    allowed_roots={str(root)},
                    rustic_candidates=[str(fake_rustic)],
                    profile_run_dir=str(root / "run-denied"),
                    profile_run_dir_uid=os.getuid(),
                )

            run_rustic(
                args,
                allowed_roots={str(root)},
                rustic_candidates=[str(fake_rustic)],
                profile_run_dir=str(root / "run-allowed"),
                profile_run_dir_uid=os.getuid(),
                allow_loopback_rest=True,
            )

            profile.write_text(
                profile.read_text(encoding="utf-8").replace(
                    "127.0.0.1", "169.254.169.254"
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "local loopback HTTP"):
                run_rustic(
                    args,
                    allowed_roots={str(root)},
                    rustic_candidates=[str(fake_rustic)],
                    profile_run_dir=str(root / "run-non-loopback"),
                    profile_run_dir_uid=os.getuid(),
                    allow_loopback_rest=True,
                )

    def test_rustic_uses_anchored_validated_profile_snapshot(self) -> None:
        run_rustic = self.helper_namespace()["run_rustic"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "source"
            source.mkdir()
            (root / "profile.toml").write_text(
                """[repository]
repository = "opendal:s3"
password = "audit-password"
[repository.options]
access_key_id = "access"
bucket = "bucket"
endpoint = "https://object.invalid"
region = "auto"
root = "project-test"
secret_access_key = "secret"
""",
                encoding="utf-8",
            )
            invocation = root / "invocation"
            fake_rustic = root / "rustic"
            fake_rustic.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f"printf '%s\\n' \"$PWD\" \"$@\" > {invocation}\n",
                encoding="utf-8",
            )
            fake_rustic.chmod(0o755)
            profile_run_dir = root / "run"
            run_rustic(
                [
                    "rustic-project-backup",
                    "--root",
                    str(root),
                    "--path",
                    "source",
                    "--profile-root",
                    str(root),
                    "--profile-path",
                    "profile.toml",
                    "--host",
                    "project-test",
                    "--tag",
                    "audit",
                ],
                allowed_roots={str(root)},
                rustic_candidates=[str(fake_rustic)],
                profile_run_dir=str(profile_run_dir),
                profile_run_dir_uid=os.getuid(),
            )
            lines = invocation.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], str(source))
            self.assertIn("backup", lines)
            self.assertIn("--host", lines)
            self.assertEqual(list(profile_run_dir.iterdir()), [])

            outside = root / "outside-profile.toml"
            outside.write_text(
                """[repository]
repository = "opendal:s3"
password = "audit"
[repository.options]
access_key_id = "access"
bucket = "bucket"
endpoint = "https://object.invalid"
region = "auto"
root = "project-test"
secret_access_key = "secret"
""",
                encoding="utf-8",
            )
            (root / "profile-link.toml").symlink_to(outside)
            with self.assertRaises(OSError):
                run_rustic(
                    [
                        "rustic-project-backup",
                        "--root",
                        str(root),
                        "--path",
                        "source",
                        "--profile-root",
                        str(root),
                        "--profile-path",
                        "profile-link.toml",
                        "--host",
                        "project-test",
                    ],
                    allowed_roots={str(root)},
                    rustic_candidates=[str(fake_rustic)],
                    profile_run_dir=str(profile_run_dir),
                    profile_run_dir_uid=os.getuid(),
                )

    def test_rootfs_rustic_reconciles_concurrent_initialization(self) -> None:
        namespace = self.helper_namespace()
        run_rustic = namespace["run_rustic"]
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "source").mkdir()
            (root / "profile.toml").write_text(
                """[repository]
repository = "opendal:s3"
password = "audit-password"
[repository.options]
access_key_id = "access"
bucket = "bucket"
endpoint = "https://object.invalid"
region = "auto"
root = "rootfs-test"
secret_access_key = "secret"
""",
                encoding="utf-8",
            )
            fake_rustic = root / "rustic"
            fake_rustic.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake_rustic.chmod(0o755)
            calls: list[list[str]] = []
            repoinfo_results = iter((1, 1, 0))

            def rustic_run(args, **_kwargs):
                calls.append(args)
                if "repoinfo" in args:
                    return subprocess.CompletedProcess(
                        args, next(repoinfo_results), "", ""
                    )
                if "init" in args:
                    # Another publisher initialized the repository first.
                    return subprocess.CompletedProcess(args, 1, "", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            with (
                mock.patch.object(namespace["subprocess"], "run", rustic_run),
                mock.patch.object(namespace["time"], "sleep") as sleep,
            ):
                run_rustic(
                    [
                        "rustic-rootfs-backup",
                        "--root",
                        str(root),
                        "--path",
                        "source",
                        "--profile-root",
                        str(root),
                        "--profile-path",
                        "profile.toml",
                        "--host",
                        "rootfs-test",
                    ],
                    allowed_roots={str(root)},
                    rustic_candidates=[str(fake_rustic)],
                    profile_run_dir=str(root / "run"),
                    profile_run_dir_uid=os.getuid(),
                )

            self.assertEqual(sum("repoinfo" in call for call in calls), 3)
            self.assertEqual(sum("init" in call for call in calls), 1)
            self.assertEqual(sum("backup" in call for call in calls), 1)
            init_call = next(call for call in calls if "init" in call)
            self.assertNotIn("--no-progress", init_call)
            sleep.assert_called_once_with(0.25)


class ProjectHostStartTest(unittest.TestCase):
    def make_project_host_cfg(self, tmpdir: str) -> bootstrap.BootstrapConfig:
        base = Path(tmpdir)
        runtime_root = base / "runtime"
        current = runtime_root / "current"
        (current / "bundle").mkdir(parents=True)
        (current / "bundle" / "index.js").write_text("", encoding="utf-8")
        (runtime_root / "bin").mkdir(parents=True)
        (runtime_root / "bin" / "ctl").write_text("", encoding="utf-8")
        return replace(
            make_cfg(tmpdir),
            project_host_bundle=bootstrap.BundleSpec(
                "",
                None,
                "",
                str(runtime_root / "bundles"),
                str(current),
                str(current),
                "",
            ),
        )
    def test_start_project_host_runs_ctl_from_runtime_home(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = self.make_project_host_cfg(tmpdir)
            calls = []
            original_run_cmd = bootstrap.run_cmd
            original_ensure_runtime_user_manager = bootstrap.ensure_runtime_user_manager

            def fake_run_cmd(_cfg, args, desc, **kwargs):
                calls.append((args, desc, kwargs))
                return subprocess.CompletedProcess(args, 0, stdout="")

            try:
                bootstrap.run_cmd = fake_run_cmd
                bootstrap.ensure_runtime_user_manager = lambda _cfg: None
                bootstrap.start_project_host(cfg)
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.ensure_runtime_user_manager = original_ensure_runtime_user_manager

            self.assertEqual(
                [call[1] for call in calls],
                ["project-host stop", "project-host start"],
            )
            self.assertEqual(
                [call[2].get("cwd") for call in calls],
                [cfg.bootstrap_home, cfg.bootstrap_home],
            )

    def test_start_project_host_accepts_running_status_after_failed_start(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = self.make_project_host_cfg(tmpdir)
            calls = []
            original_run_cmd = bootstrap.run_cmd
            original_ensure_runtime_user_manager = bootstrap.ensure_runtime_user_manager

            def fake_run_cmd(_cfg, args, desc, **kwargs):
                calls.append((args, desc, kwargs))
                code = 1 if desc == "project-host start" else 0
                return subprocess.CompletedProcess(args, code, stdout="")

            try:
                bootstrap.run_cmd = fake_run_cmd
                bootstrap.ensure_runtime_user_manager = lambda _cfg: None
                bootstrap.start_project_host(cfg)
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.ensure_runtime_user_manager = original_ensure_runtime_user_manager

            self.assertEqual(
                [call[1] for call in calls],
                [
                    "project-host stop",
                    "project-host start",
                    "project-host status after failed start",
                ],
            )
            self.assertEqual(
                [call[2].get("cwd") for call in calls],
                [cfg.bootstrap_home, cfg.bootstrap_home, cfg.bootstrap_home],
            )


class ProjectIoConfigurationTest(unittest.TestCase):
    def test_standalone_wrapper_configuration_disables_io_enforcement(self) -> None:
        cfg = bootstrap.standalone_privileged_wrapper_config("star-user")

        self.assertEqual(cfg.ssh_user, "star-user")
        self.assertIsNone(cfg.container_runtime_bundle)
        self.assertEqual(cfg.project_io_capacity["provider"], "standalone")
        self.assertEqual(cfg.project_io_policy["mode"], "disabled")
        self.assertEqual(cfg.project_io_policy["profile"], "unconfigured")
        self.assertTrue(cfg.allow_loopback_rustic_rest)

    def test_standalone_wrapper_configuration_requires_runtime_user(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "must not be empty"):
            bootstrap.standalone_privileged_wrapper_config("  ")

    def test_derives_managed_policy_from_existing_capacity_metadata(self) -> None:
        policy = bootstrap.build_project_io_policy(
            {
                "version": 1,
                "provider": "gcp",
                "targets": [
                    {
                        "mountpoint": "/mnt/cocalc",
                        "discovery": "btrfs",
                        "disk_type": "balanced",
                        "required": True,
                    }
                ],
            }
        )
        self.assertEqual(policy["mode"], "enforce")
        self.assertEqual(policy["capacity"]["mode"], "gcp-pd-balanced")
        self.assertEqual(
            policy["profile"], "gcp-pd-balanced-btrfs-headroom"
        )
        self.assertEqual(policy["leafClasses"]["premium"]["wiops"], 750)

    def test_fails_safe_for_unsupported_capacity_metadata(self) -> None:
        policy = bootstrap.build_project_io_policy(
            {
                "version": 1,
                "provider": "gcp",
                "targets": [{"disk_type": "ssd"}],
            }
        )
        self.assertEqual(policy["mode"], "disabled")
        self.assertEqual(policy["capacity"]["mode"], "static")

    def test_replaces_managed_policy_and_preserves_local_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            policy_path = Path(tmpdir) / "policy.json"
            override_path = Path(tmpdir) / "override.json"
            capacity_path = Path(tmpdir) / "capacity.json"
            policy_path.write_text('{"mode":"disabled"}\n', encoding="utf-8")
            override_text = '{"mode":"observe"}\n'
            override_path.write_text(override_text, encoding="utf-8")
            original_chown = bootstrap.os.chown
            try:
                bootstrap.os.chown = lambda *_args, **_kwargs: None
                bootstrap.write_project_io_configuration(
                    cfg,
                    policy_path=policy_path,
                    override_path=override_path,
                    capacity_path=capacity_path,
                )
            finally:
                bootstrap.os.chown = original_chown

            self.assertEqual(
                json.loads(policy_path.read_text()), cfg.project_io_policy
            )
            self.assertEqual(
                json.loads(capacity_path.read_text()), cfg.project_io_capacity
            )
            self.assertEqual(override_path.read_text(), override_text)
            self.assertEqual(override_path.stat().st_mode & 0o777, 0o600)

    def test_archives_legacy_managed_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            policy_path = Path(tmpdir) / "policy.json"
            override_path = Path(tmpdir) / "override.json"
            capacity_path = Path(tmpdir) / "capacity.json"
            override_path.write_text(
                json.dumps(bootstrap.LEGACY_MANAGED_PROJECT_IO_OVERRIDE),
                encoding="utf-8",
            )
            original_chown = bootstrap.os.chown
            try:
                bootstrap.os.chown = lambda *_args, **_kwargs: None
                bootstrap.write_project_io_configuration(
                    cfg,
                    policy_path=policy_path,
                    override_path=override_path,
                    capacity_path=capacity_path,
                )
            finally:
                bootstrap.os.chown = original_chown

            retired_path = override_path.with_name(
                f"{override_path.name}.retired-gcp-pd-balanced-size-formula-2026-07-24"
            )
            self.assertFalse(override_path.exists())
            self.assertEqual(
                json.loads(retired_path.read_text()),
                bootstrap.LEGACY_MANAGED_PROJECT_IO_OVERRIDE,
            )
            self.assertEqual(retired_path.stat().st_mode & 0o777, 0o600)


class BootstrapSharedScratchTest(unittest.TestCase):
    def test_reconcile_mounts_scratch_before_containment(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(make_cfg(tmpdir), shared_scratch_enabled=True)
            events: list[str] = []
            originals = {}

            def patch(name: str) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(
                    bootstrap,
                    name,
                    lambda _cfg, name=name: events.append(name),
                )

            names = [
                "ensure_cocalc_mount",
                "setup_shared_scratch",
                "ensure_btrfs_data",
                "reconcile_bees_runtime_policy",
                "reconcile_project_network_limits",
                "reconcile_project_io_policy",
                "reconcile_host_service_cgroup",
            ]
            try:
                for name in names:
                    patch(name)
                bootstrap.reconcile_storage_and_containment(cfg)
            finally:
                for name, original in originals.items():
                    setattr(bootstrap, name, original)

            self.assertEqual(events, names)

    def test_setup_shared_scratch_formats_mounts_and_records_fstab(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            device = Path(tmpdir) / "scratch-device"
            device.touch()
            mount = Path(tmpdir) / "mnt" / "scratch"
            cfg = replace(
                make_cfg(tmpdir),
                shared_scratch_enabled=True,
                shared_scratch_devices=str(device),
                shared_scratch_mount=str(mount),
            )
            run_calls = []
            best_effort_calls = []
            fstab_lines = []
            chmod_calls = []

            original_check_output = subprocess.check_output
            original_run_cmd = bootstrap.run_cmd
            original_run_best_effort = bootstrap.run_best_effort
            original_update_fstab = bootstrap.update_fstab
            original_chmod = os.chmod
            original_log_line = bootstrap.log_line

            def fake_check_output(args, text=False, **_kwargs):
                if args[:4] == ["lsblk", "-nr", "-o", "MOUNTPOINT"]:
                    return "" if text else b""
                if args[:4] == ["lsblk", "-nb", "-o", "SIZE"]:
                    value = str(200 * 1024 * 1024 * 1024) + "\n"
                    return value if text else value.encode()
                if args[:3] == ["lsblk", "-no", "FSTYPE"]:
                    return "" if text else b""
                if args[:5] == ["blkid", "-s", "UUID", "-o", "value"]:
                    return "scratch-uuid\n" if text else b"scratch-uuid\n"
                return original_check_output(args, text=text, **_kwargs)

            try:
                subprocess.check_output = fake_check_output
                bootstrap.run_cmd = lambda _cfg, args, desc, **_kwargs: run_calls.append(
                    (args, desc)
                )
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc, **_kwargs: best_effort_calls.append(
                        (args, desc)
                    )
                )
                bootstrap.update_fstab = lambda line, **_kwargs: fstab_lines.append(
                    line
                )
                os.chmod = lambda path, mode: chmod_calls.append((path, mode))
                bootstrap.log_line = lambda *_args, **_kwargs: None

                bootstrap.setup_shared_scratch(cfg)
            finally:
                subprocess.check_output = original_check_output
                bootstrap.run_cmd = original_run_cmd
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.update_fstab = original_update_fstab
                os.chmod = original_chmod
                bootstrap.log_line = original_log_line

            self.assertIn(
                (["mkfs.ext4", "-F", str(device)], "mkfs.ext4 shared scratch"),
                run_calls,
            )
            self.assertIn(
                (["mount", str(device), str(mount)], "mount shared scratch disk"),
                run_calls,
            )
            self.assertEqual(
                fstab_lines,
                [f"UUID=scratch-uuid {mount} ext4 defaults,nofail 0 2 # cocalc-scratch"],
            )
            self.assertIn(
                (["resize2fs", str(device)], "resize shared scratch filesystem"),
                best_effort_calls,
            )
            self.assertEqual(chmod_calls, [(str(mount), 0o1777)])


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
            runtime_current = Path(tmpdir) / "container-runtime" / "current"
            managed_podman = runtime_current / "bin" / "podman"
            managed_podman.parent.mkdir(parents=True)
            managed_podman.write_text("#!/bin/sh\n", encoding="utf-8")
            managed_podman.chmod(0o755)

            original = bootstrap.run_best_effort
            original_current = os.environ.get("COCALC_CONTAINER_RUNTIME_CURRENT")
            bootstrap.run_best_effort = lambda *args, **kwargs: None
            try:
                os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = str(runtime_current)
                bootstrap.configure_runtime_shell_env(cfg)
                bootstrap.configure_runtime_shell_env(cfg)
            finally:
                bootstrap.run_best_effort = original
                if original_current is None:
                    os.environ.pop("COCALC_CONTAINER_RUNTIME_CURRENT", None)
                else:
                    os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = original_current

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
            self.assertIn(
                f'export PATH="{runtime_current / "bin"}:$PATH"', text
            )
            self.assertIn(
                f'export CONTAINERS_CONF_OVERRIDE="{runtime_current / "etc" / "containers" / "containers.conf"}"',
                text,
            )


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

    def test_installs_privileged_rustic_from_verified_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            remote = Path(tmpdir) / "tools.tar.xz"
            payload = b"#!/usr/bin/env bash\nexit 0\n"
            with tarfile.open(remote, mode="w:xz") as archive:
                for name in ("bin/bees", "bin/rustic"):
                    member = tarfile.TarInfo(name)
                    member.mode = 0o755
                    member.size = len(payload)
                    archive.addfile(member, io.BytesIO(payload))
            bundle = replace(
                cfg.tools_bundle,
                url="https://example.invalid/tools.tar.xz",
                sha256=bootstrap.hashlib.sha256(remote.read_bytes()).hexdigest(),
                remote=str(remote),
            )
            destinations = {
                "bin/bees": Path(tmpdir) / "trusted" / "bees",
                "bin/rustic": Path(tmpdir) / "trusted" / "rustic",
            }

            bootstrap.install_privileged_tool_binaries(
                cfg,
                bundle,
                destinations=destinations,
                destination_uid=os.getuid(),
                destination_gid=os.getgid(),
            )

            for destination in destinations.values():
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(destination.stat().st_mode & 0o777, 0o755)

    def test_installs_privileged_tools_from_trusted_local_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            remote = Path(tmpdir) / "tools.tar.xz"
            payload = b"#!/usr/bin/env bash\nexit 0\n"
            with tarfile.open(remote, mode="w:xz") as archive:
                for name in ("bin/bees", "bin/rustic"):
                    member = tarfile.TarInfo(name)
                    member.mode = 0o755
                    member.size = len(payload)
                    archive.addfile(member, io.BytesIO(payload))
            destinations = {
                "bin/bees": Path(tmpdir) / "trusted" / "bees",
                "bin/rustic": Path(tmpdir) / "trusted" / "rustic",
            }

            bootstrap.install_privileged_tool_binaries_from_archive(
                remote,
                destinations=destinations,
                destination_uid=os.getuid(),
                destination_gid=os.getgid(),
            )

            for destination in destinations.values():
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(destination.stat().st_mode & 0o777, 0o755)

    def test_download_file_retries_curl_fallback_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            dest = str(Path(tmpdir) / "download.bin")
            attempts = []
            sleeps = []
            original_urlopen = bootstrap.urllib.request.urlopen
            original_which = bootstrap.shutil.which
            original_run_cmd = bootstrap.run_cmd
            original_sleep = bootstrap.time.sleep
            try:
                def fail_urlopen(*_args, **_kwargs):
                    raise RuntimeError("urllib failed")

                def fake_which(name):
                    if name == "curl":
                        return "/usr/bin/curl"
                    return original_which(name)

                def fake_run_cmd(_cfg, args, desc, **_kwargs):
                    attempts.append((args, desc))
                    if len(attempts) == 1:
                        raise RuntimeError("curl failed")
                    Path(dest).write_text("ok", encoding="utf-8")
                    return subprocess.CompletedProcess(args, 0)

                bootstrap.urllib.request.urlopen = fail_urlopen
                bootstrap.shutil.which = fake_which
                bootstrap.run_cmd = fake_run_cmd
                bootstrap.time.sleep = lambda seconds: sleeps.append(seconds)

                bootstrap.download_file(
                    cfg,
                    "https://example.invalid/file.tar.xz",
                    dest,
                    attempts=2,
                )
            finally:
                bootstrap.urllib.request.urlopen = original_urlopen
                bootstrap.shutil.which = original_which
                bootstrap.run_cmd = original_run_cmd
                bootstrap.time.sleep = original_sleep

            self.assertEqual(Path(dest).read_text(encoding="utf-8"), "ok")
            self.assertEqual(len(attempts), 2)
            self.assertEqual(sleeps, [5])


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


class BootstrapKernelModuleHardeningTest(unittest.TestCase):
    def test_disables_algif_aead_and_unloads_module_best_effort(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            calls: list[tuple[list[str], str]] = []

            original = bootstrap.run_best_effort
            bootstrap.run_best_effort = (
                lambda _cfg, args, desc: calls.append((args, desc))
            )
            try:
                bootstrap.configure_kernel_module_hardening(
                    cfg, modprobe_dir=Path(tmpdir) / "modprobe.d"
                )
            finally:
                bootstrap.run_best_effort = original

            conf = Path(tmpdir) / "modprobe.d" / "disable-algif-aead.conf"
            self.assertEqual(
                conf.read_text(encoding="utf-8"),
                'install algif_aead /bin/false\n',
            )
            self.assertEqual(
                calls,
                [(["rmmod", "algif_aead"], "unload algif_aead")],
            )


class BootstrapKernelKeyLimitsTest(unittest.TestCase):
    def test_configures_kernel_key_quotas_for_rootless_containers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            calls: list[tuple[list[str], str]] = []
            stale_conf = (
                Path(tmpdir) / "sysctl.d" / "60-cocalc-project-host-keyring.conf"
            )
            stale_conf.parent.mkdir(parents=True)
            stale_conf.write_text(
                "[kernel]\nkeys.maxkeys = 100\n", encoding="utf-8"
            )

            original = bootstrap.run_best_effort
            bootstrap.run_best_effort = (
                lambda _cfg, args, desc: calls.append((args, desc))
            )
            try:
                bootstrap.configure_kernel_key_limits(
                    cfg, sysctl_dir=Path(tmpdir) / "sysctl.d"
                )
            finally:
                bootstrap.run_best_effort = original

            conf = Path(tmpdir) / "sysctl.d" / "60-cocalc-project-host-keyring.conf"
            self.assertFalse(conf.exists())
            self.assertEqual(
                calls,
                [
                    (
                        ["sysctl", "-w", "kernel.keys.maxkeys=20000"],
                        "sysctl kernel.keys.maxkeys",
                    ),
                    (
                        ["sysctl", "-w", "kernel.keys.maxbytes=25000000"],
                        "sysctl kernel.keys.maxbytes",
                    ),
                ],
            )


class BootstrapInotifyLimitsTest(unittest.TestCase):
    def test_configures_inotify_quotas_for_project_workloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            calls: list[tuple[list[str], str]] = []
            stale_conf = (
                Path(tmpdir) / "sysctl.d" / "60-cocalc-project-host-inotify.conf"
            )
            stale_conf.parent.mkdir(parents=True)
            stale_conf.write_text(
                "[fs.inotify]\nmax_user_instances = 100\n", encoding="utf-8"
            )

            original = bootstrap.run_best_effort
            bootstrap.run_best_effort = (
                lambda _cfg, args, desc: calls.append((args, desc))
            )
            try:
                bootstrap.configure_inotify_limits(
                    cfg, sysctl_dir=Path(tmpdir) / "sysctl.d"
                )
            finally:
                bootstrap.run_best_effort = original

            conf = Path(tmpdir) / "sysctl.d" / "60-cocalc-project-host-inotify.conf"
            self.assertFalse(conf.exists())
            self.assertEqual(
                calls,
                [
                    (
                        ["sysctl", "-w", "fs.inotify.max_user_instances=8192"],
                        "sysctl fs.inotify.max_user_instances",
                    ),
                    (
                        ["sysctl", "-w", "fs.inotify.max_user_watches=2097152"],
                        "sysctl fs.inotify.max_user_watches",
                    ),
                    (
                        ["sysctl", "-w", "fs.inotify.max_queued_events=65536"],
                        "sysctl fs.inotify.max_queued_events",
                    ),
                ],
            )


class BootstrapJournaldLimitsTest(unittest.TestCase):
    def test_unchanged_limits_do_not_restart_or_vacuum_journald(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            dropin_dir = Path(tmpdir) / "journald.conf.d"
            dropin_dir.mkdir()
            (dropin_dir / "90-cocalc-root-disk.conf").write_text(
                "[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=100M\n",
                encoding="utf-8",
            )
            calls = []
            original_run_best_effort = bootstrap.run_best_effort
            original_which = bootstrap.shutil.which
            try:
                bootstrap.run_best_effort = lambda *args, **kwargs: calls.append(
                    (args, kwargs)
                )
                bootstrap.shutil.which = lambda _name: "/usr/bin/systemctl"
                bootstrap.configure_journald_limits(
                    cfg,
                    dropin_dir=dropin_dir,
                )
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.shutil.which = original_which

            self.assertEqual(calls, [])

    def test_changed_limits_use_nonblocking_bounded_operations(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            dropin_dir = Path(tmpdir) / "journald.conf.d"
            calls = []
            original_run_best_effort = bootstrap.run_best_effort
            original_which = bootstrap.shutil.which
            try:
                bootstrap.run_best_effort = lambda *args, **kwargs: calls.append(
                    (args, kwargs)
                )
                bootstrap.shutil.which = lambda _name: "/usr/bin/tool"
                bootstrap.configure_journald_limits(
                    cfg,
                    dropin_dir=dropin_dir,
                )
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.shutil.which = original_which

            self.assertEqual(
                (dropin_dir / "90-cocalc-root-disk.conf").read_text(
                    encoding="utf-8"
                ),
                "[Journal]\nSystemMaxUse=200M\nRuntimeMaxUse=100M\n",
            )
            self.assertEqual(
                calls,
                [
                    (
                        (
                            cfg,
                            [
                                "systemctl",
                                "restart",
                                "--no-block",
                                "systemd-journald",
                            ],
                            "queue systemd-journald restart",
                        ),
                        {"timeout": 15},
                    ),
                    (
                        (
                            cfg,
                            ["journalctl", "--vacuum-size=200M"],
                            "vacuum systemd journal",
                        ),
                        {"timeout": 60},
                    ),
                ],
            )


class BootstrapRsyslogLimitsTest(unittest.TestCase):
    def test_unchanged_limits_do_not_queue_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            logrotate_path = Path(tmpdir) / "logrotate.d" / "rsyslog"
            logrotate_path.parent.mkdir()
            logrotate_path.write_text(
                bootstrap.RSYSLOG_LOGROTATE_CONTENT,
                encoding="utf-8",
            )
            rsyslog_config_dir = Path(tmpdir) / "rsyslog.d"
            rsyslog_config_dir.mkdir()
            (rsyslog_config_dir / "50-default.conf").write_text(
                f"{bootstrap.RSYSLOG_HEADLESS_OUTPUT_COMMENT}\n"
                "# *.emerg :omusrmsg:*\n",
                encoding="utf-8",
            )
            calls = []
            original_run_best_effort = bootstrap.run_best_effort
            try:
                bootstrap.run_best_effort = lambda *args, **kwargs: calls.append(
                    (args, kwargs)
                )
                bootstrap.configure_rsyslog_limits(
                    cfg,
                    logrotate_path=logrotate_path,
                    rsyslog_config_dir=rsyslog_config_dir,
                )
            finally:
                bootstrap.run_best_effort = original_run_best_effort

            self.assertEqual(calls, [])

    def test_changed_limits_queue_nonblocking_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            logrotate_path = Path(tmpdir) / "logrotate.d" / "rsyslog"
            logrotate_path.parent.mkdir()
            rsyslog_config_dir = Path(tmpdir) / "rsyslog.d"
            calls = []
            original_run_best_effort = bootstrap.run_best_effort
            original_which = bootstrap.shutil.which
            try:
                bootstrap.run_best_effort = lambda *args, **kwargs: calls.append(
                    (args, kwargs)
                )
                bootstrap.shutil.which = lambda _name: "/usr/bin/systemctl"
                bootstrap.configure_rsyslog_limits(
                    cfg,
                    logrotate_path=logrotate_path,
                    rsyslog_config_dir=rsyslog_config_dir,
                )
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.shutil.which = original_which

            self.assertEqual(
                logrotate_path.read_text(encoding="utf-8"),
                bootstrap.RSYSLOG_LOGROTATE_CONTENT,
            )
            self.assertEqual(
                calls,
                [
                    (
                        (
                            cfg,
                            [
                                "systemctl",
                                "start",
                                "--no-block",
                                "logrotate.service",
                            ],
                            "queue classic system log rotation",
                        ),
                        {"timeout": 15},
                    )
                ],
            )

    def test_disables_headless_interactive_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            logrotate_path = Path(tmpdir) / "logrotate.d" / "rsyslog"
            logrotate_path.parent.mkdir()
            logrotate_path.write_text(
                bootstrap.RSYSLOG_LOGROTATE_CONTENT,
                encoding="utf-8",
            )
            rsyslog_config_dir = Path(tmpdir) / "rsyslog.d"
            rsyslog_config_dir.mkdir()
            default_config_path = rsyslog_config_dir / "50-default.conf"
            default_config_path.write_text(
                "auth,authpriv.* /var/log/auth.log\n"
                "*.emerg                 :omusrmsg:*\n",
                encoding="utf-8",
            )
            google_config_path = rsyslog_config_dir / "90-google.conf"
            google_config_path.write_text(
                "daemon,kern.* /dev/console\n",
                encoding="utf-8",
            )
            calls = []
            original_run_best_effort = bootstrap.run_best_effort
            original_which = bootstrap.shutil.which
            try:
                bootstrap.run_best_effort = lambda *args, **kwargs: calls.append(
                    (args, kwargs)
                )
                bootstrap.shutil.which = lambda _name: "/usr/bin/systemctl"
                bootstrap.configure_rsyslog_limits(
                    cfg,
                    logrotate_path=logrotate_path,
                    rsyslog_config_dir=rsyslog_config_dir,
                )
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.shutil.which = original_which

            self.assertEqual(
                default_config_path.read_text(encoding="utf-8"),
                "auth,authpriv.* /var/log/auth.log\n"
                f"{bootstrap.RSYSLOG_HEADLESS_OUTPUT_COMMENT}\n"
                "# *.emerg                 :omusrmsg:*\n",
            )
            self.assertEqual(
                google_config_path.read_text(encoding="utf-8"),
                f"{bootstrap.RSYSLOG_HEADLESS_OUTPUT_COMMENT}\n"
                "# daemon,kern.* /dev/console\n",
            )
            self.assertEqual(
                calls,
                [
                    (
                        (
                            cfg,
                            [
                                "systemctl",
                                "restart",
                                "--no-block",
                                "rsyslog.service",
                            ],
                            "queue rsyslog restart after disabling interactive delivery",
                        ),
                        {"timeout": 15},
                    )
                ],
            )


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
            lifecycle_export_dir = Path(tmpdir) / "public-lifecycle"
            cfg = replace(
                cfg,
                conat_url="https://hub.example.invalid/conat/master-token",
                status_url="https://hub.example.invalid/bootstrap/status",
                bootstrap_token="bootstrap-secret",
                ca_cert_path="/etc/ssl/cocalc-ca.pem",
                project_host_bundle=replace(
                    cfg.project_host_bundle,
                    root="/opt/cocalc/project-host/bundles",
                    version="project-host-version",
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
            original_resolve = bootstrap.resolve_runtime_user_identity
            original_export_dir = bootstrap.BOOTSTRAP_LIFECYCLE_EXPORT_DIR
            try:
                bootstrap.resolve_runtime_user_identity = lambda _cfg: (2000, 2000)
                bootstrap.BOOTSTRAP_LIFECYCLE_EXPORT_DIR = lifecycle_export_dir
                bootstrap.write_bootstrap_state_files(cfg)
            finally:
                bootstrap.resolve_runtime_user_identity = original_resolve
                bootstrap.BOOTSTRAP_LIFECYCLE_EXPORT_DIR = original_export_dir

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
            public_desired = json.loads(
                (lifecycle_export_dir / "bootstrap-desired-state.json").read_text(
                    encoding="utf-8"
                )
            )
            public_state = json.loads(
                (lifecycle_export_dir / "bootstrap-state.json").read_text(
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
                "missing-runtime-user:2000:2000",
            )
            self.assertEqual(
                desired["runtime_user_contract"]["fingerprint"],
                bootstrap.runtime_userns_map_fingerprint(
                    [
                        "0 2000 1",
                        "1 231072 65536",
                        "65537 327680 4128768",
                    ],
                    [
                        "0 2000 1",
                        "1 231072 65536",
                        "65537 327680 4128768",
                    ],
                ),
            )
            self.assertEqual(state["runtime_user_contract"]["user"], "missing-runtime-user")
            self.assertIn("installed", state)
            self.assertNotIn("bootstrap_connection", public_desired)
            self.assertNotIn("env_lines", public_desired)
            self.assertNotIn("bootstrap-secret", json.dumps(public_desired))
            self.assertEqual(
                public_desired["project_host_bundle"],
                {
                    "root": "/opt/cocalc/project-host/bundles",
                    "version": "project-host-version",
                },
            )
            self.assertEqual(
                public_state["runtime_user_contract"]["user"],
                "missing-runtime-user",
            )
            self.assertEqual(lifecycle_export_dir.stat().st_mode & 0o777, 0o755)
            self.assertEqual(
                (lifecycle_export_dir / "bootstrap-state.json").stat().st_mode
                & 0o777,
                0o644,
            )


class BootstrapRuntimeUserContractTest(unittest.TestCase):
    def test_runtime_manager_prepares_default_podman_runtime_dir(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        cfg = replace(cfg, ssh_user="runtime-user")
        prepared = []
        original_getpwnam = bootstrap.pwd.getpwnam
        original_which = bootstrap.shutil.which
        original_read_env = bootstrap.read_env_assignments
        original_ensure_dir = bootstrap.ensure_owned_runtime_dir
        try:
            bootstrap.pwd.getpwnam = lambda _user: type(
                "Pwd", (), {"pw_uid": 2000, "pw_gid": 2000}
            )()
            bootstrap.shutil.which = lambda _name: None
            bootstrap.read_env_assignments = lambda _path: {}
            bootstrap.ensure_owned_runtime_dir = (
                lambda path, uid, gid: prepared.append((str(path), uid, gid))
            )

            bootstrap.ensure_runtime_user_manager(cfg)
        finally:
            bootstrap.pwd.getpwnam = original_getpwnam
            bootstrap.shutil.which = original_which
            bootstrap.read_env_assignments = original_read_env
            bootstrap.ensure_owned_runtime_dir = original_ensure_dir

        self.assertEqual(
            prepared,
            [
                ("/run/user/2000", 2000, 2000),
                ("/run/user/2000", 2000, 2000),
                ("/mnt/cocalc/data/tmp/cocalc-podman-runtime-2000", 2000, 2000),
            ],
        )

    def test_bounded_capture_kills_hung_process_group(self) -> None:
        started = time.monotonic()
        result = bootstrap.run_bounded_capture(
            [sys.executable, "-c", "import time; time.sleep(60)"], 0.05
        )
        self.assertEqual(result.returncode, 124)
        self.assertLess(time.monotonic() - started, 2)

    def test_runtime_user_contract_stops_after_timed_out_uid_probe(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        cfg = replace(cfg, ssh_user=pwd.getpwuid(os.getuid()).pw_name)
        calls = []
        original_which = bootstrap.shutil.which
        original_probe = bootstrap.run_bounded_capture
        try:
            bootstrap.shutil.which = lambda _name: "/usr/bin/podman"

            def fake_probe(args, timeout_s):
                calls.append((args, timeout_s))
                return subprocess.CompletedProcess(args, 124, "", "timed out")

            bootstrap.run_bounded_capture = fake_probe
            contract = bootstrap.read_current_runtime_user_contract(cfg)
        finally:
            bootstrap.shutil.which = original_which
            bootstrap.run_bounded_capture = original_probe

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], bootstrap.RUNTIME_USERNS_MAP_PROBE_TIMEOUT_S)
        self.assertNotIn("uid_map", contract)
        self.assertEqual(contract["probe_error"], "timed out")

    def test_runtime_user_contract_repairs_stale_boot_state_and_retries(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        cfg = replace(cfg, ssh_user=pwd.getpwuid(os.getuid()).pw_name)
        calls = []
        repairs = []
        original_which = bootstrap.shutil.which
        original_probe = bootstrap.run_bounded_capture
        original_repair = bootstrap.repair_stale_podman_boot_state
        try:
            bootstrap.shutil.which = lambda _name: "/usr/bin/podman"

            def fake_probe(args, timeout_s):
                calls.append((args, timeout_s))
                if len(calls) == 1:
                    return subprocess.CompletedProcess(
                        args,
                        125,
                        "",
                        "current system boot ID differs from cached boot ID; "
                        "an unhandled reboot has occurred",
                    )
                map_text = "0 2000 1\n1 231072 65536\n65537 327680 4128768\n"
                return subprocess.CompletedProcess(args, 0, map_text, "")

            bootstrap.run_bounded_capture = fake_probe
            bootstrap.repair_stale_podman_boot_state = lambda _cfg, **kwargs: repairs.append(
                kwargs
            )
            contract = bootstrap.read_current_runtime_user_contract(cfg)
        finally:
            bootstrap.shutil.which = original_which
            bootstrap.run_bounded_capture = original_probe
            bootstrap.repair_stale_podman_boot_state = original_repair

        self.assertEqual(len(calls), 3)
        self.assertEqual(len(repairs), 1)
        self.assertEqual(repairs[0]["uid"], os.getuid())
        self.assertIn("fingerprint", contract)
        self.assertNotIn("probe_error", contract)

    def test_stale_boot_detection_includes_runtime_namespace_failures(self) -> None:
        for error in (
            "current system boot ID differs from cached boot ID",
            "Error: cannot re-exec process to join the existing user namespace",
            "cannot join the existing user namespace",
            "failed to reexec runtime",
            "invalid internal status",
        ):
            with self.subTest(error=error):
                proc = subprocess.CompletedProcess([], 125, "", error)
                self.assertTrue(bootstrap.podman_has_stale_boot_state(proc))
        proc = subprocess.CompletedProcess([], 124, "", "operation timed out")
        self.assertFalse(bootstrap.podman_has_stale_boot_state(proc))

    def test_stale_boot_repair_refuses_live_project_runtimes(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        original_active = bootstrap.project_host_runtime_is_active
        try:
            bootstrap.project_host_runtime_is_active = lambda: True
            with self.assertRaisesRegex(RuntimeError, "project runtimes are active"):
                bootstrap.repair_stale_podman_boot_state(
                    cfg,
                    uid=2000,
                    gid=2000,
                    runtime_dir=bootstrap.default_podman_runtime_dir(2000),
                )
        finally:
            bootstrap.project_host_runtime_is_active = original_active

    def test_stale_boot_repair_only_removes_boot_scoped_paths(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        cfg = replace(cfg, ssh_user="cocalc-host")
        removed = []
        owned = []
        original_active = bootstrap.project_host_runtime_is_active
        original_exists = Path.exists
        original_is_symlink = Path.is_symlink
        original_rmtree = bootstrap.shutil.rmtree
        original_ensure_owned = bootstrap.ensure_owned_runtime_dir
        try:
            bootstrap.project_host_runtime_is_active = lambda: False
            Path.exists = lambda _self: True  # type: ignore[method-assign]
            Path.is_symlink = lambda _self: False  # type: ignore[method-assign]
            bootstrap.shutil.rmtree = lambda path: removed.append(str(path))
            bootstrap.ensure_owned_runtime_dir = (
                lambda path, uid, gid: owned.append((str(path), uid, gid))
            )
            bootstrap.repair_stale_podman_boot_state(
                cfg,
                uid=2000,
                gid=2000,
                runtime_dir=bootstrap.default_podman_runtime_dir(2000),
            )
        finally:
            bootstrap.project_host_runtime_is_active = original_active
            Path.exists = original_exists  # type: ignore[method-assign]
            Path.is_symlink = original_is_symlink  # type: ignore[method-assign]
            bootstrap.shutil.rmtree = original_rmtree
            bootstrap.ensure_owned_runtime_dir = original_ensure_owned

        self.assertEqual(
            removed,
            [
                "/run/cocalc/containers/rootless/cocalc-host",
                "/mnt/cocalc/data/tmp/cocalc-podman-runtime-2000/libpod/tmp",
            ],
        )
        self.assertEqual(
            owned,
            [
                ("/run/cocalc/containers/rootless/cocalc-host", 2000, 2000),
                ("/mnt/cocalc/data/tmp/cocalc-podman-runtime-2000", 2000, 2000),
            ],
        )
        self.assertFalse(any("/containers/rootless/" in path for path in removed[1:]))

    def test_runtime_user_contract_uses_managed_podman(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            cfg = replace(cfg, ssh_user=pwd.getpwuid(os.getuid()).pw_name)
            current = Path(tmpdir) / "runtime" / "current"
            podman = current / "bin" / "podman"
            conf = current / "etc" / "containers" / "containers.conf"
            podman.parent.mkdir(parents=True)
            conf.parent.mkdir(parents=True)
            podman.write_text("#!/bin/sh\n", encoding="utf-8")
            podman.chmod(0o755)
            conf.write_text("[engine]\n", encoding="utf-8")
            calls = []
            original_current = os.environ.get("COCALC_CONTAINER_RUNTIME_CURRENT")
            original_probe = bootstrap.run_bounded_capture
            try:
                os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = str(current)

                def fake_probe(args, timeout_s):
                    calls.append((args, timeout_s))
                    map_text = "0 2000 1\n1 231072 65536\n65537 327680 4128768\n"
                    return subprocess.CompletedProcess(args, 0, map_text, "")

                bootstrap.run_bounded_capture = fake_probe
                contract = bootstrap.read_current_runtime_user_contract(cfg)
            finally:
                bootstrap.run_bounded_capture = original_probe
                if original_current is None:
                    os.environ.pop("COCALC_CONTAINER_RUNTIME_CURRENT", None)
                else:
                    os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = original_current

            self.assertEqual(len(calls), 2)
            self.assertIn(str(podman), calls[0][0][-1])
            self.assertIn(
                f"CONTAINERS_CONF_OVERRIDE={conf}",
                calls[0][0],
            )
            self.assertTrue(
                any(value.startswith("XDG_RUNTIME_DIR=") for value in calls[0][0])
            )
            self.assertIn("fingerprint", contract)

    def test_runtime_user_contract_uses_loaded_podman_apparmor_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            cfg = replace(cfg, ssh_user=pwd.getpwuid(os.getuid()).pw_name)
            current = Path(tmpdir) / "runtime" / "current"
            podman = current / "bin" / "podman"
            conf = current / "etc" / "containers" / "containers.conf"
            podman.parent.mkdir(parents=True)
            conf.parent.mkdir(parents=True)
            podman.write_text("#!/bin/sh\n", encoding="utf-8")
            podman.chmod(0o755)
            conf.write_text("[engine]\n", encoding="utf-8")
            calls = []
            original_current = os.environ.get("COCALC_CONTAINER_RUNTIME_CURRENT")
            original_probe = bootstrap.run_bounded_capture
            original_run = bootstrap.subprocess.run
            original_which = bootstrap.shutil.which
            try:
                os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = str(current)
                bootstrap.shutil.which = lambda name: (
                    "/usr/bin/aa-exec" if name == "aa-exec" else original_which(name)
                )
                bootstrap.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(
                    args[0], 0
                )

                def fake_probe(args, timeout_s):
                    calls.append((args, timeout_s))
                    map_text = "0 2000 1\n1 231072 65536\n65537 327680 4128768\n"
                    return subprocess.CompletedProcess(args, 0, map_text, "")

                bootstrap.run_bounded_capture = fake_probe
                contract = bootstrap.read_current_runtime_user_contract(cfg)
            finally:
                bootstrap.run_bounded_capture = original_probe
                bootstrap.subprocess.run = original_run
                bootstrap.shutil.which = original_which
                if original_current is None:
                    os.environ.pop("COCALC_CONTAINER_RUNTIME_CURRENT", None)
                else:
                    os.environ["COCALC_CONTAINER_RUNTIME_CURRENT"] = original_current

            self.assertEqual(len(calls), 2)
            for args, _timeout_s in calls:
                self.assertIn(
                    f"/usr/bin/aa-exec -p podman -- {podman} unshare cat",
                    args[-1],
                )
            self.assertIn("fingerprint", contract)

    def test_runtime_user_contract_skips_missing_podman_apparmor_profile(self) -> None:
        original_run = bootstrap.subprocess.run
        original_which = bootstrap.shutil.which
        try:
            bootstrap.shutil.which = lambda name: (
                "/usr/bin/aa-exec" if name == "aa-exec" else original_which(name)
            )
            bootstrap.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(
                args[0], 1
            )
            self.assertEqual(bootstrap.podman_apparmor_exec_prefix(), [])
        finally:
            bootstrap.subprocess.run = original_run
            bootstrap.shutil.which = original_which

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
                "probe_error": "current system boot ID differs from cached boot ID",
            }
            with self.assertRaisesRegex(
                RuntimeError,
                "podman probe failed: current system boot ID differs",
            ):
                bootstrap.verify_runtime_user_contract(cfg)
        finally:
            bootstrap.expected_runtime_user_contract = original_expected
            bootstrap.read_current_runtime_user_contract = original_read


class BootstrapRootlessPodmanResetTest(unittest.TestCase):
    def test_configure_podman_defers_live_runroot_migration(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            home = Path(tmpdir) / "home"
            storage_conf = home / ".config" / "containers" / "storage.conf"
            storage_conf.parent.mkdir(parents=True)
            storage_conf.write_text(
                '[storage]\nrunroot = "/mnt/cocalc/data/containers/rootless/missing-runtime-user/run"\n',
                encoding="utf-8",
            )
            writes = []
            original_runtime_home = bootstrap.runtime_home
            original_runtime_active = bootstrap.project_host_runtime_is_active
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            try:
                bootstrap.runtime_home = lambda _cfg: str(home)
                bootstrap.project_host_runtime_is_active = lambda: True
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, text, encoding="utf-8": writes.append(  # type: ignore[method-assign]
                    (str(self), text)
                )
                bootstrap.configure_podman(cfg)
            finally:
                bootstrap.runtime_home = original_runtime_home
                bootstrap.project_host_runtime_is_active = original_runtime_active
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]

            self.assertEqual(1, len(writes))
            self.assertEqual(
                "/mnt/cocalc/data/containers/runroot-migration-pending",
                writes[0][0],
            )
            self.assertIn(
                "desired=/run/cocalc/containers/rootless/missing-runtime-user",
                writes[0][1],
            )

    def test_configure_podman_does_not_clear_rootless_state_on_subuid_ownership(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []
            removed = []
            writes = []

            original_run_best_effort = bootstrap.run_best_effort
            original_runtime_home = bootstrap.runtime_home
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_has_unexpected = bootstrap.tree_has_unexpected_ownership
            original_rmtree = bootstrap.shutil.rmtree
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.runtime_home = lambda _cfg: str(Path(tmpdir) / "home")
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, text, encoding="utf-8": writes.append(  # type: ignore[method-assign]
                    (str(self), text)
                )
                bootstrap.tree_has_unexpected_ownership = lambda *_args, **_kwargs: True
                bootstrap.shutil.rmtree = lambda path, ignore_errors=False: removed.append(
                    (str(path), ignore_errors)
                )
                bootstrap.configure_podman(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.runtime_home = original_runtime_home
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                bootstrap.tree_has_unexpected_ownership = original_has_unexpected
                bootstrap.shutil.rmtree = original_rmtree

            self.assertEqual([], removed)
            self.assertIn(
                (
                    "/etc/containers/containers.conf",
                    '[engine]\ncgroup_manager = "cgroupfs"\n',
                ),
                writes,
            )
            self.assertIn(
                (
                    str(
                        Path(tmpdir)
                        / "home"
                        / ".config"
                        / "containers"
                        / "containers.conf"
                    ),
                    '[engine]\ncgroup_manager = "cgroupfs"\n',
                ),
                writes,
            )
            self.assertIn(
                (
                    str(
                        Path(tmpdir)
                        / "home"
                        / ".config"
                        / "containers"
                        / "storage.conf"
                    ),
                    '[storage]\ndriver = "overlay"\nrunroot = "/run/cocalc/containers/rootless/missing-runtime-user"\ngraphroot = "/mnt/cocalc/data/containers/rootless/missing-runtime-user/storage"\n',
                ),
                writes,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user/storage",
                    ],
                    "chown rootless podman persistent paths",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/run/cocalc/containers/rootless/missing-runtime-user",
                    ],
                    "chown rootless podman runroot",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chmod",
                        "0711",
                        "/run/cocalc",
                        "/run/cocalc/containers",
                        "/run/cocalc/containers/rootless",
                    ],
                    "make Podman runroot parents traversable",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chmod",
                        "0700",
                        "/run/cocalc/containers/rootless/missing-runtime-user",
                    ],
                    "restrict rootless Podman runroot",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(
                            Path(tmpdir)
                            / "home"
                            / ".config"
                            / "containers"
                            / "containers.conf"
                        ),
                    ],
                    "chown containers.conf",
                ),
                recorded,
            )


class BootstrapRuntimeUserIdentityResolutionTest(unittest.TestCase):
    def test_prefers_first_shared_free_uid_gid_starting_at_2000(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        original_getpwnam = bootstrap.pwd.getpwnam
        original_getgrnam = bootstrap.grp.getgrnam
        original_getpwall = bootstrap.pwd.getpwall
        original_getgrall = bootstrap.grp.getgrall
        try:
            bootstrap.pwd.getpwnam = lambda _user: (_ for _ in ()).throw(KeyError())
            bootstrap.grp.getgrnam = lambda _user: (_ for _ in ()).throw(KeyError())
            bootstrap.pwd.getpwall = lambda: [
                type("Pwd", (), {"pw_uid": 2000})(),
                type("Pwd", (), {"pw_uid": 2001})(),
            ]
            bootstrap.grp.getgrall = lambda: [
                type("Grp", (), {"gr_gid": 2000})(),
                type("Grp", (), {"gr_gid": 2001})(),
            ]
            self.assertEqual(
                bootstrap.resolve_runtime_user_identity(cfg),
                (2002, 2002),
            )
        finally:
            bootstrap.pwd.getpwnam = original_getpwnam
            bootstrap.grp.getgrnam = original_getgrnam
            bootstrap.pwd.getpwall = original_getpwall
            bootstrap.grp.getgrall = original_getgrall

    def test_reuses_existing_runtime_group_gid_and_picks_free_uid(self) -> None:
        cfg = make_cfg(tempfile.mkdtemp())
        original_getpwnam = bootstrap.pwd.getpwnam
        original_getgrnam = bootstrap.grp.getgrnam
        original_getpwall = bootstrap.pwd.getpwall
        original_getgrall = bootstrap.grp.getgrall
        try:
            bootstrap.pwd.getpwnam = lambda _user: (_ for _ in ()).throw(KeyError())
            bootstrap.grp.getgrnam = lambda _user: type("Grp", (), {"gr_gid": 1500})()
            bootstrap.pwd.getpwall = lambda: [
                type("Pwd", (), {"pw_uid": 1500})(),
                type("Pwd", (), {"pw_uid": 2000})(),
            ]
            bootstrap.grp.getgrall = lambda: [type("Grp", (), {"gr_gid": 1500})()]
            self.assertEqual(
                bootstrap.resolve_runtime_user_identity(cfg),
                (2001, 1500),
            )
        finally:
            bootstrap.pwd.getpwnam = original_getpwnam
            bootstrap.grp.getgrnam = original_getgrnam
            bootstrap.pwd.getpwall = original_getpwall
            bootstrap.grp.getgrall = original_getgrall


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

    def test_prune_preserves_live_mountinfo_bundle_versions(self) -> None:
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
            proc_root = Path(tmpdir) / "proc"
            pid_dir = proc_root / "123"
            pid_dir.mkdir(parents=True)
            (pid_dir / "mountinfo").write_text(
                (
                    f"36 25 0:32 {created[1]}//deleted /opt/cocalc/bin2 "
                    "rw,relatime - ext4 /dev/sda rw\n"
                    f"37 25 0:32 {created[2]}\\040(deleted) "
                    "/opt/cocalc/project-bundle rw,relatime - ext4 /dev/sda rw\n"
                ),
                encoding="utf-8",
            )
            bundle = bootstrap.BundleSpec(
                url="",
                sha256=None,
                remote="",
                root=str(root),
                dir=str(created[6]),
                current=str(current),
                version="v7",
            )

            original_proc_root = bootstrap.PROC_ROOT
            try:
                bootstrap.PROC_ROOT = proc_root
                bootstrap.prune_bundle_versions(cfg, bundle, keep=3)
            finally:
                bootstrap.PROC_ROOT = original_proc_root

            remaining = sorted(
                child.name
                for child in root.iterdir()
                if child.is_dir() and not child.is_symlink()
            )
            self.assertEqual(remaining, ["v2", "v3", "v6", "v7"])

    def test_prune_preserves_live_process_bundle_versions(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            root = Path(tmpdir) / "bundles"
            root.mkdir(parents=True, exist_ok=True)
            created: list[Path] = []
            for index in range(1, 8):
                version_dir = root / f"v{index}"
                version_dir.mkdir()
                (version_dir / "supervisor").mkdir()
                os.utime(version_dir, (index, index))
                created.append(version_dir)
            current = root / "current"
            current.symlink_to(created[5], target_is_directory=True)
            proc_root = Path(tmpdir) / "proc"
            pid_dir = proc_root / "123"
            pid_dir.mkdir(parents=True)
            (pid_dir / "cmdline").write_bytes(
                b"project-host:conat-persist\0"
                + os.fsencode(created[1] / "supervisor" / "index.js")
                + b"\0"
            )
            bundle = bootstrap.BundleSpec(
                url="",
                sha256=None,
                remote="",
                root=str(root),
                dir=str(created[6]),
                current=str(current),
                version="v7",
            )

            original_proc_root = bootstrap.PROC_ROOT
            try:
                bootstrap.PROC_ROOT = proc_root
                bootstrap.prune_bundle_versions(cfg, bundle, keep=3)
            finally:
                bootstrap.PROC_ROOT = original_proc_root

            remaining = sorted(
                child.name
                for child in root.iterdir()
                if child.is_dir() and not child.is_symlink()
            )
            self.assertEqual(remaining, ["v2", "v6", "v7"])


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

    def test_ensure_btrfs_data_repairs_host_owned_entries_with_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_run_cmd = bootstrap.run_cmd
            original_exists = Path.exists
            original_mkdir = Path.mkdir
            original_chmod = bootstrap.os.chmod
            original_iterdir = Path.iterdir
            original_is_file = Path.is_file
            original_has_unexpected = bootstrap.tree_has_unexpected_ownership
            original_path_has_unexpected = bootstrap.path_has_unexpected_ownership
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.run_cmd = lambda *args, **kwargs: None
                Path.exists = lambda self: True  # type: ignore[method-assign]
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                Path.iterdir = lambda self: iter(
                    [
                        Path("/mnt/cocalc/data/sync-fs.sqlite"),
                        Path("/mnt/cocalc/data/daemon.pid"),
                    ]
                )  # type: ignore[method-assign]
                Path.is_file = lambda self: str(self) in {  # type: ignore[method-assign]
                    "/mnt/cocalc/data/sync-fs.sqlite",
                    "/mnt/cocalc/data/daemon.pid",
                }

                def fake_has_unexpected(path: Path, _uid: int, _gid: int) -> bool:
                    return str(path) in {
                        "/mnt/cocalc/data/cache",
                        "/mnt/cocalc/data/logs",
                        "/mnt/cocalc/data/sync-fs.sqlite",
                        "/mnt/cocalc/data/daemon.pid",
                    }

                bootstrap.tree_has_unexpected_ownership = fake_has_unexpected
                bootstrap.path_has_unexpected_ownership = fake_has_unexpected
                bootstrap.ensure_btrfs_data(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.run_cmd = original_run_cmd
                Path.exists = original_exists  # type: ignore[method-assign]
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod
                Path.iterdir = original_iterdir  # type: ignore[method-assign]
                Path.is_file = original_is_file  # type: ignore[method-assign]
                bootstrap.tree_has_unexpected_ownership = original_has_unexpected
                bootstrap.path_has_unexpected_ownership = original_path_has_unexpected

            self.assertIn(
                (
                    [
                        "chown",
                        "-R",
                        "missing-runtime-user:missing-runtime-user",
                        "/mnt/cocalc/data/logs",
                    ],
                    "repair host data dir ownership",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/mnt/cocalc/data/cache",
                    ],
                    "repair host data top-level dir ownership",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/mnt/cocalc/data/sync-fs.sqlite",
                        "/mnt/cocalc/data/daemon.pid",
                    ],
                    "repair host data file ownership",
                ),
                recorded,
            )

    def test_configure_podman_chowns_rootless_storage_children(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []
            writes = []

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
                Path.write_text = lambda self, text, encoding="utf-8": writes.append(  # type: ignore[method-assign]
                    (str(self), text)
                )
                bootstrap.configure_podman(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.runtime_home = original_runtime_home
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]

            self.assertIn(
                (
                    "/etc/containers/containers.conf",
                    '[engine]\ncgroup_manager = "cgroupfs"\n',
                ),
                writes,
            )
            self.assertIn(
                (
                    str(Path(tmpdir) / "home" / ".config" / "containers" / "containers.conf"),
                    '[engine]\ncgroup_manager = "cgroupfs"\n',
                ),
                writes,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(Path(tmpdir) / "home" / ".config" / "containers"),
                    ],
                    "chown rootless podman config",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        str(
                            Path(tmpdir)
                            / "home"
                            / ".config"
                            / "containers"
                            / "containers.conf"
                        ),
                    ],
                    "chown containers.conf",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user",
                        "/mnt/cocalc/data/containers/rootless/missing-runtime-user/storage",
                    ],
                    "chown rootless podman persistent paths",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "chown",
                        "missing-runtime-user:missing-runtime-user",
                        "/run/cocalc/containers/rootless/missing-runtime-user",
                    ],
                    "chown rootless podman runroot",
                ),
                recorded,
            )


class ProjectIoPolicyHelperTest(unittest.TestCase):
    def run_calculation(
        self, devices: list[dict[str, object]], scope: str
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmpdir:
            helper = Path(tmpdir) / "cocalc-project-io-policy"
            helper.write_text(
                bootstrap.PROJECT_IO_POLICY_HELPER, encoding="utf-8"
            )
            return subprocess.run(
                [sys.executable, str(helper), "calculate", scope],
                input=json.dumps(devices),
                text=True,
                capture_output=True,
                check=False,
            )

    def test_balanced_capacity_tracks_all_project_writable_devices(self) -> None:
        devices = [
            {
                "device": "/dev/sdb",
                "major_minor": "8:16",
                "size_bytes": 150 * 1024**3,
                "provider": "gcp",
                "disk_type": "balanced",
                "mountpoints": ["/mnt/cocalc"],
                "filesystems": ["btrfs"],
            },
            {
                "device": "/dev/sdc",
                "major_minor": "8:32",
                "size_bytes": 500 * 1024**3,
                "provider": "gcp",
                "disk_type": "balanced",
                "mountpoints": ["/mnt/cocalc-scratch"],
                "filesystems": ["ext4"],
            },
        ]
        result = self.run_calculation(devices, "pool")
        self.assertEqual(result.returncode, 0, result.stderr)
        calculated = json.loads(result.stdout)
        self.assertEqual(
            calculated["capacity"],
            {
                "total_bytes": 650 * 1024**3,
                "device_count": 2,
                "physical_read_bps": 422 * 1024**2,
                "physical_write_bps": 382 * 1024**2,
                "physical_iops": 9900,
            },
        )
        self.assertEqual(
            calculated["rows"][0]["limits"],
            {
                "rbps": 171_756_748,
                "wbps": 171_756_748,
                "riops": 3510,
                "wiops": 3510,
            },
        )
        self.assertEqual(
            calculated["rows"][1]["limits"],
            {
                "rbps": 120 * 1024**2,
                "wbps": 50 * 1024**2,
                "riops": 3000,
                "wiops": 1500,
            },
        )

        premium = self.run_calculation(devices, "premium")
        self.assertEqual(premium.returncode, 0, premium.stderr)
        premium_rows = json.loads(premium.stdout)["rows"]
        self.assertEqual(
            premium_rows[0]["limits"],
            {
                "rbps": 171_756_748,
                "wbps": 171_756_748,
                "riops": 3510,
                "wiops": 3510,
            },
        )
        self.assertEqual(
            premium_rows[1]["limits"],
            {
                "rbps": 90 * 1024**2,
                "wbps": 39_321_600,
                "riops": 2250,
                "wiops": 1125,
            },
        )

        maintenance = self.run_calculation(devices, "maintenance")
        self.assertEqual(maintenance.returncode, 0, maintenance.stderr)
        maintenance_rows = json.loads(maintenance.stdout)["rows"]
        self.assertEqual(
            maintenance_rows[0]["limits"],
            {
                "rbps": 9_542_041,
                "wbps": 4_771_020,
                "riops": 195,
                "wiops": 97,
            },
        )
        self.assertEqual(
            maintenance_rows[1]["limits"],
            {
                "rbps": 12 * 1024**2,
                "wbps": 5 * 1024**2,
                "riops": 300,
                "wiops": 150,
            },
        )

        startup = self.run_calculation(devices, "startup")
        self.assertEqual(startup.returncode, 0, startup.stderr)
        self.assertEqual(
            json.loads(startup.stdout)["rows"][0]["limits"],
            {
                "rbps": 171_756_748,
                "wbps": 171_756_748,
                "riops": 3510,
                "wiops": 3510,
            },
        )
        self.assertEqual(
            json.loads(startup.stdout)["rows"][1]["limits"],
            {
                "rbps": 120 * 1024**2,
                "wbps": 100 * 1024**2,
                "riops": 3000,
                "wiops": 3000,
            },
        )

        lifecycle_pool = self.run_calculation(devices, "lifecycle-pool")
        self.assertEqual(lifecycle_pool.returncode, 0, lifecycle_pool.stderr)
        lifecycle_rows = json.loads(lifecycle_pool.stdout)["rows"]
        self.assertEqual(
            lifecycle_rows[0]["limits"],
            {
                "rbps": 171_756_748,
                "wbps": 171_756_748,
                "riops": 3510,
                "wiops": 3510,
            },
        )
        self.assertEqual(
            lifecycle_rows[1]["limits"],
            {
                "rbps": 120 * 1024**2,
                "wbps": 30 * 1024**2,
                "riops": 3000,
                "wiops": 900,
            },
        )

    def test_dynamic_capacity_rejects_unmodeled_storage(self) -> None:
        result = self.run_calculation(
            [
                {
                    "device": "/dev/nvme0n1",
                    "major_minor": "259:0",
                    "size_bytes": 500 * 1024**3,
                    "provider": "gcp",
                    "disk_type": "ssd",
                    "mountpoints": ["/mnt/cocalc"],
                    "filesystems": ["btrfs"],
                }
            ],
            "pool",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "gcp-pd-balanced capacity requires GCP balanced disks only",
            result.stderr,
        )

    def test_dynamic_policy_does_not_require_static_limits(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            helper = Path(tmpdir) / "cocalc-project-io-policy"
            helper.write_text(
                bootstrap.PROJECT_IO_POLICY_HELPER, encoding="utf-8"
            )
            policy_path = Path(tmpdir) / "policy.json"
            override_path = Path(tmpdir) / "override.json"
            policy_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "mode": "enforce",
                        "capacity": {"mode": "gcp-pd-balanced"},
                    }
                ),
                encoding="utf-8",
            )
            override_path.write_text("{}\n", encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(helper),
                    "fields",
                    str(policy_path),
                    str(override_path),
                    "standard",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(result.stdout.strip().split("\t")[-1], "gcp-pd-balanced")


class BootstrapWrapperScriptTest(unittest.TestCase):
    def test_standalone_wrapper_uses_explicit_runtime_user(self) -> None:
        cfg = bootstrap.standalone_privileged_wrapper_config("star-user")
        captured: dict[str, str] = {}

        def capture_write(path, data, **_kwargs):
            captured[str(path)] = data
            return len(data)

        with (
            mock.patch.object(
                bootstrap, "text_write_atomic", side_effect=capture_write
            ),
            mock.patch.object(bootstrap.os, "chmod"),
            mock.patch.object(bootstrap.os, "chown"),
        ):
            bootstrap.install_privileged_wrappers(cfg)

        script = captured["/usr/local/sbin/cocalc-runtime-storage"]
        path_helper = captured[
            "/usr/local/libexec/cocalc-runtime-storage-path-helper"
        ]
        self.assertIn('RUNTIME_USER="star-user"', script)
        self.assertIn('CONTAINER_RUNTIME_REQUIRED="0"', script)
        self.assertNotIn("__RUNTIME_USER__", script)
        self.assertIn('ALLOW_LOOPBACK_RUSTIC_REST = "1" == "1"', path_helper)
        self.assertNotIn("__ALLOW_LOOPBACK_RUSTIC_REST__", path_helper)
        self.assertEqual(
            json.loads(captured["/etc/cocalc/project-io-policy.json"])[
                "mode"
            ],
            "disabled",
        )

    def test_storage_wrapper_uses_xattr_overlay_mounts_and_project_rustic_commands(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                container_runtime_bundle=bootstrap.BundleSpec(
                    "", None, "", "", "", ""
                ),
            )
            captured: dict[str, str] = {}

            original_text_write_atomic = bootstrap.text_write_atomic
            original_chmod = bootstrap.os.chmod
            original_chown = bootstrap.os.chown

            def capture_write(path, data, **_kwargs):
                captured[str(path)] = data
                return len(data)

            try:
                bootstrap.text_write_atomic = capture_write
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.os.chown = lambda *_args, **_kwargs: None
                bootstrap.install_privileged_wrappers(cfg)
            finally:
                bootstrap.text_write_atomic = original_text_write_atomic
                bootstrap.os.chmod = original_chmod
                bootstrap.os.chown = original_chown

            script = captured["/usr/local/sbin/cocalc-runtime-storage"]
            subprocess.run(
                ["bash", "-n"],
                input=script,
                text=True,
                check=True,
            )
            policy_helper = captured[
                "/usr/local/libexec/cocalc-project-io-policy"
            ]
            compile(policy_helper, "cocalc-project-io-policy.py", "exec")
            policy_path = Path(tmpdir) / "io-policy.json"
            override_path = Path(tmpdir) / "io-policy-override.json"
            override_path.write_text("{}\n", encoding="utf-8")
            complete_limits = {
                "rbps": 64,
                "wbps": 32,
                "riops": 2000,
                "wiops": 1000,
            }
            policy = {
                "version": 1,
                "mode": "enforce",
                "mountpoint": "/mnt/cocalc",
                "pool": complete_limits,
                "leafClasses": {
                    "standard": {**complete_limits, "weight": 100},
                    "member": {**complete_limits, "weight": 200},
                    "premium": {**complete_limits, "weight": 400},
                },
            }
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            parser_result = subprocess.run(
                [
                    sys.executable,
                    "-",
                    "fields",
                    str(policy_path),
                    str(override_path),
                    "standard",
                ],
                input=policy_helper,
                text=True,
                capture_output=True,
            )
            self.assertEqual(parser_result.returncode, 0, parser_result.stderr)
            policy["leafClasses"]["standard"]["rbps"] = 65
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            parser_result = subprocess.run(
                [
                    sys.executable,
                    "-",
                    "fields",
                    str(policy_path),
                    str(override_path),
                    "standard",
                ],
                input=policy_helper,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(parser_result.returncode, 0)
            self.assertIn("leaf rbps exceeds pool rbps", parser_result.stderr)
            self.assertIn(
                "metacopy=on,redirect_dir=on,index=off",
                bootstrap.RUNTIME_STORAGE_PATH_HELPER,
            )
            self.assertIn(
                "project-rustic-backup|project-rustic-backup-maintenance)",
                script,
            )
            self.assertIn("project-rustic-restore)", script)
            self.assertIn(
                "rustic-project-backup",
                bootstrap.RUNTIME_STORAGE_PATH_HELPER,
            )
            self.assertNotIn('backup_status="$?"', script)
            self.assertNotIn("/opt/cocalc/tools/current/rustic", script)
            self.assertNotIn("/opt/cocalc/tools/current/bees", script)
            self.assertIn("/usr/local/libexec/cocalc-bees", script)
            self.assertIn("set_rustic_profile_parts()", script)
            self.assertIn(
                "/usr/local/libexec/cocalc-runtime-storage-path-helper",
                script,
            )
            self.assertIn(
                '["--glob", "!.snapshots", "--glob", "!.snapshots/**"]',
                bootstrap.RUNTIME_STORAGE_PATH_HELPER,
            )
            self.assertIn(
                'PRIVILEGED_RUSTIC_CACHE="/root/.cache/rustic"', script
            )
            self.assertIn(
                'PRIVILEGED_RUSTIC_CACHE_LOCK="/run/lock/cocalc-privileged-rustic-cache.lock"',
                script,
            )
            self.assertIn("maintain_privileged_rustic_cache()", script)
            self.assertIn("prepare_privileged_rustic_cache()", script)
            self.assertEqual(script.count("prepare_privileged_rustic_cache"), 5)
            self.assertIn("flock -n -x 7", script)
            self.assertIn("flock -s -w 120 7", script)
            self.assertIn("rm -rf --one-file-system", script)
            self.assertIn("PRIVILEGED_RUSTIC_CACHE_MIN_AGE_SECONDS", script)
            self.assertIn("parent_args=()", script)
            self.assertIn("--parent)", script)
            self.assertIn('"${parent_args[@]}"', script)
            self.assertIn("normalize-rootfs)", script)
            self.assertIn("BEES_ALREADY_RUNNING", script)
            self.assertIn("BEES_STARTING", script)
            self.assertIn("flock -n 9", script)
            self.assertIn("flock-missing", script)
            self.assertIn(
                'BEES_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-bees"', script
            )
            self.assertIn('BEES_CGROUP_MAX_WORKERS="4"', script)
            self.assertIn(
                'BEES_CGROUP_IO_READ_BPS="$((64 * 1024 * 1024))"', script
            )
            self.assertIn(
                'BEES_CGROUP_IO_WRITE_BPS="$((16 * 1024 * 1024))"', script
            )
            self.assertIn(
                '[ "$policy_profile" = "gcp-pd-balanced-btrfs-headroom" ]',
                script,
            )
            self.assertIn(
                'rows="$(project_io_limit_rows pool standard)"', script
            )
            self.assertIn(
                'apply_io_max "$pool" "pool" "$mode" standard "$rows"',
                script,
            )
            self.assertIn(
                'verify_io_max "$pool" "pool" standard "$rows"',
                script,
            )
            self.assertIn(
                'BEES_CGROUP_MEMORY_HIGH_MAX="$((4 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'BEES_CGROUP_MEMORY_MAX_MAX="$((8 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'BACKUP_BROWSER_POOL_MEMORY_HIGH="$((3 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'BACKUP_BROWSER_POOL_MEMORY_MAX="$((4 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                '"${BACKUP_BROWSER_CGROUP_DEFAULT}/cpu.max"',
                script,
            )
            self.assertIn(
                '"${BACKUP_BROWSER_CGROUP_DEFAULT}/memory.max"',
                script,
            )
            self.assertEqual(script.count("$BACKUP_BROWSER_POOL_CPU_MAX"), 1)
            self.assertEqual(script.count("$BACKUP_BROWSER_POOL_MEMORY_MAX"), 1)
            self.assertIn(
                '> "${parent}/cgroup.subtree_control"',
                script,
            )
            self.assertIn('> "${pool}/cpu.max"', script)
            self.assertIn('> "${pool}/cpu.weight"', script)
            self.assertIn('> "${pool}/io.weight"', script)
            self.assertIn('attach_pid_to_project_pool_storage "$$" "$pool"', script)
            self.assertIn("attach-pasta-cgroups)", script)
            self.assertIn("prepare-project-cgroup)", script)
            self.assertIn("enter-project-cgroup)", script)
            self.assertIn("verify-project-pool)", script)
            self.assertIn("attach-project-cgroup)", script)
            self.assertIn("attach-prepared-project-runtime)", script)
            self.assertIn("finish-project-startup-cgroup)", script)
            finish_startup_body = script.split(
                "  attach-prepared-project-runtime)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertIn('> "$pool/cpu.weight"', finish_startup_body)
            self.assertIn("project-cgroup-cpu-weight-mismatch", finish_startup_body)
            self.assertIn(
                "[<init-pid> <conmon-pid> [<final-cpu-weight> [<final-io-weight>]]]",
                script,
            )
            self.assertIn('> "$pool/io.weight"', finish_startup_body)
            self.assertIn("project-cgroup-io-weight-mismatch", finish_startup_body)
            self.assertIn("project_pid_is_in_pool", finish_startup_body)
            self.assertIn('require_runtime_owned_pid "$conmon_pid"', script)
            self.assertIn("is_trusted_conmon_executable()", script)
            self.assertIn(
                "/opt/cocalc/container-runtime/*/bin/conmon)",
                script,
            )
            self.assertIn(
                'is_trusted_conmon_executable "$conmon_exe"',
                script,
            )
            self.assertIn('runtime_uid="${SUDO_UID:-0}"', script)
            self.assertIn('[ "$owner_uid" = "$runtime_uid" ]', script)
            self.assertIn(
                'deny "project-conmon-executable-invalid"',
                script,
            )
            self.assertIn(
                'verify_project_pid_in_pool "$project_id" "$init_pid"',
                script,
            )
            self.assertIn(
                "Compatibility with project-host versions deployed before helper v18",
                script,
            )
            self.assertIn("verify-project-network-limits)", script)
            self.assertIn("verify-project-io-limits)", script)
            self.assertIn("verify-project-io-policy)", script)
            self.assertIn("project-io-status)", script)
            self.assertIn("configure_maintenance_cgroup", script)
            self.assertIn("configure_project_startup_cgroup", script)
            self.assertIn("prepare-project-startup-cgroup)", script)
            self.assertIn("prepare-project-startup-runtime-cgroup)", script)
            self.assertIn("attach-host-service-cgroup)", script)
            self.assertIn("verify-host-service-cgroup)", script)
            self.assertIn("reconcile-host-service-cgroup)", script)
            self.assertIn("attach-backup-browser-cgroup)", script)
            self.assertIn("remove-backup-browser-cgroup)", script)
            self.assertIn(
                'HOST_SERVICE_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-host-services"',
                script,
            )
            self.assertIn(
                'BACKUP_BROWSER_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-backup-browsers"',
                script,
            )
            self.assertIn(
                'BACKUP_BROWSER_CGROUP_MEMORY_HIGH="$((1280 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'BACKUP_BROWSER_CGROUP_MEMORY_MAX="$((2 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                '"$HOST_SERVICE_CGROUP_IO_WEIGHT" > "${HOST_SERVICE_CGROUP_DEFAULT}/io.weight"',
                script,
            )
            self.assertIn(
                'PROJECT_STARTUP_CREATE_CGROUP_DEFAULT="${PROJECT_STARTUP_CGROUP_DEFAULT}/create"',
                script,
            )
            self.assertIn('PROJECT_STARTUP_CGROUP_MEMORY_HIGH="max"', script)
            self.assertIn('PROJECT_STARTUP_CGROUP_MEMORY_MAX="max"', script)
            self.assertIn(
                'PROJECT_STARTUP_CREATE_CGROUP_MEMORY_HIGH="$((4 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'PROJECT_STARTUP_CREATE_CGROUP_MEMORY_MAX="$((8 * 1024 * 1024 * 1024))"',
                script,
            )
            startup_cgroup_body = script.split(
                "configure_project_startup_cgroup() {", 1
            )[1].split("\n}\n", 1)[0]
            self.assertIn(
                '"$PROJECT_STARTUP_CGROUP_MEMORY_HIGH" > "${PROJECT_STARTUP_CGROUP_DEFAULT}/memory.high"',
                startup_cgroup_body,
            )
            self.assertIn(
                '"$PROJECT_STARTUP_CREATE_CGROUP_MEMORY_HIGH" > "${PROJECT_STARTUP_CREATE_CGROUP_DEFAULT}/memory.high"',
                startup_cgroup_body,
            )
            self.assertIn("project-startup-runtime-cgroup-verification-failed", script)
            self.assertIn("move_project_startup_runtime_to_pool", script)
            self.assertIn("project_startup_runtime_active_count", script)
            self.assertIn("reserve_project_startup_io_capacity", script)
            self.assertIn("release_project_startup_io_capacity", script)
            self.assertIn("reconcile_project_pool_io_reservation", script)
            self.assertIn("apply_project_pool_io_snapshot", script)
            self.assertIn("verify_project_pool_io_snapshot", script)
            self.assertIn("set_project_pool_pressure_mode", script)
            self.assertIn("set-project-pool-pressure-mode)", script)
            self.assertIn(
                'PROJECT_IO_NORMAL_LIMITS_SNAPSHOT="/run/cocalc-project-pool-normal-io.max"',
                script,
            )
            self.assertIn(
                'PROJECT_IO_PRESSURE_MODE_STATE="/run/cocalc-project-pool-pressure-mode"',
                script,
            )
            reserve_startup_io_body = script.split(
                "reserve_project_startup_io_capacity() {", 1
            )[1].split("\n}\n", 1)[0]
            self.assertIn(
                'fields="$(project_io_policy_fields standard)"',
                reserve_startup_io_body,
            )
            self.assertIn(
                'if [ "$mode" != "enforce" ]; then',
                reserve_startup_io_body,
            )
            self.assertIn(
                'deny "project-io-normal-snapshot-empty"',
                reserve_startup_io_body,
            )
            self.assertLess(
                reserve_startup_io_body.index(
                    'if [ "$mode" != "enforce" ]; then'
                ),
                reserve_startup_io_body.index(
                    'deny "project-io-normal-snapshot-empty"'
                ),
            )
            reserve_startup_io_function = (
                "reserve_project_startup_io_capacity() {"
                + reserve_startup_io_body
                + "\n}\n"
            )
            pool_dir = Path(tmpdir) / "project-pool"
            pool_dir.mkdir()
            (pool_dir / "io.max").write_text("", encoding="utf-8")
            snapshot_path = Path(tmpdir) / "normal-io.max"
            released_path = Path(tmpdir) / "released"
            reservation_harness = f"""
set -euo pipefail
PROJECT_POOL_CGROUP_DEFAULT={json.dumps(str(pool_dir))}
PROJECT_IO_NORMAL_LIMITS_SNAPSHOT={json.dumps(str(snapshot_path))}
project_io_policy_fields() {{ printf '%s\\t\\n' "$POLICY_MODE"; }}
acquire_project_io_reservation_lock() {{ :; }}
release_project_io_reservation_lock() {{ : > {json.dumps(str(released_path))}; }}
project_io_pressure_protection_enabled() {{ return 1; }}
apply_project_pool_io_policy() {{ :; }}
deny() {{ printf 'SECURITY_DENY code=%s detail=%s\\n' "$1" "$2" >&2; exit 2; }}
{reserve_startup_io_function}
reserve_project_startup_io_capacity
"""
            disabled_result = subprocess.run(
                ["bash"],
                input=reservation_harness,
                text=True,
                capture_output=True,
                env={**os.environ, "POLICY_MODE": "disabled"},
            )
            self.assertEqual(
                disabled_result.returncode, 0, disabled_result.stderr
            )
            self.assertTrue(released_path.exists())
            self.assertFalse(snapshot_path.exists())
            released_path.unlink()
            enforced_result = subprocess.run(
                ["bash"],
                input=reservation_harness,
                text=True,
                capture_output=True,
                env={**os.environ, "POLICY_MODE": "enforce"},
            )
            self.assertEqual(enforced_result.returncode, 2)
            self.assertIn(
                "SECURITY_DENY code=project-io-normal-snapshot-empty",
                enforced_result.stderr,
            )
            self.assertIn(
                '"pressure_protection_enabled": pressure_protection_enabled == "true"',
                script,
            )
            self.assertIn('"pool_limit_scope": pool_scope', script)
            self.assertIn(
                '"startup_runtime_active_count": int(startup_runtime_active_count)',
                script,
            )
            prepare_runtime_body = script.split(
                "  prepare-project-startup-runtime-cgroup)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertLess(
                prepare_runtime_body.index(
                    'verify_project_pid_in_startup_runtime "$project_id" "$launcher_pid"'
                ),
                prepare_runtime_body.index("reserve_project_startup_io_capacity"),
            )
            self.assertLess(
                prepare_runtime_body.index("reserve_project_startup_io_capacity"),
                prepare_runtime_body.rindex("release_project_lock"),
            )
            self.assertLess(
                finish_startup_body.index("move_project_startup_runtime_to_pool"),
                finish_startup_body.index("release_project_startup_io_capacity"),
            )
            self.assertIn("attach_maintenance_worker", script)
            self.assertIn("btrfs|btrfs-maintenance)", script)
            self.assertIn(
                "project-rustic-backup|project-rustic-backup-maintenance)",
                script,
            )
            self.assertIn(
                'MAINTENANCE_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-maintenance"',
                script,
            )
            self.assertIn(
                'apply_io_max "$MAINTENANCE_CGROUP_DEFAULT" "maintenance" "$mode"',
                script,
            )
            self.assertIn(
                'apply_io_max "$PROJECT_STARTUP_CGROUP_DEFAULT" "startup" "$mode"',
                script,
            )
            self.assertIn(
                'PROJECT_STARTUP_CGROUP_DEFAULT="/sys/fs/cgroup/cocalc-project-startup"',
                script,
            )
            self.assertIn("cocalc-project-network-startup", script)
            self.assertIn('counter accept comment "%s-established"', script)
            self.assertIn('counter drop comment "%s-deny"', script)
            self.assertLess(
                script.index('counter accept comment "%s-established"'),
                script.index('counter drop comment "%s-deny"'),
            )
            self.assertIn(
                '"maintenance_process_count": len(maintenance_processes.split())',
                script,
            )
            self.assertIn('result["capability"] = "validated"', script)
            self.assertIn(
                'PROJECT_IO_CAPACITY_DEFAULT="/etc/cocalc/project-io-capacity.json"',
                script,
            )
            self.assertIn(
                'PROJECT_IO_POLICY_HELPER="/usr/local/libexec/cocalc-project-io-policy"',
                script,
            )
            self.assertIn(
                "Disabling containment must not depend on storage discovery",
                script,
            )
            self.assertNotIn('if [ "$mode" = "observe" ]; then', script)
            self.assertIn('"policy_profile": policy["profile"]', policy_helper)
            self.assertIn(
                '"capacity_source": policy["capacity_source"]', policy_helper
            )
            self.assertIn('"pool_io_weight": io_weight.strip()', script)
            self.assertIn(
                "io_class _policy_version _policy_profile _capacity_source",
                script,
            )
            self.assertIn('*) io_class="standard" ;;', script)
            self.assertIn(
                '"$io_class" > "${PROJECT_IO_CLASS_STATE_DIR}/${project_id}"',
                script,
            )
            self.assertIn('io_class="${12:-standard}"', script)
            self.assertIn("reconcile-project-io-policy)", script)
            self.assertIn("normalize_project_io_class_state", script)
            self.assertIn(
                'PROJECT_IO_CLASS_STATE_DIR="/var/lib/cocalc/project-io-classes"',
                script,
            )
            self.assertNotIn(
                'PROJECT_IO_CLASS_STATE_DIR="/run/cocalc-project-io-classes"',
                script,
            )
            self.assertIn("reconcile-project-network-limits)", script)
            self.assertIn('PROJECT_PASTA_NOFILE_LIMIT="4096"', script)
            self.assertIn('PROJECT_TCP_NEW_RATE="50"', script)
            self.assertIn('PROJECT_UDP_NEW_RATE="100"', script)
            self.assertIn('PROJECT_METADATA_IPV4="169.254.169.254"', script)
            self.assertIn('PROJECT_METADATA_IPV6="fd20:ce::254"', script)
            self.assertIn(
                'PROJECT_METADATA_TCP_PORTS="{ 80, 443 }"', script
            )
            self.assertIn("socket cgroupv2 level", script)
            self.assertIn("apply_pasta_resource_limits", script)
            self.assertIn("ensure_project_network_rule", script)
            self.assertIn("emit_project_metadata_rules", script)
            self.assertIn("emit_project_network_rules", script)
            self.assertIn("prepare-project-network-policy)", script)
            self.assertIn("set-project-network-policy)", script)
            self.assertIn("verify-project-network-policy)", script)
            prepare_network_policy_body = script.split(
                "  prepare-project-network-policy)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertIn(
                'set_project_network_policy "$1" "$2"',
                prepare_network_policy_body,
            )
            self.assertNotIn(
                "reconcile_project_network_limits",
                prepare_network_policy_body,
            )
            self.assertIn("set-current-exam-run)", script)
            self.assertIn("poweroff-exam-host)", script)
            emit_network_body = script.split(
                "emit_project_network_rules() {", 1
            )[1].split("\n}\n\napply_pasta_resource_limits()", 1)[0]
            self.assertIn('comment "%s-disabled-dns"', emit_network_body)
            self.assertIn('comment "%s-disabled-local"', emit_network_body)
            self.assertIn('comment "%s-disabled-reject"', emit_network_body)
            self.assertLess(
                emit_network_body.index('comment "%s-disabled-dns"'),
                emit_network_body.index('comment "%s-disabled-local"'),
            )
            emit_metadata_body = script.split(
                "emit_project_metadata_rules() {", 1
            )[1].split("\n}\n\nemit_project_network_rules()", 1)[0]
            self.assertIn('comment "%s-ipv4"', emit_metadata_body)
            self.assertIn('comment "%s-ipv6"', emit_metadata_body)
            self.assertEqual(emit_metadata_body.count("tcp dport %s"), 2)
            self.assertNotIn(
                'ip daddr %s counter drop', emit_metadata_body
            )
            self.assertNotIn(
                'ip6 daddr %s counter drop', emit_metadata_body
            )
            self.assertIn(
                'marker="cocalc-project-network-metadata"', emit_metadata_body
            )
            self.assertIn(
                'path="$(project_network_pool_cgroup_path)"', emit_metadata_body
            )
            verify_network_body = script.split(
                "verify_project_network_limits() {", 1
            )[1].split("\n}\n\nrender_project_network_rules()", 1)[0]
            self.assertIn("metadata_ipv4_count", verify_network_body)
            self.assertIn("metadata_ipv6_count", verify_network_body)
            ensure_network_body = script.split(
                "ensure_project_network_rule() {", 1
            )[1].split("\n}\n\nemit_project_metadata_rules()", 1)[0]
            self.assertNotIn("project_network_rule_handles", ensure_network_body)
            self.assertIn(
                'if emit_project_network_rules "$project_id" | run_project_network_nft -f -; then',
                ensure_network_body,
            )
            self.assertIn("configure_project_network_table", ensure_network_body)
            self.assertNotIn("flush chain inet", script)
            render_network_body = script.split(
                "render_project_network_rules() {", 1
            )[1].split("\n}\n\napply_project_network_process_limits()", 1)[0]
            self.assertLess(
                render_network_body.index("emit_project_metadata_rules"),
                render_network_body.index(
                    'for cgroup in "${PROJECT_POOL_CGROUP_DEFAULT}"/project-*'
                ),
            )
            self.assertLess(
                render_network_body.index("emit_project_metadata_rules"),
                render_network_body.index("delete rule inet"),
            )
            self.assertIn('local snapshot="$1"', render_network_body)
            self.assertIn(
                "printf '%s\\n' \"$rules\" | run_project_network_nft -f -",
                script,
            )
            self.assertIn('PROJECT_CGROUP_LOCK_WAIT_SECONDS="5"', script)
            self.assertIn("acquire_project_cgroup_shared_lock", script)
            self.assertIn("project_pool_hierarchy_ready", script)
            self.assertIn('PROJECT_NETWORK_RECONCILE_ATTEMPTS="3"', script)
            self.assertIn(
                'PROJECT_NETWORK_BOOT_RECONCILE_ATTEMPTS="20"', script
            )
            self.assertIn(
                'PROJECT_NETWORK_BOOT_RECONCILE_DELAY_SECONDS="2"', script
            )
            self.assertIn('PROJECT_NETWORK_NFT_TIMEOUT_SECONDS="30"', script)
            self.assertIn("project-cgroup-lock-timeout", script)
            self.assertIn("attach_storage_worker_to_project", script)
            self.assertIn('"$$" > "$target/cgroup.procs"', script)
            self.assertIn("PROJECT_STORAGE_WORKER_MEMORY_MAX", script)
            self.assertNotIn("project-network-lock-timeout", script)
            self.assertNotIn("acquire_project_network_lock", script)
            self.assertIn("--kill-after=2s", script)
            attach_body = script.split(
                "  attach-project-cgroup)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertNotIn(
                'ensure_project_network_rule "$project_id"',
                attach_body,
            )
            self.assertLess(
                attach_body.index("release_project_lock"),
                attach_body.index("find_project_conmon_pids"),
            )
            reconcile_body = script.split(
                "reconcile_project_network_limits() {", 1
            )[1].split("\n}\n", 1)[0]
            self.assertNotIn(
                'ensure_project_network_rule "$project_id"',
                reconcile_body,
            )
            self.assertLess(
                reconcile_body.index(
                    'for attempt in $(seq 1 "$PROJECT_NETWORK_BOOT_RECONCILE_ATTEMPTS")'
                ),
                reconcile_body.index("configure_project_pool_hierarchy"),
            )
            self.assertIn(
                'sleep "$PROJECT_NETWORK_BOOT_RECONCILE_DELAY_SECONDS"',
                reconcile_body,
            )
            self.assertLess(
                reconcile_body.index("configure_project_pool_hierarchy"),
                reconcile_body.index("configure_project_network_table"),
            )
            self.assertLess(
                reconcile_body.index(
                    'snapshot="$(run_project_network_nft -a list chain'
                ),
                reconcile_body.index(
                    'rules="$(render_project_network_rules "$snapshot")"'
                ),
            )
            self.assertLess(
                reconcile_body.index("run_project_network_nft -f -"),
                reconcile_body.index("apply_project_network_process_limits"),
            )
            prepare_body = script.split(
                "  prepare-project-cgroup)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertIn('ensure_project_network_rule "$project_id"', prepare_body)
            self.assertNotIn("acquire_project_network_lock", prepare_body)
            startup_prepare_body = script.split(
                "  prepare-project-startup-runtime-cgroup)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertIn(
                "configure_project_startup_runtime_leaf",
                startup_prepare_body,
            )
            startup_leaf_body = script.split(
                "configure_project_startup_runtime_leaf() {", 1
            )[1].split("\n}\n", 1)[0]
            self.assertIn(
                'apply_io_max "$cgroup" "startup" "$mode" "$io_class"',
                startup_leaf_body,
            )
            self.assertIn(
                'verify_io_max "$cgroup" "startup" "$io_class"',
                startup_leaf_body,
            )
            self.assertIn(
                'ensure_project_network_rule "$project_id"',
                startup_prepare_body,
            )
            cleanup_body = script.split(
                "  cleanup-project-cgroup)", 1
            )[1].split("\n    ;;", 1)[0]
            self.assertNotIn("remove_project_network_rule", cleanup_body)
            self.assertIn("project_cgroup_has_processes", script)
            self.assertNotIn('[ -s "$cgroup/cgroup.procs" ]', script)
            self.assertIn(
                'pool="$(project_cgroup "$project_id")"', script
            )
            self.assertIn("configure_project_pool_hierarchy", script)
            self.assertIn('> "$cgroup/memory.max"', script)
            self.assertIn("configure_default_project_pool_memory_limit()", script)
            require_pool_memory_body = script.split(
                "require_finite_project_pool_memory_max() {", 1
            )[1].split("\n}", 1)[0]
            self.assertIn(
                "configure_default_project_pool_memory_limit",
                require_pool_memory_body,
            )
            self.assertIn(
                "PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB="
                f'"{bootstrap.DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB}"',
                script,
            )
            self.assertIn(
                "PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB="
                f'"{bootstrap.DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB}"',
                script,
            )
            reconcile_pool_memory_body = script.split(
                "  reconcile-project-pool-memory)", 1
            )[1].split("    ;;", 1)[0]
            self.assertIn(
                "configure_project_pool_hierarchy", reconcile_pool_memory_body
            )
            self.assertIn(
                "require_finite_project_pool_memory_max",
                reconcile_pool_memory_body,
            )
            self.assertIn("effective_project_memory_max()", script)
            self.assertIn(
                'PROJECT_LEAF_POOL_HEADROOM_BYTES="$((2 * 1024 * 1024 * 1024))"',
                script,
            )
            self.assertIn(
                'memory_max="$(effective_project_memory_max "$memory_max")"',
                script,
            )
            self.assertIn("project-pool-memory-headroom-insufficient", script)
            self.assertIn(
                "printf '0\n' > \"$cgroup/memory.oom.group\"", script
            )
            self.assertNotIn(
                "printf '1\n' > \"$cgroup/memory.oom.group\"", script
            )
            self.assertIn('> "$pool/cgroup.kill"', script)
            self.assertIn('deny "project-cgroup-cleanup-failed"', script)
            self.assertIn("cocalc-project-cgroups.lock", script)
            self.assertIn('PROJECT_PROCESS_OOM_SCORE_ADJ="500"', script)
            self.assertIn("/usr/bin/ionice -c3 /usr/bin/nice -n 19", script)
            self.assertIn("find_bees_pid()", script)
            self.assertIn("apply_bees_runtime_policy()", script)
            self.assertIn("configure_bees_cgroup()", script)
            self.assertIn('pool="$(bees_cgroup)"', script)
            self.assertIn('configure_bees_cgroup "$pool" "$mountpoint"', script)
            self.assertIn('> "${pool}/memory.high"', script)
            self.assertIn('> "${pool}/memory.max"', script)
            self.assertIn('> "${pool}/pids.max"', script)
            self.assertIn('> "${pool}/io.max"', script)
            self.assertIn("emit_bees_status()", script)
            self.assertIn("bees-status)", script)
            self.assertIn("reconcile-bees)", script)
            self.assertNotIn("\x00", script)
            self.assertIn("tr '\\0' '\\n'", script)
            self.assertIn('/usr/bin/renice -n 19 -p "$tid"', script)
            self.assertIn('/usr/bin/ionice -c3 -p "$tid"', script)
            bees_branch = script.index("  bees)")
            existing_check = script.index(
                'existing_pid="$(find_bees_pid "$mountpoint")"', bees_branch
            )
            lock_check = script.index('lock_path="$beeshome/cocalc-bees.lock"')
            self.assertLess(existing_check, lock_check)
            self.assertIn('cat "$proc/comm"', script)
            self.assertIn("sandbox-rm)", script)
            self.assertIn("sandbox-rmdir)", script)
            self.assertIn("allow_privileged_delete_root", script)
            self.assertIn("cocalc-runtime-storage-path-helper", script)
            self.assertNotIn(
                "/opt/cocalc/project-host/bin/project-host privileged-rm-helper",
                script,
            )
            self.assertIn("lexical_absolute_path_is_safe", script)
            self.assertIn('deny "relative-path-not-allowed"', script)
            self.assertIn('path_helper chmod --root "$ALLOWED_PATH_ROOT"', script)
            self.assertIn("mv-cross-root-not-allowed", script)
            self.assertIn("rm-root-not-allowed", script)
            self.assertNotIn('exec /bin/chmod "$@"', script)
            self.assertNotIn('exec /bin/chown "$@"', script)
            self.assertNotIn('exec /bin/rm "$@"', script)
            self.assertIn("grow-shared-scratch)", script)
            self.assertIn("/mnt/cocalc-scratch", script)
            self.assertIn("/var/lib/cocalc/star/project-host/0/cache", script)
            self.assertIn(
                "/var/lib/cocalc/star/project-host/0/cache/project-roots/*",
                script,
            )
            self.assertIn('echo 1 > "$scratch_rescan"', script)
            self.assertIn('growpart "$scratch_parent" "$scratch_part_num"', script)
            self.assertIn('partprobe "$scratch_parent"', script)
            self.assertIn('resize2fs "$scratch_source"', script)
            self.assertIn('scratch_target_gib="${1:-}"', script)
            self.assertIn('blockdev --getsize64 "$scratch_parent"', script)
            self.assertIn("shared-scratch-grow-incomplete", script)
            self.assertIn(
                'unshare cat /proc/self/uid_map >"$rewrite_uid_map_file"',
                script,
            )
            self.assertIn("run_rootfs_podman_as_user()", script)
            self.assertIn('CONTAINER_RUNTIME_REQUIRED="1"', script)
            self.assertIn(
                'podman_bin="${CONTAINER_RUNTIME_CURRENT}/bin/podman"',
                script,
            )
            self.assertIn(
                '"CONTAINERS_CONF_OVERRIDE=${CONTAINER_RUNTIME_CURRENT}/etc/containers/containers.conf"',
                script,
            )
            self.assertIn('podman_prefix=(/usr/bin/aa-exec -p podman --)', script)
            self.assertNotIn(
                'bash -lc "cd ~ && /usr/bin/podman unshare', script
            )
            self.assertNotIn("/usr/bin/podman run --rm", script)
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
            self.assertIn("normalize_runtime_package_state_rootfs()", script)
            self.assertIn('root_owner_uid="$(stat -c', script)
            self.assertIn('"$rootfs/var/lib/apt/lists/partial"', script)
            self.assertIn('"$rootfs/var/cache/apt/archives/partial"', script)
            self.assertIn('find "$dir" -xdev -type f', script)
            self.assertIn("COCALC_RUNTIME_UID", script)
            self.assertIn("--userns=keep-id:uid=2001,gid=2001", script)
            self.assertIn(': >"$rootfs/run/podman-init"', script)
            self.assertIn(': >"$rootfs/run/.containerenv"', script)
            helper = captured[
                "/usr/local/libexec/cocalc-runtime-storage-path-helper"
            ]
            helper_namespace = {"__name__": "bootstrap_path_helper_test"}
            exec(helper, helper_namespace)
            safe_root = Path(tmpdir) / "safe-root"
            outside = Path(tmpdir) / "outside"
            safe_root.mkdir()
            outside.mkdir()
            (outside / "secret").write_text("unchanged", encoding="utf-8")
            (safe_root / "escape").symlink_to(outside, target_is_directory=True)
            run_helper = helper_namespace["run"]
            allowed_roots = {str(safe_root)}
            run_helper(
                [
                    "mkdir",
                    "--root",
                    str(safe_root),
                    "--path",
                    "a/b",
                    "--recursive",
                    "--mode",
                    "0750",
                ],
                allowed_roots,
            )
            (safe_root / "a" / "b" / "data").write_text(
                "abcdef", encoding="utf-8"
            )
            run_helper(
                [
                    "truncate",
                    "--root",
                    str(safe_root),
                    "--path",
                    "a/b/data",
                    "--length",
                    "2",
                ],
                allowed_roots,
            )
            self.assertEqual(
                (safe_root / "a" / "b" / "data").read_text(encoding="utf-8"),
                "ab",
            )
            with self.assertRaises(OSError):
                run_helper(
                    [
                        "chmod",
                        "--root",
                        str(safe_root),
                        "--path",
                        "escape/secret",
                        "--mode",
                        "0600",
                    ],
                    allowed_roots,
                )
            self.assertEqual(
                (outside / "secret").read_text(encoding="utf-8"), "unchanged"
            )
            wrapper_path = Path(tmpdir) / "cocalc-runtime-storage"
            wrapper_path.write_text(script, encoding="utf-8")
            subprocess.run(["bash", "-n", str(wrapper_path)], check=True)
            telemetry_python = script.split("emit_bees_status() {", 1)[1]
            telemetry_python = telemetry_python.split("<<'PY'\n", 1)[1]
            telemetry_python = telemetry_python.split("\nPY\n", 1)[0]
            compile(telemetry_python, "bees-status", "exec")

    def test_reconcile_bees_runtime_policy_uses_storage_wrapper(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []
            original_run_best_effort = bootstrap.run_best_effort
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.reconcile_bees_runtime_policy(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort

            self.assertEqual(
                recorded,
                [
                    (
                        [
                            "/usr/local/sbin/cocalc-runtime-storage",
                            "reconcile-bees",
                            "/mnt/cocalc",
                        ],
                        "reconcile BEES runtime policy",
                    )
                ],
            )

    def test_btrfs_grow_helper_refreshes_block_device_before_online_resize(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            captured: dict[str, str] = {}

            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.Path.chmod

            def capture_write(self, data, encoding="utf-8"):
                captured[str(self)] = data
                return len(data)

            try:
                bootstrap.Path.write_text = capture_write
                bootstrap.Path.chmod = lambda *_args, **_kwargs: None
                bootstrap.install_btrfs_helper(cfg)
            finally:
                bootstrap.Path.write_text = original_write_text
                bootstrap.Path.chmod = original_chmod

            script = captured["/usr/local/sbin/cocalc-grow-btrfs"]
            self.assertIn('refresh_block_device "$MOUNT_SOURCE"', script)
            self.assertIn('echo 1 > "$rescan_path"', script)
            self.assertIn('growpart "$parent" "$part_num"', script)
            self.assertIn('partprobe "$parent"', script)
            wrapper_path = Path(tmpdir) / "cocalc-grow-btrfs"
            wrapper_path.write_text(script, encoding="utf-8")
            subprocess.run(["bash", "-n", str(wrapper_path)], check=True)

    def test_write_helpers_chowns_only_targeted_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_best_effort = bootstrap.run_best_effort
            original_runtime_root = bootstrap.project_host_runtime_root
            original_rootctl_path = bootstrap.project_host_rootctl_path
            original_geteuid = bootstrap.os.geteuid
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.project_host_runtime_root = lambda _cfg: Path(tmpdir) / "runtime-root"
                bootstrap.project_host_rootctl_path = (
                    lambda _cfg=None: Path(tmpdir) / "usr-local-sbin" / "cocalc-project-host-rootctl"
                )
                bootstrap.os.geteuid = lambda: 0
                bootstrap.write_helpers(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.project_host_runtime_root = original_runtime_root
                bootstrap.project_host_rootctl_path = original_rootctl_path
                bootstrap.os.geteuid = original_geteuid

            self.assertTrue(recorded)
            for args, _desc in recorded:
                self.assertNotIn("-R", args)
            runtime_bin = Path(tmpdir) / "runtime-root" / "bin"
            rootctl = Path(tmpdir) / "usr-local-sbin" / "cocalc-project-host-rootctl"
            core_handler = rootctl.with_name("cocalc-project-host-core-handler")
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
            self.assertTrue(rootctl.exists())
            self.assertTrue(core_handler.exists())
            ctl_text = (runtime_bin / "ctl").read_text(encoding="utf-8")
            rootctl_text = rootctl.read_text(encoding="utf-8")
            self.assertIn(str(rootctl), ctl_text)
            self.assertIn("start|ensure|restart|stop)", ctl_text)
            self.assertIn(
                'DAEMON_CONTROL_LOCK="/mnt/cocalc/data/tmp/project-host-daemon-control.lock"',
                rootctl_text,
            )
            self.assertIn(
                f'BOOTSTRAP_LIFECYCLE_LOCK="{bootstrap.bootstrap_lock_path(cfg)}"',
                rootctl_text,
            )
            self.assertIn(
                'flock -x -w "${DAEMON_CONTROL_LOCK_WAIT_SECONDS}" 8',
                rootctl_text,
            )
            self.assertIn("acquire_bootstrap_lifecycle_lock()", rootctl_text)
            self.assertIn(
                'flock -x -w "${BOOTSTRAP_LIFECYCLE_LOCK_WAIT_SECONDS}" 7',
                rootctl_text,
            )
            self.assertIn(
                'if [ "${cmd}" = "prepare-podman-boot" ]; then',
                rootctl_text,
            )
            self.assertIn(
                "start|ensure|restart|stop|protect|prepare-podman-boot)",
                rootctl_text,
            )
            self.assertIn("prepare_podman_boot()", rootctl_text)
            self.assertIn(
                "project runtime processes are active; refusing Podman boot preparation",
                rootctl_text,
            )
            self.assertIn(
                "project runtime process observed during boot preparation; waiting for transient startup work",
                rootctl_text,
            )
            self.assertIn(
                "Podman boot preparation failed; refusing to start project-host",
                rootctl_text,
            )
            self.assertIn(
                "require_podman_boot_preparation_not_failed",
                rootctl_text,
            )
            self.assertIn(
                'runroot = "${desired_runroot}"',
                rootctl_text,
            )
            self.assertIn(
                "migrate_podman_database_runroot()",
                rootctl_text,
            )
            self.assertIn(
                '"UPDATE DBConfig SET RunRoot = ? WHERE ID = 1 AND RunRoot = ?"',
                rootctl_text,
            )
            self.assertIn(
                'if [ "${reported_runroot}" != "${desired_runroot}" ]',
                rootctl_text,
            )
            self.assertIn(
                'run_podman_as_runtime 60s "${runtime_dir}" "${cgroup_manager}" system migrate',
                rootctl_text,
            )
            self.assertIn(
                "info --format '{{.Store.RunRoot}}'",
                rootctl_text,
            )
            self.assertIn("prepare-podman-boot)", rootctl_text)
            self.assertIn(
                'COCALC_PROJECT_HOST_OOM_SCORE_ADJ:--900',
                rootctl_text,
            )
            self.assertIn(
                f'PROJECT_POOL_CGROUP_DEFAULT="{bootstrap.DEFAULT_PROJECT_POOL_CGROUP}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_MEMORY_RESERVE_MB_DEFAULT="{bootstrap.DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MIN_MB="{bootstrap.DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MIN_MB}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_MEMORY_RESERVE_DYNAMIC_MAX_MB="{bootstrap.DYNAMIC_PROJECT_POOL_MEMORY_RESERVE_MAX_MB}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'HELPER_SCHEMA_VERSION="{bootstrap.HELPER_SCHEMA_VERSION}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_CPU_RESERVE_CORES_DEFAULT="{bootstrap.DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_CPU_RESERVE_DYNAMIC_MIN_CORES="{bootstrap.DYNAMIC_PROJECT_POOL_CPU_RESERVE_MIN_CORES}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_CPU_RESERVE_DYNAMIC_MAX_CORES="{bootstrap.DYNAMIC_PROJECT_POOL_CPU_RESERVE_MAX_CORES}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR="{bootstrap.DYNAMIC_PROJECT_POOL_CPU_RESERVE_DIVISOR}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'reserve_cores="$((cpu_count / PROJECT_POOL_CPU_RESERVE_DYNAMIC_DIVISOR))"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                f'MIN_PROJECT_POOL_CPU_CORES="{bootstrap.MIN_PROJECT_POOL_CPU_CORES}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn("project_pool_cpu_max_value()", rootctl.read_text(encoding="utf-8"))
            self.assertIn('> "${pool}/cpu.max"', rootctl.read_text(encoding="utf-8"))
            self.assertIn(
                "for controller in cpu memory pids io",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "repair_runtime_environment()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'children_file="/proc/${pid}/task/${pid}/children"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "ps -eo pid=,ppid=",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "default_podman_runtime_dir()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'ensure_owned_runtime_dir "${run_dir}/containers"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "ensure_podman_runroot()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "install -d -o root -g root -m 0711",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'runroot="/run/cocalc/containers/rootless/${RUNTIME_USER}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "  ensure_podman_runroot\n",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'systemctl start "${service}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'install -d -o "${uid}" -g "${gid}" -m 0700 "${path}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "preflight_podman_runtime()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "cleanup_podman_runtime_state()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "project_host_app_running()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "project-host app is running; refusing to clean Podman runtime state",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "doctor()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "project-host app",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "project-host host-agent",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "cannot re-exec process to join the existing user namespace",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "run_podman_as_runtime()", rootctl.read_text(encoding="utf-8")
            )
            self.assertIn(
                'CONTAINERS_CONF_OVERRIDE="${container_runtime}/etc/containers/containers.conf"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'podman_bin="${container_runtime}/bin/podman"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "podman_prefix=(aa-exec -p podman --)",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "capture-forensics)",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "apply-sysctls)",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "net.ipv4.ip_local_port_range = 10000 65535",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "net.ipv4.ip_local_reserved_ports = 30000-59999",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "reconcile_app_core_dumps",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'rm -f "${LEGACY_CORE_SUDOERS_CONFIG_PATH}"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "kernel.core_pipe_limit = 4",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "fs.inotify.max_user_instances = 8192",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "/etc/sysctl.d/60-cocalc-project-host-inotify.conf",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "allow_forensics_capture_dir",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'FORENSICS_ROOT="/var/lib/cocalc-project-host-forensics"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "require_forensics_pid",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "deny() {",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'MAX_FORENSICS_DURATION_SECONDS="30"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'printf \'CAPTURE_DIR=%s\\n\'',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "<capture-dir>",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "{{.State.Pid}} {{.State.ConmonPid}}",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                "enable_project_pool_controllers()",
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'legacy="${pool}/legacy"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertIn(
                'PROJECT_OOM_ADJ="500"',
                rootctl.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "/usr/local/sbin/cocalc-runtime-storage attach-pasta-cgroups",
                rootctl.read_text(encoding="utf-8"),
            )
            subprocess.run(["bash", "-n", str(rootctl)], check=True)
            core_handler_text = core_handler.read_text(encoding="utf-8")
            self.assertNotIn("\0", core_handler_text)
            self.assertIn(
                'pid_file="/mnt/cocalc/data/project-host-app.pid"',
                core_handler_text,
            )
            self.assertIn(
                'parent_pid="$(sed -n',
                core_handler_text,
            )
            self.assertIn("count=1024 conv=sparse", core_handler_text)
            self.assertIn('"${kept}" -gt 3', core_handler_text)
            subprocess.run(["bash", "-n", str(core_handler)], check=True)

    def test_helper_schema_installed_reads_rootctl_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            rootctl = Path(tmpdir) / "usr-local-sbin" / "cocalc-project-host-rootctl"
            rootctl.parent.mkdir(parents=True)
            rootctl.write_text(
                f'#!/usr/bin/env bash\nHELPER_SCHEMA_VERSION="{bootstrap.HELPER_SCHEMA_VERSION}"\n',
                encoding="utf-8",
            )

            original_rootctl_path = bootstrap.project_host_rootctl_path
            try:
                bootstrap.project_host_rootctl_path = lambda _cfg=None: rootctl
                self.assertEqual(
                    bootstrap.helper_schema_installed(cfg),
                    bootstrap.HELPER_SCHEMA_VERSION,
                )
                rootctl.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
                self.assertIsNone(bootstrap.helper_schema_installed(cfg))
            finally:
                bootstrap.project_host_rootctl_path = original_rootctl_path

    def test_write_env_sets_project_pool_defaults_without_overriding_existing_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                env_lines=["COCALC_PROJECT_POOL_MEMORY_RESERVE_MB=4096"],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)

            original_getpwnam = bootstrap.pwd.getpwnam
            original_run_best_effort = bootstrap.run_best_effort
            original_mkdir = bootstrap.Path.mkdir
            try:
                bootstrap.pwd.getpwnam = lambda _user: type(
                    "Pwd", (), {"pw_uid": 1002}
                )()
                bootstrap.run_best_effort = lambda *_args, **_kwargs: None
                bootstrap.Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                bootstrap.write_env(cfg, 10)
            finally:
                bootstrap.pwd.getpwnam = original_getpwnam
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.Path.mkdir = original_mkdir

            text = env_path.read_text(encoding="utf-8")
            self.assertIn(
                f"COCALC_PROJECT_POOL_CGROUP={bootstrap.DEFAULT_PROJECT_POOL_CGROUP}",
                text,
            )
            self.assertIn("COCALC_PROJECT_POOL_MEMORY_RESERVE_MB=4096", text)
            self.assertIn(
                f"COCALC_PROJECT_POOL_CPU_RESERVE_CORES={bootstrap.DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES}",
                text,
            )
            self.assertIn("COCALC_PROJECT_QUOTA_LEDGER_MODE=enforce", text)
            self.assertIn("COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS=1", text)
            self.assertIn(
                "COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS_SEC=5", text
            )
            local_env_text = env_path.with_name("project-host.local.env").read_text(
                encoding="utf-8"
            )
            self.assertIn("# Local project-host overrides.", local_env_text)
            self.assertIn(
                "COCALC_PROJECT_HOST_DAEMON_CAPTURE_FORENSICS=1", local_env_text
            )

    def test_write_env_migrates_legacy_project_pool_reserve_to_auto(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(make_cfg(tmpdir), ssh_user="")
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(
                f"COCALC_PROJECT_POOL_MEMORY_RESERVE_MB={bootstrap.LEGACY_PROJECT_POOL_MEMORY_RESERVE_MB}\n",
                encoding="utf-8",
            )

            bootstrap.write_env(cfg, 10)

            self.assertIn(
                f"COCALC_PROJECT_POOL_MEMORY_RESERVE_MB={bootstrap.DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB}",
                env_path.read_text(encoding="utf-8"),
            )

    def test_write_env_preserves_explicit_quota_ledger_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                ssh_user="",
                env_lines=["COCALC_PROJECT_QUOTA_LEDGER_MODE=observe"],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)

            bootstrap.write_env(cfg, 10)

            self.assertIn(
                "COCALC_PROJECT_QUOTA_LEDGER_MODE=observe",
                env_path.read_text(encoding="utf-8"),
            )

    def test_write_env_migrates_legacy_project_pool_reserve_from_env_lines_to_auto(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                ssh_user="",
                env_lines=[
                    f"COCALC_PROJECT_POOL_MEMORY_RESERVE_MB={bootstrap.LEGACY_PROJECT_POOL_MEMORY_RESERVE_MB}"
                ],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)

            bootstrap.write_env(cfg, 10)

            self.assertIn(
                f"COCALC_PROJECT_POOL_MEMORY_RESERVE_MB={bootstrap.DEFAULT_PROJECT_POOL_MEMORY_RESERVE_MB}",
                env_path.read_text(encoding="utf-8"),
            )

    def test_write_env_creates_prev_backup_before_replacing_managed_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                ssh_user="",
                env_lines=["MASTER_CONAT_SERVER=http://alpha.example.invalid:9102"],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(
                "MASTER_CONAT_SERVER=http://old.example.invalid:9102\n",
                encoding="utf-8",
            )

            bootstrap.write_env(cfg, 10)

            self.assertEqual(
                env_path.with_suffix(".env.prev").read_text(encoding="utf-8"),
                "MASTER_CONAT_SERVER=http://old.example.invalid:9102\n",
            )
            self.assertIn(
                "MASTER_CONAT_SERVER=http://alpha.example.invalid:9102",
                env_path.read_text(encoding="utf-8"),
            )

    def test_write_env_ignores_malformed_existing_lines_and_preserves_valid_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                ssh_user="",
                env_lines=["MASTER_CONAT_SERVER=http://alpha.example.invalid:9102"],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(
                "c.projecthosts.internal:9102\n"
                "COCALC_PROJECT_POOL_MEMORY_RESERVE_MB=8192\n",
                encoding="utf-8",
            )

            bootstrap.write_env(cfg, 10)

            text = env_path.read_text(encoding="utf-8")
            self.assertIn(
                "MASTER_CONAT_SERVER=http://alpha.example.invalid:9102",
                text,
            )
            self.assertIn("COCALC_PROJECT_POOL_MEMORY_RESERVE_MB=8192", text)
            self.assertIn(
                f"COCALC_PROJECT_POOL_CPU_RESERVE_CORES={bootstrap.DEFAULT_PROJECT_POOL_CPU_RESERVE_CORES}",
                text,
            )
            self.assertNotIn("c.projecthosts.internal:9102", text)

    def test_write_env_rejects_invalid_assignments_without_clobbering_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                ssh_user="",
                env_lines=["c.projecthosts.internal:9102"],
            )
            env_path = Path(cfg.env_file)
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(
                "MASTER_CONAT_SERVER=http://old.example.invalid:9102\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "invalid env assignment line"):
                bootstrap.write_env(cfg, 10)

            self.assertEqual(
                env_path.read_text(encoding="utf-8"),
                "MASTER_CONAT_SERVER=http://old.example.invalid:9102\n",
            )
            self.assertFalse(env_path.with_suffix(".env.prev").exists())

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
            self.assertIn('nvm use --silent default >/dev/null 2>&1 || true', script)
            self.assertIn(
                'NODE_CANDIDATES=( $NVM_DIR/versions/node/v20*/bin/node )',
                script,
            )
            self.assertIn(
                'node not found for project-host wrapper (looked in PATH and $NVM_DIR/versions/node/v20*/bin/node)',
                script,
            )
            self.assertIn('exec "$NODE_BIN"', script)

    def test_install_node_uses_current_nvm_and_requested_node_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []

            original_run_cmd = bootstrap.run_cmd
            try:
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append(
                        (args, desc, kwargs)
                    )
                )
                bootstrap.install_node(cfg)
            finally:
                bootstrap.run_cmd = original_run_cmd

            self.assertEqual(len(recorded), 1)
            args, desc, kwargs = recorded[0]
            self.assertEqual(desc, "install node")
            self.assertEqual(kwargs.get("as_user"), cfg.ssh_user)
            self.assertEqual(args[:2], ["bash", "-lc"])
            script = args[2]
            self.assertIn(
                "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh",
                script,
            )
            self.assertIn('PROFILE=/dev/null bash', script)
            self.assertIn('nvm --version)" = "0.40.4"', script)
            self.assertIn("nvm install 20", script)
            self.assertIn("nvm alias default 20", script)

    def test_configure_autostart_installs_systemd_watchdog_and_removes_cron(self) -> None:
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

            written = {path: data for path, data, _ in writes}
            self.assertNotIn("/etc/cron.d/cocalc-project-host", written)
            self.assertIn(
                "/etc/systemd/system/cocalc-project-host-watchdog.service",
                written,
            )
            self.assertIn(
                f'ExecStart=/bin/bash -lc "mkdir -p /mnt/cocalc/data/logs /mnt/cocalc/data/tmp; flock -n -E 0 /mnt/cocalc/data/tmp/project-host-watchdog.lock {runtime_root}/bin/ctl ensure >> /mnt/cocalc/data/logs/project-host-watchdog.log 2>&1"',
                written["/etc/systemd/system/cocalc-project-host-watchdog.service"],
            )
            self.assertIn(
                "KillMode=process",
                written["/etc/systemd/system/cocalc-project-host-watchdog.service"],
            )
            self.assertIn(
                "/etc/systemd/system/cocalc-project-host-watchdog.timer",
                written,
            )
            self.assertIn(
                "OnUnitActiveSec=1min",
                written["/etc/systemd/system/cocalc-project-host-watchdog.timer"],
            )
            self.assertIn(
                "/etc/systemd/system/cocalc-project-host-start.service",
                written,
            )
            self.assertIn(
                "/etc/systemd/system/cocalc-project-host-prepare.service",
                written,
            )
            self.assertIn(
                f"ExecStart={bootstrap.project_host_rootctl_path(cfg)} prepare-podman-boot",
                written[
                    "/etc/systemd/system/cocalc-project-host-prepare.service"
                ],
            )
            self.assertIn(
                "Before=cocalc-project-host-start.service podman-restart.service",
                written[
                    "/etc/systemd/system/cocalc-project-host-prepare.service"
                ],
            )
            self.assertIn(
                "Conflicts=podman-restart.service",
                written[
                    "/etc/systemd/system/cocalc-project-host-prepare.service"
                ],
            )
            self.assertIn(
                "Before=google-startup-scripts.service",
                written[
                    "/etc/systemd/system/cocalc-project-host-prepare.service"
                ],
            )
            self.assertIn(
                "Requires=cocalc-project-host-prepare.service",
                written["/etc/systemd/system/cocalc-project-host-start.service"],
            )
            self.assertIn(
                f"ExecStart={runtime_root}/bin/start-project-host",
                written["/etc/systemd/system/cocalc-project-host-start.service"],
            )
            self.assertIn(
                f'ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"',
                written["/etc/systemd/system/cocalc-project-host-start.service"],
            )
            self.assertIn(
                "TimeoutStopSec=25",
                written["/etc/systemd/system/cocalc-project-host-start.service"],
            )
            self.assertIn(
                "/etc/systemd/system/cocalc-project-host-shutdown.service",
                written,
            )
            self.assertIn(
                "ExecStart=/bin/true",
                written[
                    "/etc/systemd/system/cocalc-project-host-shutdown.service"
                ],
            )
            self.assertIn(
                f'ExecStop=/bin/bash -lc "printf host-shutdown > /mnt/cocalc/data/host-shutdown-intent; {runtime_root}/bin/ctl stop"',
                written[
                    "/etc/systemd/system/cocalc-project-host-shutdown.service"
                ],
            )
            self.assertIn(
                (
                    ["systemctl", "daemon-reload"],
                    "reload systemd",
                ),
                recorded,
            )
            self.assertIn(
                (
                    ["systemctl", "disable", "podman-restart.service"],
                    "disable system Podman container restart service",
                ),
                recorded,
            )
            self.assertIn(
                (
                    ["systemctl", "mask", "podman-restart.service"],
                    "mask system Podman container restart service",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "systemctl",
                        "reset-failed",
                        "podman-restart.service",
                        "cocalc-project-host-prepare.service",
                    ],
                    "clear stale Podman boot preparation failures",
                ),
                recorded,
            )
            self.assertIn(
                (
                    ["systemctl", "enable", "cocalc-project-host-prepare.service"],
                    "enable Podman boot preparation service",
                ),
                recorded,
            )
            self.assertIn(
                (
                    ["systemctl", "enable", "cocalc-project-host-start.service"],
                    "enable project-host boot service",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "systemctl",
                        "enable",
                        "--now",
                        "cocalc-project-host-shutdown.service",
                    ],
                    "enable project-host shutdown notifier",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "systemctl",
                        "enable",
                        "--now",
                        "cocalc-project-host-watchdog.timer",
                    ],
                    "enable project-host watchdog timer",
                ),
                recorded,
            )
            self.assertIn(
                (
                    ["rm", "-f", "/etc/cron.d/cocalc-project-host"],
                    "remove legacy project-host cron watchdog",
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

    def test_configure_runtime_sudoers_whitelists_project_host_rootctl(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []
            writes = []
            rootctl = Path(tmpdir) / "usr-local-sbin" / "cocalc-project-host-rootctl"

            original_rootctl_path = bootstrap.project_host_rootctl_path
            original_run_cmd = bootstrap.run_cmd
            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.project_host_rootctl_path = lambda _cfg=None: rootctl
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append((args, desc))
                )
                bootstrap.Path.write_text = (
                    lambda self, data, encoding="utf-8": writes.append(
                        (str(self), data, encoding)
                    )
                    or len(data)
                )
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_runtime_sudoers(cfg)
            finally:
                bootstrap.project_host_rootctl_path = original_rootctl_path
                bootstrap.run_cmd = original_run_cmd
                bootstrap.Path.write_text = original_write_text
                bootstrap.os.chmod = original_chmod

            sudoers = next(data for path, data, _ in writes if path == "/etc/sudoers.d/cocalc-project-host-runtime")
            self.assertIn(f"Cmnd_Alias COCALC_RUNTIME_PROJECT_HOST = {rootctl}", sudoers)
            self.assertIn("COCALC_RUNTIME_PROJECT_HOST", sudoers)
            self.assertIn(
                (
                    ["visudo", "-c", "-f", "/etc/sudoers.d/cocalc-project-host-runtime"],
                    "validate runtime sudoers",
                ),
                recorded,
            )

    def test_configure_critical_service_oom_protection_writes_dropins_and_applies_choom(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(True),
            )
            writes = []
            mkdirs = []
            recorded = []

            original_mkdir = bootstrap.Path.mkdir
            original_write_text = bootstrap.Path.write_text
            original_run_best_effort = bootstrap.run_best_effort
            try:
                bootstrap.Path.mkdir = (
                    lambda self, parents=False, exist_ok=False: mkdirs.append(
                        (str(self), parents, exist_ok)
                    )
                )
                bootstrap.Path.write_text = (
                    lambda self, data, encoding="utf-8": writes.append(
                        (str(self), data, encoding)
                    )
                    or len(data)
                )
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.configure_critical_service_oom_protection(cfg)
            finally:
                bootstrap.Path.mkdir = original_mkdir
                bootstrap.Path.write_text = original_write_text
                bootstrap.run_best_effort = original_run_best_effort

            self.assertIn(
                (
                    "/etc/systemd/system/ssh.service.d",
                    True,
                    True,
                ),
                mkdirs,
            )
            self.assertIn(
                (
                    "/etc/systemd/system/sshd.service.d",
                    True,
                    True,
                ),
                mkdirs,
            )
            self.assertIn(
                (
                    "/etc/systemd/system/cocalc-cloudflared.service.d",
                    True,
                    True,
                ),
                mkdirs,
            )
            self.assertIn(
                (
                    "/etc/systemd/system/ssh.service.d/cocalc-oom-protect.conf",
                    f"[Service]\nOOMScoreAdjust={bootstrap.HOST_CRITICAL_OOM_SCORE_ADJ}\n",
                    "utf-8",
                ),
                writes,
            )
            self.assertIn(
                (
                    ["systemctl", "daemon-reload"],
                    "reload systemd after OOM drop-ins",
                ),
                recorded,
            )
            self.assertEqual(
                recorded[1][1],
                "protect sshd from OOM kills",
            )
            self.assertEqual(
                recorded[2][1],
                "protect cloudflared from OOM kills",
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
            downloads = []

            original_run_cmd = bootstrap.run_cmd
            original_download_file = bootstrap.download_file
            original_verify_sha256 = bootstrap.verify_sha256
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                def record_run(_cfg, args, desc, **kwargs):
                    recorded.append((args, desc, kwargs))
                    return bootstrap.subprocess.CompletedProcess(args, 0)

                bootstrap.run_cmd = record_run
                bootstrap.download_file = (
                    lambda _cfg, url, dest, **kwargs: downloads.append(
                        (url, dest, kwargs)
                    )
                )
                bootstrap.verify_sha256 = lambda _cfg, path, expected: recorded.append(
                    (["verify", path, expected], "verify cloudflared", {})
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
                bootstrap.download_file = original_download_file
                bootstrap.verify_sha256 = original_verify_sha256
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            self.assertIn(
                (
                    "https://github.com/cloudflare/cloudflared/releases/download/2026.7.2/cloudflared-linux-amd64.deb",
                    "/tmp/cloudflared.deb",
                    {"attempts": 6},
                ),
                downloads,
            )
            self.assertTrue(
                any(
                    args
                    == [
                        "verify",
                        "/tmp/cloudflared.deb",
                        bootstrap.CLOUDFLARED_DEB_SHA256["amd64"],
                    ]
                    for args, _desc, _kwargs in recorded
                )
            )
            self.assertTrue(
                any(
                    args == ["dpkg", "-i", "/tmp/cloudflared.deb"]
                    and desc == "install cloudflared"
                    for args, desc, _kwargs in recorded
                )
            )
            self.assertTrue(
                any(
                    args == ["systemctl", "restart", "cocalc-cloudflared"]
                    and kwargs.get("timeout") == 45
                    for args, _desc, kwargs in recorded
                )
            )

    def test_reconcile_cloudflared_upgrades_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(
                    True,
                    hostname="host.example.test",
                    port=9002,
                    token="token",
                ),
            )
            recorded = []
            downloads = []

            original_run_cmd = bootstrap.run_cmd
            original_download_file = bootstrap.download_file
            original_verify_sha256 = bootstrap.verify_sha256
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                def record_run(_cfg, args, desc, **kwargs):
                    recorded.append((args, desc, kwargs))
                    stdout = (
                        "cloudflared version 2026.6.0 (built 2026-06-01)"
                        if desc == "inspect cloudflared version"
                        else ""
                    )
                    return bootstrap.subprocess.CompletedProcess(
                        args, 0, stdout=stdout
                    )

                bootstrap.run_cmd = record_run
                bootstrap.download_file = (
                    lambda _cfg, url, dest, **kwargs: downloads.append(
                        (url, dest, kwargs)
                    )
                )
                bootstrap.verify_sha256 = lambda _cfg, path, expected: recorded.append(
                    (["verify", path, expected], "verify cloudflared", {})
                )
                bootstrap.shutil.which = lambda name: (
                    "/usr/bin/cloudflared"
                    if name == "cloudflared"
                    else original_which(name)
                )
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, _text, encoding="utf-8": 0  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_cloudflared_with_options(
                    cfg, install_package=False
                )
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.download_file = original_download_file
                bootstrap.verify_sha256 = original_verify_sha256
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            self.assertEqual(
                downloads,
                [
                    (
                        "https://github.com/cloudflare/cloudflared/releases/download/2026.7.2/cloudflared-linux-amd64.deb",
                        "/tmp/cloudflared.deb",
                        {"attempts": 6},
                    )
                ],
            )
            self.assertTrue(
                any(
                    args == ["dpkg", "-i", "/tmp/cloudflared.deb"]
                    and desc == "install cloudflared"
                    for args, desc, _kwargs in recorded
                )
            )
            self.assertTrue(
                any(
                    args == ["systemctl", "restart", "cocalc-cloudflared"]
                    for args, _desc, _kwargs in recorded
                )
            )

    def test_configure_cloudflared_prefers_credentials_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(
                    True,
                    hostname="host.example.test",
                    port=9002,
                    exam_hostname="exam.example.test",
                    token="token",
                    tunnel_id="tunnel-id",
                    creds_json='{"TunnelSecret":"secret"}',
                ),
            )
            writes = []

            original_run_cmd = bootstrap.run_cmd
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_exists = Path.exists
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.run_cmd = lambda _cfg, args, desc, **_kwargs: bootstrap.subprocess.CompletedProcess(
                    args,
                    0,
                    stdout=(
                        f"cloudflared version {bootstrap.CLOUDFLARED_VERSION}"
                        if desc == "inspect cloudflared version"
                        else ""
                    ),
                )
                bootstrap.shutil.which = lambda name: "/usr/bin/cloudflared"
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, text, encoding="utf-8": writes.append(  # type: ignore[method-assign]
                    (str(self), text, encoding)
                ) or len(text)
                Path.exists = lambda self: str(self) == "/etc/cloudflared/tunnel-id.json"  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_cloudflared_with_options(
                    cfg, install_package=False
                )
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                Path.exists = original_exists  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            config = next(data for path, data, _ in writes if path == "/etc/cloudflared/config.yml")
            unit = next(data for path, data, _ in writes if path == "/etc/systemd/system/cocalc-cloudflared.service")
            recovery_dropin = next(
                data
                for path, data, _ in writes
                if path
                == "/etc/systemd/system/cocalc-cloudflared.service.d/cocalc-recovery.conf"
            )
            self.assertIn("credentials-file: /etc/cloudflared/tunnel-id.json", config)
            self.assertIn("protocol: auto", config)
            self.assertIn("grace-period: 10s", config)
            self.assertIn('hostname: "exam.example.test"', config)
            self.assertIn("--no-autoupdate", unit)
            self.assertNotIn("--token", unit)
            self.assertNotIn("EnvironmentFile=/etc/cloudflared/token.env", unit)
            self.assertEqual(recovery_dropin, "[Service]\nTimeoutStopSec=30\n")

    def test_configure_cloudflared_uses_token_file_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(
                    True,
                    hostname="host.example.test",
                    port=9002,
                    token="token",
                    tunnel_id="tunnel-id",
                ),
            )
            writes = []

            original_run_cmd = bootstrap.run_cmd
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_exists = Path.exists
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.run_cmd = lambda _cfg, args, desc, **_kwargs: bootstrap.subprocess.CompletedProcess(
                    args,
                    0,
                    stdout=(
                        f"cloudflared version {bootstrap.CLOUDFLARED_VERSION}"
                        if desc == "inspect cloudflared version"
                        else ""
                    ),
                )
                bootstrap.shutil.which = lambda name: "/usr/bin/cloudflared"
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, text, encoding="utf-8": writes.append(  # type: ignore[method-assign]
                    (str(self), text, encoding)
                ) or len(text)
                Path.exists = lambda self: False  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.configure_cloudflared_with_options(
                    cfg, install_package=False
                )
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                Path.exists = original_exists  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            token = next(data for path, data, _ in writes if path == "/etc/cloudflared/token")
            config = next(data for path, data, _ in writes if path == "/etc/cloudflared/config.yml")
            unit = next(data for path, data, _ in writes if path == "/etc/systemd/system/cocalc-cloudflared.service")
            self.assertEqual(token, "token\n")
            self.assertNotIn("credentials-file:", config)
            self.assertIn("--token-file /etc/cloudflared/token", unit)
            self.assertNotIn("EnvironmentFile=/etc/cloudflared/token.env", unit)

    def test_reconcile_cloudflared_keeps_active_unchanged_tunnel_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                cloudflared=bootstrap.CloudflaredSpec(
                    True,
                    hostname="host.example.test",
                    port=9002,
                    token="token",
                    tunnel_id="tunnel-id",
                    creds_json='{"TunnelSecret":"secret"}',
                ),
            )
            stored: dict[str, str] = {}
            commands = []
            events = []

            original_run_cmd = bootstrap.run_cmd
            original_log_line = bootstrap.log_line
            original_which = bootstrap.shutil.which
            original_mkdir = Path.mkdir
            original_write_text = Path.write_text
            original_read_text = Path.read_text
            original_exists = Path.exists
            original_chmod = bootstrap.os.chmod
            try:
                def record_run(_cfg, args, desc, **kwargs):
                    commands.append((args, desc, kwargs))
                    return bootstrap.subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=(
                            f"cloudflared version {bootstrap.CLOUDFLARED_VERSION}"
                            if desc == "inspect cloudflared version"
                            else ""
                        ),
                    )

                def read_stored(self, encoding="utf-8"):
                    try:
                        return stored[str(self)]
                    except KeyError as exc:
                        raise FileNotFoundError(str(self)) from exc

                bootstrap.run_cmd = record_run
                bootstrap.log_line = lambda _cfg, message: events.append(message)
                bootstrap.shutil.which = lambda _name: "/usr/bin/cloudflared"
                Path.mkdir = lambda self, parents=False, exist_ok=False: None  # type: ignore[method-assign]
                Path.write_text = lambda self, text, encoding="utf-8": stored.__setitem__(str(self), text) or len(text)  # type: ignore[method-assign]
                Path.read_text = read_stored  # type: ignore[method-assign]
                Path.exists = lambda self: str(self) in stored or str(self) == "/etc/cloudflared/tunnel-id.json"  # type: ignore[method-assign]
                bootstrap.os.chmod = lambda *_args, **_kwargs: None

                bootstrap.configure_cloudflared_with_options(cfg, install_package=False)
                stored.pop(
                    "/etc/systemd/system/cocalc-cloudflared.service.d/cocalc-recovery.conf"
                )
                commands.clear()
                events.clear()
                bootstrap.configure_cloudflared_with_options(cfg, install_package=False)
            finally:
                bootstrap.run_cmd = original_run_cmd
                bootstrap.log_line = original_log_line
                bootstrap.shutil.which = original_which
                Path.mkdir = original_mkdir  # type: ignore[method-assign]
                Path.write_text = original_write_text  # type: ignore[method-assign]
                Path.read_text = original_read_text  # type: ignore[method-assign]
                Path.exists = original_exists  # type: ignore[method-assign]
                bootstrap.os.chmod = original_chmod

            self.assertFalse(
                any(args[:2] == ["systemctl", "restart"] for args, _desc, _kwargs in commands)
            )
            self.assertTrue(
                any(args[:2] == ["systemctl", "daemon-reload"] for args, _desc, _kwargs in commands)
            )
            self.assertTrue(
                any(args[:3] == ["systemctl", "is-active", "--quiet"] for args, _desc, _kwargs in commands)
            )
            self.assertIn(
                "bootstrap: cloudflared config unchanged; keeping tunnel running",
                events,
            )


class BootstrapModesTest(unittest.TestCase):
    def test_bootstrap_operation_lock_times_out_when_another_process_holds_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            events: list[str] = []
            original_timeout = os.environ.get("COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS")
            originals = {
                "flock": bootstrap.fcntl.flock,
                "log_line": bootstrap.log_line,
                "monotonic": bootstrap.time.monotonic,
                "sleep": bootstrap.time.sleep,
            }
            clock = {"now": 0.0}

            def fake_flock(_fd: int, operation: int) -> None:
                if operation & bootstrap.fcntl.LOCK_NB:
                    raise BlockingIOError()

            def fake_monotonic() -> float:
                return clock["now"]

            def fake_sleep(seconds: float) -> None:
                clock["now"] += seconds

            os.environ["COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS"] = "1"
            bootstrap.fcntl.flock = fake_flock
            bootstrap.log_line = lambda _cfg, message: events.append(message)
            bootstrap.time.monotonic = fake_monotonic
            bootstrap.time.sleep = fake_sleep
            try:
                with self.assertRaises(TimeoutError) as ctx:
                    with bootstrap.bootstrap_operation_lock(cfg):
                        pass
            finally:
                if original_timeout is None:
                    os.environ.pop("COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS", None)
                else:
                    os.environ["COCALC_BOOTSTRAP_LOCK_TIMEOUT_SECS"] = original_timeout
                bootstrap.fcntl.flock = originals["flock"]
                bootstrap.log_line = originals["log_line"]
                bootstrap.time.monotonic = originals["monotonic"]
                bootstrap.time.sleep = originals["sleep"]

            self.assertIn("timed out waiting for lifecycle lock", str(ctx.exception))
            self.assertTrue(
                any("bootstrap: acquiring lifecycle lock" in event for event in events)
            )
            self.assertFalse(
                any("bootstrap: acquired lifecycle lock" in event for event in events)
            )

    def test_reconcile_mode_runs_under_lifecycle_lock(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            events: list[str] = []
            originals = {}

            class FakeLock:
                def __enter__(self_inner):
                    events.append("lock-enter")

                def __exit__(self_inner, exc_type, exc, tb):
                    events.append("lock-exit")

            def patch(name: str, replacement) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(bootstrap, name, replacement)

            patch("load_config", lambda _bootstrap_dir: cfg)
            patch("bootstrap_operation_lock", lambda _cfg: FakeLock())
            patch(
                "run_reconcile",
                lambda _cfg: events.append("run-reconcile") or 0,
            )
            patch("log_line", lambda *_args, **_kwargs: None)
            try:
                result = bootstrap.main(
                    ["reconcile", "--bootstrap-dir", cfg.bootstrap_dir]
                )
            finally:
                for name, original in originals.items():
                    setattr(bootstrap, name, original)

            self.assertEqual(result, 0)
            self.assertEqual(events, ["lock-enter", "run-reconcile", "lock-exit"])

    def test_helper_reconcile_does_not_restart_runtime_services(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            events: list[str] = []
            originals = {}

            def patch(name: str, replacement) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(bootstrap, name, replacement)

            for name in (
                "ensure_runtime_user",
                "ensure_bootstrap_paths",
                "configure_rsyslog_limits",
                "configure_daily_root_cleanup",
                "install_privileged_wrappers",
                "install_privileged_tool_binaries",
                "write_helpers",
                "configure_runtime_sudoers",
                "verify_runtime_sudoers",
                "configure_autostart",
                "reconcile_bees_runtime_policy",
                "reconcile_project_network_limits",
                "reconcile_project_io_policy",
                "reconcile_host_service_cgroup",
            ):
                patch(name, lambda _cfg, name=name: events.append(name))
            patch(
                "configure_cloudflared_with_options",
                lambda _cfg, *, install_package: events.append(
                    f"configure_cloudflared:{install_package}"
                ),
            )
            patch(
                "start_project_host",
                lambda _cfg: self.fail("helper reconcile restarted project-host"),
            )
            patch(
                "record_operation_start",
                lambda _cfg, operation: events.append(f"start:{operation}"),
            )
            patch(
                "record_operation_success",
                lambda _cfg, operation: events.append(f"success:{operation}"),
            )
            patch(
                "record_operation_failure",
                lambda _cfg, operation, error: events.append(
                    f"failure:{operation}:{error}"
                ),
            )
            patch("report_bootstrap_status", lambda *_args, **_kwargs: None)
            patch("log_line", lambda *_args, **_kwargs: None)
            try:
                result = bootstrap.run_reconcile_helpers(cfg)
            finally:
                for name, original in originals.items():
                    setattr(bootstrap, name, original)

            self.assertEqual(result, 0)
            self.assertEqual(
                events,
                [
                    "start:reconcile",
                    "ensure_runtime_user",
                    "ensure_bootstrap_paths",
                    "configure_rsyslog_limits",
                    "configure_daily_root_cleanup",
                    "install_privileged_wrappers",
                    "install_privileged_tool_binaries",
                    "write_helpers",
                    "configure_runtime_sudoers",
                    "verify_runtime_sudoers",
                    "configure_autostart",
                    "reconcile_bees_runtime_policy",
                    "reconcile_project_network_limits",
                    "reconcile_project_io_policy",
                    "reconcile_host_service_cgroup",
                    "configure_cloudflared:False",
                    "success:reconcile",
                ],
            )

    def test_environment_reconcile_only_writes_managed_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            events: list[str] = []
            originals = {}

            def patch(name: str, replacement) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(bootstrap, name, replacement)

            patch(
                "ensure_runtime_user",
                lambda _cfg: events.append("ensure_runtime_user"),
            )
            patch(
                "ensure_bootstrap_paths",
                lambda _cfg: events.append("ensure_bootstrap_paths"),
            )
            patch("compute_image_size", lambda _cfg: 123)
            patch(
                "write_env",
                lambda _cfg, image_size_gb: events.append(
                    f"write_env:{image_size_gb}"
                ),
            )
            patch(
                "write_bootstrap_state_files",
                lambda _cfg: events.append("write_bootstrap_state_files"),
            )
            patch(
                "start_project_host",
                lambda _cfg: self.fail(
                    "environment reconcile restarted project-host"
                ),
            )
            patch(
                "record_operation_start",
                lambda _cfg, operation: events.append(f"start:{operation}"),
            )
            patch(
                "record_operation_success",
                lambda _cfg, operation: events.append(f"success:{operation}"),
            )
            patch(
                "record_operation_failure",
                lambda _cfg, operation, error: events.append(
                    f"failure:{operation}:{error}"
                ),
            )
            patch("report_bootstrap_status", lambda *_args, **_kwargs: None)
            patch("log_line", lambda *_args, **_kwargs: None)
            try:
                result = bootstrap.run_reconcile_environment(cfg)
            finally:
                for name, original in originals.items():
                    setattr(bootstrap, name, original)

            self.assertEqual(result, 0)
            self.assertEqual(
                events,
                [
                    "start:reconcile",
                    "ensure_runtime_user",
                    "ensure_bootstrap_paths",
                    "write_env:123",
                    "write_bootstrap_state_files",
                    "success:reconcile",
                ],
            )

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
                        "container_runtime_bundle": {
                            "url": "",
                            "sha256": None,
                            "remote": "",
                            "root": str(Path(tmpdir) / "container-runtime"),
                            "dir": str(Path(tmpdir) / "container-runtime" / "v1"),
                            "current": str(
                                Path(tmpdir) / "container-runtime" / "current"
                            ),
                            "version": "v1",
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
            events: list[str] = []

            def patch(name: str, replacement) -> None:
                originals[name] = getattr(bootstrap, name)
                setattr(bootstrap, name, replacement)

            patch(
                "BOOTSTRAP_LIFECYCLE_EXPORT_DIR",
                Path(tmpdir) / "bootstrap-lifecycle",
            )
            patch("ensure_runtime_user", lambda _cfg: None)
            patch("ensure_bootstrap_paths", lambda _cfg: None)
            patch("ensure_automatic_security_updates", lambda _cfg: None)
            patch("configure_daily_root_cleanup", lambda _cfg: None)
            patch("compute_image_size", lambda _cfg: 10)
            patch("configure_kernel_module_hardening", lambda _cfg: None)
            patch("configure_kernel_key_limits", lambda _cfg: None)
            patch("configure_inotify_limits", lambda _cfg: None)
            patch("configure_journald_limits", lambda _cfg: None)
            patch("configure_rsyslog_limits", lambda _cfg: None)
            patch("install_btrfs_helper", lambda _cfg: None)
            patch("install_privileged_wrappers", lambda _cfg: None)
            patch("reconcile_storage_and_containment", lambda _cfg: None)
            patch("reconcile_project_network_limits", lambda _cfg: None)
            patch("reconcile_project_io_policy", lambda _cfg: None)
            patch("reconcile_host_service_cgroup", lambda _cfg: None)
            patch("ensure_cocalc_mount", lambda _cfg: None)
            patch("ensure_btrfs_data", lambda _cfg: None)
            patch("ensure_subuids", lambda _cfg: None)
            patch("configure_podman", lambda _cfg: events.append("configure_podman"))
            patch("verify_runtime_user_contract", lambda _cfg: None)
            patch("write_env", lambda _cfg, _size: None)
            patch("ensure_runtime_user_manager", lambda _cfg: None)
            patch("configure_runtime_shell_env", lambda _cfg: None)
            patch("setup_master_conat_token", lambda _cfg: None)
            patch(
                "extract_bundle",
                lambda _cfg, bundle: (
                    events.append(f"extract:{bundle.root}"),
                    bundle,
                )[1],
            )
            patch("install_privileged_tool_binaries", lambda _cfg, _bundle: None)
            patch("install_node", lambda _cfg: None)
            patch("configure_node_bind_service_capability", lambda _cfg: None)
            patch("write_wrapper", lambda _cfg: None)
            patch("write_helpers", lambda _cfg: None)
            patch("configure_runtime_sudoers", lambda _cfg: None)
            patch("verify_runtime_sudoers", lambda _cfg: None)
            patch("configure_cloudflared_with_options", lambda _cfg, install_package=False: None)
            patch("configure_critical_service_oom_protection", lambda _cfg: None)
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
            self.assertLess(
                events.index(f"extract:{Path(tmpdir) / 'container-runtime'}"),
                events.index("configure_podman"),
            )
            state = json.loads(
                (Path(cfg.bootstrap_dir) / "bootstrap-state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["last_reconcile_result"], "success")


class GpuBootstrapTest(unittest.TestCase):
    def test_nvidia_cdi_normalizer_downgrades_podman4_incompatible_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            script = Path(tmpdir) / "normalize.py"
            spec = Path(tmpdir) / "nvidia.yaml"
            script.write_text(bootstrap.NVIDIA_CDI_NORMALIZER_SCRIPT, encoding="utf-8")
            spec.write_text(
                """---
cdiVersion: 0.7.0
kind: nvidia.com/gpu
devices:
    - name: "0"
      containerEdits:
        deviceNodes:
            - path: /dev/nvidia0
              major: 195
              fileMode: 438
              permissions: rwm
        additionalGids:
            - 44
            - 992
    - name: all
      containerEdits:
        hooks:
            - hookName: createContainer
              path: /usr/bin/nvidia-cdi-hook
        additionalGids:
            - 44
""",
                encoding="utf-8",
            )

            subprocess.run(["python3", str(script), str(spec)], check=True)

            normalized = spec.read_text(encoding="utf-8")
            self.assertIn("cdiVersion: 0.5.0", normalized)
            self.assertNotIn("additionalGids", normalized)
            self.assertIn("path: /dev/nvidia0", normalized)
            self.assertIn("hookName: createContainer", normalized)

    def test_install_gpu_support_allows_held_nvidia_toolkit_upgrade(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(make_cfg(tmpdir), has_gpu=True)
            recorded = []

            original_apt_run = bootstrap.apt_run
            original_run_cmd = bootstrap.run_cmd
            original_run_best_effort = bootstrap.run_best_effort
            original_write_text = bootstrap.Path.write_text
            original_chmod = bootstrap.os.chmod
            try:
                bootstrap.apt_run = (
                    lambda _cfg, args, desc, **kwargs: recorded.append((args, desc))
                )
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append((args, desc))
                )
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc: recorded.append((args, desc))
                )
                bootstrap.Path.write_text = lambda self, _data, encoding="utf-8": 0
                bootstrap.os.chmod = lambda *_args, **_kwargs: None
                bootstrap.install_gpu_support(cfg)
            finally:
                bootstrap.apt_run = original_apt_run
                bootstrap.run_cmd = original_run_cmd
                bootstrap.run_best_effort = original_run_best_effort
                bootstrap.Path.write_text = original_write_text
                bootstrap.os.chmod = original_chmod

            self.assertIn(
                (
                    ["/usr/local/sbin/cocalc-nvidia-cdi-normalize"],
                    "normalize nvidia cdi for podman",
                ),
                recorded,
            )
            self.assertIn(
                (
                    [
                        "apt-get",
                        "-y",
                        "--allow-change-held-packages",
                        "install",
                        "nvidia-container-toolkit",
                    ],
                    "install nvidia-container-toolkit",
                ),
                recorded,
            )


class AptBootstrapTest(unittest.TestCase):
    def test_disable_unattended_only_stops_automatic_apt_units(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            recorded = []
            original_run_best_effort = bootstrap.run_best_effort
            try:
                bootstrap.run_best_effort = (
                    lambda _cfg, args, desc, **kwargs: recorded.append(
                        (args, desc, kwargs)
                    )
                )
                bootstrap.disable_unattended(cfg)
            finally:
                bootstrap.run_best_effort = original_run_best_effort

            self.assertEqual(len(recorded), 1)
            self.assertEqual(recorded[0][0][0:2], ["systemctl", "stop"])
            self.assertEqual(recorded[0][2]["timeout"], bootstrap.APT_LOCK_TIMEOUT_S)
            flattened = " ".join(recorded[0][0])
            self.assertNotIn("pkill", flattened)
            self.assertNotIn("remove", flattened)

    def test_ensure_automatic_security_updates_is_strict(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            config_path = Path(tmpdir) / "52cocalc-periodic"
            helper_path = Path(tmpdir) / "cocalc-security-update"
            service_path = Path(tmpdir) / "cocalc-security-updates.service"
            timer_path = Path(tmpdir) / "cocalc-security-updates.timer"
            status_dir = Path(tmpdir) / "security-update-status"
            recorded = []
            originals = {
                "apt_run": bootstrap.apt_run,
                "run_cmd": bootstrap.run_cmd,
                "reconcile": bootstrap.reconcile_gce_ubuntu_apt_sources,
                "which": bootstrap.shutil.which,
            }
            try:
                bootstrap.reconcile_gce_ubuntu_apt_sources = (
                    lambda _cfg: recorded.append(("reconcile",))
                )
                bootstrap.apt_run = (
                    lambda _cfg, args, desc, retries, timeout: recorded.append(
                        ("apt", args, desc, retries, timeout)
                    )
                )
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append(
                        ("command", args, desc, kwargs)
                    )
                    or subprocess.CompletedProcess(args, 0, stdout="")
                )
                bootstrap.shutil.which = lambda command: (
                    "/usr/bin/unattended-upgrade"
                    if command == "unattended-upgrade"
                    else None
                )
                bootstrap.ensure_automatic_security_updates(
                    cfg,
                    config_path=config_path,
                    helper_path=helper_path,
                    service_path=service_path,
                    timer_path=timer_path,
                    status_dir=status_dir,
                )
            finally:
                bootstrap.apt_run = originals["apt_run"]
                bootstrap.run_cmd = originals["run_cmd"]
                bootstrap.reconcile_gce_ubuntu_apt_sources = originals["reconcile"]
                bootstrap.shutil.which = originals["which"]

            self.assertEqual(recorded[0], ("reconcile",))
            apt_calls = [entry for entry in recorded if entry[0] == "apt"]
            self.assertEqual(len(apt_calls), 2)
            self.assertEqual(apt_calls[0][1][-1], "update")
            self.assertEqual(apt_calls[1][1][-2:], ["install", "unattended-upgrades"])
            self.assertIn(
                f"DPkg::Lock::Timeout={bootstrap.APT_LOCK_TIMEOUT_S}",
                apt_calls[0][1],
            )
            self.assertEqual(
                config_path.read_text(encoding="utf-8"),
                bootstrap.AUTOMATIC_SECURITY_UPDATES_CONFIG,
            )
            self.assertTrue(helper_path.stat().st_mode & 0o100)
            self.assertIn("unattended-upgrade --verbose", helper_path.read_text())
            subprocess.run(["bash", "-n", str(helper_path)], check=True)
            self.assertIn(
                str(status_dir),
                helper_path.read_text(),
            )
            self.assertIn(
                f"ExecStart={helper_path}",
                service_path.read_text(),
            )
            self.assertIn("FixedRandomDelay=true", timer_path.read_text())
            command_args = [entry[1] for entry in recorded if entry[0] == "command"]
            self.assertIn(
                [
                    "systemctl",
                    "disable",
                    "--now",
                    "apt-daily.timer",
                    "apt-daily-upgrade.timer",
                ],
                command_args,
            )
            self.assertIn(
                [
                    "systemctl",
                    "enable",
                    "--now",
                    "cocalc-security-updates.timer",
                ],
                command_args,
            )
            self.assertIn(
                ["systemctl", "is-active", "cocalc-security-updates.timer"],
                command_args,
            )

    def test_configure_daily_root_cleanup_uses_only_allowlisted_caches(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            helper_path = Path(tmpdir) / "cocalc-root-cleanup"
            service_path = Path(tmpdir) / "cocalc-root-cleanup.service"
            timer_path = Path(tmpdir) / "cocalc-root-cleanup.timer"
            status_dir = Path(tmpdir) / "root-cleanup-status"
            recorded = []
            original_run_cmd = bootstrap.run_cmd
            try:
                bootstrap.run_cmd = (
                    lambda _cfg, args, desc, **kwargs: recorded.append(
                        (args, desc, kwargs)
                    )
                    or subprocess.CompletedProcess(args, 0, stdout="")
                )
                bootstrap.configure_daily_root_cleanup(
                    cfg,
                    helper_path=helper_path,
                    service_path=service_path,
                    timer_path=timer_path,
                    status_dir=status_dir,
                )
            finally:
                bootstrap.run_cmd = original_run_cmd

            script = helper_path.read_text(encoding="utf-8")
            subprocess.run(["bash", "-n", str(helper_path)], check=True)
            subprocess.run([str(helper_path), "--dry-run"], check=True)
            status = json.loads(
                (status_dir / "status.json").read_text(encoding="utf-8")
            )
            self.assertEqual(status["result"], "dry-run")
            self.assertIn("/var/lib/snapd/cache", script)
            self.assertIn("apt-get clean", script)
            self.assertIn("journalctl --vacuum-size=200M", script)
            self.assertIn(
                "/run/lock/cocalc-privileged-rustic-cache.lock", script
            )
            self.assertIn("/root/.cache/rustic", script)
            self.assertIn("--dry-run", script)
            self.assertIn('LOCK_FILE="$STATUS_DIR/cleanup.lock"', script)
            self.assertNotIn("/opt/cocalc/tools/releases", script)
            self.assertNotIn("/mnt/cocalc", script)
            self.assertIn(f"ExecStart={helper_path}", service_path.read_text())
            self.assertIn("FixedRandomDelay=true", timer_path.read_text())
            command_args = [entry[0] for entry in recorded]
            self.assertIn(
                ["systemctl", "enable", "--now", "cocalc-root-cleanup.timer"],
                command_args,
            )

    def test_reconcile_gce_ubuntu_apt_sources_rewrites_security_to_gce_mirror(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = make_cfg(tmpdir)
            sources = Path(tmpdir) / "ubuntu.sources"
            sources.write_text(
                """Types: deb
URIs: http://us-south1-c.gce.clouds.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
""",
                encoding="utf-8",
            )

            bootstrap.reconcile_gce_ubuntu_apt_sources(cfg, [sources])

            self.assertIn(
                "URIs: http://us-south1-c.gce.clouds.archive.ubuntu.com/ubuntu",
                sources.read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "security.ubuntu.com/ubuntu",
                sources.read_text(encoding="utf-8"),
            )

    def test_apt_update_install_reconciles_gce_ubuntu_sources_before_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(make_cfg(tmpdir), apt_packages=["curl", "git"])
            recorded = []

            original_apt_run = bootstrap.apt_run
            original_reconcile = bootstrap.reconcile_gce_ubuntu_apt_sources
            try:
                bootstrap.reconcile_gce_ubuntu_apt_sources = (
                    lambda _cfg: recorded.append(("reconcile",))
                )
                bootstrap.apt_run = (
                    lambda _cfg, args, desc, retries, timeout: recorded.append(
                        (args, desc, retries, timeout)
                    )
                )
                bootstrap.apt_update_install(cfg)
            finally:
                bootstrap.apt_run = original_apt_run
                bootstrap.reconcile_gce_ubuntu_apt_sources = original_reconcile

            self.assertEqual(recorded[0], ("reconcile",))

    def test_apt_update_install_uses_more_tolerant_network_timeouts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir), apt_packages=["curl", "git"], node_version="24.15.0"
            )
            recorded = []

            original_apt_run = bootstrap.apt_run
            try:
                bootstrap.apt_run = (
                    lambda _cfg, args, desc, retries, timeout: recorded.append(
                        (args, desc, retries, timeout)
                    )
                )
                bootstrap.apt_update_install(cfg)
            finally:
                bootstrap.apt_run = original_apt_run

            self.assertEqual(
                recorded[0],
                (
                    [
                        "apt-get",
                        "-y",
                        "-o",
                        "Acquire::ForceIPv4=true",
                        "-o",
                        f"Acquire::Retries={bootstrap.APT_RETRIES}",
                        "-o",
                        f"Acquire::http::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"Acquire::https::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"Acquire::ftp::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"DPkg::Lock::Timeout={bootstrap.APT_LOCK_TIMEOUT_S}",
                        "update",
                    ],
                    "apt-get update",
                    bootstrap.APT_RETRIES,
                    bootstrap.APT_UPDATE_TIMEOUT_S,
                ),
            )
            self.assertEqual(
                recorded[1],
                (
                    [
                        "apt-get",
                        "-y",
                        "-o",
                        "Acquire::ForceIPv4=true",
                        "-o",
                        f"Acquire::Retries={bootstrap.APT_RETRIES}",
                        "-o",
                        f"Acquire::http::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"Acquire::https::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"Acquire::ftp::Timeout={bootstrap.APT_ACQUIRE_TIMEOUT_S}",
                        "-o",
                        f"DPkg::Lock::Timeout={bootstrap.APT_LOCK_TIMEOUT_S}",
                        "--no-install-recommends",
                        "install",
                        "curl",
                        "git",
                    ],
                    "apt-get install",
                    bootstrap.APT_RETRIES,
                    bootstrap.APT_INSTALL_TIMEOUT_S,
                ),
            )

    def test_apt_update_install_adds_node26_runtime_library(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(make_cfg(tmpdir), apt_packages=["curl"], node_version="26.2.0")
            recorded = []

            original_apt_run = bootstrap.apt_run
            try:
                bootstrap.apt_run = (
                    lambda _cfg, args, desc, retries, timeout: recorded.append(
                        (args, desc, retries, timeout)
                    )
                )
                bootstrap.apt_update_install(cfg)
            finally:
                bootstrap.apt_run = original_apt_run

            self.assertIn("curl", recorded[1][0])
            self.assertIn("libatomic1", recorded[1][0])
            self.assertEqual(recorded[1][0].count("libatomic1"), 1)

    def test_apt_update_install_deduplicates_node_runtime_library(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg = replace(
                make_cfg(tmpdir),
                apt_packages=["curl", "libatomic1"],
                node_version="26.2.0",
            )

            self.assertEqual(
                bootstrap.effective_apt_packages(cfg),
                ["curl", "libatomic1"],
            )


if __name__ == "__main__":
    unittest.main()
