# Multibay Data Ownership Correctness Plan

Date: 2026-06-03

## Goal

Make the multibay data model correct by construction:

- every durable table has one explicit authority model;
- every write path routes to that authority;
- every routine drain path only depends on state that is explicitly
  disposable, rebuildable, or intentionally stable on its existing bay;
- bay-local caches and projections are clearly labeled as disposable;
- tests fail when new account/project/host/global state is added without an
  ownership decision.

This plan extends the current `scalable-architecture.md` rule:

- accounts are placed by `home_bay_id`;
- projects are placed by `owning_bay_id`;
- project hosts are placed by `bay_id`;
- anything else must either be seed-global, explicitly attached to one of the
  above ownership domains, explicitly stable on a bay, or explicitly
  disposable/rebuildable.

Important release stance:

- account/project/host rehome is an exceptional operator escape hatch, not a
  routine balancing primitive and not a foundational correctness assumption;
- rehome may work for carefully audited cases, but it is dangerous until every
  attached table has proven portability semantics;
- new placement and host/workload drain are the normal operational tools;
- old placements may remain stable on their original bay indefinitely;
- CLI mutation paths must call this out and require an explicit unsafe flag for
  rehome writes.

## Architecture Motivation

The multibay architecture is not primarily a high-availability design.

Reliability and high availability are handled within each bay. It is acceptable
for a piece of authoritative data to live on exactly one bay. The correctness
requirement is not "every bay has every important row"; the requirement is
"every row has a clear authoritative bay, and code always knows where that is."

The primary goal is scale:

- support millions of simultaneous active users by spreading control-plane load
  across many bays;
- avoid a design where every active browser, project, and control-plane event
  depends on one central hub/database;
- make scale mostly an operations/spending problem rather than a future
  architecture replacement.

The secondary goal is latency:

- place account home bays near users when useful;
- place project owning bays and project hosts near active compute/data-plane
  traffic when useful;
- keep browser-to-project-host traffic direct whenever possible.

The critical operational constraint is safe operational drainability:

- project hosts and active workloads must be drainable;
- a non-seed bay can be placed into "no new placement" mode and drained of
  active compute/workload pressure without moving every durable tenant row;
- full account/project/host rehome is allowed only as an exceptional, audited,
  unsafe operation with a dry-run and rollback plan;
- deleting a non-seed bay is a separate whole-bay evacuation project, not a
  routine consequence of normal drain;
- the seed bay exists for the lifetime of the cluster and is not removable;
- the seed bay may still be drained of active accounts, projects, and project
  hosts over time, but seed-global state remains there.

This motivation affects data-location tradeoffs:

- if all bays are in one low-latency cluster, seed roundtrips and iterating over
  all bays are often acceptable implementation shortcuts;
- if bays become geographically distributed, frequent seed roundtrips become a
  latency and reliability tax, so attached bays need local mirrors/projections
  for hot read paths;
- seed-global state is appropriate for low-volume, high-value, commercial,
  security, and cluster configuration data;
- account/project/host owned state is appropriate for high-volume operational
  data that benefits from horizontal scaling and locality;
- stable account/project/host placement is acceptable; rebalancing should
  usually happen by changing where new accounts/projects/hosts are placed, not
  by moving old durable state;
- global config should usually be seed-authoritative but mirrored to attached
  bays, so normal reads stay local while writes remain unambiguous.

## Current Problem

Several active tables are neither obviously seed-global nor clearly attached to
account, project, host, stable-bay, projection, cache, or ephemeral ownership.
That creates the same class of bug we just fixed for site licenses: durable
product/business state can be created on a random bay, then disappear or become
unreachable when operators assume the bay can be deleted or transparently
evacuated.

The immediate goal is not to make routine rehome safe for everything. The
immediate goal is to stop accidental ambiguity:

- commercial ledgers, credits, licenses, and global config must not be local to
  whichever bay handled the request;
- account/project/host-local tables must say whether they are stable placement,
  portable, projection/cache, or intentionally not rehome-safe;
- user-visible tooling must not imply that rehome is a safe default maintenance
  operation.

There is also an existing global-settings pattern where saving site settings
writes locally, then attempts to push the same updates to every bay. This is
operationally useful but weak as a source-of-truth model:

