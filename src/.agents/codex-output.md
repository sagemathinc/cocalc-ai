# Codex Output Rewrite Plan

## Problem

Current ACP/Codex chat output mixes two very different concerns:

- durable conversation history in the `.chat` file and patchflow
- ephemeral live turn state while a turn is running

This causes a severe performance and history-quality bug:

- the assistant message row is mutated continuously during streaming
- patchflow records a huge number of commits for one turn
- timetravel becomes noisy and expensive
- real work becomes impractical on long or verbose turns

The desired architecture is:

- `.chat` state changes only a small, bounded number of times per turn
- live activity/output updates come from DKV/ACP log state only
- the UI still feels fully realtime

## Goals

1. Separate durable chat state from ephemeral live turn state.
2. Keep realtime UX for:
   - activity log
   - visible in-progress agent output
   - running/last-activity status
3. Reduce patchflow commits for a full Codex turn to a small bounded number.
4. Preserve correct terminal behavior for:
   - success
   - error
   - interrupt
   - loop/schedule turns
5. Make the implementation explicit enough that we do not drift back into per-token document writes.

## Non-Goals

1. Do not redesign the underlying Codex activity schema in this project.
2. Do not remove the activity log DKV path.
3. Do not try to preserve token-by-token generation in timetravel.
4. Do not optimize app-server process reuse here.

## Related Future Work

All of the same architectural problems also arise with Jupyter notebook output:

- high-frequency live output should not imply high-frequency durable history
- realtime rendering and durable notebook state should be separated
- a similar ephemeral-vs-durable design will likely be needed there too

That is out of scope for this rewrite, but we should return to it later with a
parallel design.

## Target Architecture

### Durable `.chat` / patchflow state

This is the only state that should be written into the collaborative chat file.

Per turn, durable state should include only:

- the human message
- the assistant placeholder row / turn envelope
- minimal durable turn status transitions if needed
- the final assistant summary or terminal error/interrupted result
- final session/thread metadata updates
- loop/schedule bookkeeping if applicable

During streaming, the `.chat` file should otherwise stay unchanged.

### Ephemeral live turn state

This should live outside patchflow, in the existing ACP log / DKV path.

It should contain:

- full activity log events
- all in-progress `agent` messages
- evolving final summary text
- running/started/last-activity timestamps
- live terminal markers before durable finalization

This state may update frequently.
It should not create collaborative document history churn.

### Frontend render model

While a turn is running, the frontend should render the assistant row as a composition of:

- durable placeholder row from `.chat`
- ephemeral live state from DKV for that assistant message / turn id

The visible UI should show:

- running status
- last activity
- all live `agent` messages for the turn
- the evolving final summary text
- the activity log panel

When the turn completes, the frontend should:

- switch the main chat row back to the durable final summary only
- keep the full activity log accessible behind the activity button

## Required Behavioral Changes

### 1. Stop patchflow writes for streaming content

Current behavior to remove:

- updating the main assistant message content on every summary delta / word / chunk
- persisting per-token or near-per-token live state into SyncDB rows

New behavior:

- live summary text stays in DKV only until finalization
- live agent messages stay in DKV only until finalization
- SyncDB row is updated only at bounded lifecycle points

### 2. Keep activity-log persistence incremental, but off-patchflow

The ACP log path is the correct place for frequent writes.

We should keep:

- incremental DKV persistence for activity log
- activity log replay after refresh / reconnect

We should add throttling to reduce network chatter:

- DKV writes should be coalesced
- UI should also coalesce renders

These are separate throttles and both are required.

### 3. Render all live `agent` messages in the main chat during the turn

Current behavior only showing the latest `agent` message is too lossy.

During a running turn, show all `agent` messages derived from ephemeral turn state.

After terminalization:

- hide the live stack from the main chat row
- keep the final summary as the durable visible row
- preserve the full activity log behind the panel

### 4. Finalization must be explicit and one-way

At terminal state:

- resolve the durable final summary
- write it once into the assistant message row
- clear `generating`
- mark terminal state
- flush any final thread/session metadata

After that, the row must no longer depend on live streaming data to display correctly.

## Concrete Implementation Plan

### Phase 1: Identify and isolate all patchflow writes made during streaming

Audit the current `ChatStreamWriter` path and list every write that touches SyncDB or chat rows during a running turn.

Expected hotspots:

- main assistant row content updates
- `generating` / status mutations
- thread-config/session persistence
- interrupt/error/summary transitions

Deliverable:

