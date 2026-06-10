# Secure Modern CoCalc CRM Plan

Status: design and implementation plan.

Target: replace the legacy `.cocalc-crm` admin database browser with a secure,
fresh-auth, multi-bay-aware admin CRM that preserves the useful file-backed view
model while removing dependence on generic `user_query` and legacy Postgres
changefeeds.

## Context

The existing CRM editor is valuable. It stores table tabs, views, filters, sort
orders, hidden fields, column widths, and other UI state in a `.cocalc-crm`
syncdb file. That makes it easy for admins to build operational views without
hardcoding every dashboard.

The problem is the data access model:

- The frontend calls `webapp_client.query_client.query` and
  `webapp_client.async_query`.
- Reads and writes go through generic `user_query`.
- Some CRM tables ask for `changes: true`, which depends on a legacy user-query
  changefeed path that cocalc-ai has removed.
- The API is admin-gated by schema metadata, but it is not a dedicated
  fresh-auth admin RPC.
- It is not explicit about multi-bay ownership, project-host routing, query
  limits, auditing, or operational intent.

The modern CRM should keep the best part of the old system: file-backed,
shareable, editable views. The query execution layer should be replaced.

## Goals

- Keep `.cocalc-crm` as a file type for saved admin views.
- Make the editor explicitly admin-only.
- Replace generic `user_query` with explicit admin CRM RPCs.
- Require fresh auth for CRM access, with stricter requirements for mutations.
- Make query scopes explicit and multi-bay aware.
- Add curated project-host/runtime datasets, not just Postgres table views.
- Enforce hard limits on rows, fields, filters, sort, and execution time.
- Audit every CRM query and mutation.
- Make failure modes visible in the UI instead of silent loading states.
- Provide a migration path for existing `.cocalc-crm` files.

## Non-Goals

- Do not expose arbitrary SQL in the browser.
- Do not revive generic `user_query` changefeeds.
- Do not make the hub proxy project data-plane traffic.
- Do not make `.cocalc-crm` files grant permissions. They are only view state.
- Do not require full multi-bay production before a useful single-bay MVP.

## Current Architecture Summary

Relevant existing files:

- `packages/frontend/frame-editors/crm-editor/register.ts`
  registers `.cocalc-crm`.
- `packages/util/syncdoc-doctypes.ts`
  declares `.cocalc-crm` as a syncdb document with primary keys
  `{ table, id }`.
- `packages/frontend/frame-editors/crm-editor/querydb/use-table.ts`
  performs reads and changefeed-backed refreshes.
- `packages/frontend/frame-editors/crm-editor/querydb/set.ts`
  performs writes.
- `packages/frontend/frame-editors/crm-editor/tables/*`
  defines frontend table descriptors using user-query-shaped objects.
- `packages/util/db-schema/types.ts`
  forces all `crm_` tables to be admin-only in schema metadata.
- `packages/database/user-query/methods-impl.ts`
  now rejects legacy `user_query` changefeeds.

The file-backed view model is good. The query transport and authority model
should be replaced.

## Security Model

### Permissions

Opening a `.cocalc-crm` file should require:

- signed-in account,
- admin group membership,
- fresh-auth session for active CRM access.

The file may live in a project, but project collaboration must not grant CRM
access. Non-admin collaborators should see a clear access-denied state.

### Fresh Auth

Recommended policy:

- Read-only CRM session: require fresh auth at editor activation, then allow
  reads for a short window, e.g. 15 minutes.
- Mutations: require fresh auth per mutation or within a shorter window, e.g.
  5 minutes.
- Sensitive mutations, such as banning accounts, changing balances, changing
  site-license state, deleting records, or host operations: require fresh auth
  and explicit confirmation.
- Impersonated sessions should be blocked from direct CRM mutations unless there
  is a deliberate support workflow with separate audit semantics.

Use the existing dangerous/fresh-auth framework:

- `server/conat/api/dangerous-session-auth.ts`
- `server/conat/api/dangerous-rpc-registry.ts`

### Audit

Every CRM operation should produce a durable audit record:

- actor account id,
- session hash or fresh-auth proof identifier,
- operation type: read, export, mutation, host action,
- CRM view id or dataset id,
- query filters, sort, limit, and selected fields,
- target scope: local bay, all bays, specific bay, account, project, host,
- row count returned or changed,
- duration,
- success/error,
- client context: project id and file path for the `.cocalc-crm` file.

Do not log full row results by default. Some rows include private or regulated
data.

## Dedicated RPC Model

Add a dedicated hub API namespace, for example:

```ts
hub.adminCrm.listDatasets(opts)
hub.adminCrm.query(opts)
hub.adminCrm.export(opts)
hub.adminCrm.mutate(opts)
hub.adminCrm.getRecord(opts)
hub.adminCrm.getFacetCounts(opts)
```

