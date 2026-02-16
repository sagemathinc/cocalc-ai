#!/usr/bin/env python3
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--testing", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    data = Path(args.testing).read_text()
    Path(args.out).write_text(data)
    print(f"promoted {args.testing} -> {args.out}")


if __name__ == "__main__":
    main()
