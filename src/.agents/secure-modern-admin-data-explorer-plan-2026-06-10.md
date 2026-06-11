# Secure Modern Admin Data Explorer Plan

Status: cleaned-up design plan after deciding to pivot away from a file editor
and toward a shared admin-page data explorer with CLI parity.

Target: replace the legacy `.cocalc-crm` admin database browser with a secure,
audited, fresh-auth, multi-bay-aware Admin Data Explorer. The new system should
make operational investigation easy from both the admin UI and `cocalc-cli`,
including a restricted SQL mode with guardrails.

## Core Decision

Build Admin Data Explorer as an `/admin` destination, not as a project file
editor.

Saved views should live in the database as shared site-level admin resources,
not in `.cocalc-admin-data` files. The file-editor model made sharing easy, but
global DB-backed views are better for:

- discoverability from the admin page,
- CLI and Codex-assisted incident response,
- shared operational playbooks,
- export/import between sites,
- audit and permission boundaries,
- avoiding project-collaboration ambiguity.

The old `.cocalc-crm` files do not require strong backward compatibility.
Admins can recreate the useful views in the new shared registry.

## Goals

- Add an Admin Data Explorer section to `/admin`.
- Store shared saved views in a server-owned registry.
- Provide full `cocalc-cli` parity for every Admin Data Explorer operation.
- Support read-only structured queries with nested `AND`/`OR` filters.
- Support restricted read-only SQL with parser-based validation and execution
  guardrails.
- Require admin permission and fresh auth for access.
- Audit every query, export, and mutation.
- Make bay, host, freshness, row limits, and partial failures visible.
- Include data sources beyond Postgres, especially project-host and runtime
  datasets.
- Support export/import of saved view definitions as JSON for moving views
  between sites.

## Non-Goals

- Do not revive generic `user_query`.
- Do not bring back legacy Postgres changefeeds.
- Do not proxy project data-plane traffic through the hub.
- Do not make a new CRM with generic notes/tags/field-editing workflows.
- Do not support arbitrary unsafe SQL execution.
- Do not make broad mutations a first milestone.

## Why SQL Must Be Supported

In practice, if Admin Data Explorer does not support SQL, operators and agents
will SSH to production Postgres and run live SQL manually. That is worse:

- no fresh-auth boundary,
- no query audit trail,
- no row/timeout/byte limits,
- no all-bay routing model,
- no safe saved-view registry,
- no easy review of what was run,
- higher chance of accidentally running DML or an expensive query.

The right answer is not "no SQL". The right answer is controlled SQL with
server-side parsing, validation, limits, and audit logging.

## Product Model

### Shared View Registry

The registry stores reusable admin views.

Suggested fields:

```ts
type AdminDataView = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  tags: string[];
  visibility: "admin";
  query_kind: "structured" | "sql" | "dataset";
  query: StructuredQuery | SqlQuery | DatasetQuery;
  scope: AdminDataScope;
  default_columns?: string[];
  default_sort?: AdminDataSort[];
  default_limit?: number;
  visualization?: "table" | "chart" | "retention" | "summary";
  owner_account_id: string;
  created_at: string;
  updated_at: string;
  version: number;
};
```

Views are global to a site. Later, in multi-bay Rocket, view definitions should
be stored in a site/global metadata location or replicated consistently enough
that all bays and the CLI see the same catalog.

### CLI Parity

Every UI operation should have a CLI equivalent.

Example commands:

```sh
cocalc admin data views list
cocalc admin data views show <slug>
cocalc admin data views run <slug> --limit 100 --json
cocalc admin data sql --query 'select ...' --limit 100 --json
cocalc admin data views export > admin-data-views.json
cocalc admin data views import admin-data-views.json
```

This is critical for Codex-assisted investigations. The CLI should call the
same fresh-auth, audit, query validation, routing, and execution RPCs as the
browser.

## Query Model

Admin Data Explorer should support three query kinds.

### Structured Queries

Structured queries are the default UI path. They are safe JSON ASTs, not SQL.

They must support nested boolean groups:

