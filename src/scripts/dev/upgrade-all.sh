#!/usr/bin/env bash
set -ev

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${SRC_ROOT}"

pnpm dev:hub:build
pnpm dev:hub:restart
pnpm dev:hosts:upgrade
