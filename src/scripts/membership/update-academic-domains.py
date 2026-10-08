#!/usr/bin/env python3
"""
Regenerate src/packages/server/membership/educator/academic-domains-data.ts
from a checkout of https://github.com/JetBrains/swot (MIT licensed).

    git clone --depth 1 https://github.com/JetBrains/swot.git /tmp/swot
    python3 src/scripts/membership/update-academic-domains.py /tmp/swot
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(
    HERE, "..", "..", "packages", "server", "membership", "educator",
    "academic-domains-data.ts")

HEADER = """/*
 * GENERATED FILE - do not edit. Regenerate with
 *   python3 src/scripts/membership/update-academic-domains.py <swot-checkout>
 *
 * Academic email domains from JetBrains/swot ({rev}),
 * https://github.com/JetBrains/swot
 * Copyright (c) 2013 Lee Reilly. MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */

// Newline-separated, lowercase lists.
"""


def read_list(domains_dir, name):
    with open(os.path.join(domains_dir, name)) as f:
        return sorted({
            line.strip().lower()
            for line in f
            if line.strip() and not line.startswith("#")
        })


def school_domains(domains_dir):
    # swot stores each school as lib/domains/<tld>/.../<name>.txt
    domains = set()
    for root, _, files in os.walk(domains_dir):
        if root == domains_dir:
            continue
        for name in files:
            if name.endswith(".txt"):
                rel = os.path.relpath(os.path.join(root, name[:-4]),
                                      domains_dir)
                domains.add(".".join(reversed(rel.split(os.sep))).lower())
    return sorted(domains)


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    swot = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) == 3 else DEFAULT_OUT
    domains_dir = os.path.join(swot, "lib", "domains")
    rev = subprocess.run(["git", "-C", swot, "rev-parse", "HEAD"],
                         capture_output=True,
                         text=True).stdout.strip() or "unknown revision"
    lists = {
        "ACADEMIC_TLDS": read_list(domains_dir, "tlds.txt"),
        "ACADEMIC_STOPLIST": read_list(domains_dir, "stoplist.txt"),
        "ACADEMIC_ABUSED": read_list(domains_dir, "abused.txt"),
        "ACADEMIC_DOMAINS": school_domains(domains_dir),
    }
    with open(out, "w") as f:
        f.write(HEADER.format(rev=rev))
        for name, items in lists.items():
            f.write(f"export const {name}: string = {json.dumps(chr(10).join(items))};\n")
    print({name: len(items) for name, items in lists.items()})


if __name__ == "__main__":
    main()
