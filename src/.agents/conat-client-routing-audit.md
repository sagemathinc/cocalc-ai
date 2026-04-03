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

## Remaining Hotspots

### Shared Helper Fallbacks

These still silently fall back to the global singleton and should be reviewed
next:

- [conat/lro/client.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/lro/client.ts)
- [conat/lro/progress.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/lro/progress.ts)
- [conat/ai/acp/client.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/ai/acp/client.ts)

These are riskier because they are imported by both frontend and backend code,
so the next cleanup pass should separate browser-convenience wrappers from
backend-explicit helpers.

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

1. split `conat/lro/client.ts` into:
   - browser-convenience wrapper that may use the singleton
   - backend/shared helper that requires an explicit client
2. do the same for `conat/ai/acp/client.ts`
3. continue removing implicit singleton use from server-side bridge/control
   paths first, before touching broader frontend ergonomics
