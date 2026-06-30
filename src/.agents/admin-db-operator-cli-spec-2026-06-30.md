# Admin Database Operator CLI Spec

Status: proposed implementation plan.

Date: 2026-06-30.

## Motivation

Production incident response already requires direct database investigation and
occasional targeted database repair. Today the practical fallback is:

- SSH to a production bay.
- Find the right Postgres socket, container, or environment.
- Run raw `psql` commands by hand.
- Copy fragments into chat or an incident note after the fact.

That workflow is fast, but it has poor safety properties:

- It bypasses CoCalc fresh-auth and operator intent checks.
- It is easy to run against the wrong bay or database.
- It has no consistent audit trail for SQL text, actor, reason, duration, row
  counts, or commit/rollback outcome.
- It encourages unreviewed shell commands on production machines.
- It is hard for Codex or another operator to reproduce safely.

The realistic goal is not to pretend production mutations never happen. The
goal is to make the common path safer, more auditable, and more bay-aware than
SSH plus raw `psql`.

## Goals

- Add first-class `cocalc-cli` support for admin database investigation.
- Support read-only raw SQL with server-side guardrails.
- Support explicit audited write mode for real incident repairs.
- Make write mode default to rollback unless `--commit` is explicit.
- Require a human-readable reason for every raw SQL operation.
- Route to an explicit bay instead of assuming the local machine is
  authoritative.
- Share the same backend execution engine with Admin Data Explorer where
  possible.
- Provide curated diagnostics so common investigations do not require writing
  SQL at all.
- Make this useful for one-bay Launchpad today and compatible with multibay
  Rocket later.

## Non-Goals

- This does not replace migrations, application APIs, or normal product
  workflows.
- This does not make arbitrary SQL risk-free.
- This does not initially add browser-based write SQL to Admin Data Explorer.
- This does not require a complete SQL parser before shipping useful read-only
  diagnostics.
- This does not expose project data-plane traffic through the hub.

## Product Shape

The CLI should expose an `admin db` command group.

Examples:

```sh
cocalc admin db query --sql "select now()" --json
cocalc admin db query --bay prod-bay-0 --file incident-read.sql --limit 200
cocalc admin db query --bay prod-bay-0 --csv --sql "select account_id, email_address from accounts limit 10"
```

Curated diagnostics:

```sh
cocalc admin db activity --bay prod-bay-0
cocalc admin db locks --bay prod-bay-0
cocalc admin db table-sizes --bay prod-bay-0
cocalc admin db central-log --event service_admission_denied --window 10m
cocalc admin db service-denials --window 10m
```

Write mode:

```sh
cocalc admin db exec \
  --bay prod-bay-0 \
  --write \
  --reason "unban staging admin account accidentally caught by equivalent-account ban" \
  --sql "update accounts set banned=false where account_id='...'"
```

The command above should run inside a transaction and roll back by default. To
actually persist the change:

```sh
cocalc admin db exec \
  --bay prod-bay-0 \
  --write \
  --commit \
  --reason "clear stale Nebius host data_disk_id after provider-side disk deletion" \
  --sql "update project_hosts set data_disk_id=null where id='...'"
```

Break-glass mode should exist, but be intentionally high friction:

```sh
cocalc admin db break-glass \
  --bay prod-bay-0 \
  --reason "emergency production repair approved in incident channel" \
  --confirm "I understand this can mutate production data" \
  --file repair.sql
```

## Execution Modes

### Read-Only Query

Read-only query mode is the default and should be the safest path.

Properties:

- Requires admin permission.
- Prefer requiring fresh auth for raw SQL. Curated diagnostics can be allowed
  with ordinary admin auth if needed.
- Executes server-side on the selected bay.
- Opens an explicit read-only transaction.
- Sets strict `statement_timeout`, `lock_timeout`, and
  `idle_in_transaction_session_timeout`.
- Enforces row count and byte count caps.
- Supports parameterized execution internally, even if the CLI starts with raw
  `--sql`.
- Returns JSON by default in `--json` mode and compact tables in human mode.
- Logs actor, bay, SQL hash, SQL text, parameters, duration, row count, byte
  count, and failure details.

