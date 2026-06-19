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
- **⚠️ Action needed (2026-06-18 17:07):** the platform hub was STOPPED to return the
  `:9100` / `blaec.cocalc.ai` slot to synthesis (it had silently taken it, reverting the
  public preview). When the platform thread resumes preview/dev, do NOT restart on
  `:9100` — configure a different port in `/home/user/cocalc-ai/.local/hub-daemon.env`
  first (see the incident's structural fix above).

---

## Preview-ownership incident (2026-06-18) — ROOT CAUSE of the reverted homepage

**Not a code/build/merge problem.** The synthesis build and source are current and
correct. The revert is a **hub-ownership collision**:

- Both worktrees' hub daemons are configured for the **same** `http://localhost:9100`.
- Synthesis hub daemon = **stopped**; platform hub daemon = **running** (pid 100501,
  cwd `/home/user/cocalc-ai/src`). So `blaec.cocalc.ai` is served by the **platform**
  hub → it shows the **platform worktree's old public pages**.
- Diagnostic that nails it: `bash scripts/dev/hub-daemon.sh status` in each worktree,
  plus `readlink /proc/<hub-pid>/cwd`. The serving cwd must be
  `/home/user/cocalc-ai-synthesis/src`; right now it is not.

**Immediate fix — DONE (2026-06-18 17:07):** stopped the platform hub, started the
synthesis hub on `:9100` (pid 119412), cloudflared tunnel back up. Content canary
**0 failures / 75 assertions** across `/`, `/features/ai`, `/features/jupyter-notebook`,
`/pricing`. `blaec.cocalc.ai` now serves the current synthesis pages. Platform hub
is STOPPED.

**Structural fix — STILL OPEN; bigger than a port var (Codex/platform infra).**
Investigated 2026-06-18 17:1x: the synthesis hub-daemon.env is
`HUB_CMD="DATA_BASE=/home/user/cocalc-ai/src/data/app ./packages/hub/bin/start.sh postgres"`.
The platform worktree has NO `src/.local/hub-daemon.env`, so its hub inherits the
hub's default `:9100`. **Both hubs share the same `DATA_BASE`** (`cocalc-ai/src/data/app`
— DB, postgres, cloudflared). So running both simultaneously needs the platform hub to
get (a) its OWN port AND (b) its OWN `DATA_BASE`/data dir — otherwise they collide on
`:9100` and/or the shared DB. That is platform-worktree infra: the platform agent should
create `cocalc-ai/src/.local/hub-daemon.env` with a distinct port + DATA_BASE. NOT done
here to avoid breaking the shared hub/DB.

**Interim rule (in force now):** ONE hub on `:9100`, owned by **synthesis** (it backs
`blaec.cocalc.ai`). The platform hub stays stopped unless it explicitly takes a handoff.
Before ANY preview judgment, every agent runs `hub-daemon.sh status` in BOTH worktrees +
`readlink /proc/<hub-pid>/cwd` and confirms cwd `= /home/user/cocalc-ai-synthesis/src`.
HTTP 200 ≠ correct owner.

---

## Contribution-hygiene / PR-prep (2026-06-18) — NOT pushed

Cut clean, main-based PR branches so William reviews product only (not the 304-commit
synthesis branch, not scaffolding, not platform work):

- **`public-site-pr`** — worktree `/home/user/cocalc-ai-public-site-pr`. The landing-site
  PR: **70 files off `origin/main`** (frontend/public pages+tokens+tests, the
  `hub/servers/app/public-*` backend + `express-app` wiring, `customize/app-base-path`,
  `util/public-site-metadata`). Verified standalone: **zero** platform/scaffolding imports.
  Two dev-tooling tests (`public-site-browser-qa-script.test.ts`,
  `public-site-agent-workflow.test.ts`) were excluded — they assert the QA harness /
  `.agents/` docs, not product.
- **`public-site-shells`** — the 3 `cli|launchpad|plus/site/index.html` product marketing
  pages (3 files off `origin/main`). Split out so the landing PR stays tight.
- **Scaffolding stays here on `blaec-synthesis-2026-06-18`** (local): `.agents/`, the audit
  docs, `.claude/commands`, the preview hook + QA harness, the 2 dev-tooling tests.
- Empirical gate (pnpm install + jest + tsc on the fresh branch) deferred to **CI on the PR**.

**⚠️ Codex — decide the home of the orphaned platform files** (currently only on
`blaec-synthesis` via `blaec2`, NOT on `remove-empty-project-tag`): `project/page/flyouts/*`
(6), `projects/project-rootfs-badge.*` (2), `styles/index-base.css` (flyout-star CSS),
`docs/mockups/file-explorer-*` (6). Provenance commits `d0de512695` (rootfs badge),
`072401c147` (flyout controls). Cherry-pick onto a platform branch if still wanted; else
they're harmlessly excluded from the public-site PRs.

---

## main-sync (2026-06-18) — synthesis now current with upstream

Merged `origin/main` (`5a0688d925`, incl **PR #71** empty-explorer spacing, xterm 5.5.0,
idle handling) into `blaec-synthesis-2026-06-18` — **clean, zero conflicts** (synthesis
public-site changes and main's in-app changes didn't overlap). Rebuilt via `static:dev`
(new bundle `app-408615…` embeds the merge commit + #71's `no-files.tsx`) and restarted
the synthesis hub. **Public content canary: 0 failures.** #71 is a project/in-app change —
verify its spacing in the logged-in explorer view, NOT on the public landing pages. NOT pushed.
