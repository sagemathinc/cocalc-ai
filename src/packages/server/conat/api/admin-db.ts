/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID, uuid } from "@cocalc/util/misc";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { ensureProjectMaintenanceStatusTable } from "@cocalc/server/projects/maintenance-status";
import type {
  AdminDbDiagnostic,
  AdminDbExecuteRequest,
  AdminDbExecuteResponse,
} from "@cocalc/conat/hub/api/admin-db";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

type AdminAuthOpts = {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
};

const logger = getLogger("server:conat:api:admin-db");

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const MAX_STATEMENT_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const MAX_LOCK_TIMEOUT_MS = 10_000;

const DIAGNOSTIC_SQL: Record<AdminDbDiagnostic, string> = {
  activity: `
    SELECT pid, usename, application_name, client_addr::text AS client_addr,
           state, wait_event_type, wait_event,
           now() - query_start AS query_age,
           left(query, 500) AS query
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
    ORDER BY query_start NULLS LAST
  `,
  locks: `
    SELECT blocked.pid AS blocked_pid,
           blocked.application_name AS blocked_application,
           blocking.pid AS blocking_pid,
           blocking.application_name AS blocking_application,
           blocked_locks.locktype,
           blocked_locks.relation::regclass::text AS relation,
           blocked_locks.mode AS blocked_mode,
           blocking_locks.mode AS blocking_mode,
           now() - blocked.query_start AS blocked_age,
           left(blocked.query, 500) AS blocked_query
    FROM pg_locks blocked_locks
    JOIN pg_stat_activity blocked ON blocked.pid = blocked_locks.pid
    JOIN pg_locks blocking_locks
      ON blocking_locks.locktype IS NOT DISTINCT FROM blocked_locks.locktype
     AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
     AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
     AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
     AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
     AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
     AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
     AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
     AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
     AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
     AND blocking_locks.pid <> blocked_locks.pid
    JOIN pg_stat_activity blocking ON blocking.pid = blocking_locks.pid
    WHERE NOT blocked_locks.granted
      AND blocking_locks.granted
    ORDER BY blocked.query_start NULLS LAST
  `,
  "table-sizes": `
    SELECT schemaname, relname,
           pg_total_relation_size(relid) AS total_bytes,
           pg_relation_size(relid) AS table_bytes,
           pg_total_relation_size(relid) - pg_relation_size(relid) AS index_bytes,
           n_live_tup, n_dead_tup,
           last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
    FROM pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
  `,
  lro: `
    SELECT op_id, kind, scope_type, scope_id, status, created_by,
           owner_type, owner_id, routing, attempt, heartbeat_at,
           created_at, started_at, finished_at, updated_at, expires_at,
           left(coalesce(error, ''), 1000) AS error,
           progress_summary, result
    FROM long_running_operations
    WHERE ($1::uuid IS NULL OR op_id = $1::uuid)
      AND ($2::text IS NULL OR kind = $2::text)
      AND ($3::text IS NULL OR status = $3::text)
      AND ($4::text IS NULL OR scope_type = $4::text)
      AND ($5::uuid IS NULL OR scope_id = $5::uuid)
      AND updated_at >= now() - make_interval(secs => $6::double precision)
    ORDER BY updated_at DESC
  `,
  "backup-health": `
    WITH latest_index AS (
      SELECT project_id, max(backup_time) AS latest_index_backup_at
      FROM project_backup_indexes
      WHERE ($1::uuid IS NULL OR project_id = $1::uuid)
      GROUP BY project_id
    )
    SELECT p.project_id, p.title, p.host_id, p.owning_bay_id,
           p.provisioned, p.last_changed, p.last_backup,
           latest_index.latest_index_backup_at,
           p.backup_repo_id,
           now() - p.last_backup AS backup_age
    FROM projects p
    LEFT JOIN latest_index ON latest_index.project_id = p.project_id
    WHERE ($1::uuid IS NULL OR p.project_id = $1::uuid)
      AND p.deleted IS NULL
    ORDER BY p.last_backup ASC NULLS FIRST
  `,
  "host-health": `
    SELECT id AS host_id, name, bay_id, region, status, last_seen,
           now() - last_seen AS heartbeat_age,
           version, capacity, metadata,
           (SELECT count(*) FROM projects p WHERE p.host_id = project_hosts.id AND p.deleted IS NULL) AS assigned_projects
    FROM project_hosts
    WHERE deleted IS NULL
      AND ($1::uuid IS NULL OR id = $1::uuid)
    ORDER BY last_seen ASC NULLS FIRST
  `,
  project: `
    SELECT project_id, title, host_id, owning_bay_id, deleted,
           provisioned, provisioned_checked_at,
           last_changed, last_backup, backup_repo_id,
           last_edited, created
    FROM projects
    WHERE project_id = $1::uuid
  `,
  "project-recovery": `
    SELECT p.project_id, p.title, p.host_id AS current_host_id,
           p.last_changed, p.last_backup,
           a.kind, a.host_id AS reporting_host_id,
           a.storage_service_class, a.observed_at, a.outcome,
           a.reason, a.attempt_due_at, a.duration_ms,
           a.latest_backup_id,
           a.stage_durations_ms, a.bytes_scanned, a.bytes_uploaded,
           a.retry_at
    FROM projects p
    LEFT JOIN project_maintenance_attempts a
      ON a.project_id = p.project_id
    WHERE p.project_id = $1::uuid
    ORDER BY a.observed_at DESC NULLS LAST
  `,
  "migration-health": `
    SELECT 'projects_by_artifact_status' AS section,
           artifact_status AS key,
           count(*)::bigint AS count,
           max(updated) AS latest_updated
    FROM legacy_migration_projects
    GROUP BY artifact_status
    UNION ALL
    SELECT 'imports_by_status' AS section,
           status AS key,
           count(*)::bigint AS count,
           max(updated) AS latest_updated
    FROM legacy_migration_project_imports
    GROUP BY status
    ORDER BY section, count DESC
  `,
};

