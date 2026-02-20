# Jupyter Performance and Reliability Optimization Plan

This document is the working backlog for improving Jupyter execution speed and robustness in CoCalc Lite / Launchpad.

## Goals

1. Make simple evaluations (e.g. `2+3`) feel near-instant.
2. Eliminate output loss, stuck-running UI states, and flicker under heavy streaming output.
3. Keep collaborative behavior correct (multi-client, reconnects, browser refreshes, long-running cells).
4. Measure everything so optimization work is driven by data.
5. Prioritize low latency for the browser/client that initiated a run; collaborator views can be slower.

## Success Metrics

### Simple Eval Latency

1. `2+3` end-to-end latency:
   1. `p50 <= 120ms` on local/nearby network.
   2. `p95 <= 250ms` on local/nearby network.
2. On higher-latency links, overhead above ping should be minimized:
   1. `eval_latency <= ping_rtt + 120ms` target.

### Initiator vs Collaborator Latency

1. Run-initiating client should get first output with minimum latency.
2. Collaborator clients may receive/render updates later if it reduces total load and improves initiator responsiveness.
3. The system does not need strict symmetry in output timing across clients.

### Streaming Output Reliability

1. No missing final output for high-volume cells.
2. No stuck-running visual state after kernel completes.
3. No output disappearance after briefly showing.

### Streaming UX

1. No clear/repaint flicker for incremental output patterns like:

```python
from time import sleep
for i in range(10000):
    print(i,end=' ')
    sleep(0.01)
```

2. Stable scroll and cell height behavior while output grows.

## Current Execution Path (High Level)

1. Frontend `runCells` in [src/packages/frontend/jupyter/browser-actions.ts](./src/packages/frontend/jupyter/browser-actions.ts).
2. Conat client/server stream protocol in [src/packages/conat/project/jupyter/run-code.ts](./src/packages/conat/project/jupyter/run-code.ts).
3. Project-side run/control in [src/packages/jupyter/control.ts](./src/packages/jupyter/control.ts).
4. Kernel execution and output handling in [src/packages/jupyter/execute/output-handler.ts](./src/packages/jupyter/execute/output-handler.ts).
5. Sync + notebook persistence via syncdb and ipynb save/watch paths.

## Immediate Context

1. A critical frontend stuck-running race was fixed by forcing final output-state flush on handler `done`.
2. Debug logging was made low-overhead when disabled and should stay enabled while we tune performance.
3. There is still architectural opportunity to reduce patch churn and avoid full output rewrites.
4. Conat virtual sockets already provide reliability/ordering semantics (seq/ack/missing/resend) at the transport layer.

## Progress Snapshot (2026-02-16)

Completed:

1. [x] Benchmark harness exists in lite mode via [src/packages/lite/jupyter-benchmark.ts](./src/packages/lite/jupyter-benchmark.ts).
2. [x] Benchmark launcher now uses compiled dist script (not ts-node) for fast startup in [src/packages/lite/package.json](./src/packages/lite/package.json).
3. [x] Lite server connection discovery for benchmark is deterministic via pid/port connection-info:
   1. [src/packages/lite/main.ts](./src/packages/lite/main.ts)
   2. [src/packages/lite/connection-info.ts](./src/packages/lite/connection-info.ts)
4. [x] Server-side coalescing of adjacent `stream` messages is implemented in [src/packages/conat/project/jupyter/run-code.ts](./src/packages/conat/project/jupyter/run-code.ts).
5. [x] Coalescing behavior is covered by tests in [src/packages/backend/conat/test/project/jupyter/run-code.test.ts](./src/packages/backend/conat/test/project/jupyter/run-code.test.ts).
6. [x] Browser-path benchmark harness exists in lite mode via Playwright in [src/packages/lite/jupyter-browser-benchmark.ts](./src/packages/lite/jupyter-browser-benchmark.ts), with explicit `--base-url` / `--port` targeting.
7. [x] Playwright scroll/virtualization benchmark harness exists in lite mode in [src/packages/lite/jupyter-scroll-benchmark.ts](./src/packages/lite/jupyter-scroll-benchmark.ts), with scenario profiles and reliability checks.
8. [x] Scroll harness now also reports interaction metrics:
   1. open-to-first-cell / open-to-first-input / open-ready timings.
   2. typing-latency percentiles (`p50/p95/p99`) with timeout counts.
   3. CLI controls for typing sample size/timeouts.
