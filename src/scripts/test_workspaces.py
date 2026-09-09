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

    def command(self,
                script,
                workers="4",
                path="packages/example",
                shard='',
                selected=None):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / path
            package.mkdir(parents=True)
            (package / "package.json").write_text(
                json.dumps({"scripts": {
                    "test": script
                }}))
            args = SimpleNamespace(max_workers=workers,
                                   shard=shard,
                                   report=False,
                                   retries=0,
                                   test_github_ci=False)
            with patch.object(workspaces, "packages", return_value=selected if selected is not None else [path]), \
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

    def test_shard_is_forwarded_to_jest(self):
        self.assertIn('--shard=2/3', self.command('jest', shard='2/3'))

    def test_sharding_non_jest_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Jest-backed'):
            self.command('node --test', shard='1/2')

    def test_sharding_multiple_packages_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.command('jest',
                         shard='1/2',
                         selected=['packages/example', 'packages/another'])

    def test_empty_sharded_selection_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.command('jest', shard='1/2', selected=[])

    def test_shard_validation(self):
        self.assertEqual(workspaces.parse_jest_shard('2/3'), '2/3')
        for value in [
                '0/2', '3/2', '1/0', '-1/2', '1', '1/2/3', 'a/2', '1.5/2'
        ]:
            with self.subTest(value=value), self.assertRaises(
                    workspaces.argparse.ArgumentTypeError):
                workspaces.parse_jest_shard(value)

    def test_cli_without_shard_keeps_existing_behavior(self):
        with patch.object(workspaces.sys, 'argv',
                          ['workspaces.py', 'test', '--packages=server']), \
                patch.object(workspaces, 'node_version_check'), \
                patch.object(workspaces, 'pnpm_version_check'), \
                patch.object(workspaces, 'test') as run:
            workspaces.main()
        self.assertIsNone(run.call_args.args[0].shard)


class TestReportsTest(unittest.TestCase):

    def test_retry_preserves_both_reports_before_temporary_cleanup(self):
        self.check_retry('')

    def test_sharded_retry_runs_all_failed_paths_without_resharding(self):
        self.check_retry('1/2')

    def test_sharded_retry_without_report_keeps_original_shard(self):
        self.check_retry('2/2', write_report=False)

    def check_retry(self, shard, write_report=True):
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
                if write_report:
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
                                   shard=shard,
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
            if shard:
                self.assertIn('--shard=' + shard, commands[0])
            if write_report:
                self.assertIn('--runTestsByPath', commands[1])
                self.assertNotIn('--shard', commands[1])
                self.assertIn(str(package / 'example.test.ts'), commands[1])
            else:
                self.assertNotIn('--runTestsByPath', commands[1])
                self.assertIn('--shard=' + shard, commands[1])
            self.assertTrue(
                all(not directory.exists() for directory in temporary_dirs))
            for attempt, status in enumerate(['failed', 'passed']):
                if shard:
                    directory = reports / ('shard-' +
                                           shard.replace('/', '-of-'))
                else:
                    directory = reports
                directory = directory / 'packages-example'
                metadata = json.loads(
                    (directory / f'attempt-{attempt}.json').read_text())
                self.assertEqual(metadata['status'], status)
                self.assertGreaterEqual(metadata['elapsed_seconds'], 0)
                self.assertEqual(metadata['has_jest_report'], write_report)
                if write_report:
                    result = json.loads(
                        (directory /
                         f'jest-results-{attempt}.json').read_text())
                    self.assertEqual(result['testResults'][0]['status'],
                                     status)

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