- concurrent admin saves can race;
- partial propagation leaves inconsistent bay state;
- a non-seed bay can become the accidental authority;
- there is no uniform version/epoch that says which bay has which config.

The target model should be: seed is authoritative for global config and
commercial/global records; non-seed bays have read-through or periodically
mirrored copies with versioned convergence.

## Ownership Classes

Every durable table should be assigned exactly one of these classes.

### `seed-global`

The seed bay is authoritative. Attached bays may cache/mirror, but direct writes
must go to the seed.

Examples:

- cluster/site config;
- commercial catalogs;
- site licenses;
- software licenses;
- global claim directories;
- global audit/security state that must survive bay drain.

### `account-home`

The account home bay is authoritative. By default, this is stable placement.
Account rehome is exceptional and unsafe unless the table is explicitly marked
portable or rebuildable.

Examples:

- account sessions/auth factors;
- account UI projections;
- account-owned API keys;
- account-level entitlements if not seed-global.

### `project-owning`

The project owning bay is authoritative. By default, this is stable placement.
Project rehome is exceptional and unsafe unless the table is explicitly marked
portable or rebuildable.

Examples:

- project lifecycle/control metadata;
- project collaborator/invite state;
- project backup indexes if they are not seed/global;
- project-scoped external credentials.

### `host-owning`

The host's bay is authoritative. By default, this is stable placement. Host
rehome is exceptional and unsafe unless the table is explicitly marked portable
or rebuildable from cloud/provider data.

Examples:

- host access records;
- self-host connector records;
- host bootstrap/pairing state that is not short-lived.

### `projection`

Bay-local projection/copy. It may be deleted and rebuilt from authoritative
state.

Examples:

- account project index;
- account collaborator index;
- notification inbox projections.

### `cache`

Bay-local cache. Loss is acceptable and refresh paths exist.

Examples:

- cloud catalog cache;
- provider pricing cache;
- temporary provider reconcile state, if recoverable.

### `ephemeral`

Short-lived data that may be safely dropped during bay drain.

Examples:

- login challenges;
- one-time pairing tokens after expiry;
- transient operation progress.

### `audit-local`

Append-only operational history that is intentionally per-bay. This must be a
conscious decision, not a default. If the audit record is legally/commercially
important, use `seed-global` instead.

### `stable-bay`

Durable state intentionally remains on the bay where it was created or assigned.
It is not expected to move during routine operations.

Examples:

- legacy low-volume account/project/host side tables that are not release
  blockers and are not safe to move yet;
- historical operational data that is useful but not commercially critical;
- records whose ownership will be revisited before any whole-bay evacuation.

Rules:

- normal code must route reads/writes to the stored authoritative bay;
- routine drain must not delete this bay while stable-bay state remains;
- rehome tools must report or refuse unsupported stable-bay attachments unless
  running an explicit unsafe evacuation path.

## Initial Risk Inventory

This is from a code scan, not a completed compatibility audit.

### High Priority

#### Software licensing

Tables:

- `software_license_tiers`
- `software_licenses`
- `software_license_events`

Current concern:

- `src/packages/server/conat/api/software.ts` uses direct local DB access for
  tier and license list/create/revoke/restore operations.
- `software_licenses.owner_account_id` is only a reference; the license itself
  is commercial/global state.
- If created on an attached bay, a drained bay could lose license records.

Target:

- classify as `seed-global`;
- route all admin and user license reads/writes to the seed;
- keep local attached-bay cache optional only if needed for activation latency;
- make activation either query seed or use a signed-token-only path where DB
  state is not required for correctness.

#### Admin-assigned memberships

Table:

- `admin_assigned_memberships`

Current concern:

- direct local reads/writes in `src/packages/server/conat/api/system.ts`;
- not included in `src/packages/server/accounts/rehome.ts`
  `PORTABLE_STATE_TABLES`;
- newer `account_entitlement_overrides` already route to account home, so this
  table is an older conflicting entitlement path.

Target:

- decide whether to retire it in favor of `account_entitlement_overrides`, or
  classify as `account-home` and route it consistently; (ANS: classify as
  `account-home` and route it consistently)
