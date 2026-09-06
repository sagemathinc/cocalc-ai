#!/usr/bin/env python3
"""Protected evidence producer regressions. Real Btrfs is qualified in CI."""
import contextlib
import copy
import hashlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import uuid

import bootstrap


class RusticEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.api = {"__name__": "test"}
        exec(bootstrap.RUNTIME_STORAGE_PATH_HELPER, self.api)
        self.source = {"snapshot_uuid": "00000000-0000-4000-8000-000000000001",
                       "subvolume_uuid": "00000000-0000-4000-8000-000000000002",
                       "generation": "9007199254740993"}
        self.native = {
            "binary_sha256": "a" * 64,
            "admission": {name: 100 for name in ("max-entries", "max-apparent-bytes", "max-file-bytes",
                "max-chunk-references", "max-metadata-bytes", "max-path-depth", "preflight-timeout-seconds")},
            "evidence": {"policy_version": 1, "exclude_larger_than_bytes": 4, "max_report_bytes": 32768, "max_spool_bytes": 131072, "max_reports": 4},
        }

    def report(self, count=1):
        header = {"schema_version": 1, "type": "header", "sources": [{"encoding": "unix-bytes-hex", "value": "2e"}]}
        rows = [header]
        rows.extend({"schema_version": 1, "type": "excluded"} for _ in range(count))
        rows.append({"schema_version": 1, "type": "complete", "inventory": {"excluded_files": str(count)}})
        return b"".join(json.dumps(row).encode() + b"\n" for row in rows)

    def test_get_subvolume_identity_uses_exact_uuid_and_u64(self):
        def ioctl(_fd, request, buf, mutate):
            self.assertEqual(request, 0x81f8943c)
            self.assertEqual(len(buf), 504)
            self.assertTrue(mutate)
            struct.pack_into("=QQ", buf, 280, 9007199254740993, 2)
            buf[296:312] = uuid.UUID(self.source["snapshot_uuid"]).bytes
            buf[312:328] = uuid.UUID(self.source["subvolume_uuid"]).bytes
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with mock.patch("fcntl.ioctl", side_effect=ioctl):
                    self.assertEqual(self.api["btrfs_backup_identity"](fd), self.source)
                with mock.patch("fcntl.ioctl", return_value=0):
                    with self.assertRaises(ValueError):
                        self.api["btrfs_backup_identity"](fd)
            finally:
                os.close(fd)

    def test_inventory_envelope_requires_footer_and_consistent_order(self):
        report = self.report()
        _, footer = self.api["read_backup_inventory_envelope"](io.BytesIO(report))
        self.assertEqual(footer["excluded_files"], "1")
        rows = report.splitlines(keepends=True)
        for malformed in [b"".join(rows[:-1]), report[:-1], report + rows[-1], report + rows[1], rows[-1], b"x" * 65537,
                          report.replace(b'"excluded_files": "1"', b'"excluded_files": "2"')]:
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                self.api["read_backup_inventory_envelope"](io.BytesIO(malformed))

    def test_report_directory_rejects_symlinks_and_group_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report = root / "reports"
            kwargs = {"required_uid": os.getuid(), "reader_gid": os.getgid()}
            self.api["backup_report_directory"](str(report), **kwargs)
            self.assertEqual(report.stat().st_mode & 0o777, 0o750)
            report.chmod(0o770)
            with self.assertRaises(ValueError):
                self.api["backup_report_directory"](str(report), **kwargs)
            (root / "link").symlink_to(report, target_is_directory=True)
            with self.assertRaises(ValueError):
                self.api["backup_report_directory"](str(root / "link"), **kwargs)

    def test_bounded_capture_limits_before_writing_overflow(self):
        script = "import sys;sys.stdout.buffer.write(b'x' * 100000)"
        with self.assertRaises(ValueError):
            self.api["bounded_rustic_capture"](["/usr/bin/python3", "-I", "-c"], [script],
                cwd="/tmp", env={}, pass_fds=(), maximum=10, sink=io.BytesIO())

    def test_spool_reserves_future_bytes_and_bounds_report_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o750)
            limits = {"max_report_bytes": 8, "max_spool_bytes": 16, "max_reports": 2}
            first, fd = self.api["reserve_backup_report"](tmp, limits, os.getuid())
            os.close(fd)
            second, fd = self.api["reserve_backup_report"](tmp, limits, os.getuid())
            os.close(fd)
            self.assertEqual(Path(first).stat().st_size, 8)
            self.assertEqual(Path(second).stat().st_size, 8)
            with self.assertRaisesRegex(ValueError, "count exhausted"):
                self.api["reserve_backup_report"](tmp, limits, os.getuid())
            with self.assertRaisesRegex(ValueError, "byte budget exhausted"):
                self.api["reserve_backup_report"](tmp, {**limits, "max_reports": 3}, os.getuid())

    def test_concurrent_spool_reservations_cannot_over_admit(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o750)
            ctx = multiprocessing.get_context("fork")
            queue = ctx.Queue()
            def worker():
                try:
                    _, fd = self.api["reserve_backup_report"](tmp, {"max_report_bytes": 8, "max_spool_bytes": 16, "max_reports": 2}, os.getuid())
                    os.close(fd)
                    queue.put(True)
                except ValueError:
                    queue.put(False)
            workers = [ctx.Process(target=worker) for _ in range(8)]
            try:
                for process in workers: process.start()
                for process in workers:
                    process.join(timeout=15)
                    self.assertEqual(process.exitcode, 0)
                self.assertEqual(sum(queue.get(timeout=1) for _ in workers), 2, sorted(os.listdir(tmp)))
            finally:
                for process in workers:
                    if process.is_alive(): process.kill()
                    process.join()
                queue.close()
                queue.join_thread()

    def test_failed_reservation_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o750)
            with mock.patch("os.ftruncate", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    self.api["reserve_backup_report"](tmp, {"max_report_bytes": 8, "max_spool_bytes": 16, "max_reports": 2}, os.getuid())
            self.assertEqual(sorted(os.listdir(tmp)), [".lock"])

    def test_release_requires_root_seal_and_never_releases_active_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o750)
            path, fd = self.api["reserve_backup_report"](tmp, {"max_report_bytes": 8, "max_spool_bytes": 16, "max_reports": 2}, os.getuid())
            os.close(fd)
            args = ["rustic-report-release", Path(path).name, "a" * 64]
            release = lambda: self.api["release_backup_report"](args, tmp, os.getuid())
            os.setxattr(path, self.api["REPORT_SEAL"], b"a" * 64)
            with self.assertRaisesRegex(ValueError, "not sealed"):
                release()
            Path(path).chmod(0o440)
            with mock.patch("os.getxattr", return_value=b"b" * 64):
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    release()
            self.assertTrue(Path(path).exists())
            release()
            self.assertFalse(Path(path).exists())
            release()  # A retry after a lost response is harmless.

    def test_spool_and_release_refuse_symlinks_and_arbitrary_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spool = root / "reports"
            spool.mkdir(mode=0o750)
            target = root / "keep"
            target.write_text("keep")
            name = str(uuid.uuid4()) + ".ndjson"
            (spool / name).symlink_to(target)
            with self.assertRaises(ValueError):
                self.api["reserve_backup_report"](str(spool), {"max_report_bytes": 8, "max_spool_bytes": 16, "max_reports": 2}, os.getuid())
            for candidate in [name, "../keep", str(target), "other", ".lock"]:
                with self.assertRaises((ValueError, OSError)):
                    self.api["release_backup_report"](["rustic-report-release", candidate, "a" * 64], str(spool), os.getuid())
            self.assertEqual(target.read_text(), "keep")

    def exercise(self, *, count=1, changed=False, inventory_status=0, backup_status=0, oversized_output=False, repo_statuses=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "source").mkdir()
            (root / "profile.toml").write_text('''[repository]
repository="opendal:s3"
password="test"
[repository.options]
access_key_id="access"
bucket="bucket"
endpoint="https://object.invalid"
region="auto"
root="project-test"
secret_access_key="secret"
''')
            binary = root / "rustic"
            binary.write_bytes(b"binary")
            binary.chmod(0o755)
            reports = root / "reports"
            calls = []
            identity_reads = 0

            def identity(_fd):
                nonlocal identity_reads
                identity_reads += 1
                return {**self.source, "generation": "9007199254740994"} if changed and identity_reads > 1 else self.source.copy()

            def capture(_base, args, **opts):
                calls.append(args)
                if args[0] == "backup-inventory":
                    data = self.report(count)
                    opts["sink"].write(data)
                    return inventory_status, b"", {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                if oversized_output:
                    raise ValueError("native Rustic output exceeds its byte budget")
                return backup_status, json.dumps({"id": "b" * 64, "time": "2026-09-05T00:00:00Z", "summary": {}}).encode(), {}

            api_patches = {
                "require_readonly_btrfs_source": lambda _fd: None,
                "btrfs_backup_identity": identity,
                "open_pinned_rustic": lambda *_: os.open(binary, os.O_RDONLY),
                "verify_native_rustic": lambda *_, **kwargs: self.assertTrue(kwargs["require_evidence"]),
                "bounded_rustic_capture": capture,
            }
            failure = changed or inventory_status or backup_status or oversized_output
            repo_calls = []
            statuses = iter(repo_statuses or [0, 0])
            def invoke(args, **_):
                repo_calls.append(args)
                return mock.Mock(returncode=next(statuses))
            with mock.patch.dict(self.api, api_patches), mock.patch("subprocess.run", side_effect=invoke):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    def run():
                        self.api["run_rustic"](["rustic-project-backup", "--root", str(root), "--path", "source", "--profile-root", str(root), "--profile-path", "profile.toml", "--host", "project-test"],
                            allowed_roots={str(root)}, rustic_candidates=[str(binary)], profile_run_dir=str(root / "run"), profile_run_dir_uid=os.getuid(), native=self.native,
                            report_run_dir=str(reports), report_run_dir_uid=os.getuid(), report_reader_gid=os.getgid())
                    if failure:
                        error_type = ValueError if changed or oversized_output else self.api["subprocess"].CalledProcessError
                        with self.assertRaises(error_type): run()
                    else: run()
            if failure:
                self.assertEqual(output.getvalue(), "")
                self.assertEqual([p for p in reports.iterdir() if p.name != ".lock"], [])
                self.assertEqual(len(calls), 1 if inventory_status else 2)
                self.assertEqual(identity_reads, 2 if changed else 1)
                return
            doc = json.loads(output.getvalue())
            proof = doc["cocalc_backup_evidence"]
            self.assertEqual(proof["outcome"], "complete" if count == 0 else "partial_policy_exclusions")
            self.assertEqual(proof["source"]["snapshot_uuid"], self.source["snapshot_uuid"])
            self.assertEqual(proof["source"]["generation"], "9007199254740993")
            report_path = Path(proof["report_path"])
            self.assertEqual(report_path.stat().st_mode & 0o777, 0o440)
            self.assertEqual(os.getxattr(report_path, self.api["REPORT_SEAL"]), proof["report"]["sha256"].encode())
            self.assertEqual(proof["report"]["sha256"], hashlib.sha256(report_path.read_bytes()).hexdigest())
            self.assertEqual(proof["policy_sha256"], hashlib.sha256(self.api["canonical_backup_json"](self.native)).hexdigest())
            self.assertEqual(calls[0][0], "backup-inventory")
            self.assertIn("-x", calls[0])
            self.assertEqual(calls[1][0], "backup")
            self.assertIn("--strict", calls[1])
            for flags in calls:
                self.assertEqual(flags[flags.index("--exclude-larger-than") + 1], "4")
                self.assertEqual(flags[flags.index("--max-entries") + 1], "100")
            if repo_statuses:
                self.assertEqual(len(repo_calls), len(repo_statuses))
                self.assertIn("init", repo_calls[1])

    def test_complete_report_is_published_only_after_backup(self): self.exercise(count=0)
    def test_partial_report_is_published_only_after_backup(self): self.exercise()
    def test_changed_identity_cannot_publish_success(self): self.exercise(changed=True)
    def test_failed_inventory_never_starts_backup(self): self.exercise(inventory_status=1)
    def test_failed_backup_never_publishes_inventory_as_backup(self): self.exercise(backup_status=1)
    def test_oversized_backup_result_cleans_report(self): self.exercise(oversized_output=True)
    def test_new_repository_is_initialized_before_inventory(self): self.exercise(repo_statuses=[1, 0])
    def test_concurrent_repository_init_is_rechecked(self): self.exercise(repo_statuses=[1, 1, 0])

    def test_evidence_policy_is_explicit_bounded_and_consistent(self):
        api = {"__name__": "test"}
        exec(bootstrap.RUSTIC_JOB_HELPER, api)
        policy = {"version": 1, "runtime_seconds": 1800, "kill_grace_seconds": 10,
                  "memory_bytes": 2 * 1024**3, "cpu_quota_percent": 100, "io_weight": 10, "max_jobs": 2, "tasks_max": 128, "native": self.native}
        with mock.patch.dict(api, {"trusted_regular": lambda _: json.dumps(policy)}):
            self.assertEqual(api["load_policy"](), policy)
        for key in self.native["evidence"]:
            for value in [None, True, 0, -1, 2**63]:
                broken = copy.deepcopy(policy)
                broken["native"]["evidence"][key] = value
                with mock.patch.dict(api, {"trusted_regular": lambda _: json.dumps(broken)}):
                    with self.assertRaises(ValueError): api["load_policy"]()
        policy["native"]["evidence"]["exclude_larger_than_bytes"] = 101
        with mock.patch.dict(api, {"trusted_regular": lambda _: json.dumps(policy)}):
            with self.assertRaises(ValueError): api["load_policy"]()


if __name__ == "__main__":
    unittest.main()
