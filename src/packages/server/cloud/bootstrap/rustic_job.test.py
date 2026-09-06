#!/usr/bin/env python3
"""Unit/OS-lock tests; real systemd/cgroup cancellation remains a canary gate."""
import copy
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

    def test_policy_has_no_unlimited_or_environment_fallback(self):
        for key in self.policy:
            for value in [0, -1, True, "1", None]:
                policy = copy.deepcopy(self.policy)
                policy[key] = value
                with mock.patch.dict(self.api, {"trusted_regular": lambda _: json.dumps(policy)}):
                    with self.assertRaises(ValueError, msg=f"{key}={value}"):
                        self.api["load_policy"]()
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
                    "--property=KillMode=control-group", "--property=OOMPolicy=kill",
                    "--property=MemoryMax=2147483648", "--property=RuntimeMaxSec=1800",
                    "--property=TimeoutStopSec=10", "--property=MemorySwapMax=0"]:
            self.assertIn(arg, command)
        self.assertEqual(command[-len(args):], args)
        self.assertEqual(command[command.index("/usr/bin/python3") + 1], "-I")

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


if __name__ == "__main__":
    unittest.main()
