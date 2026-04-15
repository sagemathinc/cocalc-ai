---
name: cocalc-bug-hunter
description: Use when asked to do autonomous QA, overnight bug hunting, reproduce or fix real user-visible bugs in CoCalc Lite or Launchpad, especially in chat/codex, jupyter, terminal, editor, and browser-automation workflows.
---

# CoCalc Bug Hunter

Use this skill for repeated bug-hunt loops in the CoCalc codebase.

## Goal

Find real, user-visible bugs. Prioritize:

- data loss
- stuck workflows
- broken core flows
- reproducible regressions
- browser/session/tooling failures that block QA

Do not optimize for style nits or broad cleanup.

## Default targets

Unless the user gives a narrower charter, prefer this order:

1. chat / codex
2. jupyter
3. terminal
4. file editor / explorer
5. browser automation / QA infrastructure itself

If the QA tooling is unreliable, fixing the tooling is a valid bug-hunt result.

## Setup

1. Confirm target environment:
   - Lite vs Launchpad
   - API URL
   - whether browser automation is available
2. Run the bug-hunt preflight early:
   - `node scripts/bug-hunt/preflight.js --json`
3. If browser automation matters, read the repo doc:
   - `docs/browser-debugging.md`
4. To mine likely open bugs from mentioned task files, e.g., `wstein.tasks`, use:
   - `node scripts/bug-hunt/extract-open-bugs.js --fresh`
5. If you are changing the workflow itself, read:
   - `src/.agents/bug-hunter.md`

## Iteration contract

For each iteration:

1. Pick exactly one concrete scenario.
2. Reproduce it with explicit steps.
3. Gather evidence:
   - visible symptom
   - relevant console/network/runtime evidence if useful
   - likely code path
4. Decide:
   - small, contained, high-confidence fix: implement it
   - otherwise: write a precise bug report and move on
5. Validate narrowly:
   - focused test or typecheck when appropriate
   - browser smoke if the issue is UI/event-driven
6. Commit immediately after a fix is real and validated unless the user explicitly asked not to.

## Output format

For each iteration, report:

- `Iteration N`
- `Area`
- `Result: bug found | no bug`
- `Severity`
- `Repro`
- `Evidence`
- `Root-cause hypothesis`
- `Fix`
- `Validation`
- `Commit`

Keep it factual.

## Severity

- High: data loss, corruption, stuck workflow, security/privacy issue
- Medium: broken core flow with workaround
- Low: edge-case or minor UX issue

## Evidence standard

Do not claim a bug without at least one of:

- direct repro in UI
- failing focused test
- console/runtime/network evidence tied to the symptom

Do not claim a fix without:

- code-path explanation
- at least one validation step

## Fix policy

Fix inline only when all are true:

- the bug is reproducible
- the root cause is localized
- the blast radius is small
- validation is available

Otherwise stop at bug report quality, not speculative patching.

## Commit policy

When committing:

- keep commits narrow
- explain root cause and validation
- do not bundle unrelated cleanup
- do not start the next iteration with a dirty tracked worktree unless the carry-over is intentional and recorded

## Recovery policy

If a session becomes stale or browser targeting fails:

- re-resolve the active browser session
- prefer a dedicated spawned session for long hunts
- avoid rebuilding the frontend mid-run unless required
- if the environment changed underneath you, say so explicitly

## Stop conditions

Stop when any of these hold:

- wall time reached
- user-specified max turns reached
- 3 consecutive iterations with no actionable findings
- hard blocker requiring human input

## Notes

- Real regressions beat breadth.
- Browser/tooling bugs count if they materially block QA or user workflows.
- Prefer progress over exhaustiveness.
