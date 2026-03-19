# Jupyter Eval Rewrite Plan

## Status

Planned. This is the Jupyter analogue of the completed Codex output rewrite.

## Critical Constraint

The latency from pressing `Shift+Enter` on a simple cell like `2+3` to seeing
the first visible output must remain very low.

This is non-negotiable.

Any design that routes the fast path through durable syncdoc commits before the
initiating user sees output is unacceptable, even if it is more collaborative.
The current browser-led implementation is fast in the common case, and the new
architecture must preserve that property while making live output collaborative.

## Problem

Current Jupyter execution mixes two very different concerns:

- immediate local feedback for the user who started the run
- durable collaborative notebook state for everyone else

Today this is implemented asymmetrically:

- while the initiating browser is connected, live output is streamed directly to
  that browser and notebook output is mostly written with `save=false`
- other viewers do not see most intermediate output until terminal notebook
  state is durably written
- if the initiating browser disconnects, backend failover takes over and starts
  durably writing throttled output into the notebook syncdoc

This has several bad consequences:

- live notebook execution is not truly collaborative
- disconnect changes persistence semantics mid-run
- fallback can create many patchflow commits
- CLI and agent-driven execution do not have a good shared live-output model
- live output and durable notebook history are coupled in the wrong way

## Goals

1. Keep first-output latency extremely low for the initiating user.
2. Make live cell output collaborative for all viewers during the run.
3. Avoid per-output or per-chunk patchflow churn in `.ipynb`.
4. Make browser, backend, CLI, and agents all use the same run-output model.
5. Preserve robust handoff if the initiating client disconnects.
6. Keep terminal notebook state durable and correct.

## Non-Goals

1. Do not regress the fast local UX in order to get collaboration.
2. Do not persist every intermediate Jupyter output forever in notebook history.
3. Do not require a browser to remain connected for a run to be observable.
4. Do not redesign kernel protocol details unless necessary.

## Current Architecture

### Browser-run path

The initiating browser:

- starts a `JupyterClient` run against the conat/project Jupyter socket
- receives live output over a private socket stream
- applies intermediate output to notebook state mostly with `save=false`
- forces durable notebook writes on terminal flush

This is fast for the initiating user, but not collaborative.

### Backend-failover path

If the initiating browser disconnects:

- the server switches to a backend output handler
- live outputs are replayed and then applied via throttled durable notebook
  writes

This is collaborative, but creates notebook patchflow churn and changes
behavior based on who is connected.

### Root issue

Live output is currently transported as a private client stream, not as shared
project-scoped ephemeral state.

## Target Architecture

### Durable notebook state

The notebook syncdoc should contain only bounded durable state:

- input edits
- cell execution state transitions that must survive refresh
- final cell output / terminal result
- durable metadata such as execution count and timing

It should not record high-frequency live output deltas.

### Ephemeral run state

Live Jupyter run output should move to a shared project-scoped ephemeral store,
using the same general principles that now work for Codex:

- pub/sub for low-latency fanout
- DKV or equivalent ephemeral state for replay/reconnect
- a run-scoped key such as `path + run_id`
- per-cell live output state inside that run

This ephemeral state should include:

- `run_start`, `cell_start`, `cell_done`, `run_done`
- streamed outputs
- `stdout` / `stderr` text
- rich output payloads
- execution state
- truncation / `more_output` state
- timestamps and activity metadata

### Fast path requirement

The initiating user should still see output immediately via the live run stream.

The difference is:

- the live stream must be shared with all viewers
- the browser must no longer be the sole owner of that stream
- durable notebook writes must be decoupled from live display

### Ownership model

The backend control plane should own the run from the start.

Browsers, CLI, and agents should all:

- submit run requests to the same backend-owned run service
- subscribe to the same live output stream
- render from the same ephemeral run state

Client disconnect should not change the underlying persistence model.

## Render Model

While a cell is running, the UI should render from:

- durable notebook input/state from the syncdoc
- live ephemeral output state from the run stream

When the cell completes:

- final terminal output is committed durably to the notebook
- live ephemeral state can expire after a grace period

This matches the Codex pattern:

- realtime comes from ephemeral state
- history comes from bounded durable state

## Commit-Budget Target

For a simple cell run, notebook patchflow should remain bounded and small.

