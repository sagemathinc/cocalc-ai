# CoCalc Project Host

`@cocalc/project-host` is the multi-project host that embeds the Lite core and layers in podman/btrfs/project services. It is the building block for “project runner” nodes that can serve many projects and optionally attach to a remote master.

The host runs local Conat services, file-server + project-runner, SSH ingress,
and an authenticated HTTP/WS proxy. Project control uses authorized Conat APIs;
the early unauthenticated HTTP project start/stop API is no longer the current
interface. See [project-host authentication](../../../docs/project-host-auth.md).

This package deliberately **does not depend on @cocalc/server, @cocalc/hub, or @cocalc/database**. The file-server bootstrap is vendored locally for project-host; the central master will not run file-server.

## Role

- Reuses the lightweight version of "hub/server/database" implemented in [../lite](../lite/README.md) as the control\-plane core.
- Adds local project execution via `@cocalc/project-runner`, file access via `@cocalc/file-server`, and ingress via `@cocalc/project-proxy`.
- Owns podman/btrfs lifecycle for per\-project subvolumes, quotas, snapshots, and migrations.
- Provides SSH ingress \(with sshpiperd\) and HTTP/WS proxying to running project containers.
- Designed to register with a remote master for auth/project placement but keep projects usable locally.

## Change Discipline

- Shared logic belongs in Lite. Keep project-host focused on container/btrfs/ingress concerns and host-level orchestration.
- Avoid duplicating hub/server features; extend Lite instead and consume from here.
- Keep dependencies narrow: podman, btrfs, project-runner, file-server, and project-proxy live here; frontend and heavy hub logic stay out.
- Reuse appropriate Lite helpers without exposing the host-wide control database to project clients; the persistence boundaries below still apply.

## Routing Rules (HTTP vs conat)

- Prefer conat hub RPC for any endpoint that is user-, account-, or project-scoped.
- The main reason: HTTP body fields such as `account_id` or `project_id` are not trustworthy on their own.
- Project-host routing already supports project-scoped conat traffic from the frontend; use that path instead of adding bespoke HTTP POST handlers.
- Keep `web.ts` focused on minimal host HTTP concerns (health/customize/static responses), not authorization-sensitive mutations.

When adding a new project-host API, use this flow:

- Add method shape and transform/auth mapping in [../conat/hub/api/projects.ts](../conat/hub/api/projects.ts).
- Implement the host-local behavior in [hub/projects.ts](./hub/projects.ts).
- Call it from frontend conat code so subject routing can send project messages to the correct project-host.
- Only add HTTP routes when they are intentionally host-global and do not rely on caller identity.

## Persistence And Changefeed Boundaries

Project-host uses several SQLite-backed systems that have different trust and
storage boundaries. Do not treat them as interchangeable merely because they
all use SQLite or expose live updates.

### Project document persistence

- Project documents, chat streams, and other DStream data use the Conat persist
  service implemented under `@cocalc/conat/persist`.
- Project-host runs that service through `conat-persist-daemon.ts`.
- Its subjects are project-scoped, for example
  `persist.project-<project_id>`, and Conat authorization enforces access to the
  project.
- Persist stream databases live in the corresponding project's storage. They
  are intentionally readable and writable by authorized document clients, and
  their changefeeds are required for collaborative editing and reconnect.

### Host-local control SQLite

- `COCALC_LITE_SQLITE_FILENAME` names a host-wide control database reused by
  project-host for project inventory, membership mirrors, ports, provisioning,
  runtime policy, and related host operations.
- This database contains state for many projects on the same host. It is an
  internal control-plane cache and is not a project document store.
- Reusing modules from `@cocalc/lite/hub/sqlite` does not make project-host a
  CoCalc Lite deployment and does not make this database browser-readable.

### Lite database-table changefeeds

- `@cocalc/lite/hub/changefeeds` is the historical database-table changefeed
  used by the single-user CoCalc Lite runtime packaged as `@cocalc/plus`.
- Project-host must not initialize that service. It would expose the host-wide
  control database through a browser-oriented table API and would cross the
  per-project security boundary.
- Project-host does not serve a standalone frontend. The main frontend keeps
  its control-plane database/query connection to the hub and creates separate
  routed project-host clients only for explicit project data-plane services.
- Removing the Lite table service from project-host has no effect on Conat
  persist changefeeds.

The invariant is: **host-local control SQLite is internal; project document
persistence is project-scoped; Lite table changefeeds are Plus-only.**

## Getting Started

- Build with `pnpm --filter @cocalc/project-host build`.
- Run locally with `pnpm --filter @cocalc/project-host app` (builds then starts the embedded file-server + runner).
- CLI: `cocalc-project-host` works after a build (uses the compiled dist).
- Daemon helpers for local dev (background with log + pid):
  - `pnpm --filter @cocalc/project-host daemon:start` starts the configured host-agent instance (default instance index 0); it is not a clean-machine storage/bootstrap installer.
  - `pnpm --filter @cocalc/project-host daemon:stop`
- `GET /healthz` is the host health endpoint. Project list/start/stop/status
  operations use the Conat control APIs and their identity checks, not the
  removed `/projects/:id/...` HTTP routes.
- Build and daemon commands assume configured host storage, runtime user,
  credentials, and service environment. For deployment entry points, start with
  [Star](../../../docs/star.md) or the [SelfHost connector](../../../docs/self-host.md).

## Packaging

- Bundling/SEA lives here (moved from `project-runner`): `pnpm --filter @cocalc/project-host build:tarball` to create the bundle, `pnpm --filter @cocalc/project-host sea` for the SEA archive.
