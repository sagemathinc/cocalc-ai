#!/usr/bin/env python3
"""
Regenerate chromium-libs.lock: the exact Ubuntu 20.04 (focal) .deb files that
install-chromium.sh bundles with the headless Chromium, and their SHA256.

The build trusts only the lock file (immutable, reproducible inputs).  This
script, run by hand when the libraries need to change, trusts a package index
only after verifying Ubuntu's signed InRelease with gpgv against the Ubuntu
archive key, and checking each Packages.xz against the hash InRelease lists.

Usage (needs gpgv, dpkg and the ubuntu-keyring package):
    ./pin-chromium-libs.py > chromium-libs.lock
"""

import hashlib
import lzma
import os
import subprocess
import sys
import tempfile
import urllib.request

MIRRORS = {
    "amd64": "https://archive.ubuntu.com/ubuntu",
    "arm64": "https://ports.ubuntu.com/ubuntu-ports",
}
SUITE = "focal"
POCKETS = [SUITE, f"{SUITE}-updates", f"{SUITE}-security"]
COMPONENTS = ["main", "universe"]
KEYRING = os.environ.get("KEYRING", "/usr/share/keyrings/ubuntu-archive-keyring.gpg")

# Every library the browser needs beyond glibc/libgcc (install-chromium.sh
# checks that nothing is missing).
PACKAGES = """
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libblkid1 libbsd0
  libdbus-1-3 libdrm2 libexpat1 libffi7 libgbm1 libgcrypt20 libglib2.0-0
  libgpg-error0 liblz4-1 liblzma5 libmount1 libnspr4 libnss3 libpcre2-8-0
  libpcre3 libselinux1 libsqlite3-0 libsystemd0 libudev1 libwayland-server0 libx11-6
  libxau6 libxcb-randr0 libxcb1 libxcomposite1 libxdamage1 libxdmcp6 libxext6
  libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libzstd1
""".split()


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def verified_index_hashes(mirror: str, pocket: str) -> dict:
    """SHA256 of each index file, from the InRelease verified with gpgv."""
    signed = fetch(f"{mirror}/dists/{pocket}/InRelease")
    with tempfile.NamedTemporaryFile() as f:
        f.write(signed)
        f.flush()
        content = subprocess.run(
            ["gpgv", "--keyring", KEYRING, "--output", "-", f.name],
            capture_output=True,
            check=True,
        ).stdout.decode()
    hashes, in_sha256 = {}, False
    for line in content.splitlines():
        if line.startswith("SHA256:"):
            in_sha256 = True
        elif in_sha256 and line.startswith(" "):
            digest, _size, name = line.split()
            hashes[name] = digest
        else:
            in_sha256 = False
    return hashes


def newer(a: str, b: str) -> bool:
    return (
        subprocess.run(["dpkg", "--compare-versions", a, "gt", b]).returncode == 0
    )


def main() -> None:
    print("# Ubuntu focal .deb files bundled with the headless Chromium; see")
    print("# pin-chromium-libs.py.  arch package version filename sha256")
    for arch, mirror in MIRRORS.items():
        best: dict = {}
        for pocket in POCKETS:
            hashes = verified_index_hashes(mirror, pocket)
            for component in COMPONENTS:
                name = f"{component}/binary-{arch}/Packages.xz"
                data = fetch(f"{mirror}/dists/{pocket}/{name}")
                if hashlib.sha256(data).hexdigest() != hashes.get(name):
                    sys.exit(f"{pocket}/{name} does not match its signed InRelease")
                for stanza in lzma.decompress(data).decode().split("\n\n"):
                    fields = dict(
                        line.split(": ", 1)
                        for line in stanza.splitlines()
                        if ": " in line and not line.startswith(" ")
                    )
                    package = fields.get("Package")
                    if package not in PACKAGES:
                        continue
                    entry = (fields["Version"], fields["Filename"], fields["SHA256"])
                    if package not in best or newer(entry[0], best[package][0]):
                        best[package] = entry
        missing = [p for p in PACKAGES if p not in best]
        if missing:
            sys.exit(f"missing for {arch}: {' '.join(missing)}")
        for package in PACKAGES:
            version, filename, sha256 = best[package]
            print(arch, package, version, filename, sha256)


if __name__ == "__main__":
    main()
