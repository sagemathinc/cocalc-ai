# Conat Client Routing Audit

Status: initial Phase 0 audit notes for eliminating hidden global-client
fallbacks before multi-bay routing work.

This note is intentionally practical. The goal is to catalog the highest-risk
places where code can silently talk to the wrong Conat connection once there
are multiple control-plane and project-host clients in play.

## Current Rule

- browser-facing code may still have a natural singleton Conat client
- shared helpers used by backend control-plane code should not silently fall
  back to a global client
- backend callers should pass the intended Conat client explicitly

## Completed In This Pass

### `conat/hub/api/sync-impl.ts`

- removed the hidden fallback to `@cocalc/conat/client`
- `history(...)` and `purgeHistory(...)` now require an explicit sync-capable
  client
- callers in:
  - [server/conat/api/sync.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/api/sync.ts)
  - [lite/hub/api.ts](/home/wstein/build/cocalc-lite4/src/packages/lite/hub/api.ts)
    now pass a client explicitly

### Server LRO Mirror

- [start-lro-progress.ts](/home/wstein/build/cocalc-lite4/src/packages/server/projects/start-lro-progress.ts)
  now passes an explicit backend Conat client when opening the LRO stream

### Server Bridge Helpers

- [hub-bridge.ts](/home/wstein/build/cocalc-lite4/src/packages/server/api/hub-bridge.ts)
- [project-bridge.ts](/home/wstein/build/cocalc-lite4/src/packages/server/api/project-bridge.ts)

These still provide a default central-hub client, but now accept an explicit
client parameter so future bay-aware callers can inject the right connection
instead of being forced onto the singleton path.

## Completed In The LRO Pass

### `conat/lro/client.ts`

- removed the hidden fallback to the global Conat singleton
- `get(...)` and `waitForCompletion(...)` now require an explicit client
- all current server callers were already explicit
- the frontend continues to work through
  [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts),
  which passes the browser client explicitly

This keeps the shared LRO helper safe for backend reuse without forcing the
browser to own the singleton-vs-routed decision at every UI call site.

## Completed In The ACP Pass

### `conat/ai/acp/client.ts`

- removed the hidden fallback to the global Conat singleton
- `streamAcp(...)`, `interruptAcp(...)`, `forkAcpSession(...)`,
  `controlAcp(...)`, and `automationAcp(...)` now require an explicit client
- current callers already fit:
  - [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
    injects the browser client
  - [project-chat.ts](/home/wstein/build/cocalc-lite4/src/packages/cli/src/bin/core/project-chat.ts)
    passes the project-scoped CLI client explicitly

This removes another shared helper that could otherwise silently bind to the
wrong Conat connection in a multi-bay or multi-project-host world.

## Completed In The LRO Progress Pass

### `conat/lro/progress.ts`

- removed the hidden fallback to the global Conat singleton
- `lroProgress(...)` now requires an explicit client
- the only current callers live in project-runner code paths, so they now
  reuse the runner's initialized Conat client via
  [project-runner/run/conat-client.ts](/home/wstein/build/cocalc-lite4/src/packages/project-runner/run/conat-client.ts)

This keeps progress publication aligned with the same routed client that the
project runner already uses for fileserver and control traffic, instead of
quietly falling back to whichever backend singleton happens to be cached.

## Completed In The File Helper Pass

### `conat/files/read.ts` and `conat/files/write.ts`

- removed the hidden fallback to the global Conat singleton
- `createServer(...)`, `readFile(...)`, and `writeFile(...)` now require an
  explicit client
- browser-facing project wrappers now pass the browser's active Conat client
- backend upload handlers now pass their backend Conat client explicitly
- project-side file servers were already explicit through
  [project/conat/connection.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/connection.ts)

This keeps file streaming on the same routed connection chosen by the caller,
which matters once uploads/downloads can target different control-plane or
project-host clients.

## Completed In The Project Usage Pass

### `conat/project/usage-info.ts`

- removed the hidden fallback to the global Conat singleton
- both `get(...)` and the project-side service registration now require an
  explicit client
- the frontend Jupyter poller now injects the browser's active Conat client
- the project-side wrapper was already explicit through
  [project/conat/connection.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/connection.ts)

This keeps per-notebook usage lookups and the backing project service on the
same routed client chosen by the caller instead of silently attaching to a
singleton.

## Completed In The Project Runner Pass

### `conat/project/runner/run.ts` and `conat/project/runner/load-balancer.ts`

- removed the hidden fallback to the global Conat singleton
- both helper layers now require an explicit client for:
  - runner server registration
  - runner RPC clients
  - load-balancer server registration
  - load-balancer RPC clients
- current production callers already had a natural routed choice:
  - [project-host/main.ts](/home/wstein/build/cocalc-lite4/src/packages/project-host/main.ts)
  - [project-host/acp-worker.ts](/home/wstein/build/cocalc-lite4/src/packages/project-host/acp-worker.ts)
  - [project-runner/run/index.ts](/home/wstein/build/cocalc-lite4/src/packages/project-runner/run/index.ts)
- [server/projects/control/base.ts](/home/wstein/build/cocalc-lite4/src/packages/server/projects/control/base.ts)
  still intentionally chooses the current backend hub client, but now does so
  in a local helper instead of relying on the shared runner helper to silently
  select a singleton

This closes another backend control path that would otherwise become ambiguous
once project control traffic can target different bays or host-specific Conat
connections.

## Completed In The Project Metadata Pass

### `conat/project/project-info.ts` and `conat/project/project-status.ts`

- removed the hidden fallback to the global Conat singleton
- project metadata/status readers now require an explicit client for:
  - project info fetches
  - project info history fetches
  - project status subscriptions
- project-side service registration now also requires an explicit client in the
  shared `conat/project/project-info.ts` helper
- current callers were updated to pass the intended routed client explicitly:
  - browser project info hooks now inject
    [frontend/webapp-client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/webapp-client.ts)
    through `webapp_client.conat_client.conat()`
  - [frontend/project_actions.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/project_actions.ts)
    now passes the browser client when subscribing to project status
  - the project-local wrapper in
    [project/project-info/project-info.ts](/home/wstein/build/cocalc-lite4/src/packages/project/project-info/project-info.ts)
    remains the deliberate place that chooses a default project-scoped client
    via [project/conat/connection.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/connection.ts)

This keeps shared project metadata helpers reusable across frontend, backend,
CLI, and future bay-aware code without letting them silently attach to an
ambient singleton.

## Remaining Hotspots

### Shared Helper Fallbacks

These still silently fall back to the global singleton and should be reviewed
next:

- [conat/service/service.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/service/service.ts)
- [conat/lro/stream.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/lro/stream.ts)
- [conat/files/fs.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/files/fs.ts)
- [conat/llm/client.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/llm/client.ts)

### Frontend Singleton Sites

Many frontend paths intentionally use the browser's main Conat client, e.g.
[frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
and callers of `webapp_client.conat_client.conat()`.

These are not automatically wrong, but they need to be revisited once browser
control traffic is split between `home_bay` and project/host-specific routed
clients.

## Next Recommended Cleanup Pass

1. continue with the remaining shared service/stream wrappers, especially
   `conat/service/service.ts` and `conat/lro/stream.ts`
2. keep server-side bridge/control paths ahead of broader frontend ergonomics
