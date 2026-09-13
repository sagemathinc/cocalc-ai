"""Local scientific regression checks; no notebook, network, or deployment."""

import concurrent.futures
from contextlib import contextmanager
import csv
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import signal
import statistics
import subprocess
import sys
import time
import tracemalloc
import unittest
from unittest.mock import patch


ROOT = Path(__file__).parent
SCRIPT = ROOT / "scientific-prototype-v2-workflows.py"
TAG = f"{os.getpid()}"
os.umask(0o077)
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
spec = importlib.util.spec_from_file_location("scientific_workflows", SCRIPT)
workflow = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = workflow
spec.loader.exec_module(workflow)


def named(label):
    return ROOT / f"scientific-prototype-v2-test-{TAG}-{label}"


def make_csv(path, count):
    with path.open("x", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["sample_id", "group", "value"])
        for index in range(count):
            group_index = index % 3
            # Small deterministic measurements with a distinct group offset.
            value = group_index * 5 + ((index * 17) % 97 - 48) / 8
            writer.writerow([index, workflow.GROUPS[group_index], value])


def terminate_owned_group(process, grace_seconds=0.25):
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


def cancel_on_sigterm(signum, frame):
    # Let active owned-process contexts clean nested sessions before the outer
    # runner's TERM grace expires. An uncatchable SIGKILL cannot run cleanup.
    raise KeyboardInterrupt("scientific test suite received SIGTERM")


@contextmanager
def owned_process(command):
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    try:
        yield process
    except BaseException as original:
        try:
            errors = terminate_owned_group(process)
        except BaseException as cleanup_error:
            errors = [cleanup_error]
        if errors:
            diagnostics = tuple(f"{type(error).__name__}: {error}" for error in errors)
            try:
                original.owned_group_cleanup_errors = diagnostics
                if hasattr(original, "add_note"):
                    original.add_note("Owned process-group cleanup: " + "; ".join(diagnostics))
            except BaseException:
                pass
        raise
    else:
        errors = terminate_owned_group(process)
        if errors:
            raise RuntimeError("Owned process-group cleanup failed: " + "; ".join(str(error) for error in errors))


def run_cli(*arguments, expected=0):
    command = [sys.executable, str(SCRIPT), *map(str, arguments)]
    with owned_process(command) as process:
        stdout, stderr = process.communicate(timeout=15)
        result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    with named("commands.jsonl").open("a") as receipt:
        receipt.write(json.dumps({"command": command, "returncode": result.returncode,
                                  "stdout": result.stdout, "stderr": result.stderr}) + "\n")
    if result.returncode != expected:
        raise AssertionError(f"exit={result.returncode} expected={expected}\n{result.stdout}{result.stderr}")
    return result


def altered_run(source_prefix, target_prefix, alter):
    """Create a deliberately checksum-consistent invalid fixture, never edit source."""
    started = json.loads(workflow.path_for(source_prefix, "started.json").read_text())
    manifest = json.loads(workflow.path_for(source_prefix, "manifest.json").read_text())
    records = [json.loads(line) for line in workflow.path_for(source_prefix, "results.jsonl").read_text().splitlines()]
    alter(started, manifest, records)
    manifest["specification"] = started
    results_path = workflow.path_for(target_prefix, "results.jsonl")
    results_path.write_text("".join(json.dumps(record) + "\n" for record in records))
    manifest["results_sha256"] = workflow.digest_file(results_path)
    workflow.path_for(target_prefix, "started.json").write_text(json.dumps(started))
    workflow.path_for(target_prefix, "manifest.json").write_text(json.dumps(manifest))