- a precise list of writes grouped by:
  - must remain durable
  - must move to DKV
  - can be deleted entirely

### Phase 2: Define the ephemeral turn-view model

Create an explicit frontend-facing live turn model derived from DKV/ACP log data.

It should expose:

- `runningSince`
- `lastActivityAt`
- `agentMessages[]`
- `liveSummaryText`
- `terminalState`
- `activityEvents[]`

This should be the source of truth for in-progress rendering.

Deliverable:

- a typed view-model boundary between DKV events and the React chat row

### Phase 3: Rewrite backend streaming path to stop mutating chat rows

Change backend ACP streaming so that during a running turn:

- activity events are published/persisted to DKV
- live summary text is published/persisted to DKV
- live agent messages are published/persisted to DKV
- chat SyncDB rows are not rewritten for each delta

Allowed durable writes during the running phase should be minimal and intentional.

Deliverable:

- one backend path where streaming updates never call into per-delta chat-row persistence

### Phase 4: Rewrite frontend chat rendering around durable + ephemeral composition

The message row should:

- read the durable placeholder row from SyncDB
- subscribe to ephemeral turn state from DKV
- render live agent output and live summary while running
- fall back cleanly after refresh

The activity panel should continue to read from the same DKV source.

Deliverable:

- one coherent render path where main chat output and activity panel are projections of the same ephemeral state

### Phase 5: Add write throttling for DKV

Implement explicit coalescing for high-frequency activity/summary writes.

Target:

- do not write to DKV on every individual word
- batch on a short cadence

Initial target:

- summary-text DKV flush cadence around 50-150ms
- activity-log incremental persistence cadence around 100-250ms unless terminal flush

Exact numbers may be tuned later, but they must be constants with comments.

### Phase 6: Add render throttling in frontend

Even with DKV fixed, the UI should not rerender on every tiny delta.

Render updates should be coalesced so the experience is smooth but not noisy.

Deliverable:

- controlled React update cadence for live summary / agent-message rendering

### Phase 7: Harden terminal semantics

Verify success, error, and interrupt behavior under the new model.

Specifically:

- final summary must not be lost if interrupt arrives during terminal writeout
- interrupted turns must not leave the row visually `running`
- reconnect/reload during running turn must restore live state from DKV
- reconnect/reload after terminalization must show correct durable state even if DKV is gone

### Phase 8: Instrument and enforce patchflow-commit budgets

Add measurement so we can assert how many patchflow commits a turn causes.

We need:

- development logging of commits per turn
- at least one automated smoke/assertion
- clear visibility when regressions occur

This is a release blocker.

## Success Criteria

### Functional

1. While a turn is running, the user sees:
   - realtime activity log
   - realtime visible summary text
   - all live `agent` messages
   - running/last-activity status
2. After the turn finishes, the main chat row shows only the final durable summary.
3. The activity panel still exposes the full activity log for that turn.
4. Refresh during a running turn restores the live view from DKV.
5. Refresh after completion shows the final durable summary correctly even without live DKV state.

### Patchflow budget

For a normal single Codex turn, start to finish:

- target: `<= 6` patchflow commits
- hard ceiling: `<= 10` patchflow commits

This count should include:

- user row creation
- assistant placeholder/start
- terminal summary/error/interrupted write
- final metadata updates

It must not scale with number of streamed words or tokens.

### Performance

1. A long final summary must not create hundreds or thousands of patchflow commits.
2. DKV write rate must be throttled enough to avoid wasteful per-word network spam.
3. Frontend rendering must remain smooth without per-word React churn.

## Risks

1. Reconnect logic may accidentally depend on durable rows that we stop updating during the turn.
2. Terminalization may race with interrupt/error handling.
3. Existing UI may implicitly assume the latest live text is in the SyncDB row.
4. Loop/schedule automation paths may be relying on intermediate durable row writes.

## Required Tests

1. Running turn with long streamed summary:
   - patchflow commits stay under budget
2. Running turn with many `agent` messages:
   - all are visible live
   - none are durably written as separate chat-history churn
3. Interrupt during final summary:
   - terminal row is correct
   - no stuck `running` state
4. Reload while running:
   - live output and activity log recover from DKV
5. Reload after completion:
   - final summary remains correct from durable row
6. Loop/schedule turn:
   - durable bookkeeping still correct

## Migration Rule

Do not try to preserve the old per-delta patchflow behavior.

The rewrite should be explicit:

- durable chat history becomes intentionally sparse
- live turn rendering becomes intentionally DKV-driven

That is the point of the change.