The read-only transaction is the primary safety boundary. Regex-based SQL
classification is useful for early errors and clearer messages, but it must not
be treated as the security boundary.

### Audited Write

Write mode is for targeted repairs during operations. It should be safer than
raw SSH, not artificially impossible.

Properties:

- Requires admin permission.
- Requires fresh auth.
- Requires a site setting that enables operator write SQL.
- Requires `--write`.
- Requires `--reason`.
- Defaults to rollback.
- Requires `--commit` to persist changes.
- Runs in a transaction.
- Uses short `lock_timeout` and bounded `statement_timeout`.
- Emits a pre-commit summary with affected row counts.
- Audits the full operation before execution starts and after it finishes.
- Records whether the operation committed or rolled back.
- Rejects obviously hazardous server-side features such as `COPY ... PROGRAM`.

This mode should not pretend to be fully safe. The protection is explicit
operator intent, bounded execution, default rollback, and auditability.

### Break-Glass

Break-glass mode is for rare cases where the guarded write mode is too
restrictive.

Properties:

- Disabled by default.
- Requires a separate site setting.
- Requires fresh auth.
- Requires `--reason`.
- Requires an explicit confirmation string.
- Should strongly prefer `--file` over inline SQL so the exact repair script is
  reviewable and replayable.
- Records an audit row before execution starts.
- Records the complete SQL text or file hash, plus enough stored content to
  reconstruct what ran.
- Uses timeouts unless the operator explicitly overrides them.

Break-glass is still better than SSH because it preserves identity, target bay,
intent, SQL text, and outcome in one place.

## Permissions And Site Settings

Suggested settings:

- `admin_db_query_enabled`: enable read-only raw SQL for admins.
- `admin_db_write_enabled`: enable audited write mode.
- `admin_db_break_glass_enabled`: enable break-glass mode.
- `admin_db_require_fresh_auth`: default true for raw SQL.
- `admin_db_max_rows`: default result row cap.
- `admin_db_statement_timeout_ms`: default statement timeout.
- `admin_db_lock_timeout_ms`: default lock timeout.

Recommended defaults:

- Curated read-only diagnostics: enabled for admins.
- Raw read-only SQL: enabled on CoCalc-managed deployments, configurable for
  self-hosted.
- Audited write mode: disabled by default except where site operators choose to
  enable it.
- Break-glass mode: disabled by default everywhere.

Permission checks should start with admin-only access. Longer term, this should
be split into explicit operator capabilities:

- `admin_db_read`
- `admin_db_write`
- `admin_db_break_glass`
- `admin_db_audit_read`

## Audit Model

Every execution should produce an immutable audit record.

Minimum fields:

```ts
type AdminDbAuditRecord = {
  id: string;
  created_at: string;
  account_id: string;
  email_address?: string;
  client_ip?: string;
  user_agent?: string;
  cli_version?: string;
  mode: "query" | "write" | "break_glass" | "diagnostic";
  bay_id: string;
  database: string;
  reason: string;
  sql_sha256?: string;
  sql_text?: string;
  parameters?: unknown[];
  committed?: boolean;
  duration_ms?: number;
  row_count?: number;
  result_row_count?: number;
  result_bytes?: number;
  error?: string;
};
```

The audit store can initially be a dedicated Postgres table on the selected bay,
with important events also mirrored to `central_log` for admin alerting and
search. A dedicated table is better for structured querying and retention.

Retention should be long enough for incident reconstruction. Operator DB audit
events are security-relevant and should not use the same short retention as
high-volume telemetry.

## Bay-Aware Routing

The CLI must not assume that the local bay is authoritative.

Suggested behavior:

- `--bay <bay_id_or_name>` explicitly selects the execution bay.
- If omitted in one-bay deployments, use the local bay.
- If omitted in multibay deployments, fail with a message that lists available
  bays or suggests `cocalc admin db bays`.
- The selected bay executes the SQL locally using its own `getPool()` database
  connection.
