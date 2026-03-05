#!/usr/bin/env bash
set -u
set +e
set -o pipefail

cd /home/wstein/build/cocalc-lite3/src || exit 1
# shellcheck disable=SC1091
eval "$(pnpm -s dev:env:lite)"

CLI="./packages/cli/dist/bin/cocalc.js"
PLAN="${PLAN:-./.agents/real-bug-hunt-lite.plan.json}"
DURATION_SEC="${1:-3600}"
PROJECT_ID="${COCALC_PROJECT_ID:-00000000-1000-4000-8000-000000000000}"
API_URL="${COCALC_API_URL:-http://localhost:7003}"

[[ -f "$PLAN" ]] || { echo "missing plan: $PLAN" >&2; exit 2; }

RUN_ROOT="/tmp/hunt-real-bugs-v2-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_ROOT"
SUMMARY_JSONL="$RUN_ROOT/summary.jsonl"

spawn_json() {
  "$CLI" browser session spawn \
    --headless \
    --session-name "hunt-real-bugs-v2" \
    --target-url "$API_URL/projects/$PROJECT_ID/files/home/wstein/scratch/cocalc-lite3-lite-daemon/" \
    --json
}

SPAWN_JSON="$(spawn_json)"
BROWSER_ID="$(jq -r '.data.browser_id // empty' <<<"$SPAWN_JSON")"
SPAWN_ID="$(jq -r '.data.spawn_id // empty' <<<"$SPAWN_JSON")"
[[ -n "$BROWSER_ID" && -n "$SPAWN_ID" ]] || {
  echo "spawn failed" >&2
  echo "$SPAWN_JSON" >&2
  exit 1
}

cleanup() {
  "$CLI" browser session destroy "$SPAWN_ID" --json >/dev/null 2>&1 || true
  "$CLI" browser session reap --stop-running --json >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf '{"run_root":"%s","plan":"%s","browser_id":"%s","spawn_id":"%s"}\n' \
  "$RUN_ROOT" "$PLAN" "$BROWSER_ID" "$SPAWN_ID" | tee "$RUN_ROOT/run-meta.json"

start_ts=$(date +%s)
end_ts=$((start_ts + DURATION_SEC))
iter=0

while [[ $(date +%s) -lt $end_ts ]]; do
  iter=$((iter + 1))
  iter_id=$(printf '%04d' "$iter")
  iter_dir="$RUN_ROOT/iter-$iter_id"
  mkdir -p "$iter_dir"

  out="$iter_dir/harness.out.json"
  "$CLI" browser harness run \
    --plan "$PLAN" \
    --browser "$BROWSER_ID" \
    --project-id "$PROJECT_ID" \
    --report-dir "$iter_dir/report" \
    --active-only \
    --pin-target \
    --json > "$out" 2>&1
  rc=$?

  ok=false
  steps_failed=null
  duration_ms=null
  sigs='[]'

  if [[ $rc -eq 0 ]] && jq -e '.ok==true' "$out" >/dev/null 2>&1; then
    ok=$(jq -r '.data.ok' "$out")
    steps_failed=$(jq -r '.data.steps_failed // null' "$out")
    duration_ms=$(jq -r '.data.duration_ms // null' "$out")
    sigs=$(jq -c '.data.failure_signatures // []' "$out")
  fi

  jq -nc \
    --arg iter "$iter_id" \
    --argjson rc "$rc" \
    --argjson ok "$ok" \
    --argjson steps_failed "$steps_failed" \
    --argjson duration_ms "$duration_ms" \
    --argjson failure_signatures "$sigs" \
    --arg out "$out" \
    '{iter:$iter,rc:$rc,ok:$ok,steps_failed:$steps_failed,duration_ms:$duration_ms,failure_signatures:$failure_signatures,out:$out}' \
    >> "$SUMMARY_JSONL"

  # If run failed due session targeting/rpc path, respawn and continue.
  if [[ $rc -ne 0 ]] || jq -e '.ok!=true' "$out" >/dev/null 2>&1; then
    if rg -q "timeout|target|browser-session|stale|host routing info unavailable" "$out"; then
      "$CLI" browser session destroy "$SPAWN_ID" --json >/dev/null 2>&1 || true
      SPAWN_JSON="$(spawn_json)"
      BROWSER_ID="$(jq -r '.data.browser_id // empty' <<<"$SPAWN_JSON")"
      SPAWN_ID="$(jq -r '.data.spawn_id // empty' <<<"$SPAWN_JSON")"
    fi
  fi

  if ((iter % 2 == 0)); then
    total=$(wc -l < "$SUMMARY_JSONL")
    bad=$(jq -s '[ .[] | select(.ok!=true or (.steps_failed // 0) > 0) ] | length' "$SUMMARY_JSONL")
    echo "iter=$iter total=$total problematic=$bad browser=$BROWSER_ID"
  fi

  sleep 1
done

jq -s '{iterations:length,problematic:(map(select(.ok!=true or (.steps_failed // 0) > 0))|length),total_failed_steps:(map(.steps_failed // 0)|add),avg_duration_ms:((map(.duration_ms // 0)|add) / (if length>0 then length else 1 end))}' "$SUMMARY_JSONL" > "$RUN_ROOT/aggregate.json"
cat "$RUN_ROOT/aggregate.json"
echo "run_root=$RUN_ROOT"