The corresponding public Conat API wrapper should be explicit:

```ts
// packages/conat/hub/api/admin-crm.ts
export const adminCrm = {
  listDatasets: authFirstRequireAccount,
  query: authFirstRequireAccount,
  export: authFirstRequireAccount,
  mutate: authFirstRequireAccount,
  getRecord: authFirstRequireAccount,
  getFacetCounts: authFirstRequireAccount,
};
```

Server implementations should live under:

```text
packages/server/conat/api/admin-crm/
```

Core server entry points:

```ts
type CrmScope =
  | { type: "local_bay" }
  | { type: "all_bays" }
  | { type: "bay"; bay_id: string }
  | { type: "account_home"; account_id: string }
  | { type: "project_owner"; project_id: string }
  | { type: "host"; host_id: string };

type CrmQuery = {
  dataset: string;
  scope: CrmScope;
  fields?: string[];
  filters?: CrmFilter[];
  sort?: CrmSort[];
  limit?: number;
  cursor?: string;
  session_hash?: string;
};
```

Important: `dataset` is a server-owned identifier, not a raw table name or SQL
string.

## Dataset Registry

Replace frontend-owned query objects with a server-owned CRM dataset registry.

Example:

```ts
const DATASETS = {
  accounts: {
    title: "Accounts",
    icon: "user",
    source: { kind: "postgres", table: "accounts" },
    scopeModes: ["local_bay", "all_bays", "account_home"],
    fields: {
      account_id: { type: "uuid", primary: true },
      email_address: { type: "string", sensitive: true },
      last_active: { type: "timestamp" },
      groups: { type: "array" },
      banned: { type: "boolean", mutable: true, dangerous: true },
      notes: { type: "string", mutable: true },
    },
    defaultFields: ["account_id", "email_address", "last_active", "groups"],
    defaultSort: [{ field: "last_active", direction: "desc" }],
    maxLimit: 500,
  },
};
```

Dataset classes:

- Postgres datasets: accounts, projects, purchases, vouchers, support tickets.
- Projection datasets: account project windows, account/project index rows.
- Project-host datasets: running projects, host runtime state, rootfs cache,
  project backup state, project start/stop timings.
- Aggregated datasets: bay summaries, launch health, UX latency, abuse signals.
- External/system datasets: cloud host state, R2 backup status, release channel
  state.

The frontend can still define presentation metadata, but the server owns:

- allowed fields,
- allowed filters,
- allowed mutations,
- scope routing,
- SQL,
- limits,
- dangerous/fresh-auth policy.

## Query Language

Use a constrained query language.

Allowed filters:

- equality and inequality,
- contains / prefix search for selected text fields,
- timestamp ranges,
- numeric ranges,
- array contains for selected fields,
- boolean values,
- null/not-null.

Disallowed:

- arbitrary SQL,
- arbitrary joins from the browser,
- arbitrary field selection outside the dataset registry,
- unbounded exports,
- regex by default.

Sorting:

- only indexed or explicitly approved fields,
- max sort fields, e.g. 3.

Limits:

- default: 100 rows,
- normal max: 500 rows,
- export max: explicit per dataset and fresh-auth required,
- server-enforced timeout, e.g. 5-15 seconds depending on dataset.

Pagination:

- use cursor pagination, not offset for large tables.
- cursor should encode server-validated dataset, sort, and last row key.

## Multi-Bay Routing

CRM queries must say where data is authoritative.

### Local Bay

Reads the current bay database. This is the single-bay launchpad/Rocket MVP.

### Account Home Bay

For account-specific operational views:

1. Resolve `account_id -> home_bay_id`.
2. Route the CRM query to that bay.
3. Return normalized rows to the current browser session.

### Project Owning Bay

For project-specific views:

1. Resolve `project_id -> owning_bay_id`.
2. Route the query or project operation to the owning bay.
3. Data-plane details should still be fetched from project hosts directly when
   appropriate, using scoped admin capabilities.

### All Bays

For global admin views:

1. Fan out to all active bays.
2. Enforce per-bay limits.
3. Merge results deterministically.
4. Include `bay_id` in each row.
5. Surface partial failures.

Never hide partial failures in all-bay views. Operators need to know when one
bay is missing.

## Project Host Awareness

The modern CRM should include first-class host/runtime datasets.

Initial datasets:

- `project_hosts`: host id, bay id, region, provider, status, version, capacity.
- `host_running_projects`: host id, project id, owner, state, runtime age.
- `project_runtime`: project id, owning bay, host id, start state, active op.
- `project_start_log`: observed start duration, provisioned/restored path,
  terminal-ready/jupyter-ready/exec-ready metrics.
