#!/usr/bin/env python3
"""Unit/OS-lock tests; real systemd/cgroup cancellation remains a canary gate."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import bootstrap


class RusticJobTest(unittest.TestCase):
    def setUp(self):
        self.api = {"__name__": "rustic_job_test"}
        exec(bootstrap.RUSTIC_JOB_HELPER, self.api)
        self.policy = {
            "version": 1, "runtime_seconds": 1800, "kill_grace_seconds": 10,
            "memory_bytes": 2 * 1024**3, "cpu_quota_percent": 100,
            "io_weight": 10, "max_jobs": 2, "tasks_max": 128,
        }

    def test_native_policy_requires_digest_and_every_finite_budget(self):
        limits = {key: 100 for key in ("max-entries", "max-apparent-bytes", "max-file-bytes", "max-chunk-references", "max-metadata-bytes", "max-path-depth", "preflight-timeout-seconds")}
        policy = {**self.policy, "native": {"binary_sha256": "a" * 64, "admission": limits}}
        with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(policy)}):
            self.assertEqual(self.api["load_policy"](), policy)
            for key in limits:
                for value in [None, True, 0, -1, 2**63]:
                    invalid = copy.deepcopy(policy)
                    invalid["native"]["admission"][key] = value
                    with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(invalid)}):
                        with self.assertRaises(ValueError):
                            self.api["load_policy"]()
            del limits["max-chunk-references"]
            with self.assertRaises(ValueError):
                self.api["load_policy"]()

    def test_pinned_binary_uses_verified_inode_across_replacement(self):
        api = {"__name__": "path_test"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, api)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rustic"
            path.write_bytes(b"approved binary")
            path.chmod(0o755)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            fd = api["open_pinned_rustic"](str(path), digest, required_uid=os.getuid())
            try:
                replacement = Path(tmp) / "new"
                replacement.write_bytes(b"different binary")
                replacement.chmod(0o755)
                replacement.replace(path)
                self.assertEqual(Path(f"/proc/self/fd/{fd}").read_bytes(), b"approved binary")
                with self.assertRaises(ValueError):
                    api["open_pinned_rustic"](str(path), digest, required_uid=os.getuid())
            finally:
                os.close(fd)

    def test_capability_check_rejects_old_or_ambiguous_binary_output(self):
        api = {"__name__": "path_test"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, api)
        caps = {"strict_backup": True, "strict_restore": True,
                "sparse_required_restore": True, "hole_aware_backup": True,
                "backup_inventory": 1, "backup_admission": 1}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rustic"
            documents = [
                {"schema_version": 1, "capabilities": caps},
                {"schema_version": True, "capabilities": caps},
                {"schema_version": 1, "capabilities": {**caps, "backup_admission": True}},
                {"schema_version": 1, "capabilities": {**caps, "sparse_required_restore": False}},
            ]
            for index, document in enumerate(documents):
                path.write_text("#!/usr/bin/python3 -I\nprint(" + repr(json.dumps(document)) + ")\n")
                path.chmod(0o755)
                if index == 0:
                    api["verify_native_rustic"](str(path), {}, ())
                else:
                    with self.assertRaises(ValueError):
                        api["verify_native_rustic"](str(path), {}, ())
            path.write_text("#!/usr/bin/python3 -I\nprint('x' * 65537)\n")
            with self.assertRaises(ValueError):
                api["verify_native_rustic"](str(path), {}, ())

    def test_native_project_source_must_have_btrfs_readonly_flag(self):
        api = {"__name__": "path_test"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, api)
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                def readonly(_fd, operation, flags, mutate):
                    self.assertEqual(operation, 0x80089419)
                    self.assertTrue(mutate)
                    flags[0] = 2
                with mock.patch("fcntl.ioctl", side_effect=readonly):
                    api["require_readonly_btrfs_source"](fd)
                with mock.patch("fcntl.ioctl", return_value=0):
                    with self.assertRaises(ValueError):
                        api["require_readonly_btrfs_source"](fd)
                with mock.patch("fcntl.ioctl", side_effect=OSError("unsupported")):
                    with self.assertRaises(OSError):
                        api["require_readonly_btrfs_source"](fd)
            finally:
                os.close(fd)

    def test_policy_has_no_unlimited_or_environment_fallback(self):
        for key in self.policy:
            for value in [0, -1, True, "1", None]:
                policy = copy.deepcopy(self.policy)
                policy[key] = value
                with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(policy)}):
                    with self.assertRaises(ValueError, msg=f"{key}={value}"):
                        self.api["load_policy"]()

    def test_retry_policy_requires_finite_consistent_operator_limits(self):
        retry = {"base_seconds": 60, "max_seconds": 3600, "review_after_failures": 3}
        policy = {**self.policy, "retry": retry}
        with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(policy)}):
            self.assertEqual(self.api["load_policy"]()["retry"], retry)
            for key in retry:
                original = retry[key]
                for value in [None, True, 0, -1, 10**20]:
                    retry[key] = value
                    with self.assertRaises(ValueError):
                        self.api["load_policy"]()
                retry[key] = original
            retry["max_seconds"] = 1
            with self.assertRaises(ValueError):
                self.api["load_policy"]()

    def test_retry_survives_reload_and_requires_review_after_repeated_failures(self):
        retry = {"base_seconds": 60, "max_seconds": 100, "review_after_failures": 3}
        unit = "cocalc-rustic-" + "a" * 32 + ".service"
        state = {"version": 1, "phase": "running", "failures": 0,
                 "updated_at": 1000, "retry_at": 0, "reason": "started", "unit": unit}
        with tempfile.TemporaryDirectory() as tmp:
            directory = self.api["open_lock_directory"](tmp, required_uid=os.getuid())
            try:
                read = self.api["read_retry"]
                with mock.patch.dict(self.api, {"read_retry": lambda d, n: read(d, n, required_uid=os.getuid()),
                                              "unit_busy": lambda _: False}), \
                     mock.patch("time.time", return_value=1000):
                    self.api["write_retry"](directory, "project.backup.json", state)
                    with self.assertRaisesRegex(BlockingIOError, "RUSTIC_RETRY_DEFERRED"):
                        self.api["retry_admission"](directory, "project.backup.json", retry)
                    state = read(directory, "project.backup.json", required_uid=os.getuid())
                    self.assertEqual((state["failures"], state["retry_at"], state["reason"]), (1, 1060, "job_interrupted"))
                    # A fresh helper imports only persisted state, not memory.
                    fresh = {"__name__": "fresh_retry_test"}
                    exec(bootstrap.RUSTIC_JOB_HELPER, fresh)
                    self.assertEqual(fresh["read_retry"](directory, "project.backup.json", required_uid=os.getuid()), state)
                    with self.assertRaises(BlockingIOError):
                        self.api["retry_admission"](directory, "project.backup.json", retry)
                    self.assertEqual(read(directory, "project.backup.json", required_uid=os.getuid())["failures"], 1)
                    with mock.patch("time.time", return_value=1060):
                        self.assertEqual(self.api["retry_admission"](directory, "project.backup.json", retry), state)
                    state = self.api["failed_retry"](state, retry, "job_failed", 1060)
                    self.assertEqual(state["retry_at"], 1160)
                    state = self.api["failed_retry"](state, retry, "job_failed", 1160)
                    self.api["write_retry"](directory, "project.backup.json", state)
                    with mock.patch("time.time", return_value=10**6):
                        with self.assertRaisesRegex(RuntimeError, "RUSTIC_OPERATOR_REVIEW_REQUIRED"):
                            self.api["retry_admission"](directory, "project.backup.json", retry)
                    self.assertIsNone(self.api["retry_admission"](directory, "project.restore.json", retry))
            finally:
                os.close(directory)

    def test_retry_state_rejects_partial_untrusted_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = self.api["open_lock_directory"](tmp, required_uid=os.getuid())
            path = Path(tmp) / "state.json"
            try:
                for value in ["{", "{}", "x" * 4097]:
                    path.write_text(value)
                    path.chmod(0o600)
                    with self.assertRaises(ValueError):
                        self.api["read_retry"](directory, path.name, required_uid=os.getuid())
                path.chmod(0o644)
                with self.assertRaises(PermissionError):
                    self.api["read_retry"](directory, path.name, required_uid=os.getuid())
                path.unlink()
                path.symlink_to("missing")
                with self.assertRaises(OSError):
                    self.api["read_retry"](directory, path.name, required_uid=os.getuid())
            finally:
                os.close(directory)

    def test_retry_identity_ignores_staging_paths_but_separates_recovery(self):
        key = "a" * 64
        name = self.api["retry_name"]
        self.assertEqual(name(key, ["rustic-project-backup", "stage1"]), name(key, ["rustic-project-backup", "stage2"]))
        self.assertNotEqual(name(key, ["rustic-project-backup"]), name(key, ["rustic-project-restore"]))

    def test_first_persistent_directory_creation_syncs_parent(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("os.fsync") as sync:
            path = str(Path(tmp) / "retry")
            directory = self.api["open_lock_directory"](path, required_uid=os.getuid(), durable=True)
            os.close(directory)
            sync.assert_called_once()
            directory = self.api["open_lock_directory"](path, required_uid=os.getuid(), durable=True)
            os.close(directory)
            sync.assert_called_once()
        with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(self.policy)}):
            self.assertEqual(self.api["load_policy"](), self.policy)
        for invalid in [{}, [], {**self.policy, "command": "arbitrary"}]:
            with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(invalid)}):
                with self.assertRaises(ValueError):
                    self.api["load_policy"]()

    def test_root_owned_regular_input_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy"
            path.write_bytes(b"{}")
            path.chmod(0o600)
            read = self.api["trusted_regular"]
            self.assertEqual(read(path, required_uid=os.getuid()), b"{}")
            with self.assertRaises(ValueError):
                read(path, maximum=1, required_uid=os.getuid())
            with self.assertRaises(PermissionError):
                read(path, required_uid=os.getuid() + 1)
            link = Path(tmp) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                read(link, required_uid=os.getuid())
            fifo = Path(tmp) / "fifo"
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(PermissionError):
                read(fifo, required_uid=os.getuid())
            path.chmod(0o666)
            with self.assertRaises(PermissionError):
                read(path, required_uid=os.getuid())

    def test_services_use_full_tree_limits_and_literal_arguments(self):
        args = ["rustic-project-backup", "--tag", "$HOME ${X} spaces"]
        command = self.api["service_command"]("cocalc-rustic-test.service", args, [[10, 20]], self.policy)
        for arg in ["--pipe", "--wait", "--collect", "--expand-environment=no",
                    "--slice=cocalcmaintenance.slice",
                    "--property=KillMode=control-group", "--property=OOMPolicy=kill",
                    "--property=MemoryMax=2147483648", "--property=RuntimeMaxSec=1800",
                    "--property=TimeoutStopSec=10", "--property=MemorySwapMax=0"]:
            self.assertIn(arg, command)
        self.assertEqual(command[-len(args):], args)
        self.assertEqual(command[command.index("/usr/bin/python3") + 1], "-I")

    def test_maintenance_device_limits_reject_unbounded_or_ambiguous_rows(self):
        parse = self.api["parse_maintenance_rows"]
        self.assertEqual(parse("7:0\t100\t200\t30\t40\textra\n"), {
            "7:0": {"rbps": 100, "wbps": 200, "riops": 30, "wiops": 40},
        })
        for text in ["", "7:0\tmax\t1\t1\t1", "7:0\t0\t1\t1\t1",
                     "7:0\t1\t1\t1", "../7:0\t1\t1\t1\t1",
                     "7:0\t1\t1\t1\t1\n7:0\t1\t1\t1\t1",
                     "7:0\t9223372036854775808\t1\t1\t1"]:
            with self.assertRaises(ValueError, msg=text):
                parse(text)

    def test_aggregate_controller_verification_fails_closed(self):
        values = {"memory.max": str(8 * 1024**3), "pids.max": "256",
                  "memory.swap.max": "0", "cpu.max": "200000 100000",
                  "io.max": "7:0 rbps=100 wbps=100 riops=10 wiops=10"}
        rows = {"7:0": {"rbps": 100, "wbps": 100, "riops": 10, "wiops": 10}}
        with mock.patch.dict(self.api, {"cgroup_text": lambda _, name: values[name]}):
            self.api["check_maintenance_cgroup"](rows)
            for name, invalid in [("memory.max", "max"), ("pids.max", "257"),
                                  ("cpu.max", "max 100000"), ("cpu.max", "300000 100000"),
                                  ("memory.swap.max", "1"), ("io.max", ""),
                                  ("io.max", "7:0 rbps=101 wbps=100 riops=10 wiops=10")]:
                original = values[name]
                values[name] = invalid
                with self.assertRaises(RuntimeError, msg=name):
                    self.api["check_maintenance_cgroup"](rows)
                values[name] = original

    def test_busy_legacy_group_blocks_activation_before_any_systemd_change(self):
        with mock.patch.dict(self.api, {"cgroup_text": lambda *_: "populated 1\nfrozen 0"}), \
             mock.patch("subprocess.run") as run:
            with self.assertRaises(BlockingIOError):
                self.api["prepare_maintenance"]()
            run.assert_not_called()

    def test_systemd_io_properties_share_one_parent_not_one_budget_per_job(self):
        rows = self.api["parse_maintenance_rows"]("7:0\t100\t200\t30\t40\n7:1\t11\t12\t13\t14")
        command = self.api["maintenance_io_command"](rows)
        self.assertIn("cocalcmaintenance.slice", command)
        self.assertEqual(command.count("a(st)"), 4)
        self.assertEqual(command.count("/dev/block/7:0"), 4)
        self.assertEqual(command.count("/dev/block/7:1"), 4)

    def test_caller_identity_detects_exit_pid_reuse_and_unknown_processes(self):
        chain = self.api["caller_chain"]()
        self.assertTrue(self.api["callers_alive"](chain))
        self.assertFalse(self.api["callers_alive"]([]))
        self.assertFalse(self.api["callers_alive"]([[True, 1]]))
        self.assertFalse(self.api["callers_alive"]([[os.getpid(), 1]]))
        with mock.patch.dict(self.api, {"process_identity": lambda _: None}):
            self.assertFalse(self.api["callers_alive"](chain))

    def test_lease_expiry_or_eof_blocks_worker_start(self):
        with mock.patch.dict(self.api, {"callers_alive": lambda _: False}):
            self.assertFalse(self.api["lease_valid"]([[10, 20]], timeout=0))
        with mock.patch.dict(self.api, {"callers_alive": lambda _: True}):
            with mock.patch("select.select", return_value=([], [], [])):
                self.assertFalse(self.api["lease_valid"]([[10, 20]], timeout=0))
            with mock.patch("select.select", return_value=([0], [], [])), mock.patch("os.read", return_value=b""):
                self.assertFalse(self.api["lease_valid"]([[10, 20]], timeout=0))
            with mock.patch("select.select", return_value=([0], [], [])), mock.patch("os.read", return_value=b"."):
                self.assertTrue(self.api["lease_valid"]([[10, 20]], timeout=0))

    def test_lock_survives_parent_descriptor_close_until_child_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = self.api["open_lock_directory"](str(Path(tmp) / "locks"), required_uid=os.getuid())
            child = None
            held = None
            try:
                held = self.api["take_lock"](directory, "job.lock", required_uid=os.getuid())
                child = subprocess.Popen(
                    [sys.executable, "-I", "-c", "import sys; sys.stdin.buffer.read()"],
                    stdin=subprocess.PIPE, pass_fds=(held,),
                )
                os.close(held)
                held = None
                with self.assertRaises(BlockingIOError):
                    self.api["take_lock"](directory, "job.lock", required_uid=os.getuid())
                child.stdin.close()
                child.wait(timeout=5)
                held = self.api["take_lock"](directory, "job.lock", required_uid=os.getuid())
            finally:
                if child is not None and child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                if held is not None:
                    os.close(held)
                os.close(directory)

    def test_slots_never_overcommit(self):
        calls = []
        def busy(_directory, name):
            calls.append(name)
            raise BlockingIOError()
        with mock.patch.dict(self.api, {"take_lock": busy}):
            with self.assertRaises(BlockingIOError):
                self.api["take_slot"](10, 2)
        self.assertEqual(calls, ["slot-0.lock", "slot-1.lock"])

    def test_key_is_stable_for_backup_restore_same_profile(self):
        def parse(_argv):
            return _argv[0], {"profile-root": "/mnt/cocalc", "profile-path": "project/repo.toml"}
        api = {"parse_rustic": parse}
        self.assertEqual(self.api["job_key"](["rustic-project-backup"], api),
                         self.api["job_key"](["rustic-project-restore"], api))
        with self.assertRaises(ValueError):
            self.api["job_key"](["arbitrary"], api)
        with self.assertRaises(ValueError):
            self.api["job_key"](["rustic-project-backup", "x" * 16384], api)

    def test_unit_records_survive_launchers_and_reject_untrusted_content(self):
        unit = "cocalc-rustic-" + "a" * 32 + ".service"
        with tempfile.TemporaryDirectory() as tmp:
            directory = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                read = lambda: self.api["read_unit"](directory, "job.unit", required_uid=os.getuid())
                self.assertIsNone(read())
                self.api["record_unit"](directory, "job.unit", unit)
                self.assertEqual(read(), unit)
                (Path(tmp) / "job.unit").write_text("ssh.service")
                with self.assertRaises(ValueError):
                    read()
            finally:
                os.close(directory)

    def test_service_state_is_authoritative_even_without_a_lock(self):
        unit = "cocalc-rustic-" + "a" * 32 + ".service"
        for state, busy in [("active", True), ("activating", True), ("deactivating", True), ("failed", False), ("inactive", False)]:
            result = subprocess.CompletedProcess([], 0, f"LoadState=loaded\nActiveState={state}\nControlGroup=\n")
            with mock.patch("subprocess.run", return_value=result):
                self.assertEqual(self.api["unit_busy"](unit), busy)
        result = subprocess.CompletedProcess([], 0, "LoadState=loaded\nActiveState=failed\nControlGroup=/system.slice/" + unit)
        with mock.patch("subprocess.run", return_value=result), mock.patch("builtins.open", mock.mock_open(read_data="populated 1\nfrozen 0\n")):
            self.assertTrue(self.api["unit_busy"](unit))
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("systemctl", 5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.api["unit_busy"](unit)

    def test_slot_cannot_be_reused_while_previous_unit_stops(self):
        with mock.patch.dict(self.api, {
            "take_lock": lambda _directory, _name: 42,
            "read_unit": lambda _directory, _name: "predecessor",
            "unit_busy": lambda _unit: True,
            "record_unit": lambda *_args: self.fail("replaced an active unit"),
        }), mock.patch("os.close") as close:
            with self.assertRaises(BlockingIOError):
                self.api["take_slot"](10, 1, "current")
            close.assert_called_once_with(42)

    def test_startup_capacity_is_claimed_before_spawning_any_service(self):
        with mock.patch.dict(self.api, {
            "job_key": lambda *_: "key",
            "caller_chain": lambda: [[10, 20]],
            "open_lock_directory": lambda: 40,
            "take_lock": lambda *_: 41,
            "read_unit": lambda *_: None,
            "unit_busy": lambda _: False,
            "take_slot": mock.Mock(side_effect=BlockingIOError("full")),
        }), mock.patch("os.close"), mock.patch("subprocess.Popen") as spawn:
            with self.assertRaises(BlockingIOError):
                self.api["launch"](["rustic-project-backup"], {}, self.policy)
            spawn.assert_not_called()
            self.assertEqual(self.api["take_slot"].call_args.kwargs, {"prefix": "launch-slot"})


if __name__ == "__main__":
    unittest.main()
