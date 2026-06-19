#!/usr/bin/env bash
# Claude Code SessionStart hook: auto-inject live multi-agent coordination state
# (the handoff ledger + the worktree that currently serves blaec.cocalc.ai) so a
# fresh session knows the rules without being told. Emits SessionStart JSON with
# additionalContext. Must never hard-fail the session — degrades to a short note.
set -uo pipefail

LEDGER="/home/user/cocalc-ai-synthesis/src/.agents/active-agent-handoff.md"

context() {
  echo "## Live multi-agent coordination — auto-injected at session start"
  echo ""
  echo "### Who serves blaec.cocalc.ai right now (must be the synthesis worktree)"
  local found=""
  for pid in $(pgrep -f "packages/hub" 2>/dev/null); do
    echo "- hub pid ${pid} cwd: $(readlink "/proc/${pid}/cwd" 2>/dev/null)"
    found=1
  done
  [ -z "$found" ] && echo "- (no hub process running)"
  echo "- Expected: /home/user/cocalc-ai-synthesis/src — verify with \`git worktree list\`."
  echo "- Validate the preview by rendered CONTENT (the QA canary), never HTTP 200."
  echo ""
  echo "### Active-agent handoff ledger ($LEDGER)"
  if [ -f "$LEDGER" ]; then
    cat "$LEDGER"
  else
    echo "(ledger not found — not in the CoCalc repo, or path moved)"
  fi
}

context | python3 -c 'import sys, json; print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.stdin.read()}}))' 2>/dev/null || true
