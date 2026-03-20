# Jupyter Backend-Only Execution Stress Harness

## Goal

Build a **backend-only** stress harness for Jupyter evaluation correctness that
uses `cocalc-cli` and does **not** depend on any browser/frontend behavior.

The point is to prove that the authoritative notebook state is correct when:

- the browser is not involved,
- the backend is the **only writer** to notebook execution state,
- and correctness is judged entirely from backend-owned durable state.

Once this passes reliably, the frontend can be simplified to:

- send run requests,
- render ephemeral progress/output,
- never write execution output/prompt/state into the notebook.

## Canonical Stress Case

Use this as the standard stress cell:

```python
for i in range(10000): print(i, end=" ")
```

Use this as the quick smoke variant:

```python
for i in range(1000): print(i, end=" ")
```

## Required Invariants

For each run of the target cell, the harness must prove all of the following:

- `execution_count` is exactly previous prompt `+ 1`
- final runtime state is `done`
- output exists after completion
- output is still present after a short settle delay
- no malformed/null output records are written
- no output from the just-finished run disappears afterward
- the backend/project is the only writer of execution output/prompt/state for the run

Optional later invariants:

- output bytes/text length is non-zero and reasonable
- time-travel shows only backend-origin execution writes
- no duplicate completion lifecycle

## Scope Split

This harness is **not** for testing frontend rendering.

It is for proving:

- backend run protocol correctness
- backend durable state correctness
- backend write-authority correctness

Only after this passes should we add frontend/browser stress tests.

## CLI Surface

Do **not** add a new visible top-level `cocalc project jupyter-stress`
command as the first implementation.

Reasons:

- `cocalc ... -h` and `cocalc project -h` are common discovery surfaces
- this harness is initially for debugging and correctness work, not day-to-day
  end-user CLI usage
- the repo already has `project jupyter` command plumbing that should be reused

### First implementation

Implement the harness as a repo-local tool that uses the existing
`project jupyter` command/backend plumbing.

Suggested invocation shape:

```bash
pnpm -C src tsx packages/backend/conat/test/project/jupyter/stress-harness.ts \
  --project-id <uuid> \
  --path <ipynb-path> \
  --cell-id <cell-id> \
  --runs 100 \
  --preset stress \
  --json \
  --report /tmp/jupyter-stress.json
```

This harness should call the same underlying backend/project execution logic
already exposed by:

- `cocalc project jupyter cells`
- `cocalc project jupyter run`

### Optional later CLI wrapper

If a dedicated CLI wrapper turns out to be useful, add it as a **hidden**
subcommand under `project jupyter`, e.g.

```bash
cocalc project jupyter stress ...
```

and mark it hidden in help by default.

That avoids polluting top-level project help while still making the harness
available when explicitly known.

## Command Inputs

Required:

- `--project-id`
- `--path`
- `--cell-id`

One of:

- `--code "<python>"`
- `--code-file <path>`
- `--preset smoke|stress`

Optional:

- `--runs <n>`
- `--delay-ms <n>`
- `--settle-ms <n>`
- `--json`
- `--report <path>`
- `--fail-fast`
- `--assert-backend-writes-only`

## Output Shape

The command should emit:

- a short human summary by default
- structured JSON with per-run details when `--json` is set

Suggested JSON:

```json
{
  "project_id": "...",
  "path": "...",
  "cell_id": "...",
  "runs_requested": 100,
  "runs_completed": 100,
  "ok": true,
  "failures": [],
  "runs": [
    {
      "run_index": 1,
      "requested_at_ms": 0,
      "completed_at_ms": 0,
      "prev_exec_count": 12,
      "next_exec_count": 13,
      "runtime_state": "done",
      "output_present": true,
      "output_stable_after_settle": true,
      "backend_only_writes": true,
      "errors": []
    }
  ]
}
```

## Where It Should Live

### Shared implementation

Put the actual harness logic in a backend-capable library/test location, not
inside the CLI command body.

Suggested location:

- `src/packages/backend/conat/test/project/jupyter/stress-harness.ts`

If a CLI wrapper is added later, it should be a thin layer over that logic and
should live under:

- `src/packages/cli/src/bin/commands/project/`

Suggested later wrapper:

- `src/packages/cli/src/bin/commands/project/jupyter-stress.ts`

### Focused tests

Add tests near:

- `src/packages/backend/conat/test/project/jupyter/`

Suggested test files:

- `src/packages/backend/conat/test/project/jupyter/stress-harness.test.ts`
- possibly small unit tests for report/assertion logic

## Data Sources the Harness Must Use

Correctness must come from backend-owned durable state, not transient frontend
messages.

Primary sources:

- notebook syncdoc / persisted cell state
- runtime DKV / durable runtime state
- time-travel / patch history for write-origin checks

Transient pub/sub may be observed for debugging, but it must **not** be the
source of truth for pass/fail.

## Execution Model

For each run:

1. Read the current authoritative cell state.
   - record current `exec_count`
   - record output identity/length

2. Send a backend-only run request.
   - do this through backend/project APIs reachable from `cocalc-cli`
   - do not involve browser APIs

3. Wait for authoritative completion.
   - runtime state says `done`
   - or backend-owned notebook state reflects completion

4. Sleep `settle-ms`.
   - this catches output deletion / stale busy regressions

5. Re-read authoritative state.
   - compare prompt
   - compare output
   - compare runtime state

6. If enabled, inspect write history.
   - verify only backend/project authored execution writes

## Pass/Fail Rules

A run fails if any of these occur:

- `exec_count` is null
- `exec_count` is `0`
- `exec_count` is not previous `+ 1`
- runtime state is not `done`
- output is absent after completion
- output disappears after settle
- malformed/null output is written
- write history shows frontend/browser authored execution writes

The harness fails overall if any run fails.

## Minimal First Implementation

Implement only this first slice:

- smoke/stress code presets
- repeated backend-only execution
- authoritative re-read of notebook cell state
- `exec_count` exact `+1` assertion
- final `done` assertion
- output present + stable-after-settle assertion
- JSON report
- reuse existing `project jupyter` backend plumbing rather than inventing a
  new standalone execution path

Leave these for the second pass:

- detailed time-travel author attribution
- richer output-diffing
- Launchpad-specific wrappers

## Why This Should Work

This creates a proof boundary:

- if backend-only fails, the protocol/storage/backend write path is wrong
- if backend-only passes, any remaining bug is in frontend presentation or frontend writes

That is exactly the split we need before doing more optimization work.
