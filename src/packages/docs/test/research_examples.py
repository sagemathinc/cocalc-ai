"""Exercise the downloadable research scripts without a CoCalc account."""

import hashlib
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen


EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "research-workflows"


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

    def test_notebook_has_no_saved_outputs_and_valid_code(self):
        notebook = json.loads((EXAMPLES / "analysis.ipynb").read_text())
        for index, cell in enumerate(notebook["cells"]):
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
                compile("".join(cell["source"]), f"cell-{index}", "exec")


if __name__ == "__main__":
    unittest.main(verbosity=2)
