"""Regression tests for workspace test-command resource controls."""

import contextlib
import importlib.util
import io
import json
import os
import shlex
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


class TestReportsTest(unittest.TestCase):

    def test_retry_preserves_both_reports_before_temporary_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / 'packages/example'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(
                json.dumps({'scripts': {
                    'test': 'jest'
                }}))
            reports = Path(root) / 'reports'
            temporary_dirs = []
            commands = []

            def run(command, _package):
                commands.append(command)
                argv = shlex.split(command)
                output = Path(argv[argv.index('--outputFile') + 1])
                temporary_dirs.append(output.parent)
                failed = len(commands) == 1
                output.write_text(
                    json.dumps({
                        'testResults': [{
                            'name':
                            str(package / 'example.test.ts'),
                            'status':
                            'failed' if failed else 'passed',
                        }]
                    }))
                if failed:
                    raise RuntimeError('first attempt failed')

            args = SimpleNamespace(max_workers='',
                                   report=False,
                                   retries=1,
                                   test_github_ci=False)
            with patch.object(workspaces, 'packages', return_value=['packages/example']), \
                    patch.object(workspaces, 'cmd', side_effect=run), \
                    patch.object(workspaces, 'is_github_ci', return_value=False), \
                    patch.object(workspaces, 'write_github_summary'), \
                    patch.dict(os.environ, {'COCALC_TEST_REPORT_DIR': str(reports)}), \
                    contextlib.redirect_stdout(io.StringIO()):
                cwd = os.getcwd()
                try:
                    os.chdir(root)
                    workspaces.test(args)
                finally:
                    os.chdir(cwd)
            self.assertEqual(len(commands), 2)
            self.assertIn('--runTestsByPath', commands[1])
            self.assertTrue(
                all(not directory.exists() for directory in temporary_dirs))
            for attempt, status in enumerate(['failed', 'passed']):
                directory = reports / 'packages-example'
                metadata = json.loads(
                    (directory / f'attempt-{attempt}.json').read_text())
                self.assertEqual(metadata['status'], status)
                self.assertGreaterEqual(metadata['elapsed_seconds'], 0)
                self.assertTrue(metadata['has_jest_report'])
                result = json.loads(
                    (directory / f'jest-results-{attempt}.json').read_text())
                self.assertEqual(result['testResults'][0]['status'], status)

    def test_attempt_without_jest_report_still_has_timing(self):
        with tempfile.TemporaryDirectory() as root:
            workspaces.preserve_test_attempt(root, 'packages/cli', 0,
                                             str(Path(root) / 'missing.json'),
                                             1.25, 'failed')
            metadata = json.loads(
                (Path(root) / 'packages-cli/attempt-0.json').read_text())
            self.assertEqual(metadata['elapsed_seconds'], 1.25)
            self.assertFalse(metadata['has_jest_report'])


if __name__ == "__main__":
    unittest.main()
