#!/usr/bin/env bash
# On GitHub's hosted Ubuntu runners apt reads its mirrors from
# /etc/apt/apt-mirrors.txt, Azure's mirror first. On Nov 11 2026 neither that
# mirror nor Ubuntu's own archive answered the runners for hours, so CI puts
# kernel.org's Ubuntu mirror first and keeps the rest of the list behind it
# (same fix as sagemathinc/sagebrush#1035). apt still checks every index
# against Ubuntu's signing keys.
#
# Does nothing where that file doesn't exist (a self-hosted runner, another
# image), and nothing on non-amd64 runners: kernel.org's /ubuntu/ mirror only
# carries amd64/i386; arm64 packages live in ubuntu-ports.
set -euo pipefail
f=/etc/apt/apt-mirrors.txt
if [ ! -f "$f" ]; then
  echo "no $f: apt mirrors left as they are"
  exit 0
fi
arch=$(dpkg --print-architecture)
if [ "$arch" != amd64 ]; then
  echo "arch $arch: apt mirrors left as they are"
  exit 0
fi
rest=$(grep -v -e 'azure\.archive\.ubuntu\.com' -e 'mirrors\.edge\.kernel\.org' "$f" || true)
printf 'http://mirrors.edge.kernel.org/ubuntu/\tpriority:1\n%s\n' "$rest" | sudo tee "$f" > /dev/null
echo "apt mirrors:"
cat "$f"
