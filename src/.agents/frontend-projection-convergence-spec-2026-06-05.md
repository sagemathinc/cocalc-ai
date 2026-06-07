# Frontend Projection Convergence Spec, 2026-06-05

Status: implementation spec for P0-A in
[public-release-bug-burn-plan-2026-06-04.md](./public-release-bug-burn-plan-2026-06-04.md)

Primary goal:

- The browser may keep large client-side projections for speed, but no
  user-visible surface may silently remain stale after the network and backend
  are healthy.

Non-goal:

- Do not rebuild the old full SyncTable semantics in the browser.
- Do not load every project for large accounts just to repair a visible page.
- Do not make the hub/control plane carry steady-state project data-plane
  traffic.

## Background

CoCalc-ai moved account-facing browser reactivity away from many Postgres
`LISTEN/NOTIFY`-backed table changefeeds toward one home-bay account feed:

- [account-feed.ts](../packages/conat/hub/api/account-feed.ts)
- [account-dstream.ts](../packages/frontend/conat/account-dstream.ts)

This is the right backend direction for multibay scale:

- one account has a home bay,
- browser control-plane state comes from the home bay,
- project ownership/lifecycle remains authoritative on the owning bay,
- account-facing project state is copied into projection tables such as
  `account_project_index`,
- browser reactivity comes from projection snapshots plus account-feed events.

The frontend transition is incomplete. It currently mixes:

- a warm `projects.project_map` cache,
- account-feed events,
- snapshot repairs,
- legacy no-changefeed `Table` wrappers,
- many direct `project_map` consumers,
- and some optimistic local Redux updates.

That hybrid can be correct, but only if the contract is explicit.

## Current Code Inventory

### Shared account feed

Account-feed event contract:

- [account-feed.ts](../packages/conat/hub/api/account-feed.ts)
- stream name: `account-feed`
- config: `max_msgs: 1000`, `max_age: 15 * 60 * 1000`,
  `max_bytes: 4 * 1024 * 1024`
- event families:
  - `account.upsert`
  - `project.upsert`
  - `project.remove`
  - `project.detail.invalidate`
  - `notification.*`
  - `collaborator.*`
  - `news.refresh`
  - `lro.summary`

Frontend shared DStream cache:

- [account-dstream.ts](../packages/frontend/conat/account-dstream.ts)
- shares one DStream per stable option set
- closes streams on sign-out / remember-me failure / account switch
- no feed-specific heartbeat option exists today

DStream/CoreStream properties:

- [dstream.ts](../packages/conat/sync/dstream.ts)
- [core-stream.ts](../packages/conat/sync/core-stream.ts)
- DStream events include:
  - `change`
  - `history-gap`
  - `recovery-state`
  - `disconnected`
  - `recovering`
  - `paused`
  - `recovered`
- CoreStream tracks sequence numbers and requests recovery when it detects
  missed persistent sequence numbers.
- On reconnect, CoreStream fetches from `lastSeq + 1`.
- If retained history starts after the requested seq, CoreStream emits
  `history-gap`.

Important implication:

- The stream can detect many missed feed messages, but it cannot prove that
  every backend write emitted a feed event or that every frontend consumer
  merged the event correctly.

### Account row projection

Current files:

- [account/table.ts](../packages/frontend/account/table.ts)
- [account/actions.ts](../packages/frontend/account/actions.ts)
- [account/table-bootstrap.ts](../packages/frontend/account/table-bootstrap.ts)

Current behavior:

- `AccountTable.no_changefeed()` returns true.
- Initial account state comes from an account table snapshot.
- `account.upsert` events call `applyAccountPatch`.
- `history-gap` forces `refreshAccountSnapshot`, which recreates the account
  table.
- Account setting writes now wait for projected key convergence and force an
  account snapshot refresh if the feed does not update the store.

Remaining risk:

- Many account actions still write via `set_account_table(...)` without a
  formal per-action acknowledgement model.
- Account feed diagnostics are not surfaced in `cocalcSyncDiagnostics()`.

### Project list projection

Current files:

- [projects/actions.ts](../packages/frontend/projects/actions.ts)
- [projects/table.ts](../packages/frontend/projects/table.ts)
- [projects/store.ts](../packages/frontend/projects/store.ts)
- [projects/use-project-table-records.ts](../packages/frontend/projects/use-project-table-records.ts)
- [projects/projects-page.tsx](../packages/frontend/projects/projects-page.tsx)
- [projects/util.tsx](../packages/frontend/projects/util.tsx)

