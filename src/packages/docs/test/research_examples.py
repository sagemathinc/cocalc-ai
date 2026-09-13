"""Exercise the downloadable research scripts without a CoCalc account."""

import hashlib
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, call, patch
from urllib.error import HTTPError
from urllib.request import urlopen


EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "research-workflows"


def terminate_owned_group(process, grace_seconds=2):
    """Best-effort bounded cleanup of a child started with start_new_session=True.

    Reap the direct child and signal its group, including descendants that keep
    pipes open or ignore TERM. This cannot handle an uncatchable runner SIGKILL.
    Return cleanup errors so cancellation never gets replaced by a cleanup error.
    """
    errors = []
    for signum in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass
        except BaseException as error:
            errors.append(error)
        try:
            process.communicate(timeout=grace_seconds)
        except subprocess.TimeoutExpired as error:
            if signum == signal.SIGKILL:
                errors.append(error)
        except BaseException as error:
            errors.append(error)
    try:
        process.wait(timeout=grace_seconds)
    except BaseException as error:
        errors.append(error)
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            try:
                stream.close()
            except BaseException as error:
                errors.append(error)
    return errors


def communicate_owned_group(process, timeout, cleanup_timeout=2):
    """On any exceptional wait exit, clean our new session and re-raise it."""
    try:
        return process.communicate(timeout=timeout)
    except BaseException as original:
        try:
            errors = terminate_owned_group(process, grace_seconds=cleanup_timeout)
        except BaseException as cleanup_error:
            errors = [cleanup_error]
        if errors:
            # This attribute also preserves diagnostics on Python 3.9/3.10.
            diagnostics = tuple(f"{type(error).__name__}: {error}" for error in errors)
            try:
                original.owned_group_cleanup_errors = diagnostics
                if hasattr(original, "add_note"):
                    original.add_note("Owned process-group cleanup: " + "; ".join(diagnostics))
            except BaseException:
                pass
        raise


