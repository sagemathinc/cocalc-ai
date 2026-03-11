# Bug Hunter Improvement Plan

This document is a repo-side spec for improving the overnight bug-hunting workflow used against CoCalc Lite and Launchpad.

It is based on the March 11, 2026 bug-hunt run, the generated log in `src/.agents/bug-hunt/2026-03-11.md`, and the follow-up review of what slowed the work down.

## Problem

The current bug-hunt workflow is useful, but too much time is still lost to:

- stale or under-specified tasks,
- browser/session targeting mistakes,
- orphaned spawned Playwright/Chromium sessions that accumulate RAM,
- manual repro scripting,
- weak artifact capture,
- poor commit hygiene during long autonomous runs,
- difficulty attributing edits after a long session,
- no repo-owned version of the bug-hunt skill to iterate on.

The run still produced multiple real fixes, but the process was more fragile than it should be.

## Goals

1. Make it faster to find live, reproducible bugs.
2. Reduce time lost to stale tasks and bad repro inputs.
3. Make browser automation more deterministic.
4. Make each iteration auditable:
   - target task,
   - repro,
   - evidence,
   - artifacts,
   - validation,
   - commit.
5. Make it hard to end a long run with an uncommitted mixed worktree.
6. Bring the bug-hunt skill into the repo as a versioned artifact, while preserving the fact that the active runtime skill is still loaded from `~/.codex`.

## Non-goals

- Replace ad hoc debugging entirely with a rigid harness.
- Build a full bug tracker.
- Force every bug hunt to use the same environment or the same UI surface.
- Replace the user-local `~/.codex` skill mechanism immediately.

## Current Baseline

The current workflow already has strong building blocks:

- `cocalc browser` live and spawned sessions,
- `pnpm -s --dir src dev:env:lite` and `dev:env:hub`,
- focused package-local tests and typechecks,
- `docs/browser-debugging.md`,
- `wstein.tasks` as a bug backlog with inline triage notes,
- Btrfs snapshots for recovery and attribution.

These should be extended, not replaced.

## Main Pain Points From The March 11 Run

### 1. Task freshness and repro quality

Many iterations were spent on tasks that were:

- stale,
- already fixed,
- tied to deleted files or dead chat content,
- missing exact routes, files, or environment details.

Desired outcome:

- a smaller set of likely-live targets before the hunt starts,
- better separation between:
  - stale,
  - intermittent,
  - blocked-by-env,
  - already-fixed,
  - confirmed-bug.

### 2. Browser/session ambiguity

The most common debugging mistakes were:

- wrong API URL,
- wrong browser session,
- stale bundle in an old tab,
- hub automation failure without a clean fallback,
- manual spawned-session setup overhead.

Desired outcome:

- one command to attach to the intended environment with explicit target context,
- stronger spawned-session ergonomics,
- hard browser cleanup rules so bug hunts do not leak dozens of Chromium processes,
- clearer detection of stale bundles and bad targets.

### 2b. Browser process hygiene

The March 11 run also leaked a large number of headless Chromium processes.

This is not a cosmetic issue. It can:

- consume significant RAM,
- slow later repros,
- make the host unstable,
- invalidate conclusions drawn from a degraded environment.

Desired outcome:

- spawned browser sessions are treated like scarce resources,
- each spawned session is destroyed in the same iteration unless there is a documented reason not to,
- every bug-hunt turn starts from a known-clean browser-process baseline.

### 3. Ad hoc runtime probing

Live repro often required hand-written `browser exec` scripts or runtime poking.

Desired outcome:

- more first-class actions, waits, and assertions,
- reusable harness plans,
- standard artifact capture on failure.

### 4. Weak iteration ledger and commit discipline

The biggest operational failure was not the code fixes, but the process:

- multiple validated fixes accumulated without immediate commits,
- the worktree became mixed,
- later review required reconstructing intent from logs and snapshots.

Desired outcome:

- each confirmed fix becomes a commit quickly,
- each iteration gets a machine-readable ledger entry,
- dirty-tree carry-over becomes explicit instead of accidental.

### 5. Skill drift

The skill that governs bug hunts lives in `~/.codex`, not in the repo.

That makes it harder to:

- review changes,
- iterate collaboratively,
- test the workflow,
- reuse the skill in other environments.

Desired outcome:

- a repo-owned copy of the skill,
- a clear sync path to the user-local runtime skill,
- references, scripts, and templates stored alongside the repo version.

## Proposed Workstreams

### Workstream A: Better bug target selection

Deliverables:

- `src/scripts/bug-hunt/extract-open-bugs.(ts|sh)`
- `src/scripts/bug-hunt/extract-open-bugs --fresh`
- `src/scripts/bug-hunt/extract-open-bugs --area chat,codex,jupyter`
- `src/scripts/bug-hunt/extract-open-bugs --exclude-stale-days 14`

Behavior:

- parse `wstein.tasks`,
- ignore `done`, `deleted`, or clearly stale items,
- score tasks using tags and freshness,
- emit a compact candidate list with:
  - task id,
  - title,
  - area,
  - last confirmed date,
  - repro asset quality,
  - likely environment: `lite`, `hub`, or `either`.

Acceptance criteria:

- one command produces a shortlist that is materially better than scanning raw `wstein.tasks`,
- output cleanly separates:
  - confirmed live,
  - maybe stale,
  - blocked,
  - already fixed.

### Workstream B: One-command bug-hunt environment attach

Deliverables:

- `cocalc bug-hunt attach --lite`
- `cocalc bug-hunt attach --hub`
- `cocalc bug-hunt attach --browser spawned|live`
- `cocalc bug-hunt attach --project-id <uuid>`

Behavior:

- resolve the correct API URL,
- ensure the right auth context,
- choose or spawn a browser session,
- print and persist explicit target context:
  - API URL,
  - browser id,
  - project id,
  - session URL,
  - build hash if available.

Acceptance criteria:

- a bug hunter can start on lite or hub without manually stitching together env vars,
- bad target context is obvious before any repro begins,
- stale spawned sessions are cleaned up before new repro work starts.

### Workstream C: Better browser/harness primitives

Deliverables:

- more typed browser actions:
  - `click`,
  - `type`,
  - `press`,
  - `drag`,
  - `wait-for-selector`,
  - `wait-for-url`,
  - `wait-for-idle`,
  - `scroll`,
  - `screenshot-on-failure`,
  - `console-tail`,
  - `network-trace`.
- reusable harness plans under `src/.agents/bug-hunt/plans/`
- optional fixture setup hooks before running a repro.

Behavior:

- keep raw `browser exec` available for advanced cases,
- reduce routine repro work to actions and assertions,
- store artifacts per iteration under a predictable directory.

Acceptance criteria:

- common repros no longer require custom JS every time,
- failed iterations leave behind enough evidence to review later.

Required browser hygiene rules for any spawned-session workflow:

1. Before starting a new spawned repro, list existing spawned sessions and destroy stale ones.
2. Keep at most one spawned browser session alive per active bug-hunt turn unless a comparison explicitly requires two.
3. Destroy spawned sessions immediately after:
   - a repro is complete,
   - a result is recorded,
   - or the agent decides to move on.
4. If the browser count or Chromium/Chrome process count looks unexpectedly high, stop and clean up before continuing.
5. Prefer:
   - code-backed checks first,
   - live user-session inspection second,
   - spawned Playwright sessions only when determinism is actually needed.

Recommended preflight command pattern:

- inspect local spawned sessions,
- destroy stopped/stale sessions,
- if needed, kill leftover Chromium processes from prior spawned runs before starting another long bug-hunt pass.

### Workstream D: Fixture and scratch helpers

Deliverables:

- `cocalc bug-hunt seed --jupyter`
- `cocalc bug-hunt seed --chat`
- `cocalc bug-hunt seed --tasks`
- `cocalc bug-hunt seed --files`
- `cocalc bug-hunt seed --whiteboard`

Behavior:

- create throwaway files and routes for common repro scenarios,
- open them automatically in the targeted session,
- optionally clean them up afterward.

Acceptance criteria:

- creating a repro surface is faster than writing ad hoc setup code.

### Workstream E: Iteration ledger and artifacts

Deliverables:

- `src/.agents/bug-hunt/ledger/`
- machine-readable per-iteration records:
  - `iteration`,
  - `task_id`,
  - `area`,
  - `result`,
  - `evidence`,
  - `artifacts`,
  - `validation`,
  - `commit_sha`,
  - `confidence`.
- helper command:
  - `cocalc bug-hunt note ...`

Behavior:

- each iteration writes a JSON record and a compact human summary,
- `wstein.tasks` note appends can be generated from the same data.

Acceptance criteria:

- end-of-run review does not depend on parsing a long markdown diary by hand.

### Workstream F: Commit and dirty-worktree guardrails

Deliverables:

- `cocalc bug-hunt status`
- `cocalc bug-hunt commit --task <id>`
- `cocalc bug-hunt guard --fail-on-dirty`
- `cocalc bug-hunt split-suggestions`

Behavior:

- before starting a new iteration, warn if tracked edits are still uncommitted,
- after a validated fix, guide or enforce immediate commit creation,
- record commit SHA back into the ledger,
- suggest commit groupings from changed files plus iteration data.

Acceptance criteria:

- it becomes difficult to finish a 3-5 hour run with a mixed, unattributed worktree.

### Workstream G: Snapshot-aware attribution

Deliverables:

- `cocalc bug-hunt diff-since-start`
- `cocalc bug-hunt diff-since-snapshot <snap>`
- `cocalc bug-hunt recover-iteration <n>`

Behavior:

- use Btrfs snapshots when available,
- compare current tree to the start-of-run snapshot,
- help identify which files were introduced by which part of the hunt.

Acceptance criteria:

- after a long run, it is easy to reconstruct change provenance.

### Workstream H: Repo-owned skill and sync path

Deliverables:

- canonical repo copy of the skill at:
  - `src/.skills/cocalc-bug-hunter/SKILL.md`
- optional companion files:
  - `src/.skills/cocalc-bug-hunter/references/*.md`
  - `src/.skills/cocalc-bug-hunter/scripts/*`
- sync helper:
  - `src/scripts/dev/sync-codex-skill.ts`

Behavior:

- the repo copy is the canonical reviewed version,
- the actual runtime skill in `~/.codex/skills/cocalc-bug-hunter` is updated by explicit sync,
- sync should support:
  - repo -> local skill,
  - diff local vs repo,
  - dry-run.

Acceptance criteria:

- skill changes are reviewed in git,
- the runtime skill is still easy to update locally,
- references and scripts live next to the skill instead of only in a home directory.

## Proposed Skill Changes

The repo-owned `cocalc-bug-hunter` skill should be updated to require:

1. A preflight step
   - confirm environment,
   - attach browser,
   - clean up stale spawned browser sessions and leftover Chromium processes,
   - capture starting git status,
   - create a run ledger entry.
2. A task selection step
   - prefer fresh, likely-live bugs,
   - skip stale tasks earlier.
3. An iteration contract
   - exactly one bug target at a time,
   - explicit evidence standard,
   - explicit outcome type.
4. A post-validation action
   - commit immediately if the fix is validated and isolated,
   - otherwise record why not.
5. A stop/recovery step
   - if browser targeting or bundle freshness is suspect, reattach or refresh before continuing.
   - if spawned browser processes accumulate, stop and clean them up before continuing.

The skill should also explicitly define these outcome classes:

- `bug_fixed`
- `bug_confirmed_no_fix`
- `stale_report`
- `already_fixed`
- `blocked_by_environment`
- `intermittent_unconfirmed`

The skill should also include a non-optional browser cleanup checklist:

- `browser session spawned`
- destroy stale spawned sessions
- verify Chromium process count is reasonable before continuing
- destroy the active spawned session before ending the iteration unless intentionally preserved and documented

## Proposed Repo Layout

```text
src/
  .agents/
    bug-hunter.md
    bug-hunt/
      plans/
      ledger/
  .skills/
    cocalc-bug-hunter/
      SKILL.md
      references/
      scripts/
  scripts/
    bug-hunt/
      extract-open-bugs.ts
      run-iteration.ts
      diff-since-snapshot.ts
    dev/
      sync-codex-skill.ts
```

## Milestones

### Phase 0: Immediate guardrails

- add repo spec,
- add repo-owned skill copy,
- add skill sync script,
- add dirty-tree preflight check,
- add browser-process cleanup preflight,
- add a basic task extractor.

### Phase 1: Faster and safer live repro

- add `bug-hunt attach`,
- add more browser action/harness support,
- add artifact capture,
- add fixture seed helpers.

### Phase 2: Stronger auditability

- add iteration ledger,
- add commit helpers,
- add task note generation from the ledger,
- add snapshot-aware attribution helpers.

### Phase 3: Better triage and scheduling

- score tasks by freshness and severity,
- support strict target plans by area,
- enable unattended queued bug-hunt batches with per-iteration artifacts.

## Recommended Order Of Implementation

1. Repo-owned skill plus sync script.
2. Dirty-tree guard plus mandatory iteration ledger.
3. Task extractor/freshness scoring.
4. One-command environment attach.
5. Artifact capture and harness improvements.
6. Snapshot-aware attribution.

This order addresses the highest process risk first:

- unreproducible target selection,
- bad environment targeting,
- and especially lost or mixed changes.

## Success Criteria

This project is successful if a future overnight bug hunt:

- spends less time on stale reports,
- wastes less time on browser/session setup,
- leaves behind a clean ledger with artifacts,
- produces isolated commits during the run,
- and can be reviewed the next morning without reconstructing intent from memory.
