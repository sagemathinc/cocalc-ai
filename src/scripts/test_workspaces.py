"""Regression tests for workspace test-command resource controls."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "workspaces",
    Path(__file__).resolve().parents[1] / "workspaces.py")
workspaces = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspaces)


class WorkerOptionsTest(unittest.TestCase):

    def command(self, script, workers="4", path="packages/example"):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / path
            package.mkdir(parents=True)
            (package / "package.json").write_text(
                json.dumps({"scripts": {
                    "test": script
                }}))
            args = SimpleNamespace(max_workers=workers,
                                   report=False,
                                   retries=0,
                                   test_github_ci=False)
            with patch.object(workspaces, "packages", return_value=[path]), \
                    patch.object(workspaces, "cmd") as cmd, \
                    patch.object(workspaces, "is_github_ci", return_value=False), \
                    patch.object(workspaces, "write_github_summary"), \
                    contextlib.redirect_stdout(io.StringIO()):
                cwd = os.getcwd()
                try:
                    os.chdir(root)
                    workspaces.test(args)
                finally:
                    os.chdir(cwd)
                self.assertEqual(cmd.call_count, 1)
                return cmd.call_args.args[0]

    def test_jest_gets_explicit_worker_option(self):
        self.assertIn("--maxWorkers=4", self.command("jest"))

    def test_non_jest_does_not_get_jest_flags(self):
        command = self.command("node --test tests/*.test.mjs")
        self.assertEqual(command, "pnpm run --if-present test")

    def test_known_jest_wrapper_gets_option(self):
        self.assertIn(
            "--maxWorkers=4",
            self.command("node scripts/test.js", path="packages/project-host"))

    def test_default_keeps_package_worker_policy(self):
        self.assertNotIn("--maxWorkers", self.command("jest", workers=""))


if __name__ == "__main__":
    unittest.main()
