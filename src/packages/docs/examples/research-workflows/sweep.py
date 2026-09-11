"""Checkpointed toy sweep; each completed case is a separate JSON file.

Run only one worker per output directory. Use a new directory if code or inputs
change. Checkpoints preserve completed cases, not a running Python process.
"""

import argparse
import json
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--stop", type=int, default=6)
    parser.add_argument("--delay", type=float, default=0.1)
    parser.add_argument("--fail-at", type=int)
    args = parser.parse_args()
    if args.stop < 1 or args.delay < 0:
        parser.error("--stop must be positive and --delay must be nonnegative")
    args.out.mkdir(parents=True, exist_ok=True)
    for case in range(args.stop):
        target = args.out / f"case-{case:03d}.json"
        expected = {"case": case, "square": case * case}
        if target.exists():
            if json.loads(target.read_text()) != expected:
                raise ValueError(f"Checkpoint does not match this experiment: {target}")
            print(f"skip case={case}", flush=True)
            continue
        if case == args.fail_at:
            raise RuntimeError(f"Intentional demonstration failure at case {case}")
        time.sleep(args.delay)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(expected) + "\n")
        temporary.replace(target)
        print(f"completed case={case}", flush=True)


if __name__ == "__main__":
    main()
