"""Local regression checks; no installations or remote operations."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_example", ROOT / "check_native.py")
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


class NativePublicationTests(unittest.TestCase):
    def invoke(self, output, env=None):
        return subprocess.run(
            [sys.executable, "-B", str(ROOT / "check_native.py"),
             "--output", str(output)],
            capture_output=True, text=True, timeout=60, env=env,
        )

    def test_existing_result_is_preserved_before_compilation(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp) / "old-run"
            output.mkdir()
            final = output / "validation-receipt.json"
            final.write_bytes(b"previous result\n")
            result = self.invoke(output)
            self.assertEqual(result.returncode, 1)
            self.assertIn("File exists", result.stderr)
            self.assertEqual(final.read_bytes(), b"previous result\n")
            self.assertEqual(list(output.iterdir()), [final])

    def test_compilation_failure_has_no_completion_receipt(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            tools = Path(tmp) / "tools"
            tools.mkdir()
            compiler = tools / "cc"
            compiler.write_text(
                '#!/bin/sh\nif [ "$1" = "--version" ]; then\n'
                '  echo "Synthetic failure-test compiler"\n  exit 0\nfi\n'
                'echo "deliberate compile failure" >&2\nexit 7\n'
            )
            compiler.chmod(0o700)
            env = dict(os.environ, PATH=str(tools))
            output = Path(tmp) / "failed-run"
            result = self.invoke(output, env=env)
            self.assertEqual(result.returncode, 1)
            self.assertIn("compilation failed: deliberate compile failure", result.stderr)
            self.assertEqual(list(output.iterdir()), [])

    def test_late_result_is_not_replaced(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp)
            final = output / "validation-receipt.json"
            real_link = os.link

            def competing_publication(source, target):
                final.write_bytes(b"late writer result\n")
                return real_link(source, target)

            with unittest.mock.patch.object(example.os, "link", competing_publication):
                with self.assertRaises(FileExistsError):
                    example.publish_receipt(output, {"state": "PASS"})
            self.assertEqual(final.read_bytes(), b"late writer result\n")
            self.assertEqual(list(output.iterdir()), [final])

    @unittest.skipUnless(shutil.which("cc"), "existing C compiler is required")
    def test_existing_compiler_result_and_provenance(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp) / "new-run"
            result = self.invoke(output)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt = json.loads((output / "validation-receipt.json").read_text())
            self.assertEqual(receipt["state"], "PASS")
            self.assertEqual(receipt["tests_run"], 4)
            self.assertTrue(receipt["temporary_library_removed"])
            self.assertEqual(receipt["python"], sys.version.split()[0])
            self.assertNotIn("hosted", receipt)
            for name, digest in receipt["source_sha256"].items():
                self.assertEqual(digest, hashlib.sha256((ROOT / name).read_bytes()).hexdigest())
            values = receipt["example_result"]
            x = values["input"]["x"]
            y = values["input"]["y"]
            sigma = values["input"]["sigma"]
            self.assertEqual((len(x), len(y), len(sigma)), (20, 20, 20))
            self.assertEqual(values["status"], 0)
            for a, b in zip(values["native_slope_intercept_chi2"],
                            values["independent_reference"]):
                self.assertAlmostEqual(a, b, places=10)
            self.assertEqual(list(output.iterdir()), [output / "validation-receipt.json"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