- if retained, route admin APIs to target account home bay;
- explicitly mark it `portable` or `stable` for account rehome;
- if `portable`, add it to account rehome copy/clear state;
- if `stable`, ensure unsafe account rehome warns/refuses when rows exist;
- prefer retirement if it is only legacy/on-prem/dev functionality.

#### External credentials

Table:

- `external_credentials`

Current concern:

- local-only encrypted credential store;
- supports `account`, `project`, `organization`, and `site` scope;
- hard-delete knows about project-scoped rows, but project rehome does not copy
  them;
- account-scoped rows are not in account rehome portable state;
- site/org scope needs a seed/global decision.

Target:

- split authority by scope:
  - `site`: `seed-global`;
  - `organization`: seed-global unless organizations get a formal home bay;
  - `account`: `account-home`;
  - `project`: `project-owning`;
- route reads/writes by scope before touching DB;
- explicitly mark account/project scoped rows `portable` or `stable`;
- if `portable`, include account/project scoped rows in corresponding rehome
  copy/clear state;
- if `stable`, ensure unsafe rehome warns/refuses when credentials exist;
- if moved, ensure encrypted payloads remain decryptable after move.

#### Self-host connectors

Tables:

- `self_host_connectors`
- `self_host_connector_tokens`
- `self_host_commands`

Current concern:

- connector records are account/host scoped;
- host rehome currently carries `project_hosts` and `project_host_access`, but
  not connector rows;
- a self-host host stored on an attached bay can become unusable after host
  rehome/drain if connector state stays behind.

Target:

- classify durable connector records as `host-owning`;
- copy `self_host_connectors` and active durable connector command state during
  host rehome;
- classify short-lived pairing tokens as `ephemeral` unless they must survive
  host rehome in progress;
- document whether old command history is `host-owning` or `audit-local`.

### Medium Priority

#### Purchases and statements

Tables:

- `purchases`
- `statements`

Current concern:

- billing and balance history is commercial state;
- many paths use local DB access;
- account rehome does not list these tables.

Target:

- decide authority:
  - likely `account-home` for per-account balance and purchase ledger, or
    `seed-global` for all commercial ledgers; (ANS: account-home)
- if `account-home`, add purchase/statement rows to account rehome and route
  billing APIs by account home;
- if `seed-global`, route all payment/ledger writes to seed and use local
  projections for UI/account summaries;
- do not leave billing writes as "wherever the request landed".

#### Project-scoped side tables

Examples:

- `project_backup_indexes`
- `project_backup_repo_assignments`
- `mentions`
- `listings`
- `usage_info`
- `bookmarks`
- `project_app_public_subdomains`
- `notification_events_outbox`
- `project_events_outbox`
- project-scoped `external_credentials`
- `blobs`, `syncstrings`, `patches`, `cursors`

Current concern:

- project hard-delete knows many of these tables;
- project rehome currently only copies project log portable state;
- some are data-plane/project-host state, some are control-plane metadata, and
  some are projections.

Target:

- classify each table;
- for `project-owning` rows, explicitly choose `portable`, `rebuildable`, or
  `stable`;
- only add project rehome copy/clear support for rows intentionally marked
  `portable`;
- for `projection` rows, document rebuild path and ensure drain can rebuild or
  tolerate deletion;
- keep heavy data-plane sync content out of hub-mediated rehome unless the
  table is truly control-plane authoritative.

#### Global config and catalog state

Examples:

- `server_settings`
- virtual `site_settings`;
- `membership_tiers`;
- `buckets`;
- `project_backup_repos`;
- rootfs catalogs and release metadata;
- cloud catalog/pricing cache/config;
- SSO/registration-token/global policy tables.

Current concern:

- some of this is true global source-of-truth config;
- some is safely bay-local cache;
- site settings currently use a "save locally, then push to all bays" model.

Target:

- seed is authoritative for global config;
- attached bays hold mirrored snapshots with source version;
- writes only happen on seed or are forwarded to seed;
- bay-local caches are explicitly named/cache-classified and never confused with
  global config.

### Low Priority / Likely Disposable

These still need classification, but probably should not block release:

- analytics/client error/webapp error logs;
- support ticket attempts;
- transient auth challenges;
- bay-local operational logs;
- provider work queues, if idempotent/recoverable.

