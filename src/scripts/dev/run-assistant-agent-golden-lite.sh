#!/usr/bin/env bash
set -euo pipefail

cd /home/wstein/build/cocalc-lite3/src
eval "$(pnpm -s dev:env:lite)"

REPORT_ROOT="${REPORT_ROOT:-/tmp/assistant-agent-golden-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$REPORT_ROOT"

echo "report_root=$REPORT_ROOT"
echo "api_url=${COCALC_API_URL:-http://localhost:7003}"

cd packages/lite
pnpm exec playwright test \
  -c playwright.assistant.config.ts \
  playwright/assistant/workspace-agent.spec.ts \
  --reporter=list