9. [x] Scroll harness now has stronger determinism diagnostics for heavy notebooks:
   1. stale static-asset detection for virtualization instrumentation mismatch.
   2. phase-level in-page timeout watchdogs with explicit phase/error payloads.
   3. outer phase timeouts for open/typing/scroll so runs fail fast instead of hanging.

Observed benchmark impact from coalescing (output profile):

1. `burst_flush_write` message count dropped significantly (about `500 -> ~40-110` depending on settings/run).
2. `more_output` truncation for `burst_flush_write` was eliminated in measured runs (`1 -> 0`).
3. First-output latency stayed low.
4. Total wall-clock for `burst_flush_write` remains high (~1.5-1.8s), so more work is needed beyond transport-layer coalescing.

Next high-value focus:

1. Coalesce earlier in the project/kernel path (before run-code transport handling), so we reduce per-message processing overhead upstream.
2. Revisit throttling policy (`COCALC_JUPYTER_MAX_MSGS_PER_SECOND`) and whether it should be dynamic.
3. Continue append-oriented output updates in frontend/backend to reduce rewrite churn and flicker.

## Optimization Backlog

## A. Correctness and Protocol Robustness

1. Add explicit lifecycle protocol events:
   1. `cell_start` event with `run_id`, `cell_id`, `ts_server`.
   2. `cell_done` event with `run_id`, `cell_id`, `status`, `exec_count`, `ts_server`.
2. Add strict per-run sequencing:
   1. Include `run_id` on every streamed message.
   2. Optionally include a per-run `event_idx` only for app-level ordering/debug (not transport reliability).
   3. Frontend drops stale messages from older runs.
   4. Do not re-implement transport-level retransmit/ack logic in Jupyter protocol.
   5. If reliability/order semantics are ever violated, fix conat sockets (transport layer), not Jupyter protocol.
3. Add idempotent finalization:
   1. Frontend marks done on `cell_done` regardless of output content.
   2. Keep current forced flush as defense in depth.
4. Add explicit client cancel/replace semantics:
   1. If user reruns same cell quickly, ensure old run cannot overwrite new state.

## B. Output Streaming Architecture (Biggest UX and Throughput Win)

1. Move from full output-map rewrites toward append/delta updates:
   1. Current frequent writes can cause expensive sync patches and render churn.
   2. Use append-only chunk stream in-memory for live rendering.
2. Separate "live output transport" from "durable notebook state":
   1. Live path: fast, append-oriented, low-latency channel.
   2. Durable path: periodic compaction/snapshot for syncdb/ipynb.
3. Replace clear-and-rewrite behavior with stable incremental rendering:
   1. Never clear output once first chunk arrived unless explicit `clear_output` from kernel.
   2. Preserve DOM container and append text to avoid layout jumps.
4. Coalesce stream messages server-side:
   1. [x] Merge adjacent stdout/stderr chunks.
   2. [x] Reduce message count for print storms.
   3. [ ] Consider short-window/timer-based coalescing (e.g. 15-30ms) if needed after upstream coalescing work.
5. Add max-render budget per frame:
   1. Consume chunks in `requestAnimationFrame` batches.
   2. Backpressure UI rendering without losing backend stream data.

## C. Simple Eval Speed (`2+3`) Path

1. Build a latency budget (target numbers per stage):
   1. Frontend enqueue: 1-5ms.
   2. Conat request/dispatch: 5-20ms.
   3. Kernel scheduling + execute request: 5-20ms.
   4. First IOPub/shell response arrival: network + kernel.
   5. Frontend render: 5-20ms.
2. Minimize startup checks on hot path:
   1. Avoid repeated expensive readiness checks when known healthy.
   2. Cache hot handles where safe.
3. Reduce synchronous work on first output:
   1. Avoid heavy object cloning/stringification in the critical path.
   2. Defer nonessential bookkeeping to microtasks.
4. Ensure first chunk is not delayed by throttles:
   1. Keep fast first paint.
   2. Throttle only subsequent updates.
5. Prioritize initiator path:
   1. Initiator sees first output first.
   2. Secondary broadcasts to collaborators can be deferred/coalesced when needed.