## Server Settings Redesign

### Current Pattern

`setSiteSettings` normalizes updates, requires fresh admin auth, writes local
`server_settings`, then calls inter-bay `setServerSetting` on other bays. The
frontend treats any failed bay sync as save failure.

This gives fast convergence when everything works, but the authority is
ambiguous.

### Target Pattern

1. Seed owns `server_settings`.
2. All admin site-settings writes route to seed.
3. Seed writes settings inside a transaction with a monotonically increasing
   config version.
4. Seed records config changes in an outbox/table, e.g.
   `global_config_events`.
5. Attached bays pull or receive changes and apply them as mirrors.
6. Attached bays record their applied version.
7. Admin UI shows propagation status:
   - seed version;
   - per-bay applied version;
   - stale/missing/error bays.
8. Reads on attached bays use local mirrored settings for low latency, but
   expose version/staleness for admin diagnostics.

### Suggested Tables

`global_config_versions`

- `scope text primary key`;
- `version bigint not null`;
- `updated timestamptz not null`;
- `updated_by uuid`;
- `metadata jsonb`.

`global_config_events`

- `id uuid primary key`;
- `scope text not null`;
- `version bigint not null`;
- `changes jsonb not null`;
- `created timestamptz not null`;
- `created_by uuid`;

`global_config_bay_state`

- `bay_id text not null`;
- `scope text not null`;
- `applied_version bigint not null`;
- `applied_at timestamptz not null`;
- `last_error text`;
- primary key `(bay_id, scope)`.

This can start with `scope='server_settings'` and later cover membership tiers,
software license tiers, rootfs catalogs, and other global config.

### Migration Strategy

Phase 1 keeps current local read path:

- seed is source of truth for new writes;
- writes still synchronously fan out after seed commit;
- attached bays can be repaired by a periodic sync job.

Phase 2 moves to robust async mirroring:

- seed commit succeeds once seed is durable;
- propagation is monitored separately;
- admin UI warns when a bay is stale.

Phase 3 removes direct attached-bay writes:

- `setServerSetting` on attached bays becomes internal-only and requires a
  seed-signed/cluster credential;
- direct admin calls to attached bays forward to seed.

## Implementation Phases

### Phase 0: Table Ownership Manifest

Status: implemented 2026-06-03.

Create a source-controlled manifest, probably under
`src/packages/util/db-schema/table-ownership.ts`.

Each entry should include:

- table name;
- ownership class;
- authority key, if applicable;
- portability status: `portable`, `rebuildable`, `stable`, or `unsupported`;
- rebuild/delete policy;
- notes.

Example shape:

```ts
export type TableOwnership =
  | "seed-global"
  | "account-home"
  | "project-owning"
  | "host-owning"
  | "stable-bay"
  | "projection"
  | "cache"
  | "ephemeral"
  | "audit-local";
```

Add a test that fails when a schema table is missing from the manifest.

Implemented artifacts:

- `src/packages/util/db-schema/table-ownership.ts` defines the initial manifest,
  ownership classes, authority keys, portability statuses, notes, and rebuild
  policy hooks.
- `src/packages/util/db-schema/table-ownership.test.ts` fails when any
  registered durable `SCHEMA` table is missing from the manifest, when the
  manifest references an unregistered durable table, or when rebuildable entries
  lack a documented rebuild path.
- Virtual query tables and external PostgreSQL system tables are intentionally
  excluded; their placement follows the real table they wrap.

Important current-state calls encoded in the manifest:

- `purchases` and other account-commercial state are account-home but
  `unsupported` for rehome until billing-ledger authority is deliberately
  fixed.
- seed-global commercial/config/catalog state is explicitly seed-authoritative.
- account/project/host-owned source-of-truth tables default to `unsupported`
  portability rather than pretending routine rehome is safe.
- projections, caches, aggregate analytics, local audit logs, and ephemeral work
  queues are separate classes, so drain tooling can treat them differently.

### Phase 1: Automated Risk Test

Status: implemented first pass 2026-06-03.

Add tests that inspect schema metadata and table names/fields.

The test should fail or warn when:

- a table has `account_id` but is neither `account-home`, `seed-global`,
  `stable-bay`, `projection`, `cache`, `ephemeral`, nor explicitly exempt;
- a table has `project_id` but is neither `project-owning`, `projection`,
  `stable-bay`, `cache`, `ephemeral`, nor explicitly exempt;
- a table has `host_id` but is neither `host-owning`, `projection`, `cache`,
  `stable-bay`, `ephemeral`, nor explicitly exempt;
- a table is classified as `account-home`, `project-owning`, or `host-owning`
  but has no declared portability status;
- a table is marked `portable` but is missing from the corresponding rehome
  copy/clear implementation;
- a table is marked `rebuildable` but has no documented rebuild path;
- a table is marked `stable` or `unsupported` and a routine rehome/drain tool
  tries to move or delete the authoritative bay without an explicit unsafe
  override.

This test is the key to "stay correct."

Implemented artifacts:

- `table-ownership.test.ts` scans non-test `src/packages/server` TypeScript
  files for `CREATE TABLE IF NOT EXISTS`.
- Literal table names and simple constants such as `${TABLE}` are resolved.
- Every server-side Postgres table created outside `util/db-schema` must either
  be a registered durable schema table or have an explicit ad hoc ownership
  entry in `AD_HOC_POSTGRES_TABLE_OWNERSHIP`.
- The ad hoc manifest records whether each hidden table should migrate into
  `util/db-schema` or may remain outside as documented cache/ephemeral state.
- `project_backup_indexes` already had a `util/db-schema` declaration but was
  not imported into the schema index; it is now registered and covered by the
  durable table manifest.
- The manifest now records intentional secondary reference fields, e.g. an
  account-owned table with a `project_id` reference.
- The test enforces consistency for `account_id`, `owner_account_id`,
  `project_id`, `host_id`, and `bay_id` fields across both durable schema
  tables and documented ad hoc PostgreSQL tables.

Still needed:

- follow-up migrations moving durable ad hoc tables into `util/db-schema` or
  formal migrations where that adds real value;
- stronger runtime enforcement in routing/write helpers, not only schema-level
  tests.

### Phase 2: Seed-Global Commercial State

Status: software licensing seed routing implemented first pass 2026-06-03.

Fix the highest-risk commercial state first.

Tasks:

- finish/site-license seed routing is already done;

- route software licensing APIs to seed;

- classify and route software license activation;

- decide whether software license tiers are part of the server-settings/global
  config version stream;

- add tests proving an attached bay forwards create/list/revoke/restore to seed.

Implemented artifacts:

- `software_license_tiers`, `software_licenses`, and
  `software_license_events` are classified as `seed-global` in the manifest.
- Software license admin/user APIs authenticate on the receiving bay, then
  forward attached-bay reads/writes to the seed account-local inter-bay API.
- Seed-local helper functions contain the direct DB implementation, so the DB
  authority is explicit and reusable by the inter-bay service.
- Focused tests cover dangerous fresh-auth behavior and attached-bay forwarding
  for license creation and owned-license listing.

Still needed:

- route/confirm software license activation paths use seed or signed-token-only
  semantics;
- decide whether license tiers join the future global config version/mirror
  stream;
- add broader inter-bay service tests if this API becomes hot or externally
  exposed.

### Phase 3: Admin Membership Entitlement Cleanup

Status: implemented first pass 2026-06-04.

Tasks:

- decide whether `admin_assigned_memberships` is still needed; (ANS: YES, definitely needed still. overrides are far to fine grained)
- if obsolete, migrate or delete it in favor of `account_entitlement_overrides`;
- if retained, make it `account-home`;
- route admin APIs to target account home bay;
- decide whether it is `portable` or `stable` for rehome;
- if `portable`, include it in account rehome copy/clear state;
- if `stable`, ensure unsafe account rehome warns/refuses when it exists;
- add tests covering the chosen placement/portability behavior.

Implemented artifacts:

- `admin_assigned_memberships` remains an account-home table and is now marked
  `portable` in the ownership manifest.
- Local DB access is centralized in
  `src/packages/server/membership/admin-assigned.ts`.
- Admin UI RPCs `getAdminAssignedMembership`,
  `setAdminAssignedMembership`, and `clearAdminAssignedMembership` resolve the
  target account home bay before reading/writing.
