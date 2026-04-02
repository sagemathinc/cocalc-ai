# Scalable Control Plane Architecture

Status: proposed target architecture for `cocalc-rocket`, with `cocalc-launchpad`
implemented as the one-cell special case.

This document turns the high-level scaling discussion into a concrete design.
The goal is to make the control plane scale by adding cells and compute hosts,
not by redesigning the architecture later.

## Goal

The architecture must support:

- `cocalc-plus`: single-user, local, not important for this design
- `cocalc-launchpad`: one control plane, a few hosts, dozens of users
- `cocalc-rocket`: many control-plane cells, many project hosts, large scale

The hard requirement is:

- scaling to large numbers of simultaneous active users must become primarily a
  spending/operations problem
- it must not require replacing the control-plane design again

## Summary

The correct architecture is:

- a tiny global layer for auth, billing, and directory/placement
- many identical **cells**
- one account has a `home_cell`
- one project has an `owning_cell`
- each project host belongs to exactly one cell
- the browser keeps one control-plane connection to the `home_cell`
- project compute/data-plane traffic goes directly to the project host
- inter-cell RPC and event replication use internal Conat
- Postgres remains the durable relational source of truth
- browser reactivity comes from per-account projection tables, not raw table
  changefeeds

Launchpad should become exactly one cell with no cross-cell routing.

## Why The Current Model Will Not Scale

The current control plane relies heavily on:

- Postgres `LISTEN/NOTIFY`
- per-user changefeeds
- websockets from browsers into a central hub tier
- server-side tracking of large per-account project/collaborator state just to
  know which notifications to forward

In particular:

- [projects.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/projects.ts)
  uses `pg_changefeed: "projects"`
- [collaborators.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/collaborators.ts)
  uses `pg_changefeed: "collaborators"`
- [server.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/hub/changefeeds/server.ts)
  creates a live changefeed connection per client query
- [project-and-user-tracker.ts](/home/wstein/build/cocalc-lite4/src/packages/database/postgres/project/project-and-user-tracker.ts)
  loads all projects for an account so it can route updates later

That design is too expensive at large scale because it couples:

- active browsers
- size of each user account
- live database fanout

The new design must break that coupling.

## Core Concepts

### Cell

A cell is the main deployment unit.

Every cell runs the same software stack:

- control hub / API
- browser-facing control Conat endpoint
- host-controller service
- worker/scheduler processes
- Conat nodes
- one Postgres database
- projection updaters

Cells are identical operationally. There are not separate binaries for
"account cells" and "project cells".

### Home Cell

Each account has one `home_cell_id`.

The home cell is where account-facing UI state lives:

- project list
- collaborator list
- notifications
- account settings
- lightweight project summaries for all accessible projects

The browser talks to the home cell for control-plane work.

### Owning Cell

Each project has one `owning_cell_id`.

The owning cell is authoritative for:

- the project row
- membership/collaborators on that project
- lifecycle state
- host placement
- backups/snapshots metadata
- project-scoped chat/automation/control metadata

The owning cell decides where the project runs.

### Project Host

Each project host belongs to one cell.

Steady-state rule:

- a project runs only on a host in its owning cell's compute pool

This simplifies routing and authority. Moving a project between cells also
moves project ownership.

## Deployment Modes

### Plus

Not relevant to large-scale architecture. It can remain special.

### Launchpad

Launchpad should be the one-cell version of Rocket.

That means:

- one cell
- one Postgres
- one directory mapping everything to that cell
- one browser control Conat endpoint
- local in-process or same-node dispatch instead of cross-cell routing

Important property:

- the Rocket code paths get exercised in Launchpad
- there is one architecture to maintain

### Rocket

Rocket is many cells plus a small global layer.

## Global Services

The global layer must be kept intentionally tiny.

It should contain:

- auth / session issuance
- billing / subscriptions
- directory / placement service
- optional global email/notification dispatch

It should *not* contain:

- live user project lists
- collaborator lists
- per-user browser changefeed fanout
- project lifecycle state beyond placement pointers

## Global Tables

These can live in a small global database.

### `cells`

Tracks all cells.

Suggested columns:

- `cell_id`
- `region`
- `zone_group`
- `state`
- `public_api_base_url`
- `internal_conat_cluster`
- `capacity_class`
- `created_at`
- `updated_at`

