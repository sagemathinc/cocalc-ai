#!/usr/bin/env python3
"""Lifecycle tests for the installed (embedded) privileged helper."""
import os
import json
import base64
from contextlib import nullcontext
import inspect
import re
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
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
            with mock.patch.object(m, "active_state"), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", side_effect=lambda pid, start: (pid, start) in [("10", "100"), ("20", "200")]), mock.patch.object(m, "kill_scope") as kill:
                m.reap_locked()
                self.assertEqual({call.args[0] for call in kill.call_args_list}, {dead_owner, dead_guard, expired})
            # Losing generation state (or a persisted stop) also expires live jobs.
            with mock.patch.object(m, "active_state", side_effect=RuntimeError("stopping")), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", return_value=True), mock.patch.object(m, "kill_scope") as kill:
                m.reap_locked()
                self.assertEqual({call.args[0] for call in kill.call_args_list}, {live, dead_owner, dead_guard, expired})

    def test_failed_orphan_cleanup_does_not_starve_other_scopes(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / "project-00000000-0000-4000-8000-000000000001"
            project.mkdir()
            for i in range(2):
                (project / f"job-10-100-20-200-00000000-0000-4000-8000-00000000000{i}").mkdir()
            with mock.patch.object(m, "active_state"), mock.patch.object(m, "validate_scope"), mock.patch.object(m, "alive", return_value=False), mock.patch.object(m, "kill_scope", side_effect=[RuntimeError(), None]) as kill:
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.reap_locked()
                self.assertEqual(kill.call_count, 2)

    def test_unrecognized_scopes_fail_sweep_closed(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / ("project-" + str(uuid.uuid4()))
            (project / "unexpected-child").mkdir(parents=True)
            with mock.patch.object(m, "active_state"):
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.reap_locked()

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
        with mock.patch.object(m, "lifecycle_lock", return_value=nullcontext()), mock.patch.object(m, "read_state", return_value=None), mock.patch.object(m, "parent_scope"), mock.patch.object(m, "member", return_value=True), mock.patch.object(m, "reap_locked", side_effect=RuntimeError("unresolved")), mock.patch.object(m, "write_state") as write:
            with self.assertRaisesRegex(RuntimeError, "unresolved"):
                m.activate(str(uuid.uuid4()), os.getpid())
            write.assert_not_called()

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
                        else:
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
                            m.reap()
                            break
                        elif mode == "wedged-guard":
                            proc.send_signal(signal.SIGSTOP)
                            time.sleep(2)
                            m.reap()
                            proc.send_signal(signal.SIGCONT)
                        elif mode == "project-stop":
                            with m.lifecycle_lock():
                                m.cleanup_locked(project_id)
                sel.close()
                self.assertIsNotNone(escaped, proc.stderr.read() if proc.poll() is not None else "missing fixture PID")
                if mode != "supervisor-crash":
                    self.assertIsNotNone(proof)
                    self.assertTrue(proof["cleanup"])
                    self.assertIn(proof["code"], (130, -9) if mode == "project-stop" else (0 if mode == "success" else 130,))
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
