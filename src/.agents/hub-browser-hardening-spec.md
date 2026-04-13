# Hub Browser-Hardening Spec

## Goal

A confused, buggy, stale, suspended/resumed, or mildly hostile browser must **not**
be able to take down the hub control plane.

More precisely:

- Browser-originated traffic must not be able to starve project-host heartbeats.
- Browser reconnect storms must not be able to create unbounded hub work.
- Optional browser maintenance traffic must degrade first under load.
- The hub must continue serving essential control-plane traffic even when one
  browser is behaving badly.

This document is about **server-side hardening**. Frontend fixes help, but are
not sufficient.

## Incident Pattern This Spec Addresses

Observed failure mode:

1. A laptop suspends/resumes, or the browser refreshes/signs out/signs in.
2. The browser replays a large amount of reconnect, session, persist, and
   polling traffic.
3. Hub responsiveness degrades.
4. Project-host heartbeats time out.
5. The host appears offline even though the VM and project-host process are up.

Key browser-side traffic involved:

- `hub.lro.list(...)`
- `system.upsertBrowserSession(...)`
- browser reconnect handshakes
- persist/changefeed reconnects
- routed project-host reconnects

Key host-side traffic that must remain protected:

- `heartbeat`
- `listProjectUserDeltas`
- `listProjectUserReconcile`
- other host control-plane RPCs

## Hard Requirements

The system must satisfy all of the following:

1. **Traffic class isolation**
   Browser traffic must not be able to starve host traffic.

2. **Bounded per-browser cost**
   There must be an upper bound on work caused by one `(account_id, browser_id)`.

3. **Low-value work sheds first**
   Under load, maintenance and polling RPCs must fail or degrade before heartbeats
   and essential auth/control-plane operations.

4. **Server-side coalescing**
   Identical or nearly identical browser reads/writes must be merged or cached,
   not executed independently.

5. **Overload visibility**
   The hub must expose enough metrics/logging to identify the offending traffic
   class and browser quickly.

## Threat Model

We are not only defending against malicious traffic. The more likely and common
threats are:

- a browser with stale tabs
- suspend/resume reconnect storms
- repeated sign-out/sign-in
- buggy frontend reconnect logic
- one account with many open project pages
- a single browser repeatedly rebuilding persist/changefeed state

The hardening should also make intentional layer-7 abuse harder, but the design
target is primarily accidental self-DOS.

## Design Principles

### 1. One Browser Is Not One Socket

A single tab may hold:

- one main hub Conat connection
- several persist sockets
- routed project-host sockets
- browser-session maintenance traffic
- polling loops

Server budgeting must be done per **browser session**, not per TCP connection.

Primary key:

- `(account_id, browser_id)` for browser-originated work
- `host_id` for project-host work

### 2. Heartbeats Are Sacred

Host heartbeat and host reconciliation traffic must run in a protected lane.
If optional browser work is overwhelming the hub, it is acceptable for browser
features to look stale briefly. It is not acceptable for healthy project-hosts to
be marked offline.

### 3. Idempotent Maintenance Must Be Cheap

Endpoints such as `system.upsertBrowserSession` are not user-facing hot paths.
Repeated calls with unchanged inputs must be cheap and often no-ops.

### 4. Reads Need Coalescing Too

`hub.lro.list(...)` and similar polling calls must not scale linearly with the
number of tabs or managers when the answer is unchanged.

## Proposed Server-Side Changes

## Phase 1: Immediate Guard Rails

These are the highest-value, lowest-risk changes.

### A. Protect Host Traffic With Priority Separation

Introduce explicit traffic classes in the hub Conat request handling path:

- `host_critical`
- `browser_interactive`
- `browser_maintenance`

Examples:

- `host_critical`:
  - host `heartbeat`
  - host reconcile RPCs
  - host bootstrap/auth
- `browser_interactive`:
  - user-triggered project operations
  - interactive file/chat/project actions
- `browser_maintenance`:
  - `system.upsertBrowserSession`
  - `hub.lro.list`
  - similar periodic or polling traffic

Implementation target:

- request classification in hub service dispatch
- separate concurrency budgets or semaphores per class
- `host_critical` must have reserved capacity

Relevant code areas:

- `src/packages/server/conat/api/*`
- `src/packages/conat/service/*`
- hub request dispatch / response plumbing

### B. Add Server-Side Caching for `hub.lro.list`

Add a short-lived cache keyed by:

- `account_id`
- `browser_id` if available
- `scope_type`
- `scope_id`
- `include_completed`

Recommended TTL:

- `1s` to `5s`

Properties:

- identical requests within the TTL return cached results
- concurrent identical requests share one in-flight promise
- cache must be per authenticated principal, not global

Reason:

- this directly neutralizes multi-manager polling fanout
- this remains valuable even after frontend deduping

Relevant code areas:

- `src/packages/server/conat/api/lro.ts`
- any downstream LRO listing implementation

### C. Clamp `system.upsertBrowserSession`

Make `upsertBrowserSession` cheap and idempotent.

Required behavior:

- if the browser submits the same session snapshot repeatedly, avoid repeated DB writes
- enforce a minimum write interval per `(account_id, browser_id)`, e.g. `15s` or `30s`
- if the request arrives too soon and nothing material changed, treat it as success without work

Important:

- do not reject the request noisily if it is merely redundant
- instead, no-op and return success

Relevant code areas:

- `src/packages/server/conat/api/system.ts`
- any persistence for browser sessions

### D. Per-Browser Method Budgets

Introduce token-bucket style rate limits for browser-maintenance methods.

Suggested keys:

- `(account_id, browser_id, method_name)`

Suggested first limits:

- `hub.lro.list`: burst 3, refill 1 per 5s
- `system.upsertBrowserSession`: burst 2, refill 1 per 15s
- websocket handshake/auth for browser Conat: small burst, then backoff

Behavior on limit exceed:

- low-priority methods: `429` or `503` with retry guidance
- unchanged maintenance writes: return success/no-op where appropriate

Relevant code areas:

- hub API entrypoints
- Conat socket auth / request middleware

## Phase 2: Overload Shedding

When the hub is under pressure, it must degrade gracefully.

### A. Define Overload Signals

Track:

- event loop lag
- in-flight request counts by traffic class
- queue depth by traffic class
- number of active browser sockets / persist sockets
- timeouts per method family

### B. Shed Low-Value Browser Work First

When overload threshold is crossed:

- continue serving `host_critical`
- continue serving essential browser auth
- degrade or reject:
  - `hub.lro.list`
  - `system.upsertBrowserSession`
  - non-essential browser maintenance traffic

This should be explicit, not accidental.

Example response:

- `503 overloaded; retry_after_ms=5000`

### C. Separate "Stale" From "Offline"

If host heartbeats are briefly delayed during hub distress, avoid immediately
treating hosts as offline.

Suggested model:

- `running`
- `stale`
- `offline`

`stale` should mean:

- recent missed heartbeats, but insufficient evidence the host itself is down

Relevant code areas:

- `src/packages/server/conat/host-registry.ts`
- host status derivation / projection

## Phase 3: Connection and Subscription Quotas

These changes make one browser's socket fanout bounded.

### A. Per-Browser Active Resource Caps

Track and cap by `(account_id, browser_id)`:

- active Conat sockets
- active persist sockets
- active changefeeds
- active routed project-host sockets

Policy:

- warn first
- reject low-value new subscriptions after the cap
- never allow unbounded per-browser socket growth

### B. Handshake Throttling

Repeated browser reconnects should not result in unlimited expensive auth work.

Add a short-window limiter on browser Conat handshake attempts keyed by:

- `browser_id`
- fallback to account/IP when browser_id is absent

This should not block legitimate steady-state usage, but should damp loops.

Relevant code areas:

- `src/packages/server/conat/socketio/auth.ts`
- socket connection admission path

## Phase 4: Deeper Control-Plane Isolation

This is the architectural version of the above protections.

### A. Separate Host and Browser Control Planes

Long-term preferred architecture:

- host traffic served by a dedicated hub-side service/namespace/process
- browser traffic served separately

Benefits:

- browser churn cannot directly starve host heartbeats
- simpler overload policy
- simpler metrics

This is higher effort than phases 1-3, so it should not block the guard rails.

## Detailed Implementation Notes

### `hub.lro.list`

Server-side cache requirements:

- keyed by request identity and auth identity
- in-flight deduping
- short TTL
- cache invalidation optional; short TTL is sufficient for first version

This should be implemented even if frontend polling is reduced, because it is a
natural control-plane protection.

### `system.upsertBrowserSession`

Do not let this endpoint scale linearly with reconnect weirdness.

The endpoint should:

- compare normalized snapshot against the last accepted snapshot for the same browser
- if unchanged and called too soon, return success immediately
- if changed materially, update
- optionally keep a coarse `last_seen` separate from full snapshot updates

### Host Heartbeat Lane

Host heartbeat handling should:

- avoid depending on the same overloaded low-priority execution lane as browser polling
- have predictable latency
- remain cheap under load

If needed, use:

- a dedicated semaphore
- a dedicated worker pool
- a dedicated process

## Observability Requirements

Add metrics/logging for:

- top methods by request count
- top methods by timeout count
- top `(account_id, browser_id)` by request count
- active socket counts by category
- active persist/changefeed counts by browser
- host heartbeat latency and failure rate
- number of overloaded / shed requests by method class

Minimum useful dashboard/questions:

- Which browser is the loudest in the last minute?
- Is browser maintenance traffic starving host-critical traffic?
- Are heartbeats timing out because the hub is overloaded or because hosts are actually down?

## Rollout Order

Recommended order:

1. Server-side cache/dedupe for `hub.lro.list`
2. Idempotent clamp for `system.upsertBrowserSession`
3. Method budgets for browser-maintenance RPCs
4. Host-critical reserved capacity / priority separation
5. Per-browser connection/changefeed caps
6. Optional `stale` host state
7. Deeper host/browser control-plane separation

## Testing Plan

### Unit / Integration

- verify repeated identical `hub.lro.list` calls collapse to one backend fetch
- verify concurrent identical `hub.lro.list` calls share in-flight work
- verify repeated unchanged `upsertBrowserSession` calls no-op
- verify host heartbeats still succeed while browser-maintenance requests are rate-limited
- verify overloaded low-priority requests are shed before host-critical ones

### Live Validation

Reproduce the real failure pattern:

1. open one or two real browser tabs
2. suspend/resume laptop
3. sign out/sign in
4. refresh one or more project pages

Success criteria:

- host stays visible as running
- hub remains responsive
- no surge in host heartbeat timeouts
- browser maintenance traffic is clamped or coalesced, not amplified

## Non-Goals

This spec does **not** require:

- perfect fairness across all browser traffic
- solving every frontend polling issue first
- full microservice separation before immediate protections land

The goal is narrower and more urgent:

> a confused browser must not be able to take down the hub

## Recommended First Concrete Patch

If only one server-side patch is implemented first, it should be:

1. short-TTL in-flight deduped cache for `hub.lro.list`
2. unchanged-snapshot write clamp for `system.upsertBrowserSession`
3. explicit low-priority classification for both endpoints

That is the smallest change with the highest likely impact on the exact outage
pattern already observed.