Current behavior:

- `ProjectsTable.no_changefeed()` returns true.
- Initial state still uses a `projects` table wrapper, but the active live path
  is account feed plus `account_project_index`.
- `ensureRealtimeFeedForCurrentAccount()` opens the shared account feed.
- `project.upsert` and `project.remove` mutate `projects.project_map`.
- `history-gap` currently calls:
  - `refresh_projects_table()`
  - `loadProjectedProjectsForCurrentAccount(account_id)`
- `loadProjectedProjectsForCurrentAccount` loads at most
  `PROJECTED_PROJECT_BOOTSTRAP_LIMIT = 2000`.
- `loadProjectedProjectForCurrentAccount(project_id)` repairs one project row.
- Recent fix: project start schedules lifecycle reconciliation against one
  `account_project_index` row while local state remains optimistic `starting`.

Important large-account risk:

- The full projects page still computes `all_projects` and `visible_projects`
  from `project_map`.
- For accounts with more than 2000 projected projects, `project_map` is not a
  complete representation.
- A full history-gap repair must not blindly load 15,000 projects into the
  browser.

### Project detail fields

Current files:

- [project/use-project-field.ts](../packages/frontend/project/use-project-field.ts)

Existing intended direction:

- `project_map` should become a small control-plane snapshot.
- Detail fields such as region, env, rootfs configuration, course data, backup
  config, etc. should move behind per-project detail hooks.
- Account-feed `project.detail.invalidate` events invalidate those detail
  caches.

This is aligned with the convergence model in this spec.

### Other account-feed consumers

Users/collaborators:

- [users/table.ts](../packages/frontend/users/table.ts)
- uses account feed collaborator events
- `history-gap` refreshes/recreates users table

News:

- [notifications/news/init.ts](../packages/frontend/notifications/news/init.ts)
- listens for `news.refresh`
- `history-gap` calls `actions.refresh()`

Mentions/notifications:

- [notifications/mentions/actions.ts](../packages/frontend/notifications/mentions/actions.ts)
- handles `notification.upsert`, `notification.remove`,
  `notification.counts`
- `history-gap` calls `refresh()`

LRO summaries:

- [lro/account-summary-feed.ts](../packages/frontend/lro/account-summary-feed.ts)
- handles `lro.summary`
- `history-gap` notifies listeners with `reset`; consumers bootstrap summaries
  again

### Reconnect/wake hooks

Current files:

- [conat/client.ts](../packages/frontend/conat/client.ts)

Current behavior:

- Browser online and foreground wake trigger hub/project-host probes and
  resource reconnects.
- This is a transport/resource recovery layer, not a semantic projection
  freshness layer.

### Diagnostics

Current files:

- [syncdoc-diagnostics.ts](../packages/frontend/syncdoc-diagnostics.ts)

Current behavior:

- Useful syncdoc/editor/redux/conat diagnostics exist.
- Projection-feed freshness diagnostics are not yet a first-class diagnostic
  object.

## Core Model

The frontend should use a hybrid model:

- warm client projection for speed,
- bounded authoritative repair queries for correctness.

The browser cache is not "the table". It is a client-side materialized cache
with provenance.

The rule is:

> Any user-visible surface may render from cached projection state, but it must
> have a bounded authoritative repair path for the exact subset it displays or
> relies on.

## Correctness Invariants

### Invariant 1: Feed Is Not Authority

The account feed is a sequenced update/invalidation stream. It is not the
authoritative source of account/project state.

Authority remains:

- account row snapshot for account settings/profile/billing-lite fields,
- `account_project_index` for account-facing project list rows,
- per-project authoritative project detail endpoints for detail fields,
- notification read models for notification pages/counts,
- users/collaborator projection snapshot for collaborators.

### Invariant 2: Every Visible Surface Has A Bounded Repair Query

The repair query must be proportional to what the user can see or just changed.

Examples:

- Starting project `P`: repair only `account_project_index(account_id, P)`.
- Open project tabs: repair only open project IDs.
- Projects page visible window: repair the current page/search/sort window.
- Notification badge: repair counts, not the entire notification history.
- Account setting switch: repair the account row or relevant setting map.

Full account-wide project scans are allowed only as explicit background or
small-account operations.

### Invariant 3: Writes Need Projection Acknowledgement

A write RPC returning successfully means the backend accepted the write. It
does not mean the browser projection is correct.

For user-visible writes, the UI action is complete only when:

- the projected frontend state reflects the requested write, or
- the action times out and exposes a clear retry/error state.