class ResearchExamples(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def run_script(self, name, *args, success=True):
        run = subprocess.run(
            [sys.executable, str(EXAMPLES / name), *map(str, args)],
            cwd=self.directory,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if success:
            self.assertEqual(run.returncode, 0, run.stderr)
        else:
            self.assertNotEqual(run.returncode, 0, run.stdout)
        return run

    def test_independent_analysis_and_changed_input(self):
        source = self.directory / "measurements.csv"
        shutil.copyfile(EXAMPLES / source.name, source)
        self.run_script("analyze.py", source, "first.json")
        self.run_script("analyze.py", source, "second.json")
        first = json.loads((self.directory / "first.json").read_text())
        self.assertEqual(first["count"], 4)
        self.assertEqual(first["mean"], 5.0)
        self.assertEqual(first["input_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual((self.directory / "first.json").read_bytes(), (self.directory / "second.json").read_bytes())
        source.write_text("value\n2\n4\n6\n8\n10\n")
        self.run_script("analyze.py", source, "changed.json")
        changed = json.loads((self.directory / "changed.json").read_text())
        self.assertEqual(changed["mean"], 6.0)
        self.assertNotEqual(changed["input_sha256"], first["input_sha256"])

    def test_invalid_input_does_not_create_result(self):
        for content in ("value\n", "wrong\n2\n", "value\nnan\n", "value\ninf\n", "value\n2,1000\n4\n", "value,other\n2,4\n", "value\n\"\"\n"):
            with self.subTest(content=content):
                (self.directory / "bad.csv").write_text(content)
                self.run_script("analyze.py", "bad.csv", "unexpected.json", success=False)
                self.assertFalse((self.directory / "unexpected.json").exists())

    def test_dashboard_rejects_malformed_rows_and_headers(self):
        spec = importlib.util.spec_from_file_location("dashboard", EXAMPLES / "dashboard.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.DATA = self.directory / "measurements.csv"
        with ThreadingHTTPServer(("127.0.0.1", 0), module.Dashboard) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/"
                module.DATA.write_text("value\n2\n4\n6\n8\n")
                with urlopen(url, timeout=3) as response:
                    self.assertIn(b"Count: 4; mean: 5.0", response.read())
                for content in ("value\n2,1000\n4\n", "value,other\n2,4\n", "value\n", "value\nnan\n"):
                    module.DATA.write_text(content)
                    with self.subTest(content=content), self.assertRaises(HTTPError) as error:
                        urlopen(url, timeout=3)
                    self.assertEqual(error.exception.code, 503)
                    error.exception.close()
            finally:
                server.shutdown()
                worker.join(timeout=3)

    def test_failure_resume_preserves_completed_cases(self):
        failed = self.run_script("sweep.py", "--out", "run", "--fail-at", 3, "--delay", 0, success=False)
        self.assertIn("Intentional demonstration failure", failed.stderr)
        saved = sorted((self.directory / "run").glob("case-*.json"))
        self.assertEqual(len(saved), 3)
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in saved}
        self.run_script("summarize_run.py", "run", success=False)
        resumed = self.run_script("sweep.py", "--out", "run", "--delay", 0)
        self.assertEqual(resumed.stdout.count("skip case="), 3)
        self.assertEqual(resumed.stdout.count("completed case="), 3)
        for path in saved:
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before[path.name])
        result = self.run_script("summarize_run.py", "run")
        self.assertEqual(result.stdout.strip(), "completed=6 sum_of_squares=55")

    def test_corrupt_checkpoint_is_rejected(self):
        self.run_script("sweep.py", "--out", "run", "--delay", 0)
        (self.directory / "run/case-002.json").write_text('{"case": 2, "square": 99}')
        self.run_script("sweep.py", "--out", "run", "--delay", 0, success=False)
        self.run_script("summarize_run.py", "run", success=False)

    @unittest.skipUnless(os.name == "posix", "scientific examples require Unix resource limits")
    def test_scientific_references_corruption_and_interruption(self):
        # The suite writes fixtures beside itself; keep every run out of the source tree.
        for name in ("scientific-prototype-v2-workflows.py", "scientific-prototype-v2-tests.py"):
            shutil.copyfile(EXAMPLES / "scientific" / name, self.directory / name)
        process = subprocess.Popen(
            [sys.executable, "-B", "scientific-prototype-v2-tests.py"],
            cwd=self.directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        stdout, stderr = communicate_owned_group(process, timeout=90)
        print(stdout, end="")
        self.assertEqual(process.returncode, 0, stderr)
        self.assertIn("Ran 14 tests", stderr)

    def test_notebook_has_no_saved_outputs_and_valid_code(self):
        notebook = json.loads((EXAMPLES / "analysis.ipynb").read_text())
        for index, cell in enumerate(notebook["cells"]):
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
                compile("".join(cell["source"]), f"cell-{index}", "exec")


@unittest.skipUnless(os.name == "posix", "owned process groups require POSIX")
class OwnedProcessGroupTests(unittest.TestCase):
    def test_timeout_escalates_and_preserves_the_original_exception(self):
        original = subprocess.TimeoutExpired("suite", 90)
        process = Mock(pid=123456)
        process.communicate.side_effect = [
            original, subprocess.TimeoutExpired("suite", 0.1), ("", "")
        ]
        with patch.object(os, "killpg") as killpg:
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                communicate_owned_group(process, timeout=90, cleanup_timeout=0.1)
        self.assertIs(caught.exception, original)
        self.assertEqual(killpg.call_args_list, [
            call(process.pid, signal.SIGTERM), call(process.pid, signal.SIGKILL)
        ])
        self.assertEqual(process.communicate.call_args_list, [
            call(timeout=90), call(timeout=0.1), call(timeout=0.1)
        ])
        process.wait.assert_called_once_with(timeout=0.1)

    def test_keyboard_interrupt_and_pipe_error_clean_up_before_reraising(self):
        for original in (KeyboardInterrupt("cancel suite"), OSError("pipe read failed")):
            with self.subTest(error=type(original).__name__):
                process = Mock(pid=123456)
                process.communicate.side_effect = [original, ("", ""), ("", "")]
                with patch.object(os, "killpg") as killpg:
                    with self.assertRaises(type(original)) as caught:
                        communicate_owned_group(process, timeout=90, cleanup_timeout=0.1)
                self.assertIs(caught.exception, original)
                self.assertEqual(killpg.call_count, 2)
                process.wait.assert_called_once_with(timeout=0.1)

    def test_already_exited_child_does_not_replace_cancellation(self):
        original = KeyboardInterrupt("cancel after exit")
        process = Mock(pid=123456, returncode=0)
        process.communicate.side_effect = [original, ("done", ""), ("done", "")]
        with patch.object(os, "killpg", side_effect=ProcessLookupError):
            with self.assertRaises(KeyboardInterrupt) as caught:
                communicate_owned_group(process, timeout=90, cleanup_timeout=0.1)
        self.assertIs(caught.exception, original)
        self.assertFalse(hasattr(original, "owned_group_cleanup_errors"))
        process.wait.assert_called_once_with(timeout=0.1)

    def test_cleanup_errors_do_not_hide_the_original_exception(self):
        original = KeyboardInterrupt("original cancellation")
        process = Mock(pid=123456)
        process.communicate.side_effect = [original, OSError("read failed"), KeyboardInterrupt("second interrupt")]
        process.wait.side_effect = subprocess.TimeoutExpired("suite", 0.1)
        with patch.object(os, "killpg", side_effect=PermissionError("signal denied")):
            with self.assertRaises(KeyboardInterrupt) as caught:
                communicate_owned_group(process, timeout=90, cleanup_timeout=0.1)
        self.assertIs(caught.exception, original)
        self.assertEqual(len(original.owned_group_cleanup_errors), 5)
        self.assertIn("PermissionError: signal denied", original.owned_group_cleanup_errors)
        process.wait.assert_called_once_with(timeout=0.1)

        unexpected = KeyboardInterrupt("preserve even an unexpected cleanup failure")
        process = Mock(pid=123456)
        process.communicate.side_effect = unexpected
        with patch(f"{__name__}.terminate_owned_group", side_effect=RuntimeError("cleanup helper failed")):
            with self.assertRaises(KeyboardInterrupt) as caught:
                communicate_owned_group(process, timeout=90, cleanup_timeout=0.1)
        self.assertIs(caught.exception, unexpected)
        self.assertEqual(unexpected.owned_group_cleanup_errors, ("RuntimeError: cleanup helper failed",))

    def test_term_resistant_leader_and_descendant_are_bounded(self):
        child_code = """import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
time.sleep(60)
"""
        for descendant in (False, True):
            with self.subTest(descendant=descendant), tempfile.TemporaryDirectory() as directory:
                ready = Path(directory) / "ready"
                if descendant:
                    code = "import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', " + repr(child_code) + ", sys.argv[1]])\ntime.sleep(60)"
                else:
                    code = child_code
                process = subprocess.Popen(
                    [sys.executable, "-c", code, str(ready)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    start_new_session=True,
                )
                try:
                    deadline = time.monotonic() + 5
                    while not ready.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(ready.exists(), "TERM handler was not installed")
                    with self.assertRaises(subprocess.TimeoutExpired) as caught:
                        communicate_owned_group(process, timeout=0.05, cleanup_timeout=0.1)
                    self.assertFalse(hasattr(caught.exception, "owned_group_cleanup_errors"))
                    self.assertEqual(process.returncode, -signal.SIGTERM if descendant else -signal.SIGKILL)
                    # communicate reached EOF only after the resistant child,
                    # which inherited both pipes, also exited. Reap the leader.
                    process.wait(timeout=1)
                finally:
                    if process.poll() is None:
                        terminate_owned_group(process, grace_seconds=0.1)

    def test_outer_term_allows_standalone_suite_to_clean_nested_group(self):
        worker_code = """import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
time.sleep(60)
"""
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            suite = EXAMPLES / "scientific" / "scientific-prototype-v2-tests.py"
            harness = """import importlib.util, signal, sys
spec = importlib.util.spec_from_file_location("standalone_suite", sys.argv[1])
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
signal.signal(signal.SIGTERM, suite.cancel_on_sigterm)
with suite.owned_process([sys.executable, "-c", sys.argv[2], sys.argv[3]]) as child:
    child.communicate(timeout=60)
"""
            process = subprocess.Popen(
                [sys.executable, "-c", harness, str(suite), worker_code, str(ready)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                start_new_session=True,
            )
            nested_group = None
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "nested worker was not ready")
                nested_group = int(ready.read_text())
                with self.assertRaises(subprocess.TimeoutExpired):
                    communicate_owned_group(process, timeout=0.05, cleanup_timeout=1)
                with self.assertRaises(ProcessLookupError):
                    os.killpg(nested_group, 0)
                self.assertIsNotNone(process.returncode)
            finally:
                if nested_group is not None:
                    try:
                        os.killpg(nested_group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if process.poll() is None:
                    terminate_owned_group(process, grace_seconds=0.1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
