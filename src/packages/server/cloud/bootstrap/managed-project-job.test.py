#!/usr/bin/env python3
"""Lifecycle tests for the installed (embedded) privileged helper."""
import os
import json
import base64
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
            live = project / "job-10-100-20-200-00000000-0000-4000-8000-000000000001"
            dead_owner = project / "job-10-99-20-200-00000000-0000-4000-8000-000000000002"
            dead_guard = project / "job-10-100-20-199-00000000-0000-4000-8000-000000000003"
            unknown = project / "job-unrecognized"
            for path in [live, dead_owner, dead_guard, unknown]:
                path.mkdir()
            with mock.patch.object(m, "alive", side_effect=lambda pid, start: (pid, start) in [("10", "100"), ("20", "200")]), mock.patch.object(m, "kill_scope") as kill:
                m.reap()
                self.assertEqual({call.args[0] for call in kill.call_args_list}, {dead_owner, dead_guard})

    def test_failed_orphan_cleanup_does_not_starve_other_scopes(self):
        m = helper()
        with tempfile.TemporaryDirectory() as directory:
            m.POOL = Path(directory)
            project = m.POOL / "project-00000000-0000-4000-8000-000000000001"
            project.mkdir()
            for i in range(2):
                (project / f"job-10-100-20-200-00000000-0000-4000-8000-00000000000{i}").mkdir()
            with mock.patch.object(m, "alive", return_value=False), mock.patch.object(m, "kill_scope", side_effect=[RuntimeError(), None]) as kill:
                with self.assertRaisesRegex(RuntimeError, "not confirmed"):
                    m.reap()
                self.assertEqual(kill.call_count, 2)


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
                launcher.write_text("#!/usr/bin/python3\nimport os,sys\nos.execv('/bin/bash', ['bash','-c',sys.argv[-1]])\n")
                launcher.chmod(0o755)
                source = bootstrap.MANAGED_PROJECT_JOB_HELPER.replace("__PROJECT_POOL_CGROUP__", str(root)).replace("__RUNTIME_USER__", "nobody")
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
                proc = subprocess.Popen(["/usr/bin/python3", "-I", "-c", source, "run", project_id, str(uuid.uuid4()), str(owner.pid), "1500" if mode == "deadline" else "30000"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
                sel.close()
                self.assertIsNotNone(escaped, proc.stderr.read() if proc.poll() is not None else "missing fixture PID")
                if mode != "supervisor-crash":
                    self.assertEqual(proof, {"type": "exit", "code": 0 if mode == "success" else 130, "cleanup": True})
                    proc.wait(timeout=5)
                self.assertEqual(list(project.iterdir()), [])
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
            for scope in project.iterdir():
                m.kill_scope(scope)
            project.rmdir()
            root.rmdir()

    def test_detached_descendants_on_all_stop_paths(self):
        for detach in ("setsid", "double-fork"):
            for mode in ("cancel", "deadline", "lease-expiry", "success", "owner-death", "supervisor-crash"):
                with self.subTest(detach=detach, mode=mode):
                    self.exercise(mode, detach)


if __name__ == "__main__":
    unittest.main()
