# Multibay Data Ownership Correctness Plan

Date: 2026-06-03

## Goal

Make the multibay data model correct by construction:

- every durable table has one explicit authority model;
- every write path routes to that authority;
- every rehome/drain path moves or rebuilds the data it is responsible for;
- bay-local caches and projections are clearly labeled as disposable;
- tests fail when new account/project/host/global state is added without an
  ownership decision.

This plan extends the current `scalable-architecture.md` rule:

- accounts move by `home_bay_id`;
- projects move by `owning_bay_id`;
- project hosts move by `bay_id`;
- anything else must either be seed-global, explicitly portable with one of
  the above, or explicitly disposable/rebuildable.

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

The critical operational constraint is drainability:

- any non-seed bay must be drainable;
- draining a non-seed bay may cause small planned downtime for affected
  accounts, projects, and project hosts;
- draining a non-seed bay must not lose durable state that is outside those
  three movable ownership domains;
- the seed bay exists for the lifetime of the cluster and is not removable;
- the seed bay may still be drained of accounts, projects, and project hosts,
  leaving only seed-global state.

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
- global config should usually be seed-authoritative but mirrored to attached
  bays, so normal reads stay local while writes remain unambiguous.

## Current Problem

Several active tables are neither obviously seed-global nor included in account,
project, or host rehome state. That creates the same class of bug we just fixed
for site licenses: durable product/business state can be created on a random
bay, then disappear or become unreachable when that bay is drained.

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

The account home bay is authoritative. Account rehome must copy and clear the
state, or the state must be fully rebuildable from seed/global data.

Examples:

- account sessions/auth factors;
- account UI projections;
- account-owned API keys;
- account-level entitlements if not seed-global.

### `project-owning`

The project owning bay is authoritative. Project rehome must copy and clear the
state, or the state must be fully rebuildable from the project row/project-host
state.

Examples:

- project lifecycle/control metadata;
- project collaborator/invite state;
- project backup indexes if they are not seed/global;
- project-scoped external credentials.

### `host-owning`

The host's bay is authoritative. Host rehome must copy and clear the state, or
the state must be fully rebuildable from cloud/provider data.

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
  classify as `account-home` and route/copy it consistently;
- if retained, add it to account rehome portable state and route admin APIs to
  target account home bay;
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
- include account/project scoped rows in corresponding rehome portable state;
- ensure encrypted payloads remain decryptable after move.

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
    `seed-global` for all commercial ledgers;
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
- for `project-owning` rows, add project rehome copy/clear support;
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

Create a source-controlled manifest, probably under
`src/packages/util/db-schema/table-ownership.ts`.

Each entry should include:

- table name;
- ownership class;
- authority key, if applicable;
- rehome responsibility;
- rebuild/delete policy;
- notes.

Example shape:

```ts
export type TableOwnership =
  | "seed-global"
  | "account-home"
  | "project-owning"
  | "host-owning"
  | "projection"
  | "cache"
  | "ephemeral"
  | "audit-local";
```

Add a test that fails when a schema table is missing from the manifest.

### Phase 1: Automated Risk Test

Add tests that inspect schema metadata and table names/fields.

The test should fail or warn when:

- a table has `account_id` but is neither `account-home`, `seed-global`,
  `projection`, `cache`, `ephemeral`, nor explicitly exempt;
- a table has `project_id` but is neither `project-owning`, `projection`,
  `cache`, `ephemeral`, nor explicitly exempt;
- a table has `host_id` but is neither `host-owning`, `projection`, `cache`,
  `ephemeral`, nor explicitly exempt;
- a table is classified as `account-home` but is missing from account rehome
  portable state or has no documented rebuild path;
- a table is classified as `project-owning` but is missing from project rehome
  portable state or has no documented rebuild path;
- a table is classified as `host-owning` but is missing from host rehome
  portable state or has no documented rebuild path.

This test is the key to "stay correct."

### Phase 2: Seed-Global Commercial State

Fix the highest-risk commercial state first.

Tasks:

- finish/site-license seed routing is already done;
- route software licensing APIs to seed;
- classify and route software license activation;
- decide whether software license tiers are part of the server-settings/global
  config version stream;
- add tests proving an attached bay forwards create/list/revoke/restore to seed.

### Phase 3: Admin Membership Entitlement Cleanup

Tasks:

- decide whether `admin_assigned_memberships` is still needed;
- if obsolete, migrate or delete it in favor of `account_entitlement_overrides`;
- if retained, make it `account-home`;
- route admin APIs to target account home bay;
- include it in account rehome portable state;
- add tests covering account rehome with an assigned membership.

### Phase 4: External Credentials Ownership Split

Tasks:

- add scope-aware routing helpers:
  - account scope -> account home;
  - project scope -> project owning bay;
  - site scope -> seed;
  - organization scope -> seed for now;
- update system/host APIs to use these helpers before store access;
- include account/project scoped rows in account/project rehome;
- add tests for account rehome and project rehome preserving credentials;
- explicitly check encryption/decryption after move.

### Phase 5: Self-Host Connector Portability

Tasks:

- classify connector records as `host-owning`;
- include `self_host_connectors` in host rehome payload;
- decide token behavior:
  - expired/pairing tokens can be dropped;
  - active installation tokens may need copy if host rehome happens during
    setup;
- decide whether `self_host_commands` is durable command state or ephemeral
  queue;
- add host rehome tests for self-host connector continuity.

### Phase 6: Billing Ledger Authority

Tasks:

- decide seed-global versus account-home for `purchases` and `statements`;
- document balance source-of-truth;
- route all new purchase/statement writes accordingly;
- add rehome or seed-routing tests;
- ensure project-host spend caps and membership spend caps use the same account
  usage-window authority model.

Recommended default:

- seed-global for payment processor integration, statements, and immutable
  commercial ledger;
- account-home projections for fast account UI.

This avoids moving money history with accounts.

### Phase 7: Project Rehome Side-Table Audit

Tasks:

- compare every table deleted by project hard-delete with project rehome;
- classify each table as project-owning/projection/cache/ephemeral;
- extend project rehome only for control-plane metadata that must survive;
- explicitly exclude heavy project data-plane tables unless needed.

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

Before draining a bay, run an automated preflight:

- list all non-disposable rows on the source bay by ownership class;
- verify account/project/host rows are already moved or scheduled;
- verify seed-global tables have no source-only rows;
- verify projections/caches are safe to drop;
- block drain if unknown or unclassified durable state remains.

This should be a CLI/admin API and should use the manifest.

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