The write acknowledgement API should distinguish:

- RPC failed,
- RPC succeeded but projected state did not converge,
- feed disconnected/recovering,
- snapshot repair failed,
- local merge preserved or dropped the update.

### Invariant 4: Optimistic State Must Be Bounded

Optimistic Redux state is allowed only if one of these is true:

- it is tied to an active operation/LRO,
- it has a short expiry and repair path,
- it is purely local UI state and not presented as authoritative backend
  state.

Optimistic project lifecycle state must not remain indefinitely in
`project_map`.

### Invariant 5: History Gap Means Repair, Not Panic

`history-gap` means the feed cannot prove it replayed every missed event.

It should trigger:

- mark affected projection family as suspect,
- immediately repair visible/open/pending-write subsets,
- schedule bounded background repair where useful,
- record diagnostics.

It should not blindly load every project for a large account.

### Invariant 6: Wake/Reconnect Means Probe Then Repair Visible State

Browser wake/reconnect should trigger semantic projection repair in addition to
transport recovery.

At minimum after foreground wake:

- verify the shared account feed is present/recovered or recreate it,
- repair account row if account settings/profile surfaces are open or pending,
- repair open projects,
- repair the current projects page window if visible,
- repair notification counts if notification badge/page is visible.

## Repair Scopes

### Project Repair Scopes

Define a single project projection repair API in `projects/actions.ts`:

```ts
type ProjectProjectionRepairReason =
  | "write-ack"
  | "project-start"
  | "project-stop"
  | "project-archive"
  | "project-move"
  | "history-gap"
  | "foreground-wake"
  | "visible-window"
  | "manual-refresh"
  | "diagnostic";

type ProjectProjectionRepairRequest =
  | {
      kind: "project-ids";
      project_ids: string[];
      reason: ProjectProjectionRepairReason;
      force?: boolean;
    }
  | {
      kind: "visible-window";
      query: ProjectListWindowQuery;
      reason: ProjectProjectionRepairReason;
      force?: boolean;
    }
  | {
      kind: "background-page";
      cursor?: string;
      limit: number;
      reason: ProjectProjectionRepairReason;
    };
```

Required behavior:

- `project-ids` uses one-row or batched `account_project_index` queries.
- `visible-window` uses a backend query matching the actual projects page
  search/filter/sort/window.
- `background-page` is low-priority and rate-limited.
- all repair results merge through the same preservation logic as feed rows.
- all repair attempts update projection diagnostics.

Do not use `loadProjectedProjectsForCurrentAccount` as the universal repair
operation for large accounts.

### Account Repair Scopes

Define an account projection repair API:

```ts
type AccountProjectionRepairReason =
  | "write-ack"
  | "history-gap"
  | "foreground-wake"
  | "manual-refresh"
  | "diagnostic";

type AccountProjectionRepairRequest = {
  fields?: string[];
  reason: AccountProjectionRepairReason;
  force?: boolean;
};
```

Initial implementation may recreate the account table snapshot. Later it can
use narrower RPCs for account settings/profile/billing-lite fields.

### Notification Repair Scopes

Notifications should distinguish:

- counts repair,
- visible page repair,
- notification IDs touched by write/read-state updates.

The unread badge should never require loading the entire notification history.

### Users/Collaborator Repair Scopes

Users/collaborators can initially keep full snapshot repair because the
projection is much smaller than large project lists for normal accounts.

If large collaborator graphs become common, add:

- project-scoped collaborator repair,
- visible collaborator repair,
- mentioned-user repair.

## Project List Large-Account Design

The current full projects page still derives `visible_projects` from
`project_map`, which assumes local completeness.

Target design:

1. Keep `project_map` as a warm cache keyed by project ID.
2. Add a backend-backed project list window query:
   - search string,
   - hidden flag,
   - selected hashtags,
   - sort,
   - offset/cursor,
   - limit.
3. Store the current visible project ID window separately from `project_map`.
4. Render rows by joining visible IDs with cached `project_map` rows.
5. If a visible row is missing or stale, repair that row/window.
6. Feed events update `project_map`; if they affect the current window, update
   or mark the window dirty.

This preserves fast navigation for warm cache entries while making the visible
page correct for 15,000-project accounts.

### Required New State

Add a projection substate to `ProjectsState` or a separate store:

```ts
type ProjectionFreshness = "ready" | "suspect" | "repairing" | "error";

type ProjectProjectionState = {
  feed?: FeedProjectionState;
  fullProjectionStatus?: ProjectionFreshness;
  visibleWindow?: {
    key: string;
    project_ids: string[];
    total?: number;
    loaded_at?: string;
    repair_state: ProjectionFreshness;
    error?: string;
  };
  projectRows?: Record<
    string,
    {
      loaded_at?: string;
      source: "snapshot" | "feed" | "repair" | "optimistic";
      suspect?: boolean;
      last_feed_seq?: number;
      last_repair_at?: string;
      pending_ack?: string;
    }
  >;
};
```

This does not replace `project_map` immediately. It gives `project_map`
provenance and a migration path.

## Feed Diagnostics

Add a shared diagnostics layer for account-feed consumers.

```ts
type FeedProjectionState = {
  account_id?: string;
  stream_name: "account-feed";
  stream_recovery_state?: string;
  connected?: boolean;
  is_closed?: boolean;
  last_event_at?: string;
  last_event_type?: string;
  last_seq?: number;
  last_history_gap_at?: string;
  last_history_gap?: {
    requested_start_seq?: number;
    effective_start_seq?: number;
    oldest_retained_seq?: number;
    newest_retained_seq?: number;
  };
  last_repair_at?: string;
  last_repair_reason?: string;
  last_repair_error?: string;
};
```

Expose this through `cocalcSyncDiagnostics()` alongside existing syncdoc and
Redux diagnostics.

Every account-feed consumer should record:

- feed attach/detach,
- `change` event type and seq,
- `history-gap`,
- repair start/success/failure,
- pending write ack start/success/failure.

This is essential for dogfooding because many failures are sporadic and only
visible after suspend/resume.

## Write Acknowledgement API

Add a common helper for backend-confirmed actions:

```ts
type ProjectionAckOptions<T> = {
  name: string;
  write: () => Promise<T>;
  matchesProjection: () => boolean;
  repair: () => Promise<void>;
  timeout_ms?: number;
  repair_timeout_ms?: number;
  onPending?: () => void;
  onConverged?: () => void;
  onFailed?: (error: Error) => void;
};
```

Behavior:

1. Mark action pending.
2. Run write RPC/table save.
3. Wait for projection to match.
4. If not matched, run scoped repair.
5. Wait again.
6. If still not matched, expose failure and diagnostics.

Existing first targets:

- account `set_other_settings`
- project `start_project`
- project `stop_project`
- project `archive_project`
- project `move_project`
- notification read-state updates

## Optimistic State Rules

### Allowed

- Project start may show `starting` immediately if it records:
  - `source: "optimistic"`
  - timestamp,
  - associated LRO/op ID when available.

### Required Expiry

An optimistic state must stop winning over projection state when:

- associated LRO failed/cancelled,
- associated LRO succeeded and projection still disagrees after bounded retry,
- no associated LRO is active and optimistic timestamp is older than the
  configured freshness window.

### Disallowed

- Long-lived optimistic values with no provenance.
- Local `project_map` mutation that hides a failed/missed projection update
  indefinitely.

## Wake/Reconnect Semantics

Transport reconnect is not enough. After foreground wake or browser online:

1. Existing Conat reconnect code probes hub/project-host transport.
2. Projection layer should schedule semantic repairs:
   - account fields with pending write acks,
   - open project IDs,
   - visible project list window,
   - visible notification counts/page.
3. Repairs should be deduplicated by key and reason.
4. Background tabs should defer broad repairs, but still repair pending writes
   and active/open project tabs when they become foreground.

Implement this as a projection coordinator, not ad-hoc `window.focus` handlers
in every component.

## Migration Plan

### Phase 1: Instrument And Normalize Existing Consumers

Add shared feed diagnostics and register current consumers:

- account row
- projects
- users/collaborators
- notifications/mentions
- news
- LRO summaries

Do not change product behavior yet except adding diagnostics.

Deliverables:

- `cocalcSyncDiagnostics().projections`
- unit tests for feed seq/history-gap diagnostic capture
- no user-visible regressions

### Phase 2: Centralize Project Repair APIs

Replace direct calls to ad-hoc repair helpers with one repair API:

- `repairProjectProjection({ kind: "project-ids", ... })`
- `repairProjectProjection({ kind: "visible-window", ... })`

Keep existing `project_map` merge behavior initially.

Deliverables:

- start/stop/archive/move use repair API
- history-gap repairs open projects and visible window, not all projects
- tests for 15,000-project account scenario with no full load

### Phase 3: Add Project List Window Source

