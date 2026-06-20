#!/usr/bin/env bash
#
# Per-turn rebuild + screenshot guarantee for the CoCalc.ai public site.
# Wired as a non-blocking Claude Code Stop hook so "rebuilt every turn, preview
# captured" is a property of the harness, not agent memory (fixes preview-drift).
#
# Behavior:
#   - SPEED GUARD: does nothing unless public-site source changed since the last
#     snapshot (trivial / non-site turns pay zero cost).
#   - Guarantees a fresh dist (waits on the running static:watch; falls back to a
#     one-shot static:dev only if no watch is running).
#   - Captures home + the touched routes at desktop+mobile via the existing CDP
#     harness, publishes a stable contact sheet at preview/index.html
#     and appends one row to .preview-snapshots/log.md.
#   - Exits 0 (non-blocking) with an additionalContext summary line.
#   - The ONLY blocking case: a CTA/canary assertion failed (broken route /
#     leaked internal phrase). Blocks ONCE (guarded by stop_hook_active) so it
#     can fix the contract but can never trap the agent in a loop.
#
# This script must never hard-fail the turn: screenshot/build issues degrade to a
# plain note. set -e is intentionally NOT used.
set -uo pipefail

REPO="${CLAUDE_PROJECT_DIR:-/home/user/cocalc-ai}"
PUBLIC="src/packages/frontend/public"
QA="$REPO/src/packages/frontend/scripts/public-site-browser-qa.mjs"
SNAP_DIR="$REPO/preview"
MARKER="$SNAP_DIR/.last"
WATCH_LOG="/tmp/cocalc-static-watch.log"
export CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}"

emit_context() { # $1 = message; non-blocking
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": sys.argv[1]}}))
PY
}

cd "$REPO" 2>/dev/null || { emit_context "preview-snapshot: repo not found"; exit 0; }

# --- loop guard -------------------------------------------------------------
INPUT="$(cat 2>/dev/null || true)"
STOP_ACTIVE="$(printf '%s' "$INPUT" | python3 -c 'import sys,json;
try: print(str(json.load(sys.stdin).get("stop_hook_active", False)).lower())
except Exception: print("false")' 2>/dev/null || echo false)"

# --- speed guard: what public source changed since last snapshot? -----------
LAST_HEAD="$(cat "$MARKER" 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo '')"
HEAD_NOW="$(git rev-parse HEAD 2>/dev/null || echo '')"
{
  git diff --name-only -- "$PUBLIC" 2>/dev/null
  git diff --name-only --cached -- "$PUBLIC" 2>/dev/null
  git ls-files --others --exclude-standard -- "$PUBLIC" 2>/dev/null
  [ -n "$LAST_HEAD" ] && git diff --name-only "$LAST_HEAD..$HEAD_NOW" -- "$PUBLIC" 2>/dev/null
} | sort -u > /tmp/.snap_changed 2>/dev/null
CHANGED="$(grep -v '^$' /tmp/.snap_changed 2>/dev/null || true)"

if [ -z "$CHANGED" ]; then
  exit 0   # nothing public changed this turn — zero cost, silent
fi

# --- map changed files -> routes (home always; cap a handful) ---------------
ROUTE_ARGS=(--route /)
declare -A SEEN=( ["/"]=1 )
add_route() { local r="$1"; if [ -z "${SEEN[$r]:-}" ] && [ "${#SEEN[@]}" -lt 5 ]; then SEEN[$r]=1; ROUTE_ARGS+=(--route "$r"); fi; }
while IFS= read -r f; do
  case "$f" in
    *"/public/home/"*)            add_route "/";;
    *"/public/features/"*-page.tsx) base="$(basename "$f")"; add_route "/features/${base%-page.tsx}";;
    *"/public/features/"*)        add_route "/features";;
    *"/public/products/"*)        add_route "/products";;
    *"/public/pricing/"*)         add_route "/pricing";;
    *"/public/about/"*)           add_route "/about";;
    *"/public/news/"*)            add_route "/news";;
    *"/public/support/"*)         add_route "/support";;
    *"/public/docs/"*)            add_route "/docs";;
    *"/public/guides/"*)          add_route "/guides";;
    # shared (theme/shell/common/visuals/tests) -> home is the proxy
  esac
done <<< "$CHANGED"

# --- guarantee a fresh dist -------------------------------------------------
if pgrep -f "rspack.*build -w" >/dev/null 2>&1; then
  # watch is running; give any in-flight incremental compile a moment to finish
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tail -n 3 "$WATCH_LOG" 2>/dev/null | grep -q "compiled successfully" && break
    sleep 1
  done
else
  ( cd "$REPO/src/packages/static" && timeout 165 pnpm -s build:dev >/dev/null 2>&1 ) || true
fi

# --- preview-ownership guard (multi-agent) ----------------------------------
# blaec.cocalc.ai is ONE hub on :9100; another worktree may own it (documented
# handoff). If so, the canary/capture would assert the WRONG worktree's pages,
# so emit a note (NEVER a block) and skip. The dist was still rebuilt above.
# Owner = the pid holding the :9100 LISTEN socket (port 0x238C, state 0A),
# matched to a hub pid by socket inode (works for our own processes, no privs).
INODE="$(awk '$4=="0A" && $2 ~ /:238C$/ {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | head -1)"
OWNER_PID=""
if [ -n "$INODE" ]; then
  for pid in $(pgrep -f "packages/hub" 2>/dev/null); do
    if ls -l "/proc/$pid/fd" 2>/dev/null | grep -q "socket:\[$INODE\]"; then OWNER_PID="$pid"; break; fi
  done
