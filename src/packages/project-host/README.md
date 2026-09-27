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

## Memory Pressure Eviction Policy

Ordinary memory eviction is **idle-first across compute tiers**. Among eligible
projects, older authoritative edit activity always sorts before newer activity;
tier and deprioritization are only tie breakers for exactly equal timestamps.
The normal-candidate ordering invariant is: if eligible ordinary candidates A
and B have `last_edited(A) < last_edited(B)`, A must precede B, regardless of tier,
even for a one-millisecond difference. Do not group activity into buckets and
then sort by tier within a bucket. Eligibility requires at least
one hour of known edit inactivity by default, configurable with
`COCALC_PROJECT_HOST_MEMORY_PRESSURE_MIN_IDLE_MS`. Startup, explicit protection,
and cooldown guards still apply. Missing, non-finite, zero, negative, or future
edit timestamps are unknown, not evidence of inactivity.

True memory emergencies can relax these protections, including the idle cutoff,
to preserve the host. Unknown activity remains an emergency fallback after known
activity, not an artificial epoch-zero timestamp that jumps to the front.
Directly attributed resource offenders retain their safety bypass and first
rank. Missing or invalid tier information stays unknown: it is neither priority
zero nor a paid entitlement, breaks otherwise equal ties after known tiers, and
does not produce the free-tier stop label.

Admission decisions and enforcement of a project's own quota/resource limits
are separate from ordinary memory victim selection. Those safety paths, direct
offender precedence, and emergency protection relaxation are explicit
exceptions, not reasons to let tier outrank idleness in the ordinary comparator.

The ordering signal is `authoritative_last_edited_ms` from the owning bay's
existing policy mirror, not browser presence. `last_browser_activity_ms` records
receipt of an open-page heartbeat, not typing or focus. The browser only emits
these heartbeats when its browser-idle runtime policy is enabled, so absence is
expected for many paid projects and does not prove inactivity. Conversely, a
background page can keep emitting indefinitely and must not pin its project.
Presence age is recorded separately in eviction evidence and does not affect
eligibility, tier, or idle ordering. This policy does not change browser-idle
maintenance, heartbeat transport, or policy synchronization.

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

## Paced Maintenance Under I/O Pressure

In storage-admission `enforce` mode, snapshots and backups at least one hour
past their actual due time may make low-priority progress during `contended`
or `recovery` pressure. Normal recovery hysteresis is unchanged: sustained
moderate pressure need not fall below 1% for 60 seconds to protect overdue data.

- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_STARVATION_AGE_MS` defaults to `3600000`
  (one hour), measured from the schedule's due time, not simply the last edit.
- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_STARVATION_INTERVAL_MS` defaults to
  `300000` (five minutes). There is one escape attempt in flight per host, then
  a cooldown from its completion, including failures and deferrals. The old
  `STARVATION_OVERRIDES_PER_SWEEP` setting is no longer used: repeated sweeps
  cannot reset this budget.
- A process-local queue alternates maintenance types and rotates projects
  after attempted escapes. Repeated inventories retain queue position; targeted
  change/retry batches cannot jump ahead of other known overdue projects.
  Initial ordering retains the normal service-class/account ordering. Completed,
  disabled, and reassigned work is removed when schedules are refreshed.
- Full reconciliation populates the queue; event/retry wakeups service its next
  eligible project after cooldown. For a stable finite backlog, each type gets
  every other slot while both have eligible debt, and each project rotates within
  its type. This bounds scheduling delay by backlog and operation duration, not
  a wall-clock completion guarantee. Retry backoff and safety deferrals still apply.
- Emergency or unavailable I/O pressure, lifecycle activity and its settling
  window cannot be bypassed, including at Btrfs mutation boundaries. Memory is
  checked at sweep entry and before dispatch. Existing disk-space checks,
  ownership confirmation/leases, volume lifecycle locks, and low-priority
  maintenance cgroup execution remain in force.

Queue position and cooldown reset on process restart; ordinary startup delay
still applies. No starvation escape is granted to scavengers. Interactive
storage, transport, and eviction are unchanged.