## D. SyncDB and Save Strategy

Guiding principle: syncdb should contain durable collaborative notebook state, not transient backend runtime telemetry.

1. Reduce save/write amplification:
   1. Avoid large full-output object writes on every incremental chunk.
   2. Write compact checkpoints at controlled intervals.
2. Make save cadence adaptive:
   1. High-output cells: lower checkpoint rate while running.
   2. On done: immediate final checkpoint.
3. Add explicit output-compaction step:
   1. Coalesce many tiny text stream entries into fewer larger records.
   2. Trigger on idle or completion.
4. Move ephemeral backend/runtime state out of syncdb:
   1. Kernel idle/running transitions should be ephemeral channel data, not durable document state.
   2. Resource telemetry (CPU, memory, etc.) should use pub/sub or ephemeral KV.
   3. Keep syncdb focused on long-term notebook collaboration state.

## E. Frontend Rendering and State Management

1. Audit cell re-render triggers:
   1. Ensure only active cell/output subtree rerenders.
   2. Avoid notebook-wide invalidations.
2. Add output virtualization for large outputs.
3. Keep output container height stable while appending to reduce visual bounce.
4. Add cheap output mode for massive streams:
   1. Auto-switch to chunked text view above threshold.
   2. Allow expand/backfill for full fidelity.

## F. Transport and Backpressure

1. Validate conat buffer behavior under sustained output.
2. Track dropped/retried writes and `ENOBUFS` frequency.
3. Introduce adaptive batching based on socket pressure.
4. Verify existing conat/socket.io compression settings before adding protocol-level compression.
5. Avoid redundant compression work if transport compression already provides benefit.

## G. Instrumentation and Benchmarking

Keep logging for now, but make it structured and cheap.

1. Add run-level tracing fields everywhere:
   1. `run_id`, `cell_id`, optional `event_idx`, `ts_client_send`, `ts_server_recv`, `ts_kernel_start`, `ts_first_output`, `ts_done`.
2. Emit one summary line per run:
   1. end-to-end latency.
   2. first-output latency.
   3. total output messages and bytes.
   4. frontend render time estimate.
3. Benchmark scenarios to run repeatedly:
   1. `2+3` micro-latency.
   2. `print('x'*1000000)` single massive output.
   3. `for i in range(100000): print(i,end=' ')` bursty stream.
   4. `sleep` loop stream (flicker reproducer).
   5. open-to-first-view and typing-latency benchmarks on large notebooks.
4. Add network shaping test profile:
   1. 20ms, 80ms, 150ms RTT.
   2. modest packet loss/jitter profile.
5. Add pass/fail smoke assertions:
   1. no stuck-running after done.
   2. output monotonic growth for stream tests.

## H. Output Policy and User Controls

Large-output behavior should be robust and easy to control.

1. Review current large-output strategy against common patterns used by Jupyter/JupyterLab and related tools.
2. Expose output policy controls directly in notebook UI (not hidden settings):
   1. Proposed: per-cell output modal/action menu with truncation/retention controls.
   2. Make policies discoverable at the moment users encounter truncation or lag.
3. Prefer explicit opt-in/out controls over surprising hard thresholds.
4. Use aggressive defaults only if users can quickly override them per notebook/cell.

## I. Collaboration and Reconnect Semantics

1. Define authoritative run ownership semantics per client.
2. On browser refresh/reconnect:
   1. recover active run state.
   2. replay incremental outputs without wiping visible content.
3. Ensure multiple viewers do not race to overwrite shared cell state.

## J. Proposed Implementation Order

### Phase 0: Measurement First

1. Add run summary metrics and trace ids.
2. Create repeatable benchmark script and baseline results table.
3. Add browser-path benchmark that targets a real running lite server (not only conat-level runs).

### Phase 1: Correctness Hardening

1. Protocol-level `cell_start` and `cell_done` events.
2. Per-run `run_id` (and optional `event_idx`) filtering.
   1. Note: transport reliability/order is already provided by conat virtual sockets.
   2. Protocol metadata here is for stale-run isolation and observability.
3. Keep forced final flush safeguard.

### Phase 2: Streaming UX

1. Remove clear/rewrite behavior causing flicker.
2. Append-only render path + stable container strategy.
3. Coalesce stream messages.