- Cross-bay dispatch uses internal Conat bay-to-bay RPC, not SSH.
- The audit record is written by the executing bay.
- The response includes the executed `bay_id`, database identity, and server
  time.

This matches the control-plane rule that ownership and authority are explicit.
The CLI is an operator control-plane tool, not a project data-plane proxy.

## Backend Architecture

Use a Conat admin RPC API rather than a Next API route.

Suggested modules:

- `src/packages/conat/hub/api/admin-db.ts` for API types.
- `src/packages/server/admin-db/execute.ts` for execution logic.
- `src/packages/server/admin-db/diagnostics.ts` for curated queries.
- `src/packages/server/admin-db/audit.ts` for audit persistence.
- `src/packages/server/conat/api/admin-db.ts` for the server handler.
- `src/packages/cli/src/commands/admin/db.ts` for CLI commands.

Server execution should use `getPool()` from `@cocalc/database/pool`.

The request type should include:

```ts
type AdminDbExecuteRequest = {
  bay_id?: string;
  mode: "query" | "write" | "break_glass" | "diagnostic";
  sql?: string;
  params?: unknown[];
  diagnostic?: string;
  reason?: string;
  commit?: boolean;
  max_rows?: number;
  max_bytes?: number;
  statement_timeout_ms?: number;
  lock_timeout_ms?: number;
  output?: "json" | "csv" | "table";
};
```

The response type should include:

```ts
type AdminDbExecuteResponse = {
  audit_id: string;
  bay_id: string;
  server_time: string;
  mode: AdminDbExecuteRequest["mode"];
  committed?: boolean;
  duration_ms: number;
  fields?: { name: string; data_type?: string }[];
  rows?: unknown[][];
  row_count?: number;
  truncated?: boolean;
  notices?: string[];
};
```

## Query Guardrails

Baseline guardrails:

- Always set `application_name` to include `cocalc-admin-db`, account id, audit
  id, and CLI version when possible.
- Always set `statement_timeout`.
- Always set `lock_timeout`.
- Always set `idle_in_transaction_session_timeout`.
- Cap returned rows.
- Cap returned bytes.
- Do not allow multiple concurrent admin DB operations per operator by default.
- Refuse empty SQL.
- Refuse `COPY ... PROGRAM`.
- Refuse psql meta-commands because this is not `psql`.
- Refuse unbounded `LISTEN`, `NOTIFY`, and long-running cursor workflows in the
  first version.
- In read-only mode, run `BEGIN READ ONLY`.
- In write mode, run `BEGIN`, execute, summarize, then `ROLLBACK` unless
  `commit=true`.

Avoid building a fragile pseudo-SQL sandbox. PostgreSQL transaction modes and
permissions should do the heavy lifting. Simple parsing or denylisting is still
useful for clearer error messages and to block known dangerous features before
they reach Postgres.

## Curated Diagnostics

Curated diagnostics should cover the common cases that currently cause SSH.

Initial commands:

- `activity`: active Postgres sessions, grouped by application and state.
- `locks`: blockers and blocked sessions.
- `table-sizes`: largest tables and indexes.
- `index-usage`: obvious unused or missing-index signals.
- `central-log`: filtered central log events by type and time window.
- `service-denials`: service admission denial summary.
- `account`: safe account summary by account id or email.
- `project`: safe project summary by project id.
- `host`: safe host summary by host id.

These commands can be implemented as named diagnostics that call the same
backend executor with checked SQL templates and typed parameters. They should be
fast, capped, and usable without remembering schema details.

## Admin Data Explorer Relationship

Admin Data Explorer and `cocalc admin db` should share execution infrastructure
but have different product surfaces.

Recommended split:

- CLI is the primary incident-response surface.
- Admin Data Explorer is the browser surface for saved read-only views,
  dashboards, and CSV export.
- Raw browser SQL should use the same read-only backend and audit model.
- Browser write SQL should not be in the first milestone because browser admin
  sessions have more accidental-click and XSS risk.
- Saved Data Explorer views should be read-only unless a later design adds an
  explicit reviewed mutation workflow.