function normalizePositiveInt({
  value,
  fallback,
  max,
}: {
  value?: number;
  fallback: number;
  max: number;
}): number {
  const n = Math.floor(Number(value ?? fallback));
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, max);
}

function trimTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

function rejectClearlyUnsafeSql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("SQL must be non-empty");
  }
  if (trimmed.startsWith("\\")) {
    throw new Error("psql meta-commands are not supported");
  }
  if (/\bcopy\b[\s\S]*\bprogram\b/i.test(trimmed)) {
    throw new Error("COPY PROGRAM is not allowed");
  }
  if (/\b(listen|notify)\b/i.test(trimmed)) {
    throw new Error("LISTEN and NOTIFY are not allowed");
  }
}

async function requireAdminAccount({
  account_id,
}: AdminAuthOpts): Promise<string> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    throw new Error("must be signed in");
  }
  if (!(await isAdmin(accountId))) {
    throw Object.assign(new Error("admin privileges required"), { code: 403 });
  }
  return accountId;
}

async function requireFreshAdmin(opts: AdminAuthOpts): Promise<string> {
  const accountId = await requireAdminAccount(opts);
  await requireDangerousSessionAuth({
    account_id: accountId,
    session_hash: opts.session_hash,
    browser_id: opts.browser_id,
    require_second_factor: "if_enabled",
  });
  return accountId;
}

function sqlHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function recordAudit({
  audit_id,
  account_id,
  mode,
  diagnostic,
  reason,
  bay_id,
  host_id,
  sql,
  duration_ms,
  row_count,
  result_bytes,
  committed,
  error,
}: {
  audit_id: string;
  account_id: string;
  mode: "query" | "diagnostic" | "write" | "host-query";
  diagnostic?: AdminDbDiagnostic;
  reason?: string;
  bay_id: string;
  host_id?: string;
  sql?: string;
  duration_ms?: number;
  row_count?: number;
  result_bytes?: number;
  committed?: boolean;
  error?: unknown;
}) {
  try {
    await centralLog({
      event: "admin_db_operator",
      value: {
        audit_id,
        account_id,
        mode,
        diagnostic,
        reason: reason ?? null,
        bay_id,
        host_id: host_id ?? null,
        sql_sha256: sql ? sqlHash(sql) : null,
        sql_text: sql ?? null,
        duration_ms,
        row_count,
        result_bytes,
        committed,
        error: error == null ? null : `${error}`,
      },
    });
  } catch (err) {
    logger.warn("failed to write admin DB audit event", { audit_id, err });
  }
}

function assertLocalBay(requested: string | undefined): string {
  const localBay = getConfiguredBayId();
  const bay = `${requested ?? ""}`.trim();
  if (bay && bay !== localBay) {
    throw new Error(
      `admin DB cross-bay dispatch is not implemented yet; selected bay '${bay}' but this API is running on '${localBay}'`,
    );
  }
  return localBay;
}

