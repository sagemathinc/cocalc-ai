# Process Monitoring Revamp Plan (Lite + Launchpad + macOS)

## 1. Goals

1. Make process monitoring cheap and accurate in `cocalc-lite`.
2. Keep launchpad/multiuser monitoring useful, but at a lower baseline cost.
3. Support macOS for lite mode without Linux-specific assumptions.
4. Add short-term history (last 60 minutes) with UI plots for CPU and memory.
5. Replace heuristic process classification with explicit metadata from process launch points.

## 2. Current State (Reviewed)

### Frontend consumer

- Polling hook: [src/packages/frontend/project/info/use-project-info.ts](./src/packages/frontend/project/info/use-project-info.ts)
  - Calls `project-info.get()` every 4 seconds.
- Main UI: [src/packages/frontend/project/info/project-info.tsx](./src/packages/frontend/project/info/project-info.tsx)
- Full view and process table: [src/packages/frontend/project/info/full.tsx](./src/packages/frontend/project/info/full.tsx)
- Shared process/info components: [src/packages/frontend/project/info/components.tsx](./src/packages/frontend/project/info/components.tsx)
- UI state types: [src/packages/frontend/project/info/types.ts](./src/packages/frontend/project/info/types.ts)

### Backend/server model

- Project info producer loop: [src/packages/project/project-info/server.ts](./src/packages/project/project-info/server.ts)
- Process snapshot implementation (Linux `/proc` full scan): [src/packages/backend/process-stats.ts](./src/packages/backend/process-stats.ts)
- Conat service exposure (`get` only): [src/packages/conat/project/project-info.ts](./src/packages/conat/project/project-info.ts)
- Shared payload type: [src/packages/util/types/project-info/types.ts](./src/packages/util/types/project-info/types.ts)

### Storage primitive for history

- Async KV API suitable for server-side samples and client reads: [src/packages/conat/sync/akv.ts](./src/packages/conat/sync/akv.ts)

## 3. Key Design Decision

Use **owned-root process tracking** as the primary model:

- Track processes launched by CoCalc (terminal, jupyter, codex/agent runners, exec-stream jobs, etc.) as roots.
- Dynamically include descendants of those roots.
- Attach trusted metadata at root registration time (`kind`, `path`, `thread_id`, etc.).

Why:

- Accurate classification without brittle heuristics.
- Much lower scanning scope in lite mode.
- Cross-platform feasible (Linux + macOS) because root metadata is independent of OS process APIs.

## 4. Architecture

## 4.1 Process Scope Modes

Add scope mode in project-info server:

- `owned` (default for lite): roots launched by CoCalc + descendants.
- `all` (default for launchpad/multiuser): full process snapshot behavior.
- `off` (already supported in lite via `COCALC_ENABLE_PROJECT_INFO=0`).

Proposed env var:

- `COCALC_PROJECT_INFO_SCOPE=owned|all|off`

## 4.2 Registry

Create `OwnedProcessRegistry` singleton (project package):

- `registerRoot(meta) -> root_id`
- `attachPid(root_id, pid, start_time)`
- `markExited(root_id, pid)`
- `listActiveRoots()`

Root metadata shape (minimum):

- `root_id`
- `kind` (`terminal`, `jupyter`, `exec`, `codex`, `x11`, etc.)
- `path?`
- `thread_id?`
- `session_id?`
- `spawned_at`
- `pid`
- `start_time` (for PID reuse safety)

## 4.3 Process Snapshot Providers

Define provider interface:

- `snapshotAll()` for `scope=all`
- `snapshotOwned(roots)` for `scope=owned`
- `childrenOf(pid)` helper where efficient

Implementations:

- `LinuxProcfsProvider`
  - Uses `/proc`.
  - For owned mode: walk descendants from roots and read only needed PIDs.
- `DarwinPsProvider`
  - Uses `ps` snapshot (`pid,ppid,pgid,%cpu,rss,etimes,comm,args` as needed).
  - Build parent/child map in memory, then filter by owned roots.

## 4.4 ProjectInfo payload extension

Keep existing `ProjectInfo` fields and add optional provenance:

- `scope?: "owned" | "all"`
- `process_count?: { visible: number; total?: number }`

For each process, optional explicit metadata field:

- `origin?: { kind: string; path?: string; thread_id?: string; session_id?: string; root_id?: string }`

This is additive and backward compatible.

## 4.5 History Storage (60-minute window)

Keep one sample per minute (configurable).

Data model (AKV keys):

- `v1/history/minute/<minuteEpoch>`
  - Value:
    - `timestamp`
    - `scope`
    - `project`: `{ cpu_pct, mem_rss, mem_tot, disk_usage, nprocs }`
    - `processes`: map keyed by stable process id (`pid:start_time`) with `{ cpu_pct, mem_rss, kind?, path?, root_id? }`
- `v1/history/meta`
  - schema/version info

Retention:

- Set TTL for each minute key (`2h`, configurable), so old data self-prunes.
- UI requests only last 60 samples (configurable window).

Rationale:

- Write path is simple (1 key/minute).
- Read path is simple (list minute keys in range).
- Preserves per-process minute samples as requested.

Required tunables (config/env):

- history window minutes (default `60`)
- sample cadence seconds (default `60`)
- history key TTL seconds (default `7200`)
- per-minute process cap/top-N for history (default `50`)

Adaptive collection:

- If there are no active process-info consumers (no recent `project-info.get` or `getHistory` requests), reduce realtime/process sampling cadence further.
- Keep watchdog visibility for active viewers vs. passive mode.

## 4.6 Conat API extension

Extend [src/packages/conat/project/project-info.ts](./src/packages/conat/project/project-info.ts) service API:

- `get()` existing
- `getHistory({ minutes?: number })`

Client helper in same module:

- `getHistory({ project_id, minutes })`

## 5\. Frontend Plan

## 5.1 Data hooks

- Keep `useProjectInfo` for realtime table.
- Add `useProjectInfoHistory` in [src/packages/frontend/project/info](./src/packages/frontend/project/info):
  - Poll every 30s (or on tab visibility + interval + user clicking "refresh").
  - Fetch last 60 minutes.

## 5.2 UI additions

In full view ([src/packages/frontend/project/info/full.tsx](./src/packages/frontend/project/info/full.tsx)):

- Add compact CPU and memory time-series cards near existing cgroup bars.
- Optionally add small process-count trend.
- Add overall CPU usage trend line aggregated across all visible monitored processes.

In process modal ([src/packages/frontend/project/info/components.tsx](./src/packages/frontend/project/info/components.tsx)):

- Show 60-minute sparkline for selected process when present in history.

## 5.3 Graceful behavior

- If history unavailable, UI silently hides chart section.
- Keep current table/actions unchanged.

## 6\. Integration Points for Root Registration

Register at process launch boundaries:

- Terminal server manager.
- Jupyter kernel/process launch path.
- Exec-stream or code-exec runners.
- Codex/ACP subprocess launch paths.
- Any explicit spawn utility used by project runtime.

Rule:

- Register only roots explicitly spawned by CoCalc runtime.
- Descendants discovered automatically by provider.

## 7\. Performance Guardrails

1. In `scope=owned`, skip process scanning entirely when no active roots.
2. Keep project-info interval configurable (`COCALC_PROJECT_INFO_INTERVAL_S`), default `7` in launchpad.
3. For history writes, batch once per minute by default and avoid per-process extra writes.
4. Add watchdog fields for:
   - `projectInfo.scope`
   - `projectInfo.visibleProcesses`
   - `projectInfo.historyWriteMs`
   - `projectInfo.activeViewers`

## 8\. Cross-Platform Notes (Linux + macOS)

- Linux: `/proc` path remains fastest for owned/all modes.
- macOS: `ps` snapshot provider; no `/proc` dependency.
- Root metadata origin classification works identically on both OSes.
- Use `pid + start_time` identity where possible to avoid PID reuse corruption.

## 9\. Commit Plan (Concrete)

## Commit 1: Scope plumbing + provider abstraction

- Add scope config and provider interface.
- No behavior change yet (default remains current behavior where enabled).

## Commit 2: OwnedProcessRegistry core

- Add registry module + tests.
- No caller integration yet.

## Commit 3: Linux owned-scope collector

- Implement descendant walk from registered roots.
- Add tests for tree filtering and stale PID pruning.

## Commit 4: Wire first launch points

- Register terminal + jupyter roots.
- Verify process table classification origin fields.

## Commit 5: Wire remaining launch points

- Register exec-stream/codex/other spawners.
- Add coverage assertions/logging for unregistered launches.

## Commit 6: History writer + AKV retention

- Add minute sampler and AKV persistence.
- Add backend tests for TTL + key shape.
- Use `akv(..., { ephemeral: true })` for lite-mode history persistence.
- Store top-N processes per sample (by CPU, with memory tie-break).

## Commit 7: Conat `getHistory` API

- Add server + client API methods.
- Backward compatible with existing `get()`.

## Commit 8: Frontend history hook + charts

- Add `useProjectInfoHistory` and UI charts in full view.
- Add optional process sparkline in modal.

## Commit 9: Darwin provider

- Implement macOS provider + unit tests.
- Keep behind runtime OS detection.

## Commit 10: Defaults/cutover

- Lite default `scope=owned`, launchpad default `scope=all` + 7s.
- Final docs and runbook update.

## 10. Acceptance Criteria

1. Lite idle CPU remains low with no active roots.
2. Lite process table shows only CoCalc-owned process trees (roots + descendants).
3. Classification labels are explicit and stable (no heuristic guessing required).
4. Last-60-minute CPU/memory charts render in frontend.
5. macOS lite mode supports owned-scope process monitoring.
6. Launchpad continues to provide all-process visibility at reduced refresh cost.

## 11. Open Questions

1. Decide the initial top-N default for history process samples (`N=50` proposed).
2. Decide whether adaptive idle cadence should be request-count based, or a simple \"last viewer seen at\" timeout model (`60s` proposed).

## 12. Implementation Progress

- [x] Commit 1: scope plumbing + provider abstraction.
- [x] Commit 2: owned-process registry core.
- [x] Commit 3: linux owned-scope collector.
- [x] Commit 4: terminal + jupyter launch-point wiring.
- [x] Commit 5: remaining launch-point wiring (exec/codex/x11 via backend bridge).
- [x] Commit 6: history writer + AKV retention.
- [x] Commit 7: conat `getHistory` API.
- [x] Commit 8: frontend history hook + trend charts.
- [x] Commit 9: darwin owned-scope provider + tests.
- [~] Commit 10: defaults/cutover.
  - [x] Scope default now resolves to `owned` for lite and `all` for launchpad.
  - [ ] Lite still explicitly disables process-info services in `lite/main.ts` for performance unless re-enabled.