This lets the CLI solve the urgent operational problem without blocking on the
full Data Explorer product.

## CLI Ergonomics

Important behaviors:

- `--json` must be stable for scripts and Codex.
- Human output should be concise and include audit id.
- Dangerous commands should print the target bay and mode before executing.
- Write mode without `--commit` should make the rollback obvious.
- `--dry-run` should be accepted as an alias for default rollback in write mode.
- `--file` should be preferred for multi-statement repairs.
- `--reason` should be required for raw SQL and optional for curated
  diagnostics.
- Failure output should include audit id if one was created.

A write-mode dry run should be normal, not special:

```sh
cocalc admin db exec --write --reason "check repair impact" --file repair.sql
```

Then the committed run should be a small diff:

```sh
cocalc admin db exec --write --commit --reason "apply checked repair" --file repair.sql
```

## Testing Plan

Backend tests:

- Read-only mode rejects writes because Postgres read-only transaction blocks
  them.
- Write mode rolls back by default.
- Write mode commits only with `commit=true`.
- Audit records are created for success and failure.
- Timeouts are applied.
- Row and byte caps truncate results.
- `COPY ... PROGRAM` and psql meta-commands are rejected.
- Permission and fresh-auth failures happen before SQL execution.

CLI tests:

- `--json` output is stable.
- Missing `--reason` fails for raw SQL.
- Write without `--commit` reports rollback.
- Write with `--commit` reports commit.
- `--bay` appears in output.
- Curated diagnostics call the expected backend mode.

Operational tests:

- Run a read-only query on staging.
- Run a write-mode rollback on staging and verify no persisted change.
- Run a write-mode commit on a staging scratch table.
- Verify audit entries from both success and failure.
- Verify a remote bay dispatch path in a multibay test deployment when
  available.

## Implementation Phases

### Phase 1: Read-Only CLI And Backend

- Add Conat admin DB API types.
- Add server-side read-only executor.
- Add audit table or central-log-backed audit records.
- Add `cocalc admin db query`.
- Add `activity`, `locks`, and `table-sizes` diagnostics.

This phase replaces many SSH read-only investigations.

### Phase 2: More Diagnostics

- Add central-log and service-denial diagnostics.
- Add account, project, and host summaries.
- Add CSV output.
- Add saved command examples to `src/.agents` or CLI help.

This phase reduces the need for raw SQL.

### Phase 3: Audited Write Mode

- Add site setting and permission gate.
- Add write executor with default rollback.
- Add explicit `--commit`.
- Add stronger audit persistence.
- Add tests for rollback and commit.

This phase replaces most production repair SSH sessions.

### Phase 4: Break-Glass

- Add disabled-by-default break-glass mode.
- Require explicit confirmation and reason.
- Add stricter audit and alerting.

This phase is for rare emergencies.

### Phase 5: Data Explorer Integration

- Point Admin Data Explorer SQL mode at the same read-only executor.
- Show audit ids for Data Explorer runs.
- Support saved views that call curated diagnostics or checked SQL.

This phase unifies the browser and CLI surfaces.

## Open Questions

- Should raw read-only SQL be enabled by default for self-hosted admins, or only
  after a site setting is enabled?
- Should write mode require a distinct operator role beyond `is_admin`?
- Should write commits require a second admin approval for CoCalc-managed
  production?
- Should audit records store full SQL text forever, or store full text for a
  shorter period plus permanent hashes and metadata?
- Should break-glass mode page all admins or just write an alert?
- How should bay discovery be presented in the CLI before multibay is fully
  deployed?

## Recommended First Implementation

Build Phase 1 and Phase 3 before spending more time improving direct SSH
operator workflows.

The smallest useful version is:

- `cocalc admin db query --bay ... --sql ...`
- `cocalc admin db activity`
- `cocalc admin db locks`
- `cocalc admin db table-sizes`
- `cocalc admin db exec --write`, rollback by default
- `cocalc admin db exec --write --commit`
- audit records for every operation

That is enough to move routine production database investigation and targeted
repair from "SSH and cross fingers" to an authenticated, bay-aware, auditable
operator path.
