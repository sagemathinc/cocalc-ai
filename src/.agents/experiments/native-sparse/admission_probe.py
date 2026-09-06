#!/usr/bin/env python3
"""Bounded, disposable Btrfs admission/metadata cost probes. No inherited auth."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("report", type=Path)
    options = parser.parse_args()
    assert options.binary.is_absolute() and options.binary.is_file()
    assert options.report.is_absolute() and not options.report.exists()
    with options.binary.open("rb") as binary_file:
        digest = hashlib.file_digest(binary_file, "sha256").hexdigest()
    report = {"binary": str(options.binary), "sha256": digest, "rayon_threads": 4,
              "virtual_address_space_limit": 16 * 1024**3, "runs": []}
    with tempfile.TemporaryDirectory(prefix="cocalc-admission-probe-", dir="/tmp") as tmp:
        root = Path(tmp)
        env = {"HOME": tmp, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
               "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
               "RUSTIC_PASSWORD": "disposable-fixture-only", "RAYON_NUM_THREADS": "4"}
        filesystem = subprocess.check_output(["findmnt", "-T", tmp, "-n", "-o", "FSTYPE"], env=env, text=True, timeout=10).strip()
        assert filesystem == "btrfs", filesystem
        report["filesystem"] = filesystem
        measure = root / "measure"
        subprocess.run(["gcc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", str(measure),
                        str(Path(__file__).with_name("measure.c"))], env=env, check=True, timeout=30)

        def restrict():
            # Virtual reservations/allocator arenas are not resident memory.
            # Production RSS containment is qualified separately with cgroups.
            resource.setrlimit(resource.RLIMIT_AS, (16 * 1024**3, 16 * 1024**3))
            resource.setrlimit(resource.RLIMIT_CPU, (90, 90))

        def run(label, args, cwd=root, success=True):
            stats = root / f"measure-{len(report['runs'])}.json"
            started = time.monotonic()
            proc = subprocess.Popen([str(measure), str(stats), str(options.binary),
                                     "--repository", str(root / "repo"), "--no-cache", "--no-progress", *args],
                                    cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, preexec_fn=restrict)
            streams = {"stdout": bytearray(), "stderr": bytearray()}
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
                    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
                    while selector.get_map():
                        assert time.monotonic() - started < 120, "probe deadline exceeded"
                        for key, _ in selector.select(.2):
                            data = os.read(key.fileobj.fileno(), 65536)
                            if not data:
                                selector.unregister(key.fileobj)
                                continue
                            streams[key.data].extend(data)
                            assert sum(map(len, streams.values())) <= 4 * 1024**2, "probe output exceeded budget"
                code = proc.wait(timeout=5)
                stdout = streams["stdout"].decode("utf-8")
                stderr = streams["stderr"].decode("utf-8")
                row = {"label": label, "elapsed_seconds": time.monotonic() - started,
                       "exit_code": code, **json.loads(stats.read_text())}
                if code == 0 and stdout.strip():
                    row["output"] = json.loads(stdout)
                elif code != 0:
                    row["error"] = stderr[-2000:]
                report["runs"].append(row)
                print(json.dumps(row), flush=True)
                if (code == 0) != success:
                    report["status"] = "failed"
                    with options.report.open("x") as file:
                        json.dump(report, file, indent=2)
                    raise AssertionError((label, code, stderr[-4000:]))
                return row.get("output")
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
                proc.stdout.close()
                proc.stderr.close()

        def repo_files():
            return sorted((str(path.relative_to(root)), path.stat().st_size) for path in (root / "repo").rglob("*") if path.is_file())

        run("init", ["init"])
        source = root / "huge"
        source.mkdir()
        with (source / "70TiB").open("xb") as file:
            file.truncate(70 * 1024**4)
        assert (source / "70TiB").stat().st_blocks == 0
        before = repo_files()
        inventory = run("70TiB-metadata-only", ["backup-inventory", "--preflight-timeout-seconds", "5", "."], cwd=source)
        assert inventory["chunk_references_bound"] == 70 * 1024**4 // (512 * 1024)
        run("70TiB-reference-rejection", ["backup", "--strict", "--json", "--no-scan",
             "--max-chunk-references", "4194304", "--preflight-timeout-seconds", "5", "."], cwd=source, success=False)
        assert "max-chunk-references" in report["runs"][-1]["error"]
        assert repo_files() == before, "rejected backup wrote repository artifacts"

        source = root / "metadata"
        source.mkdir()
        previous = 0
        for count in [300, 1000, 5000]:
            for index in range(previous, count):
                file = source / (f"{index:08d}-" + "n" * 180)
                file.touch()
                os.setxattr(file, "user.backup-qualification", b"a" * 2048)
            previous = count
            inventory = run(f"{count}-metadata-only", ["backup-inventory", "--preflight-timeout-seconds", "10", "."], cwd=source)
            assert inventory["files"] == count
            before = repo_files()
            run(f"{count}-metadata-rejection", ["backup", "--strict", "--json", "--no-scan",
                 "--max-metadata-bytes", str(inventory["node_metadata_bytes"] - 1), "."], cwd=source, success=False)
            assert "max-metadata-bytes" in report["runs"][-1]["error"]
            assert repo_files() == before
            run(f"{count}-metadata-backup", ["backup", "--strict", "--json", "--no-scan",
                 "--max-entries", str(count + 1), "--max-metadata-bytes", str(inventory["node_metadata_bytes"]), "."], cwd=source)
        unchanged = run("5000-unchanged", ["backup", "--strict", "--json", "--no-scan", "."], cwd=source)
        assert unchanged["summary"]["files_unmodified"] == 5000
        assert unchanged["summary"]["data_added"] == 0
        before = repo_files()
        run("5000-entry-rejection", ["backup", "--strict", "--json", "--no-scan", "--max-entries", "4999", "."], cwd=source, success=False)
        assert "max-entries" in report["runs"][-1]["error"]
        assert repo_files() == before

        source = root / "dense"
        source.mkdir()
        for name in ["random", "zeros"]:
            with (source / name).open("xb") as file:
                for _ in range(64):
                    file.write(os.urandom(1024**2) if name == "random" else bytes(1024**2))
                file.flush()
                os.fsync(file.fileno())
        report["dense_source"] = {p.name: {"size": p.stat().st_size, "allocated": p.stat().st_blocks * 512} for p in source.iterdir()}
        run("128MiB-dense-backup", ["backup", "--strict", "--json", "--no-scan", "."], cwd=source)
        unchanged = run("128MiB-dense-unchanged", ["backup", "--strict", "--json", "--no-scan", "."], cwd=source)
        assert unchanged["summary"]["files_unmodified"] == 2
        assert unchanged["summary"]["data_added"] == 0
        report["limitations"] = [
            "Bounded local fixtures, not absolute worst-case memory or unique-index growth proof.",
            "No production data, credentials, project quotas, or lifecycle operations.",
            "Reference bounds use the test repository's default 512 KiB minimum chunk size.",
            "Native admission counts source metadata; serialized trees and index/process memory are separate costs.",
        ]
    with options.report.open("x") as file:
        report["status"] = "passed"
        json.dump(report, file, indent=2)
        file.write("\n")


if __name__ == "__main__":
    main()
