"""Analyze the example CSV: python3 analyze.py measurements.csv result.json."""

import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
from statistics import mean


def analyze(source):
    raw = Path(source).read_bytes()
    rows = csv.DictReader(io.StringIO(raw.decode("utf-8")))
    if rows.fieldnames != ["value"]:
        raise ValueError("Expected one column named value")
    values = [float(row["value"]) for row in rows]
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError("The input must contain at least one finite measurement")
    return {
        "count": len(values),
        "mean": mean(values),
        "input_sha256": hashlib.sha256(raw).hexdigest(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = analyze(args.input)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"count={result['count']} mean={result['mean']:.1f}")
