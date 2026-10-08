#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks: the Docker image links this script as /usr/local/bin/star.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
export SRC_ROOT="${SRC_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
exec "${SCRIPT_DIR}/../star-poc/star-poc.sh" "$@"