### Phase 3: Throughput and Persistence

1. Delta output model instead of full output rewrites.
2. Adaptive save/checkpoint/compaction.

### Phase 4: Latency Polish

1. Optimize `2+3` path from new traces.
2. Remove remaining overhead hotspots.

## K. Logging Policy During Optimization

1. Keep debug hooks in place while performance work is active.
2. Default mode remains off or low-volume.
3. Keep JSON mode available for reproducible bug reports.
4. After stabilization:
   1. keep run-summary metrics.
   2. gate verbose per-chunk logs behind explicit debug switch.

## L. Working Decisions and Remaining Questions

Working decisions:

1. Output durability during active runs can be eventual; strong consistency is primarily needed by run completion.
2. If browser vanishes mid-run, output may lag before durability (roughly seconds-level delay is acceptable).
3. Dedicated output stream data structure separate from cell docs is worth serious evaluation.
4. Do not use hard behavior thresholds that make notebooks feel unpredictably different by size.
5. Prefer explicit user controls (and optional notebook-level opt-in/out) for heavy performance modes.

Remaining questions:

1. Best default retention/truncation policy for very large output across local and remote use.
2. Exact UI shape/location for output policy controls (cell toolbar vs output panel modal vs notebook settings).
3. Whether virtualization should auto-suggest enablement or remain manual opt-in until confidence is very high.

## M. Initial Task List (Actionable)

1. [x] Add run summary timing logs with stable `run_id`.
2. [ ] Add protocol `cell_done` and frontend handler for authoritative completion.
3. [ ] Change output update path to append without clear/repaint.
4. [x] Add benchmark notebook/script and record baseline for:
   1. `2+3` p50/p95.
   2. three high-output scenarios above.
5. [ ] Audit and migrate ephemeral runtime syncdb fields (kernel state, telemetry) to ephemeral channels.
6. [ ] Add first-pass output policy UI entry point for per-cell truncation/retention controls.
7. [x] Add Playwright scroll benchmark harness for large notebook virtualization reliability checks.

## N. Notebook Virtualization (React-Virtuoso) and Stateful HTML Outputs

This is a high-impact optimization for large notebooks (500-1000+ cells), but must be done without breaking stateful HTML/Javascript outputs.

### Problem Statement

1. Full DOM rendering of large notebooks causes lag, long layout/reflow times, and expensive React updates.
2. Standard virtualization unmounts off-screen cells, which breaks outputs that assume persistent DOM identity.
3. Many Jupyter visualization outputs are stateful:
   1. Plotly and similar libraries keep JS state bound to DOM nodes.
   2. JS in one cell may reference DOM in another cell.
   3. Unmount/remount can break event handlers, references, and internal widget state.

### Desired Outcome

1. Virtualization ON by default for large notebooks.
2. Smooth scrolling and editing even with heavy output.
3. No regressions for stateful HTML outputs.

### Proposed Architecture: Two-Plane Rendering

Use two rendering planes:

1. Notebook plane (virtualized):
   1. Input/editor regions and lightweight outputs render in virtualized rows.
   2. Off-screen rows can be unmounted safely.
2. Output persistence plane (non-virtualized overlay/host):
   1. Stateful HTML outputs remain mounted in a persistent DOM host.
   2. Visible rows show clipped/positioned views of these persistent outputs.
   3. Virtualization controls visibility/position, not mount lifecycle, for stateful outputs.

This is consistent with the existing “absolutely positioned + clipped HTML” direction, but should be formalized with clearer ownership/lifecycle.

### Output Classification Strategy

Classify outputs into render modes:

1. `ephemeral`:
   1. Plain text, markdown, static images.
   2. Safe to virtualize normally (mount/unmount).
2. `persistent`:
   1. Known stateful HTML/JS outputs.
   2. Render in persistent host and project into row viewport.
3. `auto`:
   1. Default heuristics based on mimetype/output metadata.
   2. Fall back to `persistent` if uncertain.

### Low-Risk Rollout Plan

1. Keep feature-gated (`virtualize_notebook` flag), but improve reliability until default-on.
2. Start with `ephemeral` virtualization only:
   1. Virtualize notebooks where outputs are mostly text/static.
   2. Auto-disable per-cell virtualization for detected stateful outputs.