fi
OWNER_CWD="$(readlink "/proc/${OWNER_PID:-0}/cwd" 2>/dev/null || true)"
case "$OWNER_CWD" in
  "$REPO"/*|"$REPO") : ;;  # POSITIVELY this worktree owns :9100 → validate (may block)
  *)
    # foreign worktree OR unresolvable owner → do NOT assert: would test the wrong
    # worktree's pages, or a transient resolution glitch would false-fail. Only a
    # positive self-ownership match runs the canary + can block.
    printf '%s' "$HEAD_NOW" > "$MARKER"
    emit_context "preview-snapshot: canary SKIPPED — :9100 is not positively owned by this worktree ($REPO/src); owner=${OWNER_CWD:-unresolved}. Skipping so this turn does not assert another worktree's pages (the documented preview handoff). The dist here was rebuilt; reclaim :9100 to validate live."
    exit 0 ;;
esac

# --- capture ----------------------------------------------------------------
mkdir -p "$SNAP_DIR"
QA_JSON="$(timeout 150 node "$QA" "${ROUTE_ARGS[@]}" --viewport desktop --viewport mobile 2>/dev/null | tail -c 200000)"
OUTDIR="$(printf '%s' "$QA_JSON" | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("outDir",""))
except Exception: print("")' 2>/dev/null)"

if [ -z "$OUTDIR" ] || [ ! -d "$OUTDIR" ]; then
  printf '%s' "$HEAD_NOW" > "$MARKER"
  emit_context "preview-snapshot: rebuilt for [$(printf '%s' "$CHANGED" | tr '\n' ' ')] but screenshot capture was unavailable this turn. Live preview: blaec.cocalc.ai"
  exit 0
fi

# copy shots into the stable snapshot dir + build the contact sheet
rm -f "$SNAP_DIR"/*.png 2>/dev/null || true
cp "$OUTDIR"/*.png "$SNAP_DIR"/ 2>/dev/null || true
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
FAILED_COUNT="$(printf '%s' "$QA_JSON" | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("failedCount",0))
except Exception: print(0)' 2>/dev/null || echo 0)"

SNAP_DIR="$SNAP_DIR" QA_JSON="$QA_JSON" COMMIT="$COMMIT" STAMP="$STAMP" \
CHANGED="$CHANGED" python3 - <<'PY'
import os, json, html, glob
sd=os.environ["SNAP_DIR"]
try: r=json.loads(os.environ.get("QA_JSON") or "{}")
except Exception: r={}
routes=r.get("routes",["/"]); failed=r.get("failed",[]); fc=r.get("failedCount",0)
shots={os.path.basename(p) for p in glob.glob(os.path.join(sd,"*.png"))}
def img(route,vp):
    slug="home" if route=="/" else route.strip("/").replace("/","-")
    for suffix in ("full","top"):  # prefer the complete full-page image
        name=f"{slug}-{vp}-{suffix}.png"
        if name in shots:
            return f'<a href="{name}" title="open full image"><img src="{name}" loading="lazy" style="width:100%;border:1px solid #ddd;border-radius:6px;vertical-align:top"></a>'
    return '<div style="color:#999">no shot</div>'
banner=(f'<div style="background:#cf1322;color:#fff;padding:10px 14px;border-radius:6px">FAIL ({fc}): '
        + html.escape("; ".join(m.get("message","") for m in failed)[:400]) + '</div>') if fc else \
       '<div style="background:#389e0d;color:#fff;padding:10px 14px;border-radius:6px">PASS — canaries green</div>'
rows="".join(
  f'<tr><td style="vertical-align:top;font-weight:600;padding:8px">{html.escape(rt)}</td>'
  f'<td style="width:64%;padding:8px">{img(rt,"desktop")}</td>'
  f'<td style="width:24%;padding:8px">{img(rt,"mobile")}</td></tr>' for rt in routes)
changed=html.escape(os.environ.get("CHANGED","")).replace("\n","<br>")
doc=f'''<!doctype html><meta charset=utf8><title>CoCalc public preview — turn snapshot</title>
<body style="font-family:system-ui,Arial;margin:24px;max-width:1200px">
<h2>Public preview — turn snapshot</h2>
<p style="color:#555">commit <code>{html.escape(os.environ["COMMIT"])}</code> · {html.escape(os.environ["STAMP"])} · live: <a href="https://blaec.cocalc.ai">blaec.cocalc.ai</a></p>
{banner}
<p style="color:#555">changed:<br>{changed}</p>
<table style="border-collapse:collapse;width:100%"><tr><th>route</th><th>desktop</th><th>mobile</th></tr>{rows}</table>
</body>'''
open(os.path.join(sd,"index.html"),"w").write(doc)
with open(os.path.join(sd,"log.md"),"a") as f:
    f.write(f"- {os.environ['STAMP']} · {os.environ['COMMIT']} · routes {','.join(routes)} · {'FAIL '+str(fc) if fc else 'PASS'}\n")
PY

printf '%s' "$HEAD_NOW" > "$MARKER"

# --- blocking branch: a canary/CTA assertion failed -------------------------
if [ "${FAILED_COUNT:-0}" != "0" ] && [ "$STOP_ACTIVE" != "true" ]; then
  python3 - "$FAILED_COUNT" <<'PY'
import json, sys
print(json.dumps({"decision":"block",
  "reason": f"Public-site canary FAILED ({sys.argv[1]} assertion(s)) — a broken route, horizontal overflow, or leaked internal phrase. Fix before ending the turn. See preview/index.html."}))
PY
  exit 0
fi

emit_context "preview rebuilt + captured. Contact sheet: preview/index.html (commit $COMMIT, routes: $(IFS=,; echo "${!SEEN[*]}"), canaries: $([ "${FAILED_COUNT:-0}" = 0 ] && echo PASS || echo FAIL)). Open it alongside blaec.cocalc.ai to gate ship/revise/revert."
exit 0