function truncateRows({
  rows,
  maxBytes,
}: {
  rows: unknown[][];
  maxBytes: number;
}): { rows: unknown[][]; bytes: number; truncated: boolean } {
  let output = rows;
  let encoded = JSON.stringify(output);
  let truncated = false;
  while (Buffer.byteLength(encoded, "utf8") > maxBytes && output.length > 0) {
    truncated = true;
    output = output.slice(0, -1);
    encoded = JSON.stringify(output);
  }
  return {
    rows: output,
    bytes: Buffer.byteLength(encoded, "utf8"),
    truncated,
  };
}

function rowsFromResult({
  fields,
  rows,
}: {
  fields: { name: string }[];
  rows: Record<string, unknown>[];
}): unknown[][] {
  return rows.map((row) => fields.map((field) => row[field.name]));
}

function fieldsFromResult(fields: { name: string; dataTypeID: number }[]) {
  return fields.map((field) => ({
    name: field.name,
    data_type_id: field.dataTypeID,
  }));
}

function diagnosticParams({
  diagnostic,
  params,
}: {
  diagnostic: AdminDbDiagnostic;
  params?: Record<string, unknown>;
}): unknown[] {
  const p = params ?? {};
  if (diagnostic === "lro") {
    return [
      p.op_id ?? null,
      p.kind ?? null,
      p.status ?? null,
      p.scope_type ?? null,
      p.scope_id ?? null,
      Number(p.window_seconds ?? 24 * 60 * 60),
    ];
  }
  if (
    diagnostic === "backup-health" ||
    diagnostic === "project" ||
    diagnostic === "project-recovery"
  ) {
    return [p.project_id ?? null];
  }
  if (diagnostic === "host-health") {
    return [p.host_id ?? null];
  }
  return [];
}

async function runReadOnlySql({
  sql,
  values,
  limit,
  maxBytes,
  statementTimeoutMs,
  lockTimeoutMs,
}: {
  sql: string;
  values?: unknown[];
  limit: number;
  maxBytes: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}): Promise<
  Omit<AdminDbExecuteResponse, "audit_id" | "bay_id" | "server_time" | "mode">