The exact budget can be refined later, but the intended direction is:

- no commit per output line
- no commit per `print(...)`
- no change in commit behavior when the initiating browser disconnects

## Proposed Phases

### Phase 1: Audit current write paths

Map exactly which writes happen in:

- browser-run mode
- backend-failover mode
- notebook save-to-disk
- refresh/reconnect paths

Deliverable:

- a categorized list of durable writes:
  - required durable writes
  - live-only writes that should move off syncdoc
  - redundant writes that can be deleted

### Phase 2: Define a shared live run schema

Create a typed run-state schema for ephemeral notebook execution.

Suggested shape:

- run id
- notebook path
- started/updated timestamps
- per-cell live state
- ordered output events
- terminal state

Deliverable:

- a shared type definition usable by backend, frontend, and CLI

### Phase 3: Add backend-owned live run transport

Implement a project-scoped backend-owned live transport for notebook runs.

Requirements:

- low-latency pub/sub delivery
- replay/reconnect support via DKV or equivalent
- no browser ownership of the live stream
- multiple concurrent viewers

Deliverable:

- one backend-controlled live Jupyter run channel

### Phase 4: Switch browser execution to render from live run state

Change the frontend notebook runner so that:

- it submits a run request
- it subscribes to the shared live stream
- it stops treating the local browser as the sole output owner

Deliverable:

- initiating browser still feels instant
- second viewer sees the same live output during the run

### Phase 5: Bound durable notebook writes

Change notebook persistence so that only bounded lifecycle writes happen.

Candidate durable writes:

- cell enters running state
- optional sparse checkpoint if truly needed
- final output / exec_count / timing
- terminal error / interrupt state

Deliverable:

- no output-line patchflow churn

### Phase 6: CLI and agent integration

Expose the same backend-owned Jupyter run model to `cocalc-cli` and agents.

Capabilities should include:

- run selected cells
- subscribe to live output
- inspect final output
- continue to receive output even without a browser

Deliverable:

- notebook execution is a first-class backend capability, not a browser trick

### Phase 7: Reconnect and handoff hardening

Test:

- second viewer joining mid-run
- initiating browser refresh during run
- initiating browser disconnect during run
- backend-only run from CLI

Deliverable:

- no semantic change in output persistence when clients come and go

### Phase 8: Patchflow budget and performance checks

Add explicit measurement for:

- time to first visible output
- number of notebook commits per run
- reconnect correctness
- output visibility to secondary viewers

Deliverable:

- automated evidence that we preserved fast UX and bounded patchflow

## Open Design Questions

1. Should final output always be durably written only at cell completion, or do
   we need optional sparse checkpoints for very long-running cells? ANS: we are storing the data durably in a dkv, so we don't need checkpoints.  We just make sure that deleting from the dkv only happens after a while (e.g, 7 days).   As long as something opens the notebook and the backend resolves things, this should be sufficient.  Definitely a case to imagine: long running valuable operation is half-way through; whole project is instantly killed.  User should not lose everything as long as the open the notebook within a couple of days.
2. How large should ephemeral live-output retention be for reconnect and late
   join?  Ans: a configurable parameter, but I think 1 week is a reasonable default.  Once the data is committed to the syncb though, then we remove it from ephemeral.  Regarding **size**, that is difficult -- it should just be a parameter, but 16MB might be a good starting default; ideally this should be user configurable (not a hard requirement for now).
3. What should the exact live-output truncation model be for very noisy cells? Ans: we have various policies in place now, so just try to emulate them.   The ideal policy is really **anything**, as long as it is easy for the user to configure/discover.  What we have now is I think NOT easy to configure.  
4. Do we want one run stream per notebook run or one stream per cell?  Ans: one per run, at least for now, since only one cell can run at a time (most kernels are single threaded).  Notebooks are already really confusing with out of order execution; having multiple cells at once is not a great idea.  (I know, it's landed in upstream jupyter, but I think it's pretty niche.)

## Success Criteria

This rewrite is successful if all of the following are true:

1. `Shift+Enter` on a simple cell still feels immediate.
2. A second viewer sees live output while the cell is running.
3. Closing the initiating browser does not suddenly increase notebook commits.
4. CLI and agents can run cells and observe live output without a browser.
5. Notebook timetravel remains clean and bounded instead of reflecting every
   output fragment.