```ts
type AdminDataFilter =
  | { op: "and"; filters: AdminDataFilter[] }
  | { op: "or"; filters: AdminDataFilter[] }
  | { op: "not"; filter: AdminDataFilter }
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; field: string; value: any }
  | { op: "contains" | "prefix"; field: string; value: string }
  | { op: "in"; field: string; values: any[] }
  | { op: "is_null" | "not_null"; field: string };
```

This fixes a major legacy CRM limitation: only supporting `AND` filters.

### Dataset Queries

Dataset queries target server-owned datasets such as accounts, projects,
project hosts, runtime state, backup status, rootfs cache, and latency metrics.

The server owns:

- allowed fields,
- filter metadata,
- sort metadata,
- default columns,
- limits,
- scope routing,
- underlying SQL or RPC calls.

### Restricted SQL Queries

SQL is supported, but only through a safe server-side SQL engine.

This SQL mode is for:

- power admin views,
- CLI investigations,
- Codex-assisted incident response,
- complex reporting such as retention and abuse analysis.

The SQL engine must be read-only and guarded. A parser is necessary but not
sufficient.

Allowed:

- one statement only,
- `SELECT`,
- safe `WITH` queries that resolve to a final `SELECT`,
- approved schemas, tables, views, and columns,
- approved stable/immutable functions,
- bounded joins over allowlisted relations,
- server-enforced limit, timeout, and row/byte caps.

Rejected:

- `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`,
- DDL,
- `COPY`,
- `DO`,
- temp tables,
- transaction control,
- multiple statements,
- unallowlisted functions,
- unallowlisted schemas such as unrestricted `pg_catalog`,
- unbounded exports,
- queries that cannot be parsed and normalized.

Execution guardrails:

- parse to AST before execution,
- validate all referenced relations, fields, functions, and operators,
- execute regenerated/normalized SQL where feasible instead of raw input,
- parameterize all external values,
- enforce a server-side `LIMIT`,
- set `statement_timeout`,
- run in `BEGIN READ ONLY`,
- use a restricted read-only DB role if feasible,
- set a safe `search_path`,
- cap response rows and serialized bytes,
- audit the original SQL, normalized SQL, validation result, duration, row
  count, and error.

The SQL engine should also provide a dry-run validation mode:

```sh
cocalc admin data sql validate --query 'select ...'
```

## Security Model

### Access

Admin Data Explorer access requires:

- signed-in account,
- admin group membership,
- fresh-auth session.

Use the existing fresh-auth/dangerous RPC framework:

- `server/conat/api/dangerous-session-auth.ts`
- `server/conat/api/dangerous-rpc-registry.ts`

Fresh-auth duration can follow existing site policy, e.g. 15 minutes or 8 hours
depending on what the admin selected.

### Audit

Every operation should write an audit record:

- actor account id,
- fresh-auth/session proof,
- operation type: list, query, SQL validate, SQL run, export, import, mutate,
- view id or ad-hoc query marker,
- query kind,
- query text or structured query summary,
- scope,
- target bay/host/project/account,
- row count,
- response byte count,
- duration,
- success/error,
- client: browser or CLI,
- CLI version or browser context when available.

Do not log full result rows by default.

### Rate Limits

Rate-limit broad account/project reads per admin account. Apply stricter limits
to all-bay fanout, SQL, exports, and expensive datasets.

## Dedicated RPC Model

Add a dedicated hub API namespace.

```ts
hub.adminDataExplorer.listViews(opts);
hub.adminDataExplorer.getView(opts);
hub.adminDataExplorer.saveView(opts);
hub.adminDataExplorer.deleteView(opts);
hub.adminDataExplorer.importViews(opts);
hub.adminDataExplorer.exportViews(opts);
hub.adminDataExplorer.listDatasets(opts);
hub.adminDataExplorer.query(opts);
hub.adminDataExplorer.validateSql(opts);
hub.adminDataExplorer.runSql(opts);
hub.adminDataExplorer.mutate(opts);
```

Corresponding public Conat wrapper:

```ts
// packages/conat/hub/api/admin-data-explorer.ts
export const adminDataExplorer = {
  listViews: authFirstRequireAccount,
  getView: authFirstRequireAccount,
  saveView: authFirstRequireAccount,
  deleteView: authFirstRequireAccount,
  importViews: authFirstRequireAccount,
  exportViews: authFirstRequireAccount,
  listDatasets: authFirstRequireAccount,
  query: authFirstRequireAccount,
  validateSql: authFirstRequireAccount,
  runSql: authFirstRequireAccount,
  mutate: authFirstRequireAccount,
};
```

Server implementation should live under:

```text
packages/server/conat/api/admin-data-explorer/
```

## Scopes And Multi-Bay Routing

Every query must declare scope.

```ts
type AdminDataScope =
  | { type: "local_bay" }
  | { type: "all_bays" }
  | { type: "bay"; bay_id: string }
  | { type: "account_home"; account_id: string }
  | { type: "project_owner"; project_id: string }
  | { type: "host"; host_id: string };
```

Routing rules:

- `local_bay`: execute on the current bay.
- `account_home`: resolve `account_id -> home_bay_id`, then route.
- `project_owner`: resolve `project_id -> owning_bay_id`, then route.
- `all_bays`: fan out, enforce per-bay limits, merge deterministic results,
  include `bay_id`, and surface partial failures.
- `host`: use host/project-host APIs when the host is authoritative.

Do not hide partial failures. Operators need to know when a bay or host is
missing from an answer.

## Project Host And Runtime Data

Admin Data Explorer must go beyond Postgres.

Initial operational datasets:

- `project_hosts`: host id, bay id, region, provider, status, version,
  capacity.
- `host_running_projects`: host id, project id, owner, runtime age, resources.
- `project_runtime`: project id, owning bay, host id, start state, active op.
- `project_start_log`: lifecycle duration and observed terminal/Jupyter/exec
  readiness.
- `host_rootfs_cache`: image key, size, last used, cache health.
- `project_backup_status`: last backup, failures, size, restore metadata.
- `host_software_versions`: project-host, project bundle, tools, bootstrap.
- `ux_latency`: launch/file/Jupyter/terminal metrics and SLA status.
- `retention`: cached retention computations and plots.

Host data should come through existing host/project-host APIs when those are
authoritative, not direct SQL.

## UI Requirements

Admin page section:

- searchable view catalog,
- tags/categories,
- favorite/pin views,
- run view,
- clone/edit view,
- create structured view,
- create SQL view,
- validate SQL before save,
- explicit refresh button,
- optional auto-refresh only for cheap datasets,
- last refreshed timestamp,
- row count and limit display,
- bay/host/scope display,
- partial failure display,
- export current result from CLI first; browser export can wait.

No live updates are required for MVP. Manual refresh is preferable and
predictable.

Failure states must be explicit:

- not signed in,
- not admin,
- fresh auth required,
- query rejected by validator,
- field/filter/sort not allowed,
- SQL parse error,
- timeout,
- result too large,
- partial bay failure,
- host unreachable.

The old indefinite "Loading from database..." state should be impossible.

## Mutations

Do not build generic CRM-style mutations.

Only expose mutations that already exist as authoritative admin RPCs or CLI
operations, such as:

- ban/unban account,
- stop project,
- host drain,
- quarantine-style actions if already implemented,
- other explicit existing admin actions.

Admin Data Explorer should call those existing RPCs. It should not invent new
generic field updates for notes, tags, or arbitrary row editing.

Every mutation needs:

- fresh auth,
- explicit confirmation for dangerous operations,
- audit log,
- existing authoritative RPC call,
- no SQL mutation path.

## Import And Export

Saved view definitions should be portable.

```sh
cocalc admin data views export > views.json
cocalc admin data views import views.json
```

Import behavior:

- validate schema,
- validate datasets/SQL,
- merge by stable slug or id,
- preserve local edits unless `--overwrite`,
- report conflicts,
- never execute imported SQL before validation.