class ScientificPrototypeTests(unittest.TestCase):
    def test_late_created_destinations_are_not_replaced(self):
        for suffix in ("results.jsonl", "manifest.json"):
            with self.subTest(destination=suffix):
                prefix = named("late-" + suffix)
                run = workflow.ResultRun(prefix, workflow.specification(
                    "group-statistics", workflow.GROUPS, workflow.STREAM_PARAMETERS))
                sentinel = workflow.path_for(prefix, suffix)
                try:
                    for group in workflow.GROUPS:
                        run.append({"id": group, "n": 2, "mean": 1.0, "sample_variance": 0.0})
                    sentinel.write_bytes(b"late-created sentinel\n")
                    with self.assertRaises(FileExistsError):
                        run.complete({"input_rows": 6, "input_sha256": "0" * 64})
                    self.assertEqual(sentinel.read_bytes(), b"late-created sentinel\n")
                    with self.assertRaises(ValueError):
                        workflow.verify(prefix)
                finally:
                    run.close()
        print("EXCLUSIVE_PUBLICATION late-created results and manifest sentinels preserved", flush=True)

    def test_verification_rejects_oversized_artifacts_before_parsing(self):
        source, original = named("bounded-verify.csv"), named("bounded-verify")
        make_csv(source, 12)
        run_cli("stream", "--input", source, "--out", original)
        for suffix in ("manifest.json", "started.json"):
            with self.subTest(metadata=suffix):
                prefix = named("oversized-" + suffix)
                altered_run(original, prefix, lambda *_: None)
                workflow.path_for(prefix, suffix).write_bytes(b" " * (workflow.MAX_METADATA_BYTES + 1))
                with self.assertRaisesRegex(ValueError, "metadata exceeds"):
                    workflow.verify(prefix)
        for label, raw, expected_count, error in (
            ("line", b" " * (workflow.MAX_RESULT_LINE_BYTES + 1), 3, "result record exceeds"),
            ("count", b"{}\n" * (workflow.MAX_RESULT_RECORDS + 1), 32, "too many result records"),
            ("declared-count", b"{}\n", 33, "result count must"),
        ):
            with self.subTest(results=label):
                prefix = named("oversized-" + label)
                altered_run(original, prefix, lambda *_: None)
                result_path = workflow.path_for(prefix, "results.jsonl")
                result_path.write_bytes(raw)
                manifest_path = workflow.path_for(prefix, "manifest.json")
                manifest = json.loads(manifest_path.read_text())
                manifest["result_count"] = expected_count
                manifest["results_sha256"] = hashlib.sha256(raw).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, error):
                    workflow.verify(prefix)
        print("BOUNDED_VERIFICATION oversized manifest, specification, line, actual count, declared count rejected", flush=True)

    def test_stream_matches_independent_statistics_and_input_hash(self):
        source, prefix = named("measurements.csv"), named("stream")
        make_csv(source, 12000)
        output = run_cli("stream", "--input", source, "--out", prefix)
        self.assertIn("verified complete: 3 results", output.stdout)
        actual = {result["id"]: result for result in workflow.verify(prefix)}
        expected = {group: [] for group in workflow.GROUPS}
        with source.open(newline="") as stream:
            for row in csv.DictReader(stream):
                expected[row["group"]].append(float(row["value"]))
        for group, values in expected.items():
            self.assertEqual(actual[group]["n"], len(values))
            self.assertAlmostEqual(actual[group]["mean"], statistics.mean(values), places=12)
            self.assertAlmostEqual(actual[group]["sample_variance"], statistics.variance(values), places=11)
        manifest = json.loads(workflow.path_for(prefix, "manifest.json").read_text())
        self.assertEqual(manifest["evidence"]["input_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(manifest["evidence"]["input_rows"], 12000)
        result = run_cli("stream", "--input", source, "--out", prefix, expected=1)
        self.assertIn("output prefix already used", result.stderr)
        print("STREAM_REFERENCE rows=12000 groups=3 independent statistics.mean/variance match; fresh-prefix refusal PASS", flush=True)

    def test_stream_high_offset_low_spread_matches_independent_reference(self):
        source, prefix = named("high-offset.csv"), named("high-offset")
        cases = {
            "control": [1e100, math.nextafter(1e100, 0), math.nextafter(1e100, 0)],
            "low": [1e12, math.nextafter(1e12, 0), math.nextafter(1e12, 0)],
            "high": [1.0, math.nextafter(1.0, 0), math.nextafter(1.0, 0)],
        }
        with source.open("x", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["sample_id", "group", "value"])
            for index, (group, value) in enumerate((group, value) for group, values in cases.items() for value in values):
                writer.writerow([index, group, value])
        run_cli("stream", "--input", source, "--out", prefix)
        actual = {record["id"]: record for record in workflow.verify(prefix)}
        for group, values in cases.items():
            reference = statistics.variance(values)
            self.assertGreater(reference, 0)
            self.assertTrue(math.isclose(actual[group]["sample_variance"], reference, rel_tol=1e-12), (group, actual[group], reference))
            self.assertTrue(math.isclose(actual[group]["mean"], statistics.mean(values), rel_tol=1e-15))
        print("CENTERED_VARIANCE offsets=1e100,1e12,1 with adjacent-float spreads; independent statistics.variance relative tolerance=1e-12 PASS", flush=True)

    def test_stream_rejects_checksum_consistent_bad_schema_and_provenance(self):
        source, baseline = named("schema-stream.csv"), named("schema-stream-baseline")
        make_csv(source, 60)
        run_cli("stream", "--input", source, "--out", baseline)
        changes = {
            "id-only": lambda s, m, r: r.__setitem__(slice(None), [{"id": row["id"]} for row in r]),
            "missing-mean": lambda s, m, r: r[0].pop("mean"),
            "extra-field": lambda s, m, r: r[0].update(extra="unexpected"),
            "bool-count": lambda s, m, r: r[0].update(n=True),
            "float-count": lambda s, m, r: r[0].update(n=20.0),
            "short-count": lambda s, m, r: r[0].update(n=1),
            "nan-mean": lambda s, m, r: r[0].update(mean=float("nan")),
            "bool-mean": lambda s, m, r: r[0].update(mean=True),
            "huge-mean": lambda s, m, r: r[0].update(mean=10**1000),
            "negative-variance": lambda s, m, r: r[0].update(sample_variance=-1),
            "infinite-variance": lambda s, m, r: r[0].update(sample_variance=float("inf")),
            "bool-variance": lambda s, m, r: r[0].update(sample_variance=False),
            "row-total": lambda s, m, r: m["evidence"].update(input_rows=61),
            "bool-rows": lambda s, m, r: m["evidence"].update(input_rows=True),
            "input-hash": lambda s, m, r: m["evidence"].update(input_sha256="not-a-hash"),
            "code-hash": lambda s, m, r: s.update(script_sha256=123),
            "python-version": lambda s, m, r: s.update(python=""),
            "format": lambda s, m, r: s.update(format=999),
            "bool-format": lambda s, m, r: s.update(format=True),
            "workflow": lambda s, m, r: s.update(workflow="unknown"),
            "expected-ids": lambda s, m, r: s.update(expected_ids=["control", "low"]),
            "float-result-count": lambda s, m, r: m.update(result_count=3.0),
        }
        for label, alter in changes.items():
            with self.subTest(label=label):
                prefix = named(f"invalid-stream-{label}")
                altered_run(baseline, prefix, alter)
                result = run_cli("verify", "--out", prefix, expected=1)
                self.assertTrue(result.stderr.startswith("failed:"), result.stderr)
        print(f"STREAM_SCHEMA checksum-consistent invalid fixtures rejected={len(changes)}; scientific fields/count/provenance enforced", flush=True)

    def test_sweep_rejects_checksum_consistent_bad_schema_and_provenance(self):
        source, baseline = named("schema-rates.json"), named("schema-sweep-baseline")
        source.write_text("[0,1,2]")
        run_cli("parallel", "--rates", source, "--out", baseline, "--workers", 1, "--intervals", 100)
        changes = {
            "id-only": lambda s, m, r: r.__setitem__(slice(None), [{"id": row["id"]} for row in r]),
            "missing-integral": lambda s, m, r: r[0].pop("integral"),
            "wrong-rate": lambda s, m, r: r[0].update(rate=9),
            "bool-rate": lambda s, m, r: r[0].update(rate=False),
            "wrong-intervals": lambda s, m, r: r[0].update(intervals=101),
            "bool-intervals": lambda s, m, r: r[0].update(intervals=True),
            "float-intervals": lambda s, m, r: r[0].update(intervals=100.0),
            "nan-integral": lambda s, m, r: r[0].update(integral=float("nan")),
            "bool-integral": lambda s, m, r: r[0].update(integral=True),
            "negative-integral": lambda s, m, r: r[0].update(integral=-1),
            "large-integral": lambda s, m, r: r[0].update(integral=2),
            "submitted-count": lambda s, m, r: m["evidence"].update(submitted_cases=2),
            "bool-submitted-count": lambda s, m, r: m["evidence"].update(submitted_cases=True),
            "input-hash": lambda s, m, r: s["parameters"].update(input_sha256="bad"),
            "parameters-rate-map": lambda s, m, r: s["parameters"].update(rates=[0,1,3]),
            "parameters-duplicate-rates": lambda s, m, r: s["parameters"].update(rates=[0,0,2]),
            "parameters-intervals": lambda s, m, r: s["parameters"].update(intervals=200),
            "bool-workers": lambda s, m, r: s["parameters"].update(workers=True),
            "method": lambda s, m, r: s["parameters"].update(method="different method"),
            "extra-expected-id": lambda s, m, r: s["expected_ids"].append("rate-003"),
        }
        for label, alter in changes.items():
            with self.subTest(label=label):
                prefix = named(f"invalid-sweep-{label}")
                altered_run(baseline, prefix, alter)
                result = run_cli("verify", "--out", prefix, expected=1)
                self.assertTrue(result.stderr.startswith("failed:"), result.stderr)
        print(f"SWEEP_SCHEMA checksum-consistent invalid fixtures rejected={len(changes)}; parameter agreement and finite-domain result enforced", flush=True)

    def test_invalid_worker_records_cannot_publish_completion(self):
        prefix = named("invalid-worker-records")
        run = workflow.ResultRun(prefix, workflow.specification("group-statistics", workflow.GROUPS, workflow.STREAM_PARAMETERS))
        try:
            for group in workflow.GROUPS:
                run.append({"id": group})
            with self.assertRaisesRegex(ValueError, "streaming result fields"):
                run.complete({"input_sha256": "0" * 64, "input_rows": 6})
        finally:
            run.close()
        self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
        self.assertTrue(workflow.path_for(prefix, "partial.jsonl").exists())
        print("MANIFEST_PUBLICATION malformed ID-only records rejected before publishing completion", flush=True)

    def test_stream_memory_does_not_scale_with_row_count(self):
        peaks = []
        for count in (6000, 60000):
            source, prefix = named(f"memory-{count}.csv"), named(f"memory-{count}")
            make_csv(source, count)  # Fixture creation is deliberately outside tracing.
            tracemalloc.start()
            workflow.stream_statistics(source, prefix)
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            peaks.append(peak)
        self.assertLess(max(peaks), 2 * 1024 * 1024)
        self.assertLess(peaks[1], peaks[0] + 256 * 1024)
        print(f"STREAM_MEMORY traced_python_peak_bytes rows6000={peaks[0]} rows60000={peaks[1]}; excludes OS buffers/interpreter/fixture generation", flush=True)

    def test_corrupt_csv_is_rejected_without_completion(self):
        corrupt_records = {
            "nan": "0,control,nan\n",
            "infinity": "0,control,inf\n",
            "magnitude": "0,control,1e101\n",
            "unknown-group": "0,other,1\n",
            "wrong-id": "1,control,1\n",
            "extra-column": "0,control,1,extra\n",
            "non-numeric": "0,control,broken\n",
            "oversized": "0,control," + "9" * 513 + "\n",
            "quoted-newline": '0,control,"1\n2"\n',
            "too-few": "0,control,1\n",
        }
        for label, record in corrupt_records.items():
            with self.subTest(label=label):
                source, prefix = named(f"bad-{label}.csv"), named(f"bad-{label}")
                source.write_text("sample_id,group,value\n" + record)
                rejection = run_cli("stream", "--input", source, "--out", prefix, expected=1)
                self.assertTrue(rejection.stderr.startswith("failed:"), rejection.stderr)
                self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
                self.assertIn("incomplete run", run_cli("verify", "--out", prefix, expected=1).stderr)
        print(f"CORRUPT_CSV rejected={len(corrupt_records)}; no completion manifests", flush=True)

    def test_parallel_matches_independent_serial_and_closed_form(self):
        source = named("rates.json")
        rates, intervals = [0, 0.125, 0.5, 1, 2, 4, 8, 16], 20000
        source.write_text(json.dumps(rates))
        outputs = []
        for workers in (1, 2):
            prefix = named(f"parallel-{workers}")
            result = run_cli("parallel", "--rates", source, "--out", prefix, "--workers", workers, "--intervals", intervals)
            self.assertEqual(result.stdout.count("completed rate-"), len(rates))
            actual = {record["id"]: record for record in workflow.verify(prefix)}
            for index, rate in enumerate(rates):
                record = actual[f"rate-{index:03d}"]
                # Independent summation order with an ordinary loop, not integrate().
                total = 0.0
                for cell in reversed(range(intervals)):
                    total += math.exp(-rate * (cell + 0.5) / intervals)
                self.assertAlmostEqual(record["integral"], total / intervals, places=12)
                closed_form = 1.0 if rate == 0 else -math.expm1(-rate) / rate
                self.assertLessEqual(abs(record["integral"] - closed_form), rate * rate / (24 * intervals * intervals) + 1e-14)
            outputs.append(actual)
        self.assertEqual(outputs[0], outputs[1])
        print("PARALLEL_REFERENCE cases=8 intervals=20000 workers=1,2; identical records; independent serial and analytic error-bound checks PASS", flush=True)

    def test_corrupt_rates_and_resource_arguments_are_rejected(self):
        for label, text in {
            "nan": "[NaN]", "boolean": "[true]", "duplicate": "[1,1]",
            "negative": "[-1]", "too-large": "[101]", "empty": "[]",
            "too-many": json.dumps(list(range(33))), "oversized": " " * 4097,
            "huge-integer": "[" + "9" * 1000 + "]",
        }.items():
            with self.subTest(label=label):
                source, prefix = named(f"rates-bad-{label}.json"), named(f"rates-bad-{label}")
                source.write_text(text)
                rejection = run_cli("parallel", "--rates", source, "--out", prefix, expected=1)
                self.assertTrue(rejection.stderr.startswith("failed:"), rejection.stderr)
                self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
        source = named("rates-limits.json")
        source.write_text("[1,2]")
        for flag, value in [("--workers", 0), ("--workers", 5), ("--intervals", 9), ("--intervals", 500001)]:
            run_cli("parallel", "--rates", source, "--out", named(f"limit-{flag[2:]}-{value}"), flag, value, expected=1)
        print("CORRUPT_PARAMETERS rejected=9; resource-argument limits rejected=4", flush=True)

    def test_worker_failure_prevents_completion_and_queue_is_bounded(self):
        source, prefix = named("rates-failure.json"), named("worker-failure")
        source.write_text("[0,1,2,3,4,5]")
        submitted = []

        class FailingPool:
            def __init__(self, *, max_workers, mp_context):
                self.workers = max_workers

            def __enter__(self):
                return self

            def __exit__(self, *arguments):
                return False

            def submit(self, function, job):
                submitted.append(job)
                result = concurrent.futures.Future()
                result.set_exception(RuntimeError("synthetic worker exception"))
                return result

        with patch.object(workflow, "ProcessPoolExecutor", FailingPool):
            with self.assertRaisesRegex(RuntimeError, "synthetic worker exception"):
                workflow.parallel_integrals(source, prefix, 2, 10)
        self.assertEqual(len(submitted), 2)
        self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
        with self.assertRaisesRegex(ValueError, "incomplete run"):
            workflow.verify(prefix)
        print("WORKER_FAILURE synthetic executor: exception propagated; only 2 initial submissions; no completion manifest", flush=True)

    def test_real_process_interruption_leaves_detectable_partial_results(self):
        # Intercept only the coordinator's notification after append has fsynced
        # its first result. The calculation file and spawned workers are unchanged.
        wrapper = named("interrupt-wrapper.py")
        wrapper.write_text(r"""import builtins
from pathlib import Path
import runpy
import sys
import time

if __name__ == "__main__":
    script, marker = sys.argv[1:3]
    sys.argv = [script, *sys.argv[3:]]
    original_print = builtins.print
    paused = False
    def pause_after_first_result(*args, **kwargs):
        global paused
        original_print(*args, **kwargs)
        if not paused and args and str(args[0]).startswith("completed "):
            paused = True
            Path(marker).write_text("waiting\n")
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                time.sleep(0.02)
            raise RuntimeError("test-only interruption barrier timed out")
    builtins.print = pause_after_first_result
    try:
        runpy.run_path(script, run_name="__main__")
    finally:
        builtins.print = original_print
""")
        # A delayed parent used to read a buffered line after all cases finished.
        # At this test-only barrier the coordinator cannot append a second result.
        for parent_delay in (0, 1):
            with self.subTest(parent_delay=parent_delay):
                source = named(f"rates-interrupt-{parent_delay}.json")
                prefix = named(f"interrupted-{parent_delay}")
                marker = named(f"interrupt-ready-{parent_delay}")
                source.write_text(json.dumps([0.25 * index for index in range(16)]))
                command = [sys.executable, str(wrapper), str(SCRIPT), str(marker), "parallel", "--rates", str(source), "--out", str(prefix), "--workers", "2", "--intervals", "500000"]
                with owned_process(command) as process:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if marker.exists() and marker.read_text() == "waiting\n":
                            break
                        if process.poll() is not None:
                            stdout, stderr = process.communicate(timeout=1)
                            self.fail(f"child exited before the interruption barrier: {stdout} {stderr}")
                        time.sleep(0.01)
                    else:
                        self.fail("no durable first-result barrier within 10 seconds")
                    time.sleep(parent_delay)
                    self.assertIsNone(process.poll(), "coordinator left the interruption barrier")
                    partial = workflow.path_for(prefix, "partial.jsonl")
                    self.assertEqual(len(partial.read_text().splitlines()), 1)
                    self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
                    process.send_signal(signal.SIGINT)
                    stdout, stderr = process.communicate(timeout=10)
                    with named("commands.jsonl").open("a") as receipt:
                        receipt.write(json.dumps({"command": command, "signal_sent": "SIGINT at test-only barrier after first durable result",
                                                  "parent_delay_seconds": parent_delay, "returncode": process.returncode,
                                                  "stdout": stdout, "stderr": stderr}) + "\n")
                    self.assertEqual(process.returncode, 130, stderr)
                    self.assertIn("interrupted", stderr)
                    records = [json.loads(line) for line in partial.read_text().splitlines()]
                    self.assertEqual(len(records), 1)
                    self.assertFalse(workflow.path_for(prefix, "manifest.json").exists())
                    self.assertIn("incomplete run", run_cli("verify", "--out", prefix, expected=1).stderr)
                    print(f"REAL_SIGINT barrier=first-durable-result parent_delay={parent_delay}s exit=130 partial_records=1/16; completion verification rejected", flush=True)

        # A coordinator can exit while a stalled worker still owns stdout/stderr.
        # Exercise that exact pipe-lifetime case in a separate owned session.
        with self.subTest(stalled_descendant=True):
            marker = named("stalled-worker-ready")
            worker_code = """import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
time.sleep(60)
"""
            coordinator_code = "import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', " + repr(worker_code) + ", sys.argv[1]])\ntime.sleep(60)"
            command = [sys.executable, "-c", coordinator_code, str(marker)]
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                with owned_process(command) as process:
                    deadline = time.monotonic() + 5
                    while not marker.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(marker.exists(), "stalled worker was not ready")
                    process.communicate(timeout=0.05)
            self.assertFalse(hasattr(caught.exception, "owned_group_cleanup_errors"))
            self.assertEqual(process.returncode, -signal.SIGTERM)
            # EOF from the inherited pipes proves the resistant worker exited;
            # the context has also reaped the coordinator, with bounded waits.
            print("STALLED_WORKER timeout preserved; owned group terminated; coordinator reaped and inherited pipes closed", flush=True)

    def test_corrupted_and_missing_results_do_not_verify(self):
        source = named("integrity.csv")
        make_csv(source, 60)
        for label in ("checksum", "missing-record"):
            prefix = named(label)
            run_cli("stream", "--input", source, "--out", prefix)
            result_path = workflow.path_for(prefix, "results.jsonl")
            lines = result_path.read_text().splitlines()
            result_path.write_text("\n".join(lines[:-1]) + "\n")
            if label == "missing-record":
                # A checksum alone is insufficient: even recomputed checksums must
                # not hide an omitted expected result.
                manifest_path = workflow.path_for(prefix, "manifest.json")
                manifest = json.loads(manifest_path.read_text())
                manifest["results_sha256"] = workflow.digest_file(result_path)
                manifest_path.write_text(json.dumps(manifest))
            error = "checksum" if label == "checksum" else "missing, duplicate, or unexpected"
            self.assertIn(error, run_cli("verify", "--out", prefix, expected=1).stderr)
        print("RESULT_INTEGRITY damaged checksum and missing expected result rejected", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel_on_sigterm)
    print(f"LOCAL_TEST_ENV python={sys.version.split()[0]} platform={sys.platform}; RLIMIT_CPU=20 seconds per process; max actually used workers=2", flush=True)
    unittest.main(verbosity=2)