- `host_rootfs_cache`: image key, size, last used, source, cache health.
- `project_backup_status`: last backup, backup failures, backup size.
- `host_software_versions`: project-host, project bundle, tools versions.

Host data should come through existing host/project-host APIs where possible,
not via direct SQL if the host is authoritative for the state.

## Frontend Architecture

Keep the current editor shell concept:

- table tabs,
- multiple views per table,
- grid/gallery/kanban/calendar views,
- filters,
- sort,
- hidden fields,
- column widths,
- saved state in syncdb.

Replace the data layer:

```text
crm-editor/querydb/use-table.ts
crm-editor/querydb/set.ts
```

with:

```text
crm-editor/api/use-crm-query.ts
crm-editor/api/crm-client.ts
crm-editor/api/use-crm-mutation.ts
```

The new frontend flow:

1. On editor open, call `adminCrm.listDatasets`.
2. If not admin or no fresh auth, show a clear access/fresh-auth panel.
3. Load saved view state from the `.cocalc-crm` syncdb file.
4. Convert saved legacy table names to new dataset ids when possible.
5. Query via `adminCrm.query`.
6. Show explicit errors, partial bay failures, and stale data indicators.
7. Refresh via manual refresh or polling, not database changefeeds.

Polling policy:

- default: manual refresh,
- optional auto-refresh per view: 15s, 30s, 60s,
- disable auto-refresh for expensive datasets,
- show last refresh timestamp.

## File Format

The file should store view state, not query authority.

Stored records should include:

```ts
{
  table: "views";
  id: string;
  dataset: string;
  name: string;
  type: "grid" | "gallery" | "kanban" | "calendar" | "retention";
  pos: number;
  scope?: CrmScope;
}
```

Other saved state:

- hidden fields,
- field order,
- widths,
- sort,
- filters,
- limits,
- auto-refresh interval,
- selected records.

Migration:

- Old records with `dbtable` should map to `dataset`.
- Unknown legacy tables should be shown as deprecated/unavailable with a repair
  action.
- Keep old data in the file where possible so rollback is not destructive.

## Mutations

Mutations should be dataset-specific operations, not generic set queries.

Examples:

```ts
adminCrm.mutate({
  dataset: "accounts",
  operation: "set_notes",
  key: { account_id },
  value: { notes },
  session_hash,
});
```

Mutation classes:

- simple field update,
- append note,
- add/remove tag,
- ban/unban account,
- annotate abuse incident,
- stop project,
- quarantine account resources,
- host action.

Every mutation needs:

- dataset registry approval,
- admin check,
- fresh-auth check,
- audit log,
- server-side validation,
- clear UI confirmation if dangerous.

The CRM should not reimplement operational actions. It should call the same
authoritative server functions used by admin pages and CLI commands.

## Live Updates

Do not bring back generic Postgres changefeeds.

Options, in order:

1. Manual refresh and polling for MVP.
2. Dataset-specific event streams for high-value small feeds.
3. Account/bay/host operational streams from existing Conat subjects where they
   already exist.

For all-bay CRM views, polling is much easier to reason about than fanout
changefeeds.

## UI Requirements

Admin CRM should make authority and freshness visible.

Each view should show:

- dataset title,
- scope,
- bay/host target if applicable,
- row count,
- limit,
- last refresh time,
- partial failure status,
- fresh-auth state,
- audit-friendly query summary.

Failure states:

- not signed in,
- not admin,
- fresh auth required,
- dataset unavailable,
- field/filter not allowed,
- query timed out,
- partial bay failure,
- host unreachable.

The current indefinite “Loading from database...” state should be impossible.
Every query must have timeout and error UI.

## Implementation Plan

### Phase 0: Stabilize Existing Editor

Goal: stop the current CRM from hanging while the new API is built.

- Add a visible admin-only gate around the existing CRM editor.
- Disable `changes: true` for CRM queries or force it off in `useTable`.
- Add query timeout handling and a clear error if the old query path fails.
- Keep this as a temporary compatibility mode.

Exit criteria:

- Admin can open a `.cocalc-crm` file and see either data or a clear error.
- Non-admins see access denied.
- No view can spin forever without an error.

### Phase 1: Server Dataset Registry

Goal: define the server-owned dataset model.

- Add `packages/server/conat/api/admin-crm/datasets.ts`.
- Add field metadata, filter metadata, default fields, default sort, limits.
- Implement local-bay Postgres read datasets for:
  - accounts,
  - projects,
  - purchases,
  - vouchers,
  - support tickets,
  - messages or central log if useful.
- Add unit tests for dataset validation.

Exit criteria:

- Server can validate a CRM query without executing SQL.
- Invalid fields, filters, sorts, and limits are rejected.