- Attached bays forward admin-assigned membership operations to the target
  account home bay through account-local inter-bay RPCs.
- Account rehome includes `admin_assigned_memberships` in the copied portable
  account state.
- Focused tests cover local reads, remote forwarding, and fresh-auth gating for
  remote writes.

Still needed:

- the admin-assisted purchase path still writes admin-assigned membership rows
  in the same transaction as billing ledger rows; fix that together with Phase
  6 billing-ledger authority so commercial transactions remain coherent;
- add an end-to-end rehome regression test that verifies an admin-assigned
  membership survives account rehome.

### Phase 4: External Credentials Ownership Split

Status: mostly implemented.

Implemented:

- added scope-aware routing helpers:
  - account scope -&gt; account home;
  - project scope -&gt; project owning bay;
  - site scope -&gt; seed;
  - organization scope -&gt; seed for now;
- added a dedicated bay-addressed `inter-bay-external-credentials` service;
- updated system/host APIs to use the routing helpers before store access;
- classified `external_credentials` as `row-scoped` in the manifest, with
  account/project/seed authority determined by each row selector scope;
- treated these rows as `unsupported` for rehome/drain, so normal bay drain
  remains blocked unless an explicit unsafe override is used;
- added focused routing tests for local account, remote account, remote
  project, and seed-scoped credential access.

Still needed:

- decide later whether account/project scoped credential rows should become
  `portable`;
- if `portable`, include account/project scoped rows in account/project
  rehome copy/clear state;
- explicitly check encryption/decryption after move before ever making them
  portable.

### Phase 5: Self-Host Connector Portability

Status: first safety slice implemented.

Implemented:

- classified `self_host_connectors`, `self_host_connector_tokens`, and
  `self_host_commands` as `host-owning`;
- added `connector_id` as an explicit manifest authority/reference key for
  self-host connector subresources;
- marked these tables `unsupported`, so normal bay drain/rehome blocks rather
  than silently dropping connector auth or in-flight commands;
- added a bay-drain preflight regression for the connector tables.

Still needed:

- decide later whether connector records should become `portable`;
- if `portable`, include connector records in host rehome payload;
- decide token copy/drop behavior before portability:
  - expired/pairing tokens can probably be dropped;
  - active installation tokens may need copy if host rehome happens during
    setup;
- decide whether completed `self_host_commands` can be treated as disposable
  history while pending/sent commands remain blocking;
- add host rehome tests for self-host connector continuity.

### Phase 6: Billing Ledger Authority

Status: first safety slice implemented.

Decision for the current release:

- keep `purchases` and `statements` account-home authoritative for now, because
  current billing, statement generation, Stripe/payment-intent reconciliation,
  balance calculations, project-host spend-cap checks, and membership purchase
  paths all assume account-home/local transactional access;
- treat both tables as `unsupported` for routine drain/rehome;
- make generic drain/rehome tooling block on these tables unless an explicit
  unsafe operator path is used;
- do not claim billing ledger portability until there is a dedicated migration
  and routing design.

Balance source-of-truth today:

- `purchases` is the commercial ledger input used to compute account balance;
- `statements` is statement/balance snapshot and payment reconciliation state
  derived from the ledger;
- losing either table, or reinitializing it on another bay, can incorrectly
  change customer credit/debt.

Long-term target:

- move immutable commercial ledger/payment processor state to seed-global;
- keep account-home projections for fast account UI and local spend checks;
- route all new purchase/statement/payment writes to the seed authority;
- version or rebuild account-home projections from seed.

Implemented:

- moved `statements` out of the generic account-home bucket and documented it as
  explicit billing ledger state;
- strengthened `purchases` notes to clarify that it is current balance source
  input and not generic account state;
- added bay-drain preflight regression coverage that both billing tables block
  normal drain.

Tasks:

- design the seed-global billing migration;
- document balance source-of-truth;
- route all new purchase/statement writes accordingly after migration;
- add seed-routing and projection-rebuild tests;
- ensure project-host spend caps and membership spend caps use the same account
  usage-window authority model.

Recommended default:

- seed-global for payment processor integration, statements, and immutable
  commercial ledger;
