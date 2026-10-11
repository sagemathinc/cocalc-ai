#!/usr/bin/env python3
"""
Is the bundled Chrome (install-chromium.sh's CHROME_VERSION) behind Chrome
for Testing's Stable channel?  Exit 1 if so, printing both versions: run it
as part of a release, and update install-chromium.sh when it fails.
"""

import json
import pathlib
import re
import sys
import urllib.request

URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json"
script = pathlib.Path(__file__).with_name("install-chromium.sh").read_text()
pinned = re.search(r'^CHROME_VERSION="([0-9.]+)"', script, re.M).group(1)
with urllib.request.urlopen(URL, timeout=60) as response:
    stable = json.load(response)["channels"]["Stable"]["version"]
key = lambda v: tuple(int(x) for x in v.split("."))
print(f"bundled {pinned}, Chrome for Testing Stable {stable}")
sys.exit(1 if key(pinned) < key(stable) else 0)