This replaces the old "share a `.cocalc-crm` file" workflow with a cleaner
site-level sharing model.

## Implementation Plan

### Phase 1: Registry And CLI Skeleton

Goal: shared views exist and are accessible from CLI/UI APIs.

- Add shared view storage.
- Add RPCs for list/get/save/delete/export/import.
- Add CLI commands for view catalog operations.
- Require admin and fresh auth.
- Add audit records for catalog changes.

Exit criteria:

- Admin can create/list/export/import view definitions from CLI.
- Browser can list the view catalog.

### Phase 2: Restricted SQL Engine

Goal: safe read-only SQL exists before operators are tempted to SSH to
Postgres.

- Choose and integrate a Postgres SQL parser.
- Add `validateSql`.
- Add `runSql`.
- Enforce one-statement read-only SQL.
- Add allowlists for schemas/tables/columns/functions.
- Enforce limits, timeout, read-only transaction, and audit.
- Add CLI `cocalc admin data sql validate/run`.

Exit criteria:

- CLI can run a bounded audited SQL query.
- Unsafe SQL is rejected before execution.
- Result size and execution time are capped.

### Phase 3: Admin UI View Runner

Goal: make saved SQL and dataset views usable in `/admin`.

- Add Admin Data Explorer section to admin page.
- Show searchable view catalog.
- Run a saved view.
- Show explicit errors and last refresh time.
- Add SQL validate-before-save UI.

Exit criteria:

- Admin can run a saved view from the browser.
- Bad SQL/view definitions show validator errors.
- No indefinite loading states.

### Phase 4: Structured Query Builder

Goal: support normal non-SQL views with nested boolean filters.

- Add structured query AST.
- Add server validation/compilation.
- Add UI filter builder with `AND`/`OR` groups.
- Add dataset registry for core tables.

Initial datasets:

- accounts,
- projects,
- purchases,
- vouchers,
- support/contact records if useful.

Exit criteria:

- Admin can build and save a view without writing SQL.
- `OR` filters work.

### Phase 5: Operational Datasets

Goal: make Admin Data Explorer useful for launch operations.

- Add project host datasets.
- Add runtime datasets.
- Add backup/rootfs/software-version datasets.
- Add UX latency and SLA datasets.
- Add cached retention datasets.

Exit criteria:

- Admin Data Explorer can answer launch readiness and incident-response
  questions without SSH or ad-hoc DB access.

### Phase 6: Multi-Bay Routing

Goal: make views bay-aware.

- Add scope metadata per view/dataset.
- Implement local bay, account home, project owner, host, and all-bay routing.
- Add partial failure reporting.
- Add tests for fanout and routing.

Exit criteria:

- All-bay views work with visible bay provenance.
- Partial failures are visible and audited.

### Phase 7: Existing RPC Mutations

Goal: expose selected existing admin actions in context.

- Add mutation registry that maps to existing RPCs only.
- Add confirmation UI.
- Add CLI commands or links to existing CLI commands.
- Audit all actions.

Exit criteria:

- Admin can run selected existing operational actions from a result row.
- No generic SQL or row-edit mutation path exists.

## Testing

Server:

- SQL parser rejects unsafe statements,
- SQL validator enforces allowlists,
- limits and timeout are enforced,
- read-only transaction is used,
- admin/fresh-auth is required,
- audit records are written,
- structured `AND`/`OR` filters compile correctly,
- saved views validate on import,
- multi-bay fanout surfaces partial failures.

CLI:

- list/get/run views,
- validate/run SQL,
- export/import views,
- JSON output is stable for agents.

Frontend:

- access denied,
- fresh auth required,
- view catalog loading,
- SQL validation errors,
- query errors,
- manual refresh,
- result table rendering,
- no indefinite loading.

## First Useful Milestone

The first useful milestone is:

- shared view registry,
- CLI list/run/export/import,
- restricted SQL validate/run,
- admin UI catalog and run view,
- local-bay only,
- read-only only,
- fresh auth and audit enabled.

That immediately gives operators and Codex a safer alternative to SSHing into
Postgres and running live SQL by hand.