- account-home projections for fast account UI.

This avoids moving money history with accounts.

### Phase 7: Project Rehome Side-Table Audit

Status: first audit slice implemented.

Current project rehome reality:

- project rehome copies the `projects` row and a small portable Conat
  project-log payload;
- it does not copy SQL side tables such as secrets, backup indexes, app
  subdomains, copy/move operations, sync metadata, or project-scoped
  credentials;
- therefore project rehome remains an exceptional unsafe operation and must not
  be treated as routine maintenance.

Implemented:

- extracted the project hard-delete SQL side-table cleanup list into a shared
  module so it can be audited outside the delete implementation;
- added a regression that every hard-delete side table has an ownership-manifest
  entry;
- added a regression that no project-owned hard-delete side table can be marked
  `portable` unless it is explicitly included in the project rehome SQL portable
  table set;
- documented the current seed-global cleanup mismatch:
  `project_app_public_subdomains` is seed-global in the manifest but still
  reached by local project hard-delete cleanup.

Tasks:

- compare every table deleted by project hard-delete with project rehome;
- classify each table as project-owning/projection/cache/ephemeral;
- extend project rehome only for control-plane metadata that must survive;
- explicitly exclude heavy project data-plane tables unless needed.
- route hard-delete cleanup for seed-global project-attached records through
  seed authority, starting with `project_app_public_subdomains`;
- decide whether any SQL side tables become project-rehome portable:
  - likely candidates: `project_secrets`, `project_backup_indexes`, selected
    project-scoped `external_credentials`;
  - likely non-candidates: `blobs`, `syncstrings`, `patches`, `cursors`, large
    data-plane content.

Important distinction:

- project files, terminals, sync data, and large content should not be moved
  through hub/control-plane rehome unless there is a documented reason;
- metadata that controls access, backup availability, secrets, credentials, or
  public URLs must not be silently dropped.

### Phase 8: Global Config Seed Authority

Tasks:

- implement seed-routed `setSiteSettings`;
- add `server_settings` versioning;
- add attached-bay mirror apply path;
- add periodic repair/sync worker;
- add admin propagation status UI;
- then bring `membership_tiers`, global buckets/repos, and catalog config under
  the same framework where appropriate.

### Phase 9: Drain Safety Gate

Status: reusable preflight evaluator implemented first pass 2026-06-03.

Before draining a bay, run an automated preflight:

- list all non-disposable rows on the source bay by ownership class;
- verify account/project/host rows are already moved or scheduled;
- verify seed-global tables have no source-only rows;
- verify projections/caches are safe to drop;
- block drain if unknown or unclassified durable state remains.

This should be a CLI/admin API and should use the manifest.

Implemented artifacts:

- `src/packages/server/bay-drain/preflight.ts` evaluates local table names
  against the ownership manifest.
- Unknown tables always block drain.
- Unsupported/stable authoritative state blocks by default and downgrades only
  with an explicit `unsafe_rehome` override.
- Cache, ephemeral, and projection tables are treated as safe to drop/rebuild.
- Seed-global tables on non-seed bays warn, since they should be mirrors or
  reconcilable from seed.

Still needed:

- wire this evaluator into the actual drain/rehome CLI/admin paths;
- require an explicit unsafe flag for rehome-style operations that would leave
  or move unsupported account/project/host-owned state;
- add row-count/detail reporting so operators see which ownership classes remain
  on a bay before deletion.

## Definition of Done

This effort is done when:

- every schema table is classified;
- tests enforce classification for new tables;
- seed-global writes route to seed;
- account/project/host owned tables are included in rehome or explicitly
  rebuildable;
- drain preflight reports no unknown durable state;
- site settings no longer rely on ambiguous local-first writes;
- admin UI can show global config propagation status;
- a bay can be drained with confidence that only accounts, projects, and
  project-hosts need to be intentionally moved first.

## Recommended First Slice

Start with the ownership manifest and tests.

Reason:

- it is small and mechanical;
- it documents current reality without changing behavior;
- it prevents us from fixing one class of bugs while adding another;
- it gives every later phase a concrete checklist.

Then fix `software_licenses` as the next runtime change, since it is the most
similar to the just-fixed site-license issue.
