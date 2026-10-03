#!/usr/bin/env python3
"""Lifecycle tests for the installed (embedded) privileged helper."""
import os
import json
import base64
from contextlib import ExitStack, nullcontext, redirect_stdout
import io
import inspect
import re
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import threading
import time
import types
import unittest
import uuid
from unittest import mock

import bootstrap


def helper():
    module = types.ModuleType("managed_job_fixture")
    exec(compile(bootstrap.MANAGED_PROJECT_JOB_HELPER, "managed-project-job", "exec"), module.__dict__)
    return module


class ManagedJobTests(unittest.TestCase):
    def test_cleanup_confirmation_is_exact_and_read_only_after_scope_removal(self):
        m = helper()
        project_id = str(uuid.uuid4())
        def query(index):
            return {"project_id": project_id,
                    "scope": f"job-10-100-20-200-999999999999-00000000-0000-4000-8000-{index:012d}"}
        with tempfile.TemporaryDirectory() as directory:
            pool = Path(directory)
            parent = pool / ("project-" + project_id)
            parent.mkdir()
            live, removed, unreadable, symlink = [query(i) for i in range(4)]
            (parent / live["scope"]).mkdir()
            (parent / symlink["scope"]).symlink_to(pool / "missing")
            pool_mock = mock.MagicMock()
            pool_mock.is_symlink.return_value = False
            pool_mock.stat.return_value.st_uid = 0
            pool_mock.__truediv__.side_effect = lambda name: pool / name
            original_lstat = Path.lstat
            def lstat(path):
                if path.name == unreadable["scope"]:
                    raise PermissionError("fixture")
                return original_lstat(path)
            with mock.patch.object(m, "POOL", new=pool_mock), mock.patch.object(m, "parent_scope"), mock.patch.object(m, "lifecycle_lock", side_effect=nullcontext), mock.patch.object(m, "config_from_stdin", return_value={"jobs": [live, removed, unreadable, symlink]}), mock.patch.object(Path, "lstat", new=lstat), mock.patch.object(m, "kill_scope") as kill:
                output = io.StringIO()
                with redirect_stdout(output):
                    m.confirm_cleanup()
                self.assertEqual(json.loads(output.getvalue()), {"confirmed": [removed]})
                kill.assert_not_called()
                # Main host reaper or project stop removes a scope independently.
                (parent / live["scope"]).rmdir()
                output = io.StringIO()
                with redirect_stdout(output):
                    m.confirm_cleanup()
                self.assertEqual(json.loads(output.getvalue()), {"confirmed": [live, removed]})

    def test_cleanup_confirmation_rejects_unavailable_pool_and_untrusted_parent(self):
        m = helper()
        query = {"project_id": str(uuid.uuid4()), "scope": "job-10-100-20-200-999-" + str(uuid.uuid4())}
        with tempfile.TemporaryDirectory() as directory:
            pool = Path(directory)
            with mock.patch.object(m, "POOL", new=pool / "absent"), mock.patch.object(m, "lifecycle_lock", side_effect=nullcontext), mock.patch.object(m, "config_from_stdin", return_value={"jobs": [query]}):
                with self.assertRaises(FileNotFoundError):
                    m.confirm_cleanup()
            parent = pool / ("project-" + query["project_id"])
            parent.symlink_to(pool / "missing")
            pool_mock = mock.MagicMock()
            pool_mock.is_symlink.return_value = False
            pool_mock.stat.return_value.st_uid = 0
            pool_mock.__truediv__.side_effect = lambda name: pool / name
            with mock.patch.object(m, "POOL", new=pool_mock), mock.patch.object(m, "lifecycle_lock", side_effect=nullcontext), mock.patch.object(m, "config_from_stdin", return_value={"jobs": [query]}):
                output = io.StringIO()
                with redirect_stdout(output):
                    m.confirm_cleanup()
                self.assertEqual(json.loads(output.getvalue()), {"confirmed": []})

    def test_cleanup_queries_are_bounded_and_cannot_escape_scope_paths(self):
        m = helper()
        valid = {"project_id": str(uuid.uuid4()), "scope": "job-10-100-20-200-999-" + str(uuid.uuid4())}
        for jobs in [None, [valid] * 65, [None], [{**valid, "scope": "../escape"}], [{**valid, "project_id": "../escape"}], [{**valid, "scope": "job-" + "1" * 300 + valid["scope"][6:]}]]:
            with self.subTest(jobs=type(jobs)), mock.patch.object(m, "config_from_stdin", return_value={"jobs": jobs}), mock.patch.object(m, "lifecycle_lock") as lock:
                with self.assertRaises(ValueError):
                    m.confirm_cleanup()
                lock.assert_not_called()

    def test_cleanup_warns_once_even_when_supervisor_note_arrives_during_final_drain(self):
        for warned in (False, True):
            for cleanup_fails in (False, True):
                with self.subTest(warned=warned, cleanup_fails=cleanup_fails), ExitStack() as stack:
                    m = helper()
                    # Exercise the real output/cleanup ordering with fake kernel
                    # operations, including a warning split across the exit drain.
                    note = m.BackgroundWarningTracker.note if warned else b"ordinary stderr\n"
                    reads = {14: iter([note[:20], note[20:], b""]), 12: iter([b""])}
                    frames = bytearray()
                    events_order = []
                    def write(fd, chunk):
                        if fd == 1:
                            frames.extend(chunk)
                            events_order.append("frame")
                        return len(chunk)
                    def patch(obj, name, **kwargs):
                        return stack.enter_context(mock.patch.object(obj, name, **kwargs))
                    account = types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
                    patch(m.pwd, "getpwnam", return_value=account)
                    path = patch(m, "Path")
                    path.return_value.stat.return_value.st_uid = 1000
                    pool = patch(m, "POOL", new=mock.MagicMock())
                    pool.__truediv__.return_value.__truediv__.return_value.name = "job-fixture"
                    patch(m, "identity", return_value="1")
                    patch(m, "alive", return_value=True)
                    patch(m, "lifecycle_lock", side_effect=nullcontext)
                    patch(m, "active_state", return_value={"generation": "g"})
                    patch(m, "config_from_stdin", return_value={"args": ["exec"], "env": {}})
                    patch(m, "reap_project_locked")
                    patch(m, "lease_connected", return_value=True)
                    patch(m, "launch_locked", side_effect=lambda *_: (events_order.append("launch"), 123)[1])
                    patch(m, "live_scope_processes", return_value=1)
                    kill = patch(m, "kill_scope", side_effect=RuntimeError("fixture") if cleanup_fails else None)
                    patch(m.signal, "signal")
                    patch(m.os, "pipe", side_effect=[(10, 11), (12, 13), (14, 15)])
                    patch(m.os, "set_blocking")
                    patch(m.os, "close")
                    patch(m.os, "waitpid", return_value=(123, 0))
                    patch(m.os, "read", side_effect=lambda fd, _: next(reads[fd]))
                    patch(m.os, "write", side_effect=write)
                    sel = patch(m.selectors, "DefaultSelector").return_value
                    sel.select.return_value = [(types.SimpleNamespace(fd=14, data="stderr"), 1)]
                    if cleanup_fails:
                        with self.assertRaisesRegex(RuntimeError, "cleanup not confirmed"):
                            m.supervise(str(uuid.uuid4()), str(uuid.uuid4()), 99, 10000)
                    else:
                        m.supervise(str(uuid.uuid4()), str(uuid.uuid4()), 99, 10000)
                    kill.assert_called_once()
                    self.assertEqual(events_order[:2], ["frame", "launch"])
                    events = [json.loads(line) for line in frames.splitlines()]
                    self.assertEqual(events[0], {"type": "scope", "scope": "job-fixture"})
                    if cleanup_fails:
                        self.assertFalse(any(event["type"] == "exit" for event in events))
                    else:
                        stderr = b"".join(base64.b64decode(event["data"]) for event in events
                                          if event["type"] == "output" and event["stream"] == "stderr")
                        self.assertEqual(stderr.count(b"use cocalc project terminal spawn"), 1)
                        self.assertEqual(events[-1], {"type": "exit", "code": 0, "cleanup": True})

    def test_identity_transport_failure_prevents_process_launch(self):
        with ExitStack() as stack:
            m = helper()
            def patch(obj, name, **kwargs):
                return stack.enter_context(mock.patch.object(obj, name, **kwargs))
            patch(m.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=1000, pw_gid=1000))
            patch(m, "Path").return_value.stat.return_value.st_uid = 1000
            pool = patch(m, "POOL", new=mock.MagicMock())
            pool.__truediv__.return_value.__truediv__.return_value.name = "job-fixture"
            patch(m, "identity", return_value="1")
            patch(m, "alive", return_value=True)
            patch(m, "lifecycle_lock", side_effect=nullcontext)
            patch(m, "active_state", return_value={"generation": "g"})
            patch(m, "config_from_stdin", return_value={"args": ["exec"], "env": {}})
            patch(m, "reap_project_locked")
            patch(m, "lease_connected", return_value=True)
            launch = patch(m, "launch_locked")
            kill = patch(m, "kill_scope")
            patch(m.signal, "signal")
            patch(m.os, "set_blocking")
            patch(m.os, "write", side_effect=lambda _, data: 0 if b'"scope"' in data else len(data))
            with self.assertRaisesRegex(RuntimeError, "identity transport failed"):
                m.supervise(str(uuid.uuid4()), str(uuid.uuid4()), 99, 10000)
            launch.assert_not_called()
            kill.assert_called_once()

    def test_background_warning_tracker_handles_every_chunk_boundary(self):
        m = helper()
        note = m.BackgroundWarningTracker.note
        supervisor = Path(__file__).resolve().parents[3] / "project-runner/run/sandbox-command-supervisor.ts"
        self.assertIn(note.decode().replace("\n", r"\n"), supervisor.read_text())
        for split in range(1, len(note)):
            with self.subTest(split=split):
                tracker = m.BackgroundWarningTracker()
                tracker.observe("stderr", b"other output\n" + note[:split])
                self.assertFalse(tracker.seen)
                tracker.observe("stdout", b"interleaved output")
                tracker.observe("stderr", note[split:] + b"more output")
                self.assertTrue(tracker.seen)
                self.assertEqual(tracker.tail, b"")

    def test_background_warning_tracker_is_bounded_and_stderr_only(self):
        m = helper()
        tracker = m.BackgroundWarningTracker()
        tracker.observe("stdout", tracker.note)
        self.assertFalse(tracker.seen)
        tracker.observe("stderr", b"x" * 1000000)
        self.assertLess(len(tracker.tail), len(tracker.note))
        self.assertFalse(tracker.seen)
        tracker.observe("stderr", tracker.note)
        tracker.observe("stderr", b"x" * 1000000)
        self.assertTrue(tracker.seen)
        self.assertEqual(tracker.tail, b"")

    def test_leftover_diagnostic_ignores_dead_processes_and_unreadable_scopes(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            scope = Path(directory)
            self.assertEqual(m.live_scope_processes(scope), 0)
            (scope / "cgroup.procs").write_text("10\n11\n12\n")
            with mock.patch.object(m, "identity", side_effect=["123", ProcessLookupError(), FileNotFoundError()]), \
                mock.patch.object(m, "process_name", return_value="sleep"):
                self.assertEqual(m.live_scope_processes(scope, grace=0), 1)

    def test_leftover_diagnostic_ignores_podman_exec_infrastructure(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            # A process named like podman's exec monitor.
            conmon = Path(directory) / "conmon"
            conmon.write_bytes(Path("/bin/sleep").read_bytes())
            conmon.chmod(0o755)
            infra = subprocess.Popen([str(conmon), "30"])
            leftover = subprocess.Popen(["/bin/sleep", "30"])
            try:
                scope = Path(directory) / "scope"
                scope.mkdir()
                procs = scope / "cgroup.procs"
                procs.write_text(f"{infra.pid}\n")
                self.assertEqual(m.live_scope_processes(scope, grace=0), 0)
                procs.write_text(f"{infra.pid}\n{leftover.pid}\n")
                self.assertEqual(m.live_scope_processes(scope, grace=0), 1)
            finally:
                for process in (infra, leftover):
                    process.kill()
                    process.wait()

    def test_leftover_diagnostic_waits_for_exiting_processes(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            exiting = subprocess.Popen(["/bin/sleep", "0.1"])
            # Reap it as soon as it exits, as the real parent would.
            reaper = threading.Thread(target=exiting.wait)
            reaper.start()
            try:
                (Path(directory) / "cgroup.procs").write_text(f"{exiting.pid}\n")
                self.assertEqual(m.live_scope_processes(Path(directory), grace=2), 0)
            finally:
                exiting.kill()
                reaper.join()

    def test_reconciliation_preserves_managed_cgroups(self):
        source = inspect.getsource(bootstrap.install_privileged_wrappers)
        functions = []
        for name in ["pid_in_managed_project_job", "attach_pid_to_project_pool_storage"]:
            functions.append(re.search(r"^" + name + r"\(\) \{.*?^\}", source, re.M | re.S).group(0))
        for current, expected in [("/fixture/project-uuid/job-identity", ""), ("/fixture/project-uuid", "123\n")]:
            with self.subTest(current=current), tempfile.TemporaryDirectory() as directory:
                target = Path(directory)
                (target / "cgroup.procs").touch()
                script = "\n".join(functions) + "\n" + "\n".join([
                    "project_pool_relative_path() { printf /fixture; }",
                    f"awk() {{ printf '%s\\n' '{current}'; }}",
                    "kill() { return 0; }",
                    f"attach_pid_to_project_pool_storage 123 '{target}'",
                ])
                subprocess.run(["bash", "-euc", script], check=True)
                self.assertEqual((target / "cgroup.procs").read_text(), expected)

    def test_process_identity_detects_death_and_pid_reuse(self):
        m = helper()
        start = m.identity(os.getpid())
        self.assertTrue(m.alive(str(os.getpid()), start))
        self.assertFalse(m.alive(str(os.getpid()), "0"))
        self.assertFalse(m.alive("999999999", "1"))

    def test_cleanup_requires_atomic_kill_and_empty_verification(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            scope = Path(directory)
            (scope / "cgroup.kill").touch()
            (scope / "cgroup.events").write_text("populated 0\nfrozen 0\n")
            with mock.patch.object(Path, "rmdir") as remove:
                m.kill_scope(scope)
                remove.assert_called_once()
            self.assertEqual((scope / "cgroup.kill").read_text(), "1\n")

    def test_populated_scope_cannot_be_reported_clean(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            scope = Path(directory)
            (scope / "cgroup.kill").touch()
            (scope / "cgroup.events").write_text("populated 1\n")
            with mock.patch.object(m.time, "monotonic", side_effect=[0, 11]), mock.patch.object(Path, "rmdir") as remove:
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.kill_scope(scope)
                remove.assert_not_called()

    def test_missing_kill_file_is_not_missing_scope(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            # A read-only/open failure must not be converted to success.
            with mock.patch.object(Path, "write_text", side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    m.kill_scope(Path(directory))

    def test_orphans_and_reused_pids_are_reaped_but_live_jobs_are_not(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / "project-00000000-0000-4000-8000-000000000001"
            project.mkdir()
            live = project / "job-10-100-20-200-999999999999-00000000-0000-4000-8000-000000000001"
            dead_owner = project / "job-10-99-20-200-999999999999-00000000-0000-4000-8000-000000000002"
            dead_guard = project / "job-10-100-20-199-999999999999-00000000-0000-4000-8000-000000000003"
            expired = project / "job-10-100-20-200-1-00000000-0000-4000-8000-000000000004"
            for path in [live, dead_owner, dead_guard, expired]:
                path.mkdir()
            with mock.patch.object(m, "parent_scope"), mock.patch.object(m, "active_state"), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", side_effect=lambda pid, start: (pid, start) in [("10", "100"), ("20", "200")]), mock.patch.object(m, "kill_scope") as kill:
                m.sweep_project_locked(project.name[8:])
                self.assertEqual({call.args[0] for call in kill.call_args_list}, {dead_owner, dead_guard, expired})
                self.assertTrue(all(call.kwargs == {"timeout": 0} for call in kill.call_args_list))
            # Losing generation state (or a persisted stop) also expires live jobs.
            with mock.patch.object(m, "parent_scope"), mock.patch.object(m, "active_state", side_effect=RuntimeError("stopping")), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", return_value=True), mock.patch.object(m, "kill_scope") as kill:
                m.sweep_project_locked(project.name[8:])
                self.assertEqual({call.args[0] for call in kill.call_args_list}, {live, dead_owner, dead_guard, expired})

    def test_failed_orphan_cleanup_does_not_starve_other_scopes(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / "project-00000000-0000-4000-8000-000000000001"
            project.mkdir()
            for i in range(2):
                (project / f"job-10-100-20-200-00000000-0000-4000-8000-00000000000{i}").mkdir()
            with mock.patch.object(m, "parent_scope"), mock.patch.object(m, "active_state"), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", return_value=False), mock.patch.object(m, "kill_scope", side_effect=[RuntimeError(), None]) as kill:
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.sweep_project_locked(project.name[8:])
                self.assertEqual(kill.call_count, 2)

    def test_unrecognized_scopes_fail_sweep_closed(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / ("project-" + str(uuid.uuid4()))
            (project / "unexpected-child").mkdir(parents=True)
            with mock.patch.object(m, "parent_scope"), mock.patch.object(m, "active_state"):
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.sweep_project_locked(project.name[8:])

    def test_cleanup_removes_children_before_parent_and_persists_stop_on_failure(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as directory:
                m = helper()
                m.POOL = Path(directory)
                project_id = str(uuid.uuid4())
                parent = m.POOL / ("project-" + project_id)
                parent.mkdir()
                scopes = [parent / ("job-10-100-20-200-" + str(uuid.uuid4())) for _ in range(2)]
                for scope in scopes:
                    scope.mkdir()
                state = Path(directory) / "state"
                removed = []
                def kill(scope, _timeout):
                    self.assertEqual(json.loads(state.read_text())["status"], "stopping")
                    self.assertEqual((parent / "cgroup.kill").read_text(), "1\n")
                    removed.append(scope)
                    if fail and scope == scopes[0]:
                        raise RuntimeError("busy")
                with mock.patch.object(m, "state_path", return_value=state), mock.patch.object(m, "parent_scope", return_value=parent), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "kill_scope", side_effect=kill):
                    if fail:
                        with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                            m.cleanup_locked(project_id)
                    else:
                        m.cleanup_locked(project_id)
                self.assertEqual(set(removed[:2]), set(scopes))
                self.assertEqual(json.loads(state.read_text())["status"], "stopping" if fail else "stopped")
                self.assertEqual(len(removed), 2 if fail else 3)
                if not fail:
                    self.assertEqual(removed[-1], parent)

    def test_failed_cleanup_blocks_activation_after_helper_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            first, restarted = helper(), helper()
            with mock.patch.object(first, "state_path", return_value=state):
                first.begin_stop_locked(str(uuid.uuid4()))
            with mock.patch.object(restarted, "state_path", return_value=state), mock.patch.object(restarted, "lifecycle_lock", return_value=nullcontext()), mock.patch.object(restarted, "parent_scope") as parent:
                with self.assertRaisesRegex(RuntimeError, "unresolved"):
                    restarted.activate(str(uuid.uuid4()), os.getpid())
                parent.assert_not_called()

    def test_activation_requires_successful_sweep_before_admission(self):
        m = helper()
        with mock.patch.object(m, "lifecycle_lock", return_value=nullcontext()), mock.patch.object(m, "read_state", return_value=None), mock.patch.object(m, "parent_scope"), mock.patch.object(m, "member", return_value=True), mock.patch.object(m, "reap_project_locked", side_effect=RuntimeError("unresolved")), mock.patch.object(m, "write_state") as write:
            with self.assertRaisesRegex(RuntimeError, "unresolved"):
                m.activate(str(uuid.uuid4()), os.getpid())
            write.assert_not_called()

    def test_two_project_admission_and_activation_isolation(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory) / "pool"
            m.POOL.mkdir()
            broken, healthy = str(uuid.uuid4()), str(uuid.uuid4())
            for project in (broken, healthy):
                (m.POOL / ("project-" + project)).mkdir()
            (m.POOL / ("project-" + broken) / "unexpected-child").mkdir()
            state_dir = Path(directory) / "state"
            state_dir.mkdir()
            with mock.patch.object(m, "state_path", side_effect=lambda project: state_dir / project), mock.patch.object(m, "parent_scope", side_effect=lambda project: m.POOL / ("project-" + project)), mock.patch.object(m, "lifecycle_lock", side_effect=lambda: nullcontext()), mock.patch.object(m, "member", return_value=True):
                # The periodic pass reports diagnostics, but still attempts B.
                with self.assertRaisesRegex(RuntimeError, "sweeps failed"):
                    m.reap()
                self.assertTrue(m.quarantine_path(broken).exists())
                self.assertFalse(m.quarantine_path(healthy).exists())
                # Neither target sweep nor activation can consult A's scopes.
                m.activate(healthy, os.getpid())
                m.reap_project_locked(healthy)
                self.assertEqual(m.active_state(healthy)["status"], "active")
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.activate(broken, os.getpid())
                self.assertTrue(m.quarantine_path(broken).exists())
                (m.POOL / ("project-" + broken) / "unexpected-child").rmdir()
                m.activate(broken, os.getpid())
                self.assertFalse(m.quarantine_path(broken).exists())

    def test_periodic_sweep_releases_lock_and_continues_after_project_failure(self):
        m = helper()
        events = []
        class Lock:
            def __enter__(self):
                events.append("lock")
            def __exit__(self, *_):
                events.append("unlock")
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            ids = [str(uuid.uuid4()) for _ in range(2)]
            for project in ids:
                (m.POOL / ("project-" + project)).mkdir()
            def sweep(project):
                events.append(project)
                if project == ids[0]:
                    raise RuntimeError("busy")
            with mock.patch.object(m, "lifecycle_lock", side_effect=Lock), mock.patch.object(m, "reap_project_locked", side_effect=sweep):
                with self.assertRaisesRegex(RuntimeError, "sweeps failed"):
                    m.reap()
            self.assertEqual(set(events[1::3]), set(ids))
            self.assertEqual(events[::3], ["lock", "lock"])
            self.assertEqual(events[2::3], ["unlock", "unlock"])

    def test_quarantine_persists_until_target_cleanup_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            project = str(uuid.uuid4())
            for fail in (True, True, False):
                m = helper()  # No in-memory quarantine is trusted across restart.
                with mock.patch.object(m, "state_path", return_value=Path(directory) / project), mock.patch.object(m, "sweep_project_locked", side_effect=RuntimeError("busy") if fail else None):
                    if fail:
                        with self.assertRaises(RuntimeError):
                            m.reap_project_locked(project)
                        self.assertEqual(json.loads(m.quarantine_path(project).read_text())["cleanup_error"], "job cleanup not confirmed")
                    else:
                        m.reap_project_locked(project)
                        self.assertFalse(m.quarantine_path(project).exists())

    def test_lease_drain_is_bounded_and_fails_closed(self):
        for limit in ("bytes", "time"):
            with self.subTest(limit=limit):
                m = helper()
                selector = mock.MagicMock()
                selector.select.return_value = [True]  # Permanently readable.
                with mock.patch.object(m.selectors, "DefaultSelector", return_value=selector), mock.patch.object(m.os, "read", return_value=b"x" * 4096) as read, mock.patch.object(m.time, "monotonic", side_effect=[0, 1] if limit == "time" else None, return_value=0):
                    self.assertFalse(m.lease_connected())
                    self.assertLessEqual(read.call_count, 16)
                    selector.close.assert_called_once()

    def test_lease_eof_and_normal_heartbeats(self):
        m = helper()
        for chunk, expected in [(b"", False), (b".\n", True)]:
            selector = mock.MagicMock()
            selector.select.side_effect = [[True], []]
            with mock.patch.object(m.selectors, "DefaultSelector", return_value=selector), mock.patch.object(m.os, "read", return_value=chunk):
                self.assertEqual(m.lease_connected(), expected)

    def test_no_new_privileges_is_irreversible_in_child_process(self):
        # Exercise the actual hardening helper without changing the test runner.
        source = bootstrap.MANAGED_PROJECT_JOB_HELPER.split('if __name__ == "__main__":')[0]
        source += """
libc = ctypes.CDLL(None, use_errno=True)
prevent_privilege_gain(libc)
assert libc.prctl(39, 0, 0, 0, 0) == 1
assert libc.prctl(38, 0, 0, 0, 0) != 0
"""
        subprocess.run(["/usr/bin/python3", "-I", "-c", source], check=True, timeout=5)

    def test_no_new_privileges_failure_prevents_exec(self):
        m = helper()
        libc = mock.MagicMock()
        libc.prctl.return_value = -1
        with self.assertRaisesRegex(RuntimeError, "disable new privileges"):
            m.prevent_privilege_gain(libc)
        libc.prctl.assert_called_once_with(38, 1, 0, 0, 0)

    def test_launcher_migration_is_verified_before_gate_opens(self):
        m = helper()
        scope = mock.MagicMock()
        events = []
        (scope / "cgroup.procs").write_text.side_effect = lambda pid: events.append(("migrate", pid))
        def verify(pid, _scope):
            events.append(("verify", pid))
            return True
        with mock.patch.object(m.os, "pipe", return_value=(100, 101)), mock.patch.object(m.os, "fork", return_value=123), mock.patch.object(m.os, "close"), mock.patch.object(m.os, "write", side_effect=lambda fd, data: events.append(("gate", data))), mock.patch.object(m, "member", side_effect=verify):
            self.assertEqual(m.launch_locked(scope, None, None, None, []), 123)
        self.assertEqual(events, [("migrate", "123"), ("verify", 123), ("gate", b"1")])

    def test_failed_migration_never_opens_gate_and_reaps_uncontained_child(self):
        m = helper()
        with mock.patch.object(m.os, "pipe", return_value=(100, 101)), mock.patch.object(m.os, "fork", return_value=123), mock.patch.object(m.os, "close"), mock.patch.object(m.os, "write") as gate, mock.patch.object(m.os, "kill") as kill, mock.patch.object(m.os, "waitpid") as wait, mock.patch.object(m, "member", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                m.launch_locked(mock.MagicMock(), None, None, None, [])
            gate.assert_not_called()
            kill.assert_called_once_with(123, signal.SIGKILL)
            wait.assert_called_once_with(123, 0)

    def test_lifecycle_lock_serializes_stop_with_admission(self):
        # Exercise real cross-process flock without host privileges/cgroups.
        # Only the fixture lock's owner check is substituted for our test UID.
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "lock"
            source = bootstrap.MANAGED_PROJECT_JOB_HELPER
            source = source.replace('LOCK = Path("/run/lock/cocalc-project-cgroups.lock")', f'LOCK = Path({str(lock)!r})')
            source = source.replace('os.fstat(fd).st_uid != 0', 'os.fstat(fd).st_uid != os.getuid()')
            source = source.split('if __name__ == "__main__":')[0]
            admission = subprocess.Popen(["/usr/bin/python3", "-I", "-c", source + '\nwith lifecycle_lock():\n print("membership pending", flush=True)\n sys.stdin.readline()\n'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            stop = None
            try:
                self.assertEqual(admission.stdout.readline(), b"membership pending\n")
                stop = subprocess.Popen(["/usr/bin/python3", "-I", "-c", source + '\nprint("stop waiting", flush=True)\nwith lifecycle_lock():\n print("stop admitted", flush=True)\n'], stdout=subprocess.PIPE)
                self.assertEqual(stop.stdout.readline(), b"stop waiting\n")
                time.sleep(0.1)
                self.assertIsNone(stop.poll())
                admission.stdin.close()
                admission.wait(timeout=3)
                self.assertEqual(stop.communicate(timeout=3)[0], b"stop admitted\n")
            finally:
                for process in (admission, stop):
                    if process is None:
                        continue
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                    if process.stdout:
                        process.stdout.close()
                    if process.stdin:
                        process.stdin.close()

    def test_active_generation_checks_inode_and_init_identity(self):
        m = helper()
        parent = mock.MagicMock()
        parent.stat.return_value.st_ino = 123
        value = {"status": "active", "inode": 123, "init": 99, "start": "42", "generation": "g"}
        with mock.patch.object(m, "read_state", return_value=value), mock.patch.object(m, "parent_scope", return_value=parent), mock.patch.object(m, "alive", return_value=True) as alive, mock.patch.object(m, "member", return_value=True):
            self.assertEqual(m.active_state(str(uuid.uuid4())), value)
            alive.return_value = False
            with self.assertRaisesRegex(RuntimeError, "blocked"):
                m.active_state(str(uuid.uuid4()))
            alive.return_value = True
            value["inode"] = 122
            with self.assertRaisesRegex(RuntimeError, "blocked"):
                m.active_state(str(uuid.uuid4()))


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("COCALC_TEST_JOB_CGROUP_PARENT"),
                     "requires root and an explicitly delegated disposable cgroup parent")
class KernelContainmentTests(unittest.TestCase):
    """Opt-in real kernel tests; no production cgroups or project credentials.

    COCALC_TEST_JOB_CGROUP_PARENT must be a writable cgroup v2 directory on a
    disposable test host. The launcher fixture substitutes for Podman only;
    the installed supervisor, privilege drop and cgroup.kill are real.
    """
    def reap_until_clean(self, m):
        until = time.monotonic() + 5
        while True:
            try:
                m.reap()
                return
            except RuntimeError:
                if time.monotonic() >= until:
                    raise
                # The periodic sweep deliberately never waits under the lock.
                time.sleep(0.05)

    def exercise(self, mode, detach="double-fork"):
        m = helper()
        root = Path(os.environ["COCALC_TEST_JOB_CGROUP_PARENT"]) / ("cocalc-job-test-" + str(uuid.uuid4()))
        root.mkdir()
        project_id = str(uuid.uuid4())
        project = root / ("project-" + project_id)
        project.mkdir()
        m.POOL = root
        owner = subprocess.Popen(["sleep", "60"], user="nobody", group="nogroup")
        proc = None
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                path.chmod(0o755)
                launcher = path / "podman"
                launcher.write_text("""#!/usr/bin/python3
import os,sys
assert os.getuid() != 0 and os.getgid() != 0
for fd in os.listdir('/proc/self/fd'):
    if int(fd) > 2:
        assert not os.path.exists('/proc/self/fd/' + fd), 'inherited control descriptor'
for line in open('/proc/self/status'):
    if line.startswith(('CapEff:', 'CapPrm:', 'CapAmb:')):
        assert int(line.split()[1], 16) == 0
    if line.startswith('NoNewPrivs:'):
        assert int(line.split()[1]) == 1
os.execv('/bin/bash', ['bash','-c',sys.argv[-1]])
""")
                launcher.chmod(0o755)
                source = bootstrap.MANAGED_PROJECT_JOB_HELPER.replace("__PROJECT_POOL_CGROUP__", str(root)).replace("__RUNTIME_USER__", "nobody")
                m.STATE = path / "state"
                m.LOCK = path / "lifecycle.lock"
                source = source.replace('STATE = Path("/run/cocalc-managed-project-jobs")', f'STATE = Path({str(m.STATE)!r})')
                source = source.replace('LOCK = Path("/run/lock/cocalc-project-cgroups.lock")', f'LOCK = Path({str(m.LOCK)!r})')
                source = source.replace('PODMAN = "/opt/cocalc/container-runtime/current/bin/podman"', f'PODMAN = {str(launcher)!r}')
                (project / "cgroup.procs").write_text(str(owner.pid))
                m.activate(project_id, owner.pid)
                # The grandchild explicitly escapes the original process group.
                script = """import os,signal,time
r,w=os.pipe()
pid=os.fork()
if pid == 0:
    os.close(r)
    os.setsid()
    if DETACH == 'double-fork' and os.fork() != 0:
        os._exit(0)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    os.write(w, str(os.getpid()).encode())
    os.close(w)
    while True: time.sleep(1)
os.close(w)
print(os.read(r, 64).decode(), flush=True)
os.close(r)
if MODE != 'success': time.sleep(60)
""".replace("DETACH", repr(detach)).replace("MODE", repr(mode))
                command = "/usr/bin/python3 - <<'PY'\n" + script + "\nPY"
                proc = subprocess.Popen(["/usr/bin/python3", "-I", "-c", source, "run", project_id, str(uuid.uuid4()), str(owner.pid), "1500" if mode in ("deadline", "wedged-guard") else "30000"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                config = {"args": ["exec", "fixture", command], "env": {"PATH": str(path) + ":/usr/bin:/bin"}}
                proc.stdin.write((json.dumps(config) + "\n").encode())
                proc.stdin.flush()
                sel = selectors.DefaultSelector()
                sel.register(proc.stdout, selectors.EVENT_READ)
                data = b""
                output = ""
                escaped = None
                proof = None
                until = time.monotonic() + 20
                triggered = False
                while time.monotonic() < until and proof is None:
                    if mode not in ("lease-expiry",) and not proc.stdin.closed:
                        try:
                            proc.stdin.write(b".\n")
                            proc.stdin.flush()
                        except BrokenPipeError:
                            pass
                    if not sel.select(0.1):
                        continue
                    chunk = os.read(proc.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    data += chunk
                    while b"\n" in data:
                        line, data = data.split(b"\n", 1)
                        frame = json.loads(line)
                        if frame["type"] == "exit":
                            proof = frame
                        elif frame["type"] == "output":
                            output += base64.b64decode(frame["data"]).decode()
                            if "\n" in output:
                                escaped = int(output.splitlines()[0])
                    if escaped and not triggered:
                        triggered = True
                        if mode == "cancel":
                            proc.stdin.close()
                        elif mode == "owner-death":
                            owner.kill()
                            owner.wait()
                        elif mode == "supervisor-crash":
                            proc.kill()
                            proc.wait()
                            self.reap_until_clean(m)
                            break
                        elif mode == "wedged-guard":
                            proc.send_signal(signal.SIGSTOP)
                            time.sleep(2)
                            self.reap_until_clean(m)
                            proc.send_signal(signal.SIGCONT)
                        elif mode == "project-stop":
                            with m.lifecycle_lock():
                                m.cleanup_locked(project_id)
                sel.close()
                self.assertIsNotNone(escaped, proc.stderr.read() if proc.poll() is not None else "missing fixture PID")
                if mode != "supervisor-crash":
                    self.assertIsNotNone(proof)
                    self.assertTrue(proof["cleanup"])
                    # A reaper/stop can kill the child while the guard is paused
                    # inside its loop, before it observes cancellation itself.
                    external_kill = mode in ("project-stop", "wedged-guard")
                    self.assertIn(proof["code"], (130, -9) if external_kill else (0 if mode == "success" else 130,))
                    proc.wait(timeout=5)
                self.assertEqual([p for p in project.iterdir() if p.is_dir()] if project.exists() else [], [])
                with self.assertRaises((FileNotFoundError, ProcessLookupError)):
                    m.identity(escaped)
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    try:
                        stream.close()
                    except BrokenPipeError:
                        pass
            owner.kill() if owner.poll() is None else None
            owner.wait(timeout=5)
            if project.exists():
                for scope in project.iterdir():
                    if scope.is_dir():
                        m.kill_scope(scope)
                m.kill_scope(project)
            root.rmdir()

    def test_detached_descendants_on_all_stop_paths(self):
        for detach in ("setsid", "double-fork"):
            for mode in ("cancel", "deadline", "lease-expiry", "success", "owner-death", "supervisor-crash", "wedged-guard", "project-stop"):
                with self.subTest(detach=detach, mode=mode):
                    self.exercise(mode, detach)


if __name__ == "__main__":
    unittest.main()