Change the full projects page from local full-map filtering to backend-backed
window queries.

Deliverables:

- backend query for project list window from `account_project_index`
  - implemented for the DB helper and authenticated hub `projects.listAccountProjectWindow`
- frontend state for visible window IDs
  - started: projects store now records the last loaded backend window and the projects page prefetches/merges the current top window as a convergence aid
- Projects table renders joined window IDs + `project_map`
  - started: full projects page now renders from the matching backend window when no hashtag filter is active, and falls back to local filtering when the backend window is loading, stale, errored, or semantically unsafe
- feed events mark visible window dirty or repair affected rows
  - implemented: feed upsert/remove/history-gap marks the active backend window dirty, updates row data in place, and shows an explicit refresh control instead of silently reordering the project list

### Phase 4: Move Detail Fields Out Of `project_map`

Follow [projects-live-projection-audit-2026-04-06.md](./projects-live-projection-audit-2026-04-06.md):

- keep live control fields in `project_map`
- move detail/settings fields to `use-project-field`
- use `project.detail.invalidate` feed events for invalidation

### Phase 5: Make Write Acks Uniform

Convert user-facing writes to the projection ack helper.

Priority:

1. account settings
   - implemented for `account.other_settings` via the shared write-ack helper
2. project lifecycle
   - implemented for `start_project`: start RPC waits for
     `account_project_index.state_summary.state` to become `starting` or
     `running`, with targeted project-row repair on lag
   - implemented for `stop_project`: stop RPC waits for
     `account_project_index.state_summary.state === "opened"`, with targeted
     project-row repair on lag
   - implemented for `archive_project`: the archive RPC waits for
     `account_project_index.state_summary.state === "archived"` and uses
     targeted project-row repair if the feed/projection lags
   - implemented for project move LRO success with an explicit destination
     host: after local success handling, the projection ack verifies
     `account_project_index.host_id` matches the destination host and repairs
     the project row if needed
3. project metadata
   - implemented for project title, description, and theme via `account_project_index` ack checks and targeted row repair
4. notification read state
   - implemented for mention notification read/unread state via the shared write-ack helper
5. collaborator membership changes
   - implemented for collaborator removal and role changes via `users_summary` ack checks and targeted row repair

### Phase 6: Release Hardening

Add automated tests and dogfood diagnostics:

- suspend/resume browser with visible projects page
- simulate DStream history gap
- simulate write RPC success but dropped feed event
- simulate frontend merge preserving stale optimistic state
- simulate 15,000 projects and a current visible page

## Test Plan

### Unit Tests

Projects:

- one-row repair updates stale project state
- optimistic `starting` expires or follows LRO state
- history-gap repairs only open IDs and visible window for large accounts
- visible-window query does not require full `project_map`
- feed upsert invalidates/updates current visible window correctly

Account:

- setting write waits for projection convergence
- missed feed causes snapshot repair
- failed convergence exposes warning/error diagnostics

Feed diagnostics:

- records last seq for each event
- records history-gap info
- records recovery state transitions
- records repair outcome

### Integration / Browser Tests

- Open multiple browser tabs, suspend/resume, verify:
  - account feed reconnects or repairs,
  - open projects repair,
  - visible project list rows repair,
  - no stale `Starting` after project is running.

- For large account fixture:
  - project list page loads one visible window,
  - switching search/filter queries backend window,
  - history-gap does not load all projects,
  - open project tabs still repair immediately.

## Operational Diagnostics

When a dogfooding browser reports stale projection, capture:

```ts
cocalcSyncDiagnostics().projections;
```

It should answer:

- Is the account feed connected?
- What was the last event seq/type/time?
- Did a history gap happen?
- Which repair ran after the gap?
- Which writes are pending acknowledgement?
- Which visible project rows are stale/suspect?
- Did a repair query fail?

## Release Exit Criteria

P0-A is release-ready when:

- no known account setting can remain silently stuck after backend write
  success,
- no known project lifecycle action can remain silently stale after backend
  state changes,
- foreground wake repairs visible/open projections without requiring a full
  page refresh,
- history-gap repair is bounded for large project accounts,
- project list correctness does not require loading all projects,
- diagnostics can explain the last projection failure without a custom console
  script.

## Design Summary

This is not a return to old full SyncTable.

It is:

- feed for speed,
- snapshot/window repair for correctness,
- write acknowledgement for user actions,
- bounded optimistic state,
- diagnostics for sporadic failures,
- and large-account behavior that never depends on loading every project.