> {
  const client: PoolClient = await getPool().connect();
  const started = Date.now();
  const executedSql = `SELECT * FROM (${sql}) AS admin_db_operator_query LIMIT ${limit + 1}`;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`,
    );
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    );
    await client.query("SET LOCAL search_path = public");
    const result = await client.query(executedSql, values ?? []);
    await client.query("COMMIT");
    const overLimit = result.rows.length > limit;
    const limited = overLimit ? result.rows.slice(0, limit) : result.rows;
    const rows = rowsFromResult({ fields: result.fields, rows: limited });
    const truncated = truncateRows({ rows, maxBytes });
    return {
      duration_ms: Date.now() - started,
      fields: fieldsFromResult(result.fields),
      rows: truncated.rows,
      row_count: truncated.rows.length,
      result_bytes: truncated.bytes,
      truncated: overLimit || truncated.truncated,
      executed_sql: executedSql,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

function rejectWriteControlSql(sql: string): void {
  if (sql.includes(";")) {
    throw new Error("admin DB write mode supports exactly one SQL statement");
  }
  if (/\b(begin|commit|rollback|savepoint|release\s+savepoint)\b/i.test(sql)) {
    throw new Error(
      "transaction control is not allowed in admin DB write mode",
    );
  }
}

async function runWriteSql({
  sql,
  commit,
  maxBytes,
  statementTimeoutMs,
  lockTimeoutMs,
}: {
  sql: string;
  commit: boolean;
  maxBytes: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}): Promise<
  Omit<AdminDbExecuteResponse, "audit_id" | "bay_id" | "server_time" | "mode">
> {
  const client: PoolClient = await getPool().connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`,
    );
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    );
    await client.query("SET LOCAL search_path = public");
    const result = await client.query(sql);
    if (commit) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    const rows = rowsFromResult({ fields: result.fields, rows: result.rows });
    const truncated = truncateRows({ rows, maxBytes });
    return {
      duration_ms: Date.now() - started,
      fields: fieldsFromResult(result.fields),
      rows: truncated.rows,
      row_count: result.rowCount ?? truncated.rows.length,
      result_bytes: truncated.bytes,
      truncated: truncated.truncated,
      executed_sql: sql,
      committed: commit,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

async function executeReadOnly({
  mode,
  account_id,
  bay_id,
  sql,
  diagnostic,
  params,
  reason,
  limit,
  max_bytes,
  statement_timeout_ms,
  lock_timeout_ms,
}: AdminDbExecuteRequest & {
  mode: "query" | "diagnostic";
  account_id: string;
}): Promise<AdminDbExecuteResponse> {
  const audit_id = uuid();
  const localBay = assertLocalBay(bay_id);
  const normalizedLimit = normalizePositiveInt({
    value: limit,
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });
  const maxBytes = normalizePositiveInt({
    value: max_bytes,
    fallback: DEFAULT_MAX_BYTES,
    max: MAX_MAX_BYTES,
  });
  const statementTimeoutMs = normalizePositiveInt({
    value: statement_timeout_ms,
    fallback: DEFAULT_STATEMENT_TIMEOUT_MS,
    max: MAX_STATEMENT_TIMEOUT_MS,
  });
  const lockTimeoutMs = normalizePositiveInt({
    value: lock_timeout_ms,
    fallback: DEFAULT_LOCK_TIMEOUT_MS,
    max: MAX_LOCK_TIMEOUT_MS,
  });
  const rawSql =
    mode === "diagnostic"
      ? DIAGNOSTIC_SQL[diagnostic as AdminDbDiagnostic]
      : sql;
  if (!rawSql) {
    throw new Error("unknown or missing admin DB SQL");
  }
  if (diagnostic === "project-recovery") {
    await ensureProjectMaintenanceStatusTable();
  }
  const normalizedSql = trimTrailingSemicolon(rawSql);
  rejectClearlyUnsafeSql(normalizedSql);
  await recordAudit({
    audit_id,
    account_id,
    mode,
    diagnostic,
    reason,
    bay_id: localBay,
    sql: normalizedSql,
  });
  const started = Date.now();
  try {
    const result = await runReadOnlySql({
      sql: normalizedSql,
      values:
        mode === "diagnostic" && diagnostic
          ? diagnosticParams({ diagnostic, params })
          : [],
      limit: normalizedLimit,
      maxBytes,
      statementTimeoutMs,
      lockTimeoutMs,
    });
    await recordAudit({
      audit_id,
      account_id,
      mode,
      diagnostic,
      reason,
      bay_id: localBay,
      sql: normalizedSql,
      duration_ms: result.duration_ms,
      row_count: result.row_count,
      result_bytes: result.result_bytes,
    });
    return {
      audit_id,
      bay_id: localBay,
      server_time: new Date().toISOString(),
      mode,
      diagnostic,
      ...result,
    };
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id,
      mode,
      diagnostic,
      reason,
      bay_id: localBay,
      sql: normalizedSql,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

async function executeHostQuery({
  account_id,
  bay_id,
  host_id,
  sql,
  reason,
  limit,
  max_bytes,
  statement_timeout_ms,
}: AdminDbExecuteRequest & {
  account_id: string;
}): Promise<AdminDbExecuteResponse> {
  const audit_id = uuid();
  const localBay = assertLocalBay(bay_id);
  const hostId = `${host_id ?? ""}`.trim();
  if (!isValidUUID(hostId)) {
    throw new Error("--host-id must be a valid project-host id");
  }
  if (!sql) {
    throw new Error("SQL is required");
  }
  const normalizedSql = trimTrailingSemicolon(sql);
  rejectClearlyUnsafeSql(normalizedSql);
  const normalizedLimit = normalizePositiveInt({
    value: limit,
    fallback: DEFAULT_LIMIT,
    max: 1000,
  });
  const maxBytes = normalizePositiveInt({
    value: max_bytes,
    fallback: DEFAULT_MAX_BYTES,
    max: 5 * 1024 * 1024,
  });
  const timeoutMs = normalizePositiveInt({
    value: statement_timeout_ms,
    fallback: DEFAULT_STATEMENT_TIMEOUT_MS,
    max: 30_000,
  });
  await recordAudit({
    audit_id,
    account_id,
    mode: "host-query",
    reason,
    bay_id: localBay,
    host_id: hostId,
    sql: normalizedSql,
  });
  const started = Date.now();
  try {
    const hostClient = await getRoutedHostControlClient({
      host_id: hostId,
      timeout: timeoutMs + 5_000,
      fresh: true,
    });
    const result = await hostClient.querySqlite({
      sql: normalizedSql,
      limit: normalizedLimit,
      max_bytes: maxBytes,
    });
    await recordAudit({
      audit_id,
      account_id,
      mode: "host-query",
      reason,
      bay_id: localBay,
      host_id: hostId,
      sql: normalizedSql,
      duration_ms: result.duration_ms,
      row_count: result.row_count,
      result_bytes: result.result_bytes,
    });
    return {
      audit_id,
      bay_id: localBay,
      host_id: hostId,
      server_time: new Date().toISOString(),
      mode: "host-query",
      ...result,
    };
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id,
      mode: "host-query",
      reason,
      bay_id: localBay,
      host_id: hostId,
      sql: normalizedSql,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export async function query({
  account_id,
  ...opts
}: AdminAuthOpts & AdminDbExecuteRequest): Promise<AdminDbExecuteResponse> {
  const accountId = await requireFreshAdmin({ account_id, ...opts });
  if (!opts.reason?.trim()) {
    throw new Error("--reason is required for raw admin DB SQL");
  }
  return await executeReadOnly({
    ...opts,
    account_id: accountId,
    mode: "query",
  });
}

export async function queryHost({
  account_id,
  ...opts
}: AdminAuthOpts & AdminDbExecuteRequest): Promise<AdminDbExecuteResponse> {
  const accountId = await requireFreshAdmin({ account_id, ...opts });
  if (!opts.reason?.trim()) {
    throw new Error("--reason is required for raw project-host SQLite SQL");
  }
  return await executeHostQuery({
    ...opts,
    account_id: accountId,
  });
}

export async function diagnostic({
  account_id,
  ...opts
}: AdminAuthOpts & AdminDbExecuteRequest): Promise<AdminDbExecuteResponse> {
  const accountId = await requireAdminAccount({ account_id });
  if (!opts.diagnostic) {
    throw new Error("diagnostic is required");
  }
  return await executeReadOnly({
    ...opts,
    account_id: accountId,
    mode: "diagnostic",
  });
}

export async function exec({
  account_id,
  ...opts
}: AdminAuthOpts & AdminDbExecuteRequest): Promise<AdminDbExecuteResponse> {
  const accountId = await requireFreshAdmin({ account_id, ...opts });
  if (!opts.write) {
    throw new Error("--write is required for admin DB write mode");
  }
  if (!opts.reason?.trim()) {
    throw new Error("--reason is required for admin DB write mode");
  }
  const audit_id = uuid();
  const localBay = assertLocalBay(opts.bay_id);
  const rawSql = opts.sql;
  if (!rawSql) {
    throw new Error("SQL is required");
  }
  const normalizedSql = trimTrailingSemicolon(rawSql);
  rejectClearlyUnsafeSql(normalizedSql);
  rejectWriteControlSql(normalizedSql);
  const maxBytes = normalizePositiveInt({
    value: opts.max_bytes,
    fallback: DEFAULT_MAX_BYTES,
    max: MAX_MAX_BYTES,
  });
  const statementTimeoutMs = normalizePositiveInt({
    value: opts.statement_timeout_ms,
    fallback: DEFAULT_STATEMENT_TIMEOUT_MS,
    max: MAX_STATEMENT_TIMEOUT_MS,
  });
  const lockTimeoutMs = normalizePositiveInt({
    value: opts.lock_timeout_ms,
    fallback: DEFAULT_LOCK_TIMEOUT_MS,
    max: MAX_LOCK_TIMEOUT_MS,
  });
  const commit = opts.commit === true;
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode: "write",
    reason: opts.reason,
    bay_id: localBay,
    sql: normalizedSql,
    committed: false,
  });
  const started = Date.now();
  try {
    const result = await runWriteSql({
      sql: normalizedSql,
      commit,
      maxBytes,
      statementTimeoutMs,
      lockTimeoutMs,
    });
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "write",
      reason: opts.reason,
      bay_id: localBay,
      sql: normalizedSql,
      duration_ms: result.duration_ms,
      row_count: result.row_count,
      result_bytes: result.result_bytes,
      committed: commit,
    });
    return {
      audit_id,
      bay_id: localBay,
      server_time: new Date().toISOString(),
      mode: "write",
      ...result,
      committed: commit,
    };
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "write",
      reason: opts.reason,
      bay_id: localBay,
      sql: normalizedSql,
      duration_ms: Date.now() - started,
      committed: false,
      error: err,
    });
    throw err;
  }
}
