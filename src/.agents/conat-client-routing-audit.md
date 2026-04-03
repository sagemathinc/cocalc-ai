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

## Completed In The Generic Service Pass

### `conat/service/service.ts`

- removed the hidden fallback to the global Conat singleton
- `callConatService(...)` and `createConatService(...)` now require an
  explicit client
- `pingConatService(...)` and `waitForConatService(...)` now flow through the
  same explicit-client requirement
- the natural singleton wrappers remain local:
  - [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
    now injects the browser Conat client explicitly
  - [project/client.ts](/home/wstein/build/cocalc-lite4/src/packages/project/client.ts)
    now injects the project-scoped client explicitly

This keeps the reusable request/reply service layer safe for backend and
multi-bay reuse while preserving convenient wrapper APIs in the browser and
project runtimes.

## Completed In The LRO Stream Pass

### `conat/lro/stream.ts`

- removed the hidden fallback to the global Conat singleton
- shared LRO event/summary publishers now require an explicit client
- the natural singleton wrappers remain local:
  - [server/lro/stream.ts](/home/wstein/build/cocalc-lite4/src/packages/server/lro/stream.ts)
    now injects the backend hub client explicitly
  - [project-host/lro/stream.ts](/home/wstein/build/cocalc-lite4/src/packages/project-host/lro/stream.ts)
    now injects the project-host client explicitly
- server and project-host code now import those local wrappers instead of the
  shared helper directly

This keeps the reusable LRO stream publisher safe for multi-bay reuse while
preserving stable call signatures inside the current backend and project-host
code.

## Remaining Hotspots

### Shared Helper Fallbacks

These still silently fall back to the global singleton and should be reviewed
next:

- none in the initial audit set

### Frontend Singleton Sites

Many frontend paths intentionally use the browser's main Conat client, e.g.
[frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
and callers of `webapp_client.conat_client.conat()`.

These are not automatically wrong, but they need to be revisited once browser
control traffic is split between `home_bay` and project/host-specific routed
clients.

## Next Recommended Cleanup Pass

1. review remaining intentionally-local singleton wrappers and decide which
   should become explicit before multi-bay routing
2. keep server-side bridge/control paths ahead of broader frontend ergonomics

## Completed In The Filesystem And LLM Pass

### `conat/files/fs.ts`

- removed the hidden fallback to the global Conat singleton
- both `fsServer(...)` and `fsClient(...)` now require an explicit client
- runtime-specific wrappers remain the deliberate places that choose a default:
  - [conat/core/client.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/core/client.ts)
    injects the caller's connected client for `client.fs(...)`
  - [backend/conat/files/local-path.ts](/home/wstein/build/cocalc-lite4/src/packages/backend/conat/files/local-path.ts)
    still chooses the backend client explicitly when no caller overrides it
- remaining direct callers used outside those wrappers were updated to pass
  their intended backend client explicitly

This closes the main shared file helper that could otherwise silently route
filesystem reads/writes/watch traffic over the wrong Conat connection.

### `conat/llm/client.ts`

- removed the hidden fallback to the global Conat singleton
- `llm(...)` now requires an explicit client
- [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
  now injects the browser's active client explicitly
- backend tests now pass the backend client explicitly

This keeps the shared LLM request helper safe for future multi-bay control
routing instead of silently attaching to an ambient singleton.

## Completed In The Service Wrapper Pass

### `conat/service/listings.ts`

- removed the hidden fallback to the global Conat singleton
- `createListingsApiClient(...)`, `createListingsService(...)`, and
  `listingsClient(...)` now require an explicit client
- directory listing DKV helpers now flow through the same explicit client
- the cached `listingsClient(...)` path now keys by both `project_id` and core
  Conat client identity, so separate routed clients do not accidentally share
  one cached listing client
- the natural singleton wrappers remain local:
  - [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
    now injects the browser client explicitly
  - [frontend/conat/listings.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/listings.ts)
    and [frontend/conat/use-listing.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/use-listing.ts)
    now inject the active browser client explicitly
  - [project/conat/listings.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/listings.ts)
    now injects the project-scoped client explicitly

This keeps directory listing interest, cached listing state, and the listing
service itself aligned to the caller's chosen routed client.

### `conat/service/time.ts`

- removed the hidden fallback to the global Conat singleton and ambient account
  or project identity
- `timeClient(...)` and `createTimeService(...)` now require an explicit client
- the natural singleton wrappers remain local:
  - [conat/time.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/time.ts)
    now injects the active client and current account/project identity
  - [server/conat/index.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/index.ts)
    now injects the backend hub client explicitly

This keeps time-sync traffic on the intended routed connection instead of
silently attaching to whichever singleton happens to be initialized.

### `conat/service/terminal.ts`

- removed the hidden fallback to the global Conat singleton
- terminal server, terminal browser, and both client helpers now require an
  explicit client
- the natural singleton wrappers remain local:
  - [project/conat/terminal/manager.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/terminal/manager.ts)
    now injects the project-scoped client explicitly for the terminal server
  - [project/conat/terminal/session.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/terminal/session.ts)
    now injects the project-scoped client explicitly for browser callbacks

This keeps terminal control traffic on the same project-scoped connection
selected by the runtime wrapper instead of hiding that choice inside the shared
helper.

### `conat/service/browser-session.ts`

- removed the hidden fallback to the global Conat singleton
- browser-session client and service registration now require an explicit client
- current production callers were already a good fit:
  - CLI browser/workspace commands pass their routed remote client explicitly
  - [frontend/conat/browser-session/index.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/browser-session/index.ts)
    already injects the browser's active client explicitly

This keeps browser-session automation bound to the correct control-plane
connection instead of silently depending on ambient global state.

## Completed In The Shared Server Helper Pass

### `conat/files/file-server.ts`

- removed the hidden fallback to the global Conat singleton
- shared file-server server/client helpers now require an explicit client
- the natural singleton or routed choices remain local:
  - [server/conat/api/file-sync.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/api/file-sync.ts)
    now explicitly injects the backend hub client when using the generic
    routed file-server API
  - [http-api/pages/api/v2/projects/copy-path.ts](/home/wstein/build/cocalc-lite4/src/packages/http-api/pages/api/v2/projects/copy-path.ts)
    now explicitly injects the backend hub client
  - [server/conat/file-server-client.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/file-server-client.ts),
    [project-host/file-server.ts](/home/wstein/build/cocalc-lite4/src/packages/project-host/file-server.ts),
    and [project-runner/run/filesystem.ts](/home/wstein/build/cocalc-lite4/src/packages/project-runner/run/filesystem.ts)
    were already the deliberate places that choose a routed or local client

This keeps the shared file-server helper reusable across hub, project-host,
project-runner, and future multi-bay control code without silently selecting
an ambient connection.

### `conat/llm/server.ts`

- removed the hidden fallback to the global Conat singleton
- `init(...)` now requires an explicit client
- the natural singleton wrappers remain local:
  - [server/conat/llm.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/llm.ts)
    now injects the backend hub client explicitly
  - [lite/hub/llm.ts](/home/wstein/build/cocalc-lite4/src/packages/lite/hub/llm.ts)
    now injects the Lite runtime client explicitly

This keeps the shared LLM server registration helper safe for future routed
control-plane reuse instead of implicitly binding to a global client.

### `conat/ai/acp/server.ts`

- removed the hidden fallback to the global Conat singleton
- ACP server initialization now requires an explicit client
- the current Lite ACP runtime already had the right shape:
  - [lite/hub/acp/index.ts](/home/wstein/build/cocalc-lite4/src/packages/lite/hub/acp/index.ts)
    already passes its runtime-selected client explicitly

This keeps ACP server registration aligned with the caller's chosen routed
client rather than silently attaching to global state.

## Completed In The Sync Primitive Pass

### `conat/sync/core-stream.ts`, `dstream.ts`, `dkv.ts`, `dko.ts`, `akv.ts`, `astream.ts`, and `inventory.ts`

- removed the hidden fallback to the global Conat singleton from the shared
  sync constructors and caches
- removed the lower-level `connect()` fallback from `akv(...)` and
  `astream(...)`
- shared sync helpers now require an explicit client for:
  - core persistent streams
  - distributed streams / kv / key-object stores
  - async kv / stream accessors
  - inventory access
- DKO cache keys now include client identity, so routed clients do not share a
  cache entry just because the logical store name matches

### Runtime-Local Sync Wrappers

- the intentional singleton/default choice now lives only in runtime-local
  wrappers:
  - [backend/conat/sync.ts](/home/wstein/build/cocalc-lite4/src/packages/backend/conat/sync.ts)
    now injects the backend hub client explicitly
  - [project/conat/sync.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/sync.ts)
    now injects the project runtime client explicitly
  - [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
    now injects the browser client explicitly

### Follow-On Production Callers

- remaining production callsites that depended on the old sync fallback were
  updated:
  - [server/conat/api/file-use-times.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/api/file-use-times.ts)
    now goes through the backend sync wrapper
  - [jupyter/redux/actions.ts](/home/wstein/build/cocalc-lite4/src/packages/jupyter/redux/actions.ts)
    now requires an explicit runtime Conat client for blob-store and
    runtime-state setup
  - [jupyter/redux/runtime-state.ts](/home/wstein/build/cocalc-lite4/src/packages/jupyter/redux/runtime-state.ts)
    now requires an explicit client in the shared runtime-state opener

This is one of the highest-value foundation cleanups because these sync
primitives are reused across frontend, backend, project, lite, and future
multi-bay control-plane code.

## Completed In The Project API Pass

### `conat/project/api/project-client.ts`

- removed the hidden fallback to the global Conat singleton
- `projectApiClient(...)` now requires an explicit client
- current production callers were updated to use the right local wrapper or
  routed client explicitly:
  - [frontend/conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)
    remains the deliberate browser-local wrapper that injects the active
    browser client
  - [frontend/components/run-button/index.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/components/run-button/index.tsx)
    and [frontend/components/run-button/kernel-info.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/components/run-button/kernel-info.ts)
    now go through that browser-local wrapper instead of importing the shared
    helper directly
  - [conat/sync-doc/sync-client.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/sync-doc/sync-client.ts)
    now injects its active sync client's Conat connection explicitly
  - [lite/hub/agent.ts](/home/wstein/build/cocalc-lite4/src/packages/lite/hub/agent.ts)
    now injects the Lite runtime client explicitly
  - [lite/hub/acp/executor/container.ts](/home/wstein/build/cocalc-lite4/src/packages/lite/hub/acp/executor/container.ts)
    now requires either an explicit Conat client or a prebuilt project API

This closes another shared helper that previously looked harmless in a
single-client world but would become an easy source of wrong-bay or
wrong-project-host routing bugs once multiple Conat connections are normal.

## Completed In The Server Bridge Pass

### `server/api/hub-bridge.ts` and `server/api/project-bridge.ts`

- removed the remaining backend-singleton fallback from the server-side bridge
  wrappers
- both bridge helpers now require an explicit backend Conat client
- the only production callers were already easy to update:
  - [http-api/pages/api/conat/hub.ts](/home/wstein/build/cocalc-lite4/src/packages/http-api/pages/api/conat/hub.ts)
    now injects the backend client explicitly
  - [http-api/pages/api/conat/project.ts](/home/wstein/build/cocalc-lite4/src/packages/http-api/pages/api/conat/project.ts)
    now injects the backend client explicitly

This removes another layer where backend routing could quietly collapse onto
the ambient singleton even after the higher-level caller had been made
bay-aware.

## Completed In The Project Runtime Helper Pass

### Project-Local Conat Access

- added [project/conat/runtime-client.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/runtime-client.ts)
  as the single project-runtime helper that reads the active Conat connection
  from project state
- updated project-local modules to use that helper instead of importing the
  generic global Conat client directly:
  - [project/app-servers/control.ts](/home/wstein/build/cocalc-lite4/src/packages/project/app-servers/control.ts)
  - [project/conat/hub.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/hub.ts)
  - [project/conat/terminal/session.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/terminal/session.ts)
  - [project/conat/terminal/manager.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/terminal/manager.ts)
  - [project/conat/listings.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/listings.ts)
  - [project/conat/sync.ts](/home/wstein/build/cocalc-lite4/src/packages/project/conat/sync.ts)

This does not eliminate the project runtime's local singleton yet, but it
does confine that choice to one project-local helper instead of scattering
direct `@cocalc/conat/client` access across unrelated modules.

## Completed In The Backend Client Hygiene Pass

### Server-Side HTTP and LRO Helpers

- replaced remaining server-side imports of the generic `@cocalc/conat/client`
  singleton with the backend-specific
  [@cocalc/backend/conat](/home/wstein/build/cocalc-lite4/src/packages/backend/conat/index.ts)
  entrypoint in:
  - [http-api/pages/api/v2/projects/copy-path.ts](/home/wstein/build/cocalc-lite4/src/packages/http-api/pages/api/v2/projects/copy-path.ts)
  - [http-api/lib/share/get-contents.ts](/home/wstein/build/cocalc-lite4/src/packages/http-api/lib/share/get-contents.ts)
  - [server/lro/stream.ts](/home/wstein/build/cocalc-lite4/src/packages/server/lro/stream.ts)

This does not change routing behavior, but it makes the runtime boundary
clearer: server-side code now depends directly on the backend Conat runtime
instead of reaching through the generic global-client facade.