3. Introduce persistent output host for `persistent` class.
4. Add hard fallback:
   1. If output host invariants fail, disable virtualization for that notebook session.

### Robustness Requirements

1. Stable DOM IDs for persistent outputs across scroll and rerender.
2. Deterministic mount/unmount policy:
   1. Persistent outputs mount once and unmount only on cell delete/notebook close.
3. Correct geometry sync:
   1. Position/clipping updates must be tied to scroll + resize + cell height changes.
4. Selection/focus correctness:
   1. Keyboard focus, context menu, and click targets behave identically in both modes.
5. Collaboration correctness:
   1. Remote edits/output updates do not desynchronize host mapping.

### Instrumentation for Virtualization

Add measurements specifically for virtualized mode:

1. Scroll FPS and long-frame counts.
2. Time-to-first-visible-cell and time-to-first-output render.
3. Number of mounted DOM nodes (baseline vs virtualized).
4. Reflow/layout costs during rapid output updates.
5. Error counters for host mapping mismatches.

### Benchmark Scenarios for Virtualization

1. 1000-cell mixed notebook:
   1. 70% code/text, 20% plots, 10% rich HTML.
2. Plot-heavy notebook with cross-cell JS references.
3. Live-streaming notebook with many updating outputs.
4. Notebook with frequent cell insert/delete/move while scrolled mid-document.

### Acceptance Criteria

1. Large notebooks show clearly lower input latency and smoother scroll.
2. No broken Plotly/widget output after long scrolling or reruns.
3. No output disappearing due to virtualization transitions.
4. Virtualization can remain enabled for full session without needing manual reset.

### Suggested Implementation Sequence (After Low-Hanging Fruit)

1. Formalize output classification and add per-cell virtualization mode.
2. Add persistent output host abstraction with strict lifecycle tests.
3. Integrate host geometry sync with virtuoso row measurements.
4. Add notebook-level watchdog + graceful fallback.
5. Run benchmark matrix and flip default for large notebooks.

## O. Virtualization Reliability Matrix (Playwright)

Harness:

1. [src/packages/lite/jupyter-scroll-benchmark.ts](./src/packages/lite/jupyter-scroll-benchmark.ts)
2. Script entrypoint in [src/packages/lite/package.json](./src/packages/lite/package.json): `jupyter:bench:scroll`

Run commands:

1. Quick profile:

```bash
pnpm -C src/packages/lite jupyter:bench:scroll -- --profile quick
```

2. Full profile:

```bash
pnpm -C src/packages/lite jupyter:bench:scroll -- --profile full
```

3. Single-scenario debugging:

```bash
pnpm -C src/packages/lite jupyter:bench:scroll -- --profile quick --scenario mixed_280 --headed
```

4. Force virtualization mode for A/B testing:

```bash
pnpm -C src/packages/lite jupyter:bench:scroll -- --profile quick --virtualization on
pnpm -C src/packages/lite jupyter:bench:scroll -- --profile quick --virtualization off
```

The harness forces mode by adding `jupyter_virtualization=on|off` to notebook URLs.

Current matrix dimensions:

1. `text_400` (quick)
2. `mixed_280` (quick)
3. `text_1200` (full)
4. `mixed_700` (full)

For each scenario, the harness reports:

1. Scroll duration.
2. Approximate FPS and frame p95.
3. Long task count/max.
4. DOM cell counts at top/mid/bottom positions.
5. Marker visibility at top/bottom before and after repeated scroll cycles.
6. A `virtualization_likely` heuristic and overall reliability pass/fail.

Initial interpretation guidance:

1. If `DOM T/M/B` is much lower than total cell count, virtualization is likely active.
2. Reliability requires:
   1. top marker visible after cycles,
   2. bottom marker visible after cycles,
   3. nonzero max scroll range.
3. Regressions worth immediate investigation:
   1. marker disappears after cycles,
   2. long task spikes with low FPS,
   3. DOM counts unexpectedly near full cell count when virtualization should be active.

Sample run notes (2026-02-16, single local machine):

1. `text_400` and `mixed_280` both passed reliability checks.
2. DOM counts were equal to total cell count (`T/M/B ~= total`), indicating virtualization was not active in that run configuration.
3. This harness is therefore already useful to validate reliability and to confirm whether virtualization is actually engaged.
