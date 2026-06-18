# Active-Agent Handoff Ledger

Live "who is doing what right now" board for concurrent agents (Claude, Codex,
Gemini). This is the FAST-CHANGING companion to the stable
`multi-agent-github-operating-model.md` (which holds the durable branch/worktree
map). Update the relevant block at the **start and end of every agent turn**.

## Rules (the "checkout system")

1. **One worktree per domain.** Platform UI → `/home/user/cocalc-ai`
   (`remove-empty-project-tag`). Public site → `/home/user/cocalc-ai-synthesis`
   (`blaec-synthesis-2026-06-18`). Never edit the other agent's worktree.
2. **Claim before editing.** List the files/routes you will touch under your
   block below. If they overlap another agent's active claim, STOP and coordinate.
3. **Commit at handoff.** Don't hand off uncommitted piles. Finish a bounded
   change → validate → commit → release the claim.
4. **One preview owner at a time.** `blaec.cocalc.ai` is served from ONE worktree.
   Verify before any build/preview: `ps -eo pid,cmd | rg 'packages/hub|node .*hub'`
   then `readlink /proc/<pid>/cwd`. Do not start a build that writes a `dist/` the
   other agent's preview serves while they're mid-turn.
5. **Serialize builds.** Two `build:dev`/`static:dev` runs against a shared cache
   can produce a mixed/stale bundle (this is what reverted the homepage). Only one
   agent builds at a time; the other waits for the commit + "build released".
6. **Validate the preview by CONTENT, not liveness.** HTTP 200 + metadata is not
   enough — a stale bundle still returns 200. Use the canary check
   (`public-site-browser-qa.mjs`, rendered-text assertions) before declaring a
   preview good.
7. **Scratch stays out of Git.** Screenshots/QA JSON/logs → `/tmp/cocalc-*` or the
   ignored `preview/`. Commit only source, tests, and intentional docs.

## Block template

```
Active agent:
Task:
Worktree / Branch:
Preview owner (this turn?):
Claimed files/routes:
Do not touch:
Validation required:
Last commit:
Open PR:
Next step:
Known risks:
```

---

## Current state (2026-06-18)

### Claude — public-site thread
- **Task:** Plan-A token cleanup (done) → diagnosing the reverted `blaec.cocalc.ai`.
- **Worktree / Branch:** `/home/user/cocalc-ai-synthesis` / `blaec-synthesis-2026-06-18`
- **Preview owner this turn:** YES (must verify hub cwd before each build).
- **Claimed files/routes:** `public/__tests__/test-helpers.ts`,
  `public/features/__tests__/app.test.tsx`, `public/__tests__/type-scale.test.ts`,
  `public/features/*-page.tsx` (#fff sweep — committed), this ledger.
- **Do not touch:** anything under `/home/user/cocalc-ai` (platform), `blaec2`,
  `blaec` (historical).
- **Validation required:** synthesis public Jest (232) + tsc + lint + a content
  canary against the live preview.
- **Last commit:** `0460b72` render-time type-scale guard (local; not pushed).
- **Open PR:** none.
- **Next step:** serialized clean rebuild of the synthesis preview (cache cleared,
  no concurrent build) + canary re-check.
- **Known risks:** synthesis `dist` currently builds a STALE main chunk
  ("Codex thread") despite current source — suspected shared-cache/concurrent-build
  corruption. Do not trust the preview until a clean serialized rebuild passes the
  canary.

### Codex — platform-UI thread
- **Task:** empty-file-explorer spacing fix (`no-files.tsx`) — reported committed.
- **Worktree / Branch:** `/home/user/cocalc-ai` / `remove-empty-project-tag`
- **Preview owner this turn:** NO (left the synthesis hub untouched — correct).
- **Last commit (reported):** `1a3d836` spacing fix on `remove-empty-project-tag`.
- **Known risks:** ran `pnpm -C src build:dev` ~1h ago; if that shared a cache with
  the synthesis build, it may have contributed to the stale public bundle.
