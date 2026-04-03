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

## Remaining Hotspots

### Shared Helper Fallbacks

These still silently fall back to the global singleton and should be reviewed
next:

### Project / Files Helpers

These also have hidden singleton fallback behavior and should be audited after
the higher-level control-plane helpers above:

- [conat/files/read.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/files/read.ts)
- [conat/files/write.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/files/write.ts)
- [conat/project/usage-info.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/project/usage-info.ts)
- [conat/project/runner/run.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/project/runner/run.ts)
- [conat/project/runner/load-balancer.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/project/runner/load-balancer.ts)

### Frontend Singleton Sites

Many frontend paths intentionally use the browser's main Conat client, e.g.
[frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
and callers of `webapp_client.conat_client.conat()`.

These are not automatically wrong, but they need to be revisited once browser
control traffic is split between `home_bay` and project/host-specific routed
clients.

## Next Recommended Cleanup Pass

1. continue removing implicit singleton use from project/files helpers that are
   already shared across backend and runner code
2. keep server-side bridge/control paths ahead of broader frontend ergonomics
