#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SRC_ROOT="${SRC_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
exec "${SCRIPT_DIR}/../star-poc/star-poc.sh" "$@"