### `accounts_directory`

Maps accounts to home cells.

Suggested columns:

- `account_id`
- `home_cell_id`
- `preferred_region`
- `org_id`
- `created_at`
- `updated_at`

### `projects_directory`

Maps projects to owning cells and current hosts.

Suggested columns:

- `project_id`
- `owning_cell_id`
- `host_id`
- `host_session_id`
- `region`
- `state_summary`
- `created_at`
- `updated_at`

This is the minimum global directory entry. The authoritative project row is in
the owning cell.

### `hosts_directory`

Global host registry.

Suggested columns:

- `host_id`
- `cell_id`
- `region`
- `machine_class`
- `gpu_class`
- `state`
- `last_heartbeat_at`
- `public_url`
- `internal_url`

### `org_directory`

Optional but probably useful.

Suggested columns:

- `org_id`
- `preferred_cell_id`
- `preferred_region`
- `policy_json`

This lets org-owned projects bias toward one cell/region.

## Cell-Local Authoritative Tables

These live in each cell's Postgres and are authoritative only for rows owned by
that cell.

### `projects`

Only projects whose `owning_cell_id == this_cell_id`.

Suggested additions relative to current model:

- `project_id`
- `owning_cell_id`
- `host_id`
- `state`
- `users`
- `title`
- `description`
- `launcher`
- `settings`
- `last_activity_at`
- `created_at`
- `updated_at`

The current `projects` table shape from
[projects.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/projects.ts)
can largely remain, but it is now cell-partitioned.

### `project_events_outbox`

Transactional outbox for authoritative project changes.

Suggested columns:

- `event_id`
- `project_id`
- `event_type`
- `payload_json`
- `created_at`
- `published_at`

This is the durable source for cross-cell propagation.

### `project_host_assignments`

Optional normalized table if needed instead of overloading `projects.host_id`.

### `project_chats`, `project_automations`, `project_notifications`

Any project-scoped control metadata should live with the owning project.

## Cell-Local Projection Tables

These live in each cell's Postgres for accounts homed in that cell.

These are what the browser queries and subscribes to.

### `account_project_index`

One row per `(account_id, project_id)` visible to that account.

Suggested columns:

- `account_id`
- `project_id`
- `owning_cell_id`
- `host_id`
- `title`
- `description`
- `users_summary`
- `state_summary`
- `last_activity_at`
- `last_opened_at`
- `is_hidden`
- `sort_key`
- `updated_at`

This replaces the need to query the global/base `projects` table for the
browser's project list.

### `account_collaborator_index`

One row per `(account_id, collaborator_account_id)`.

Suggested columns:

- `account_id`
- `collaborator_account_id`
- `common_project_count`
- `display_name`
- `avatar_ref`
- `updated_at`

This replaces the need for the current collaborator changefeed model.

### `account_notification_index`

Suggested columns:

- `account_id`
- `notification_id`
- `kind`
- `project_id`
- `summary`
- `read_state`
- `created_at`

### `account_settings_projection`

If account settings become split across systems, keep a browser-friendly
projection here.

## Browser Connections

The browser should keep exactly one control-plane Conat connection:

- to the `home_cell`

That connection handles:

- project list reads/subscriptions
- collaborator reads/subscriptions
- notifications
- account settings
- project-scoped control RPC that the home cell forwards when needed

The browser may also keep direct project-host connections for:

- notebooks
- terminals
- sync docs
- codex/project runtime traffic

Important implementation rule:

- avoid use of a global implicit Conat client in browser code
- all non-default cell/project-host clients must be passed explicitly

This is critical because mixing clients implicitly has already caused bugs in
the current hub vs project-host split.

## Internal Conat Layout

Conat should be the internal fabric for:

- inter-cell RPC
- inter-cell event distribution
- host-to-cell control traffic
- cell-local browser live fanout

Do not create subjects per project.

That would lead to enormous subject interest state, e.g. millions of project
subjects.

### Inter-Cell RPC

Use one subject per cell API surface, e.g.:

- `api.cell.<cell_id>`

The RPC payload includes:

- caller cell
- authenticated account
- method name
- request body
- trace/request id

This matches normal NATS/Conat-style RPC and avoids subject explosion.

### Host Control RPC

Use one subject per host control endpoint or per cell host-controller endpoint,
e.g.:

- `host.cell.<cell_id>`
- `host.<host_id>` only if the number of live hosts is reasonable

Since host counts are much smaller than project counts, host-specific subjects
are acceptable if useful.

### Durable Inter-Cell Streams

For durable cross-cell replication, use one durable Conat stream per
destination cell, not per project and not per account.

Suggested logical naming:

- `cells/<dest_cell_id>/events`

Stored under hub/global scope in Conat persist.

Each event includes:

- `event_id`
- `source_cell_id`
- `destination_cell_id`
- `entity_type`
- `entity_id`
- `event_type`
- `payload`
- `created_at`

Events stay on disk until the destination cell has definitely consumed them.

This is the correct way to guarantee that cell `B` eventually receives project
summary updates from cell `P`.

### Optional Fanout Streams Inside A Cell

Inside a cell, browser session fanout can be driven by:

- one cell-local stream per account session
- or one in-memory/pubsub fanout fed from projection updates

The exact local mechanism is less important than the architectural rule:

- browser updates come from account projections, not direct base-table
  changefeeds

## Why Postgres LISTEN/NOTIFY Is Not Core Anymore

Postgres remains the durable relational store.

However:

- browser reactivity should not depend on base-table `LISTEN/NOTIFY`
- cross-cell correctness should not depend on `LISTEN/NOTIFY`

Acceptable use of `LISTEN/NOTIFY`:

- optional wakeup hint for local outbox workers

Not acceptable:

- one live DB changefeed per browser query
- reconstructing user-visible state by listening directly to base tables

## Event Model

The event model is central.

### Authoritative Events

Produced by the owning cell inside the same transaction as the write via the
outbox table.

Examples:

- `project.created`
- `project.summary_changed`
- `project.membership_changed`
- `project.state_changed`
- `project.host_changed`
- `project.deleted`
- `project.moved_out`
- `project.moved_in`

### Projection Update Consumers

Home cells consume these events and update:

- `account_project_index`
- `account_collaborator_index`
- notifications

### Delivery Guarantee

The design target is:

- at-least-once delivery between cells
- idempotent projection updaters

This is fine because projection tables can safely upsert by `(account_id,
project_id)` and use event ids/version numbers for deduplication.

## Control Flows

### Login / Bootstrap

1. User authenticates against the global auth service.
2. Global directory resolves `account_id -> home_cell_id`.
3. Browser receives:
   - auth token
   - home cell address
   - any bootstrap config needed
4. Browser opens control Conat connection to `home_cell`.
5. Browser requests initial account projections from `home_cell`.

### Open Project

1. Browser selects a project from its home-cell project index.
2. Browser asks `home_cell` to open the project.
3. `home_cell` consults:
   - local projection row for `owning_cell_id`
   - or global directory if cache is stale
4. If needed, `home_cell` forwards RPC to `owning_cell`.
5. `owning_cell` returns:
   - current host route
   - access token / session material
   - project status
6. Browser connects directly to project host for the data plane.

### Rename Project

1. Browser sends rename RPC to `home_cell`.
2. `home_cell` forwards to `owning_cell`.
3. `owning_cell` transactionally:
   - updates `projects`
   - appends `project.summary_changed` to outbox
4. `owning_cell` returns success.
5. Outbox worker publishes event.
6. Each relevant home cell updates `account_project_index`.
7. Home cell pushes updated summary to connected browser sessions.

### Add Collaborator

1. Browser sends collaborator add RPC to `home_cell`.
2. `home_cell` forwards to `owning_cell`.
3. `owning_cell` updates project membership transactionally and writes
   `project.membership_changed`.
4. Outbox worker publishes event.
5. All affected home cells update:
   - `account_project_index`
   - `account_collaborator_index`
6. Connected browsers receive updates from their home cells.

### Start Project

1. Browser asks `home_cell` to start the project.
2. `home_cell` forwards to `owning_cell`.
3. `owning_cell` selects/validates a host within its own compute pool.
4. `owning_cell` instructs host-controller / host via Conat.
5. Host starts the project runtime.
6. Host reports state back to owning cell.
7. Owning cell updates authoritative `projects.state` and emits
   `project.state_changed`.
8. Home cells update their projections.

### Move Project Between Cells

Project moves are required for:

- rebalancing
- GPU vs non-GPU placement
- storage or compliance reasons
- region moves

This is not trivial, but it is necessary and should be designed in from the
start.

Suggested move flow:

1. A global or source-cell operator initiates move.
2. Source owning cell is `S`, destination cell is `D`.
3. Project is quiesced or placed in move-safe mode.
4. Project data is copied to a host in `D`.
5. Authoritative project metadata is copied from `S` to `D`.
6. `D` creates the project row transactionally with `owning_cell_id = D`.
7. Global directory updates `project_id -> owning_cell_id = D`.
8. `S` writes `project.moved_out`; `D` writes `project.moved_in`.
9. Home-cell projections update route/owner information.
10. Browser/project open requests now resolve to `D`.
11. Source cell retains tombstone/redirect metadata for a bounded period.

The move must be treated as a first-class workflow, not an afterthought.

## Directory Semantics

The directory should be tiny and authoritative for routing only.

It should answer:

- where is this account homed?
- where is this project owned?
- which cell owns this host?

It should not attempt to be a global project-list or collaboration database.

## Messages Table

The current global `messages` functionality in
[messages.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/messages.ts)
does not fit naturally into this architecture if kept exactly as-is.

That is acceptable.

Recommendation:

- do not treat the current global user-to-user messaging system as a hard
  requirement for Rocket scaling
- replace it with email or another simpler notification channel
- or redesign it later as a separate service

This should not block the cell architecture.

## Geographic Distribution

Geographic distribution should be supported, but not by making one globally
synchronous control plane.

Recommended approach:

- cells are region-local
- a cell's Postgres is strongly consistent only within that region
- cross-region propagation is asynchronous via Conat/event replication
- accounts default to a home cell near the user/org
- projects default to an owning cell near desired compute or collaborators

Do not require globally synchronous multi-region Postgres replication.

## Multi-Zone High Availability

Within a region:

- run cell services across multiple zones
- run Postgres with zonal HA/failover
- run Conat nodes across zones
- keep project host pools spread across zones where practical

This is orthogonal to multi-region distribution.

## Launchpad As One-Cell Rocket

This should be an explicit product requirement.

In one-cell mode:

- directory maps everything to `cell-0`
- `home_cell_id == owning_cell_id == cell-0`
- inter-cell RPC becomes local dispatch
- cross-cell event replication is disabled
- the same projection tables are still used

Benefits:

- one architecture to maintain
- Launchpad tests Rocket control-plane code paths
- much lower migration risk

## Migration Plan

### Phase 1: Projection Interface In The Monolith

Before sharding:

- build projection tables for project list, collaborators, notifications
- stop exposing raw base-table changefeeds directly to the browser
- keep current monolith, but change the interface

This is the most important rewrite because it is needed whether or not cells are
introduced immediately.

### Phase 2: Introduce Directory And Cell Identity

- add `home_cell_id` and `owning_cell_id`
- add global directory service
- keep one real cell initially

### Phase 3: Launchpad Uses The One-Cell Architecture

- Launchpad runs the same cell stack in one-node mode
- no cross-cell traffic yet

### Phase 4: Add Cross-Cell RPC And Durable Inter-Cell Streams

- implement `api.cell.<cell_id>`
- implement per-destination-cell durable event streams
- implement projection consumers

### Phase 5: Move Some Accounts/Projects To Additional Cells

- new tenants first
- then controlled project moves

### Phase 6: Region Expansion

- add region-aware cell placement
- keep async inter-region replication

## Concrete Do / Do Not

Do:

- use Postgres for authoritative relational state
- use Conat for internal RPC/events/fanout
- use per-account projection tables for browser-facing data
- use one home-cell browser control connection
- move project ownership with project moves

Do not:

- use raw base-table changefeeds for browser reactivity at scale
- create Conat subjects per project
- make project hosts depend on one global central hub
- make global services carry the full weight of live user state

## Immediate Next Design Step

The next document should define the exact schema and API deltas needed in the
codebase:

- exact new global tables
- exact modifications to existing `projects` and related cell-local tables
- exact projection table schemas
- exact Conat subjects and RPC method names
- exact event payload contracts
- exact project move state machine
- exact browser bootstrap payload

That is enough detail to start implementing Launchpad-as-one-cell first, then
expand to Rocket cells.
