"""Standard-library examples for the CoCalc research workflow guides.

Use a fresh output prefix per run. A completed result requires `verify` to pass.
These examples do not resume running processes or promise a speedup.
"""

import argparse
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
import csv
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import sys


GROUPS = ("control", "low", "high")
SUFFIXES = ("started.json", "partial.jsonl", "results.jsonl", "manifest.json")
MAX_METADATA_BYTES = 16384
MAX_RESULT_LINE_BYTES = 2048
MAX_RESULT_RECORDS = 32
STREAM_PARAMETERS = {
    "header": ["sample_id", "group", "value"], "maximum_line_bytes": 512,
    "variance": "sample, denominator n-1",
}


def path_for(prefix, suffix):
    return Path(f"{prefix}.{suffix}")


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sync_directory(path):
    # Exercise this on the target filesystem; fsync is not a remote backup.
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save_json_exclusive(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def publish_exclusive(source, destination):
    """Publish a complete file without replacing a late-created destination.

    Both paths are in the same output directory. A filesystem that cannot hard
    link fails visibly; do not fall back to an operation that replaces files.
    """
    os.link(source, destination)
    Path(source).unlink()


def read_json_bounded(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_METADATA_BYTES + 1)
    if len(raw) > MAX_METADATA_BYTES:
        raise ValueError("metadata exceeds 16384 bytes")
    return json.loads(raw)


def finite_number(value):
    if type(value) not in (int, float):  # JSON booleans are not measurements.
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def sha256_text(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def require_fields(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError(f"invalid {label} fields")


def validate_rates(rates):
    if (not isinstance(rates, list) or not 1 <= len(rates) <= 32
            or any(not finite_number(rate) or not 0 <= rate <= 100 for rate in rates)
            or len(set(rates)) != len(rates)):
        raise ValueError("expected 1..32 distinct finite rates in [0,100]")


def validate_results(started, evidence, records):
    """Check schema and run consistency; do not recompute or authenticate science."""
    require_fields(started, "format workflow expected_ids parameters script_sha256 python", "specification")
    if (type(started["format"]) is not int or started["format"] != 2
            or not sha256_text(started["script_sha256"])
            or not isinstance(started["python"], str) or not started["python"].strip()):
        raise ValueError("invalid specification version or code provenance")
    parameters = started["parameters"]
    if started["workflow"] == "group-statistics":
        if parameters != STREAM_PARAMETERS or started["expected_ids"] != list(GROUPS):
            raise ValueError("invalid streaming parameters or expected ids")
        require_fields(evidence, "input_sha256 input_rows", "streaming evidence")
        if (not sha256_text(evidence["input_sha256"]) or type(evidence["input_rows"]) is not int
                or evidence["input_rows"] < 2 * len(GROUPS)):
            raise ValueError("invalid streaming input provenance")
        for record in records:
            require_fields(record, "id n mean sample_variance", "streaming result")
            if (not isinstance(record["id"], str) or type(record["n"]) is not int or record["n"] < 2
                    or not finite_number(record["mean"]) or abs(record["mean"]) > 1e100
                    or not finite_number(record["sample_variance"]) or record["sample_variance"] < 0):
                raise ValueError("invalid streaming count, mean, or variance")
    elif started["workflow"] == "decay-integrals":
        require_fields(parameters, "rates intervals workers method input_sha256", "sweep parameters")
        validate_rates(parameters["rates"])
        if (type(parameters["workers"]) is not int or not 1 <= parameters["workers"] <= 4
                or type(parameters["intervals"]) is not int or not 10 <= parameters["intervals"] <= 500000
                or parameters["method"] != "composite midpoint on [0,1]"
                or not sha256_text(parameters["input_sha256"])):
            raise ValueError("invalid sweep settings or input provenance")
        expected_rates = {f"rate-{index:03d}": rate for index, rate in enumerate(parameters["rates"])}
        if started["expected_ids"] != list(expected_rates):
            raise ValueError("sweep ids do not match the parameter list")
        require_fields(evidence, "submitted_cases", "sweep evidence")
        if type(evidence["submitted_cases"]) is not int or evidence["submitted_cases"] != len(expected_rates):
            raise ValueError("submitted case count does not match the parameter list")
        for record in records:
            require_fields(record, "id rate intervals integral", "sweep result")
            if (not isinstance(record["id"], str) or record["id"] not in expected_rates
                    or not finite_number(record["rate"]) or record["rate"] != expected_rates[record["id"]]
                    or type(record["intervals"]) is not int or record["intervals"] != parameters["intervals"]
                    or not finite_number(record["integral"]) or not 0 < record["integral"] <= 1):
                raise ValueError("invalid sweep result or mismatched rate/intervals")
    else:
        raise ValueError("unknown workflow")
    identifiers = [record["id"] for record in records]
    if len(identifiers) != len(set(identifiers)) or set(identifiers) != set(started["expected_ids"]):
        raise ValueError("missing, duplicate, or unexpected results")
    if started["workflow"] == "group-statistics" and sum(record["n"] for record in records) != evidence["input_rows"]:
        raise ValueError("group counts do not add up to the recorded input rows")


class ResultRun:
    """One coordinator owns the output; only a final manifest means complete."""

    def __init__(self, prefix, specification):
        self.prefix = Path(prefix)
        self.specification = specification
        for suffix in (*SUFFIXES, "manifest.tmp"):
            if path_for(prefix, suffix).exists():
                raise ValueError("output prefix already used; choose a fresh prefix")
        save_json_exclusive(path_for(prefix, "started.json"), specification)
        sync_directory(self.prefix.parent)
        self.ids = set()
        self.records = []  # At most three groups or 32 parameter cases.
        self.stream = path_for(prefix, "partial.jsonl").open("x", encoding="utf-8")

    def append(self, result):
        identifier = result["id"]
        if identifier not in self.specification["expected_ids"] or identifier in self.ids:
            raise ValueError("unexpected or duplicate result id")
        self.stream.write(json.dumps(result, sort_keys=True, allow_nan=False) + "\n")
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.ids.add(identifier)
        self.records.append(result)

    def complete(self, evidence):
        validate_results(self.specification, evidence, self.records)
        if self.ids != set(self.specification["expected_ids"]):
            raise ValueError("missing results; run cannot be marked complete")
        self.stream.close()
        result_path = path_for(self.prefix, "results.jsonl")
        publish_exclusive(path_for(self.prefix, "partial.jsonl"), result_path)
        sync_directory(self.prefix.parent)
        manifest = {
            "status": "complete",
            "specification": self.specification,
            "evidence": evidence,
            "result_count": len(self.ids),
            "results_sha256": digest_file(result_path),
        }
        temporary = path_for(self.prefix, "manifest.tmp")
        save_json_exclusive(temporary, manifest)
        publish_exclusive(temporary, path_for(self.prefix, "manifest.json"))
        sync_directory(self.prefix.parent)

    def close(self):
        self.stream.close()


def verify(prefix):
    manifest_path = path_for(prefix, "manifest.json")
    if not manifest_path.is_file():
        raise ValueError("incomplete run: no completion manifest")
    manifest = read_json_bounded(manifest_path)
    started = read_json_bounded(path_for(prefix, "started.json"))
    require_fields(manifest, "status specification evidence result_count results_sha256", "manifest")
    if manifest["status"] != "complete" or manifest["specification"] != started:
        raise ValueError("manifest does not match the started run")
    result_path = path_for(prefix, "results.jsonl")
    if (type(manifest["result_count"]) is not int
            or not 1 <= manifest["result_count"] <= MAX_RESULT_RECORDS):
        raise ValueError("result count must be 1..32")
    if not sha256_text(manifest["results_sha256"]):
        raise ValueError("result checksum mismatch")
    records = []
    digest = hashlib.sha256()
    with result_path.open("rb") as stream:
        while raw := stream.readline(MAX_RESULT_LINE_BYTES + 1):
            if len(raw) > MAX_RESULT_LINE_BYTES:
                raise ValueError("result record exceeds 2048 bytes")
            if len(records) >= manifest["result_count"]:
                raise ValueError("too many result records")
            digest.update(raw)
            records.append(json.loads(raw))
    if digest.hexdigest() != manifest["results_sha256"]:
        raise ValueError("result checksum mismatch")
    validate_results(started, manifest["evidence"], records)
    if type(manifest["result_count"]) is not int or len(records) != manifest["result_count"]:
        raise ValueError("missing, duplicate, or unexpected results")
    return records


def specification(workflow, expected_ids, parameters):
    return {
        "format": 2,
        "workflow": workflow,
        "expected_ids": list(expected_ids),
        "parameters": parameters,
        "script_sha256": digest_file(__file__),
        "python": sys.version.split()[0],
    }


def stream_statistics(input_path, prefix):
    """Centered Welford mean/variance; fixed groups and <=512 bytes per CSV line."""
    run = ResultRun(prefix, specification("group-statistics", GROUPS, STREAM_PARAMETERS))
    states = {group: [0, 0.0, 0.0, 0.0] for group in GROUPS}
    digest = hashlib.sha256()
    rows = 0
    try:
        with Path(input_path).open("rb") as source:
            header = source.readline(513)
            if header not in (b"sample_id,group,value\n", b"sample_id,group,value\r\n"):
                raise ValueError("expected CSV header sample_id,group,value")
            digest.update(header)
            while raw := source.readline(513):
                if len(raw) > 512:
                    raise ValueError("CSV record exceeds 512 bytes")
                digest.update(raw)
                fields = next(csv.reader([raw.decode("utf-8")], strict=True))
                if len(fields) != 3:
                    raise ValueError("each record must contain exactly three columns")
                sample_id, group, text = fields
                value = float(text)
                if sample_id != str(rows) or group not in states or not math.isfinite(value):
                    raise ValueError("invalid sample id, group, or non-finite value")
                if abs(value) > 1e100:
                    raise ValueError("value magnitude exceeds this example's numerical range")
                count, origin, mean_offset, m2 = states[group]
                if count == 0:
                    origin = value
                # Preserve small spreads around a large offset by updating the
                # differences from the group's first observation.
                centered = value - origin
                count += 1
                delta = centered - mean_offset
                mean_offset += delta / count
                m2 += delta * (centered - mean_offset)
                states[group] = [count, origin, mean_offset, m2]
                rows += 1
        for group, (count, origin, mean_offset, m2) in states.items():
            if count < 2:
                raise ValueError("every group needs at least two observations")
            run.append({"id": group, "n": count, "mean": origin + mean_offset, "sample_variance": m2 / (count - 1)})
        run.complete({"input_sha256": digest.hexdigest(), "input_rows": rows})
    finally:
        run.close()
    return verify(prefix)


def integrate(job):
    """Midpoint quadrature of exp(-rate*x) on [0,1], with a distinct rate per case."""
    identifier, rate, intervals = job
    value = math.fsum(math.exp(-rate * (i + 0.5) / intervals) for i in range(intervals)) / intervals
    return {"id": identifier, "rate": rate, "intervals": intervals, "integral": value}


def parallel_integrals(rates_path, prefix, workers, intervals):
    if type(workers) is not int or not 1 <= workers <= 4 or type(intervals) is not int or not 10 <= intervals <= 500000:
        raise ValueError("workers must be 1..4; intervals must be 10..500000")
    # Bound the parameter file, job count, and in-flight tasks independently.
    with Path(rates_path).open("rb") as source:
        raw = source.read(4097)
    if len(raw) > 4096:
        raise ValueError("parameter file exceeds 4096 bytes")
    rates = json.loads(raw)
    validate_rates(rates)
    jobs = [(f"rate-{index:03d}", rate, intervals) for index, rate in enumerate(rates)]
    run = ResultRun(prefix, specification("decay-integrals", [job[0] for job in jobs], {
        "rates": rates, "intervals": intervals, "workers": workers,
        "method": "composite midpoint on [0,1]", "input_sha256": hashlib.sha256(raw).hexdigest(),
    }))
    print("started bounded CPU sweep", flush=True)
    try:
        # Spawn works without inheriting a notebook/kernel process. CLI entry point only.
        with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) as pool:
            iterator = iter(jobs)
            pending = {pool.submit(integrate, job) for job in [next(iterator) for _ in range(min(workers, len(jobs)))]}
            while pending:
                completed, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    result = future.result()  # A worker error prevents a completion manifest.
                    run.append(result)       # Workers never write shared artifacts.
                    print(f"completed {result['id']}", flush=True)
                    job = next(iterator, None)
                    if job is not None:
                        pending.add(pool.submit(integrate, job))
        run.complete({"submitted_cases": len(jobs)})
    finally:
        run.close()
    return verify(prefix)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    streaming = subcommands.add_parser("stream")
    streaming.add_argument("--input", type=Path, required=True)
    streaming.add_argument("--out", type=Path, required=True)
    parallel = subcommands.add_parser("parallel")
    parallel.add_argument("--rates", type=Path, required=True)
    parallel.add_argument("--out", type=Path, required=True)
    parallel.add_argument("--workers", type=int, default=2)
    parallel.add_argument("--intervals", type=int, default=20000)
    verifier = subcommands.add_parser("verify")
    verifier.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.command == "stream":
            records = stream_statistics(arguments.input, arguments.out)
        elif arguments.command == "parallel":
            records = parallel_integrals(arguments.rates, arguments.out, arguments.workers, arguments.intervals)
        else:
            records = verify(arguments.out)
        print(f"verified complete: {len(records)} results", flush=True)
    except KeyboardInterrupt:
        print("interrupted: completion must be checked with verify", file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, TypeError, csv.Error) as error:
        print(f"failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
