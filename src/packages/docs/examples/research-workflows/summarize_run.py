"""Verify a completed toy sweep: python3 summarize_run.py runs/demo --stop 6."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--stop", type=int, default=6)
    args = parser.parse_args()
    if args.stop < 1:
        parser.error("--stop must be positive")
    expected_names = {f"case-{case:03d}.json" for case in range(args.stop)}
    actual_names = {p.name for p in args.directory.glob("case-*.json")}
    if actual_names != expected_names:
        raise ValueError("Incomplete or unexpected cases; inspect the run directory")
    total = 0
    for case in range(args.stop):
        data = json.loads((args.directory / f"case-{case:03d}.json").read_text())
        if data != {"case": case, "square": case * case}:
            raise ValueError(f"Unexpected result for case {case}")
        total += data["square"]
    print(f"completed={args.stop} sum_of_squares={total}")


if __name__ == "__main__":
    main()