### Phase 2: Fresh-Auth RPC

Goal: expose safe read-only CRM query RPCs.

- Add `packages/conat/hub/api/admin-crm.ts`.
- Add server implementation under `packages/server/conat/api/admin-crm`.
- Require admin permission.
- Require fresh-auth for CRM session activation or query.
- Add audit logging.
- Register dangerous/fresh-auth decisions.
- Implement `listDatasets` and `query`.

Exit criteria:

- CLI or browser can list datasets and run a bounded local-bay query.
- Non-admin and non-fresh-auth requests fail with clear errors.
- Queries are audited.

### Phase 3: Frontend Data-Layer Migration

Goal: switch CRM reads to the new RPC.

- Add `crm-editor/api/crm-client.ts`.
- Add `useCrmQuery`.
- Convert table descriptors from `query` objects to `dataset` ids.
- Keep presentation metadata in the frontend.
- Add legacy `dbtable -> dataset` migration.
- Remove dependence on `webapp_client.query_client.query` for CRM reads.

Exit criteria:

- Existing `.cocalc-crm` files can open against the new read API.
- Saved views still work after mapping old table ids.

### Phase 4: Mutations

Goal: replace generic CRM writes.

- Add dataset-specific mutation definitions.
- Add `adminCrm.mutate`.
- Add fresh-auth per mutation.
- Add audit logging for every mutation.
- Migrate editable fields to mutation calls.
- Initially support notes and tags only.

Exit criteria:

- Admin can edit notes/tags through CRM.
- Dangerous account/project/host actions are not exposed until each has a
  dedicated operation and confirmation UI.

### Phase 5: Multi-Bay Routing

Goal: make CRM work beyond single-bay.

- Add scope metadata per dataset.
- Implement `local_bay`, `account_home`, and `project_owner`.
- Add all-bay fanout for read-only datasets.
- Include `bay_id` and partial-failure metadata in responses.
- Add tests for routing and partial failure behavior.

Exit criteria:

- A global admin can query accounts/projects across bays with visible bay
  provenance.
- Project-specific views route to the owning bay.

### Phase 6: Project Host Datasets

Goal: make CRM useful for operations, not just Postgres browsing.

- Add host/project runtime datasets backed by host APIs and hub metadata.
- Add project start and UX latency datasets.
- Add backup/rootfs/software-version datasets.
- Add actions that delegate to existing admin/host/project APIs.

Exit criteria:

- CRM can answer operational questions like:
  - Which projects are burning resources?
  - Which hosts have stale software?
  - Which projects failed backups?
  - Which account owns running GPU-heavy workloads?

## Testing

Server tests:

- dataset validation,
- admin-only enforcement,
- fresh-auth enforcement,
- field allowlist,
- filter allowlist,
- limit enforcement,
- audit logging,
- local-bay query execution,
- multi-bay routing/fanout,
- partial failure handling.

Frontend tests:

- non-admin access denied,
- fresh-auth required state,
- dataset list loading,
- legacy `.cocalc-crm` migration,
- query error display,
- no indefinite loading,
- table/view state persistence.

Manual smoke:

- create `.cocalc-crm`,
- add Accounts dataset,
- filter by email/domain,
- add Projects dataset,
- filter by owner/account,
- refresh manually,
- edit a note,
- verify audit log.

## Migration Strategy

Do not delete the old CRM implementation immediately.

Recommended sequence:

1. Stabilize old editor enough to avoid hangs.
2. Add new admin CRM RPCs.
3. Add new frontend data client behind a feature flag.
4. Migrate read-only datasets.
5. Migrate safe mutations.
6. Remove generic CRM `user_query` reads/writes.
7. Delete dead changefeed compatibility code.

Feature flag:

```text
admin_crm_modern_api_enabled
```

If disabled, show a clear message rather than silently falling back to unsafe
generic queries in production.

## Open Questions

- Should `.cocalc-crm` be creatable only inside admin-owned projects?
- Should CRM files support shared saved views among admins through a central
  registry instead of project files?
- What is the fresh-auth duration for read-only CRM sessions?
- Which datasets are safe for all-bay fanout during launch?
- Should exports be allowed before launch, or only on the CLI?
- Should broad account/project CRM reads be rate-limited per admin account?
- Which CRM mutations should be supported first: notes/tags, account ban,
  account quarantine, project stop, or host drain?

## Recommendation

Do this in two tracks:

1. Immediate compatibility: disable CRM changefeeds, add admin/fresh-auth/error
   gates, and make the current editor stop hanging.
2. Modern replacement: build `adminCrm` RPCs and migrate datasets one by one.

The first useful modern CRM can be read-only, local-bay only, and polling-based.
That is enough to restore the incident-response value without reintroducing the
generic query/changefeed risk.
