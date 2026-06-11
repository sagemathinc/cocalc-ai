/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  ADMIN_DATA_EXPLORER_ALLOWED_SQL_COLUMNS,
  ADMIN_DATA_EXPLORER_ALLOWED_SQL_FUNCTIONS,
  ADMIN_DATA_EXPLORER_ALLOWED_SQL_RELATIONS,
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES,
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS,
  ADMIN_DATA_EXPLORER_SQL_MAX_BYTES,
  ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
  ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS,
} from "@cocalc/util/admin-data-explorer";
import { uuid } from "@cocalc/util/misc";
import { parse, toSql } from "pgsql-ast-parser";
import type {
  AdminDataAuditEvent,
  AdminDataDataset,
  AdminDataQuery,
  AdminDataQueryKind,
  AdminDataScope,
  AdminDataSqlRunResult,
  AdminDataSqlValidationResult,
  AdminDataSort,
  AdminDataView,
  AdminDataViewExport,
  AdminDataViewImportResult,
  AdminDataViewInput,
  AdminDataViewRunResult,
  AdminDataViewSummary,
  AdminDataVisualization,
} from "@cocalc/conat/hub/api/admin-data-explorer";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";

const logger = getLogger("server:conat:api:admin-data-explorer");

const MAX_SLUG_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 80;
const MAX_COLUMNS = 200;
const MAX_SORTS = 20;
const MAX_DEFAULT_LIMIT = 10_000;
const MAX_AUDIT_EVENTS = 200;
const TABLE = "admin_data_explorer_views";

const ALLOWED_SQL_RELATIONS: Set<string> = new Set(
  ADMIN_DATA_EXPLORER_ALLOWED_SQL_RELATIONS,
);
const ALLOWED_SQL_FUNCTIONS: Set<string> = new Set(
  ADMIN_DATA_EXPLORER_ALLOWED_SQL_FUNCTIONS,
);
const ALLOWED_SQL_COLUMNS = new Map<string, Set<string>>(
  Object.entries(ADMIN_DATA_EXPLORER_ALLOWED_SQL_COLUMNS).map(
    ([relation, columns]) => [relation, new Set(columns)],
  ),
);

type AdminAuthOpts = {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
};

type AdminDataViewRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  visibility: string;
  query_kind: string;
  query: AdminDataQuery;
  scope: AdminDataScope;
  default_columns: string[] | null;
  default_sort: AdminDataSort[] | null;
  default_limit: number | null;
  visualization: string | null;
  owner_account_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

const DATASETS: AdminDataDataset[] = [
  {
    id: "accounts",
    title: "Accounts",
    description:
      "Account records for admin investigations. Query execution will enforce field allowlists and limits.",
    source: "postgres",
    scope_kinds: ["local", "all_bays", "bay"],
    default_limit: 100,
    max_limit: 1000,
    fields: [
      { name: "account_id", type: "uuid", filterable: true, sortable: true },
      { name: "email_address", type: "string", filterable: true },
      { name: "first_name", type: "string", filterable: true },
      { name: "last_name", type: "string", filterable: true },
      { name: "created", type: "timestamp", filterable: true, sortable: true },
      {
        name: "last_active",
        type: "timestamp",
        filterable: true,
        sortable: true,
      },
      { name: "banned", type: "boolean", filterable: true },
    ],
  },
  {
    id: "projects",
    title: "Projects",
    description:
      "Project metadata and placement state, routed by owning bay in a future multi-bay query engine.",
    source: "postgres",
    scope_kinds: ["local", "all_bays", "bay", "host", "account"],
    default_limit: 100,
    max_limit: 1000,
    fields: [
      { name: "project_id", type: "uuid", filterable: true, sortable: true },
      { name: "title", type: "string", filterable: true },
      { name: "state", type: "map", filterable: true },
      { name: "host_id", type: "uuid", filterable: true, sortable: true },
      {
        name: "owning_bay_id",
        type: "string",
        filterable: true,
        sortable: true,
      },
      { name: "created", type: "timestamp", filterable: true, sortable: true },
    ],
  },
  {
    id: "project_hosts",
    title: "Project Hosts",
    description: "Project host inventory, runtime rollout, and capacity state.",
    source: "postgres",
    scope_kinds: ["local", "all_bays", "bay", "host"],
    default_limit: 100,
    max_limit: 1000,
    fields: [
      { name: "id", type: "uuid", filterable: true, sortable: true },
      { name: "name", type: "string", filterable: true, sortable: true },
      { name: "region", type: "string", filterable: true, sortable: true },
      { name: "bay_id", type: "string", filterable: true, sortable: true },
      { name: "status", type: "string", filterable: true, sortable: true },
      {
        name: "last_seen",
        type: "timestamp",
        filterable: true,
        sortable: true,
      },
      { name: "version", type: "string", filterable: true },
      { name: "updated", type: "timestamp", filterable: true, sortable: true },
    ],
  },
  {
    id: "ux_latency_events",
    title: "UX Latency Events",
    description:
      "Browser-observed launch and readiness latency events used for operator launch diagnostics.",
    source: "postgres",
    scope_kinds: ["local", "bay", "host", "project"],
    default_limit: 100,
    max_limit: 5000,
    fields: [
      { name: "event_type", type: "string", filterable: true, sortable: true },
      { name: "metric", type: "string", filterable: true, sortable: true },
      {
        name: "duration_ms",
        type: "integer",
        filterable: true,
        sortable: true,
      },
      { name: "project_id", type: "uuid", filterable: true },
      { name: "host_id", type: "uuid", filterable: true },
      { name: "bay_id", type: "string", filterable: true },
      {
        name: "started_at",
        type: "timestamp",
        filterable: true,
        sortable: true,
      },
    ],
  },
];

let schemaReady: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  schemaReady ??= getPool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      visibility TEXT NOT NULL DEFAULT 'admin',
      query_kind TEXT NOT NULL,
      query JSONB NOT NULL,
      scope JSONB NOT NULL,
      default_columns TEXT[],
      default_sort JSONB,
      default_limit INTEGER,
      visualization TEXT,
      owner_account_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS admin_data_explorer_views_updated_idx
      ON ${TABLE} (updated_at DESC);
    CREATE INDEX IF NOT EXISTS admin_data_explorer_views_query_kind_idx
      ON ${TABLE} (query_kind);
    CREATE INDEX IF NOT EXISTS admin_data_explorer_views_tags_idx
      ON ${TABLE} USING GIN (tags);
  `) as unknown as Promise<void>;
  await schemaReady;
}

async function requireFreshAdmin({
  account_id,
  browser_id,
  session_hash,
}: AdminAuthOpts): Promise<string> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return account_id;
}

function optionalString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value == null) return value as null | undefined;
  const trimmed = `${value}`.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function requiredString({
  value,
  name,
  maxLength,
}: {
  value: unknown;
  name: string;
  maxLength: number;
}): string {
  const normalized = optionalString(value, maxLength);
  if (!normalized) {
    throw Error(`${name} must be non-empty`);
  }
  return normalized;
}

function normalizeSlug(value: unknown): string {
  const slug = requiredString({
    value,
    name: "view.slug",
    maxLength: MAX_SLUG_LENGTH,
  }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw Error(
      "view.slug must start with a lowercase letter or digit and contain only lowercase letters, digits, '_' or '-'",
    );
  }
  return slug;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Error("view.tags must be an array");
  }
  const tags = value
    .map((tag) => `${tag ?? ""}`.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length > MAX_TAGS) {
    throw Error(`view.tags may contain at most ${MAX_TAGS} tags`);
  }
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      throw Error(`view tag '${tag}' is longer than ${MAX_TAG_LENGTH}`);
    }
  }
  return Array.from(new Set(tags)).sort();
}

function normalizeStringArray(value: unknown, name: string): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw Error(`${name} must be an array`);
  }
  if (value.length > MAX_COLUMNS) {
    throw Error(`${name} may contain at most ${MAX_COLUMNS} entries`);
  }
  return value.map((entry) =>
    requiredString({ value: entry, name, maxLength: 200 }),
  );
}

function normalizeSort(value: unknown): AdminDataSort[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw Error("view.default_sort must be an array");
  }
  if (value.length > MAX_SORTS) {
    throw Error(`view.default_sort may contain at most ${MAX_SORTS} entries`);
  }
  return value.map((entry) => {
    if (!isObject(entry)) {
      throw Error("view.default_sort entries must be objects");
    }
    const field = requiredString({
      value: entry.field,
      name: "view.default_sort.field",
      maxLength: 200,
    });
    const direction = `${entry.direction ?? "asc"}`;
    if (direction !== "asc" && direction !== "desc") {
      throw Error("view.default_sort.direction must be 'asc' or 'desc'");
    }
    return { field, direction };
  });
}

function normalizeQueryKind(value: unknown): AdminDataQueryKind {
  if (value === "structured" || value === "sql" || value === "dataset") {
    return value;
  }
  throw Error("view.query_kind must be one of structured, sql, dataset");
}

function normalizeVisualization(value: unknown): AdminDataVisualization | null {
  if (value == null || value === "") return null;
  if (
    value === "table" ||
    value === "chart" ||
    value === "retention" ||
    value === "summary"
  ) {
    return value;
  }
  throw Error(
    "view.visualization must be one of table, chart, retention, summary",
  );
}

function normalizeScope(value: unknown): AdminDataScope {
  const scope = value == null ? { kind: "local" } : value;
  if (!isObject(scope)) {
    throw Error("view.scope must be an object");
  }
  const kind = `${scope.kind ?? "local"}`;
  if (
    kind !== "local" &&
    kind !== "all_bays" &&
    kind !== "bay" &&
    kind !== "host" &&
    kind !== "project" &&
    kind !== "account"
  ) {
    throw Error("view.scope.kind is invalid");
  }
  return {
    kind,
    bay_id: optionalString(scope.bay_id, 120) ?? undefined,
    host_id: optionalString(scope.host_id, 80) ?? undefined,
    project_id: optionalString(scope.project_id, 80) ?? undefined,
    account_id: optionalString(scope.account_id, 80) ?? undefined,
  };
}

function normalizeQuery(
  kind: AdminDataQueryKind,
  value: unknown,
): AdminDataQuery {
  if (!isObject(value)) {
    throw Error("view.query must be an object");
  }
  if (kind === "sql") {
    const sql = requiredString({
      value: value.sql,
      name: "view.query.sql",
      maxLength: 200_000,
    });
    return {
      sql,
      parameters: Array.isArray(value.parameters)
        ? value.parameters
        : undefined,
    };
  }
  const dataset = requiredString({
    value: value.dataset,
    name: "view.query.dataset",
    maxLength: 120,
  });
  if (kind === "dataset") {
    return {
      dataset,
      parameters: isObject(value.parameters) ? value.parameters : undefined,
    };
  }
  return {
    dataset,
    filter: isObject(value.filter) ? value.filter : undefined,
  };
}

function normalizeDefaultLimit(value: unknown): number | null {
  if (value == null || value === "") return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("view.default_limit must be a positive integer");
  }
  return Math.min(limit, MAX_DEFAULT_LIMIT);
}

function normalizeAuditLimit(value: unknown): number {
  if (value == null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return Math.min(limit, MAX_AUDIT_EVENTS);
}

function normalizeSqlLimit(value: unknown): number {
  if (value == null || value === "")
    return ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return Math.min(limit, ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT);
}

function normalizeSqlTimeoutMs(value: unknown): number {
  if (value == null || value === "")
    return ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw Error("timeout_ms must be a positive integer");
  }
  return Math.min(timeout, ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS);
}

function normalizeSqlMaxBytes(value: unknown): number {
  if (value == null || value === "")
    return ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES;
  const maxBytes = Number(value);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw Error("max_bytes must be a positive integer");
  }
  return Math.min(maxBytes, ADMIN_DATA_EXPLORER_SQL_MAX_BYTES);
}

function normalizeSql(sql: unknown): string {
  return requiredString({
    value: sql,
    name: "sql",
    maxLength: 200_000,
  }).replace(/;\s*$/, "");
}

function walkAst(value: unknown, visit: (node: any) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkAst(item, visit);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  visit(value);
  for (const item of Object.values(value)) {
    walkAst(item, visit);
  }
}

function collectCteNames(statement: any): Set<string> {
  const names = new Set<string>();
  walkAst(statement, (node) => {
    if (node?.type !== "with" || !Array.isArray(node.bind)) {
      return;
    }
    for (const binding of node.bind) {
      const name = `${binding?.alias?.name ?? ""}`.trim().toLowerCase();
      if (name) {
        names.add(name);
      }
    }
  });
  return names;
}

function validateReadOnlyStatement(node: any, errors: string[]): void {
  if (!node || typeof node !== "object") {
    errors.push("SQL did not parse to a statement");
    return;
  }
  if (node.type === "select") {
    return;
  }
  if (node.type === "with") {
    if (Array.isArray(node.bind)) {
      for (const binding of node.bind) {
        validateReadOnlyStatement(binding?.statement, errors);
      }
    }
    validateReadOnlyStatement(node.in, errors);
    return;
  }
  errors.push(
    `only SELECT and read-only WITH statements are allowed, not ${node.type}`,
  );
}

function collectSelectRelationAliases(
  statement: any,
  cteNames: Set<string>,
): {
  aliasToRelation: Map<string, string>;
  cteAliases: Set<string>;
  baseRelations: Set<string>;
} {
  const aliasToRelation = new Map<string, string>();
  const cteAliases = new Set<string>();
  const baseRelations = new Set<string>();
  for (const entry of Array.isArray(statement?.from) ? statement.from : []) {
    if (entry?.type !== "table") continue;
    const relation = `${entry.name?.name ?? ""}`.trim().toLowerCase();
    if (!relation) continue;
    const alias = `${entry.name?.alias ?? relation}`.trim().toLowerCase();
    if (cteNames.has(relation)) {
      cteAliases.add(alias);
      continue;
    }
    aliasToRelation.set(alias, relation);
    aliasToRelation.set(relation, relation);
    baseRelations.add(relation);
  }
  return { aliasToRelation, cteAliases, baseRelations };
}

function validateColumnReference({
  column,
  relation,
  errors,
}: {
  column: string;
  relation: string;
  errors: string[];
}) {
  const allowed = ALLOWED_SQL_COLUMNS.get(relation);
  if (!allowed) {
    errors.push(`relation '${relation}' has no configured column allowlist`);
    return;
  }
  if (!allowed.has(column)) {
    errors.push(`column '${relation}.${column}' is not allowed`);
  }
}

function validateSelectColumns(
  statement: any,
  cteNames: Set<string>,
  errors: string[],
): void {
  const { aliasToRelation, cteAliases, baseRelations } =
    collectSelectRelationAliases(statement, cteNames);
  walkAst(statement, (node) => {
    if (node?.type !== "ref") return;
    const column = `${node.name ?? ""}`.trim().toLowerCase();
    if (!column || column === "*") return;
    const qualifier = `${node.table?.name ?? ""}`.trim().toLowerCase();
    if (qualifier) {
      const relation = aliasToRelation.get(qualifier);
      if (!relation) {
        if (!cteAliases.has(qualifier)) {
          errors.push(`column qualifier '${qualifier}' is not a known table`);
        }
        return;
      }
      validateColumnReference({ column, relation, errors });
      return;
    }
    if (baseRelations.size === 0) {
      return;
    }
    if (baseRelations.size > 1) {
      errors.push(
        `column '${column}' must be qualified when querying multiple relations`,
      );
      return;
    }
    validateColumnReference({
      column,
      relation: [...baseRelations][0],
      errors,
    });
  });
}

function validateSqlColumns(
  statement: any,
  cteNames: Set<string>,
  errors: string[],
): void {
  if (!statement || typeof statement !== "object") return;
  if (statement.type === "with") {
    for (const binding of Array.isArray(statement.bind) ? statement.bind : []) {
      validateSqlColumns(binding?.statement, cteNames, errors);
    }
    validateSqlColumns(statement.in, cteNames, errors);
    return;
  }
  if (statement.type === "select") {
    validateSelectColumns(statement, cteNames, errors);
  }
}

function validateSqlInternal({
  sql,
  limit,
}: {
  sql: string;
  limit?: number;
}): AdminDataSqlValidationResult & { sanitized_sql?: string } {
  const enforcedLimit = normalizeSqlLimit(limit);
  const result: AdminDataSqlValidationResult & { sanitized_sql?: string } = {
    ok: false,
    errors: [],
    warnings: [],
    relations: [],
    functions: [],
    enforced_limit: enforcedLimit,
  };
  let sanitized: string;
  try {
    sanitized = normalizeSql(sql);
  } catch (err) {
    result.errors.push(`${err}`);
    return result;
  }
  result.sanitized_sql = sanitized;

  let statements: any[];
  try {
    statements = parse(sanitized) as any[];
  } catch (err) {
    result.errors.push(`SQL parse failed: ${err}`);
    return result;
  }
  if (statements.length !== 1) {
    result.errors.push("exactly one SQL statement is allowed");
    return result;
  }
  const statement = statements[0];
  validateReadOnlyStatement(statement, result.errors);
  const cteNames = collectCteNames(statement);
  const relations = new Set<string>();
  const functions = new Set<string>();

  walkAst(statement, (node) => {
    if (node?.type === "table") {
      const schema = `${node.name?.schema ?? ""}`.trim().toLowerCase();
      const relation = `${node.name?.name ?? ""}`.trim().toLowerCase();
      if (schema && schema !== "public") {
        result.errors.push(`schema '${schema}' is not allowed`);
      }
      if (relation && !cteNames.has(relation)) {
        relations.add(relation);
        if (!ALLOWED_SQL_RELATIONS.has(relation)) {
          result.errors.push(`relation '${relation}' is not allowed`);
        }
      }
    }
    if (node?.type === "call") {
      const schema = `${node.function?.schema ?? ""}`.trim().toLowerCase();
      const name = `${node.function?.name ?? ""}`.trim().toLowerCase();
      if (schema) {
        result.errors.push(`function schema '${schema}' is not allowed`);
      }
      if (name) {
        functions.add(name);
        if (!ALLOWED_SQL_FUNCTIONS.has(name)) {
          result.errors.push(`function '${name}' is not allowed`);
        }
      }
    }
  });
  validateSqlColumns(statement, cteNames, result.errors);

  result.relations = [...relations].sort();
  result.functions = [...functions].sort();
  try {
    result.normalized_sql = toSql.statement(statement);
  } catch (err) {
    result.warnings.push(`could not normalize SQL: ${err}`);
  }
  result.errors = Array.from(new Set(result.errors));
  result.ok = result.errors.length === 0;
  return result;
}

function normalizeViewInput(view: AdminDataViewInput): AdminDataViewInput {
  if (!isObject(view)) {
    throw Error("view must be an object");
  }
  const query_kind = normalizeQueryKind(view.query_kind);
  return {
    id: optionalString(view.id, 80) ?? undefined,
    slug: normalizeSlug(view.slug),
    title: requiredString({
      value: view.title,
      name: "view.title",
      maxLength: MAX_TITLE_LENGTH,
    }),
    description:
      optionalString(view.description, MAX_DESCRIPTION_LENGTH) ?? null,
    tags: normalizeTags(view.tags),
    query_kind,
    query: normalizeQuery(query_kind, view.query),
    scope: normalizeScope(view.scope),
    default_columns: normalizeStringArray(
      view.default_columns,
      "view.default_columns",
    ),
    default_sort: normalizeSort(view.default_sort),
    default_limit: normalizeDefaultLimit(view.default_limit),
    visualization: normalizeVisualization(view.visualization),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function viewFromRow(row: AdminDataViewRow): AdminDataView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    visibility: "admin",
    query_kind: normalizeQueryKind(row.query_kind),
    query: row.query,
    scope: row.scope,
    default_columns: row.default_columns,
    default_sort: row.default_sort,
    default_limit: row.default_limit,
    visualization: normalizeVisualization(row.visualization),
    owner_account_id: row.owner_account_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    version: Number(row.version) || 1,
  };
}

function summarizeView(view: AdminDataView): AdminDataViewSummary {
  return {
    id: view.id,
    slug: view.slug,
    title: view.title,
    description: view.description,
    tags: view.tags,
    query_kind: view.query_kind,
    scope: view.scope,
    updated_at: view.updated_at,
    version: view.version,
  };
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function optionalQueryKind(value: unknown): AdminDataQueryKind | null {
  if (value === "structured" || value === "sql" || value === "dataset") {
    return value;
  }
  return null;
}

async function recordAudit({
  account_id,
  operation,
  view,
  details,
}: {
  account_id: string;
  operation: string;
  view?: Pick<AdminDataView, "id" | "slug" | "query_kind">;
  details?: Record<string, unknown>;
}) {
  try {
    await centralLog({
      event: "admin_data_explorer",
      value: {
        account_id,
        operation,
        bay_id: getConfiguredBayId(),
        view_id: view?.id,
        slug: view?.slug,
        query_kind: view?.query_kind,
        ...details,
      },
    });
  } catch (err) {
    logger.warn("failed to write Admin Data Explorer audit event", {
      operation,
      err: `${err}`,
    });
  }
}

async function loadViewByIdOrSlug({
  id,
  slug,
}: {
  id?: string;
  slug?: string;
}): Promise<AdminDataView | null> {
  await ensureSchema();
  if (!id && !slug) {
    throw Error("id or slug must be specified");
  }
  const where = id ? "id=$1" : "slug=$1";
  const value = id ?? normalizeSlug(slug);
  const { rows } = await getPool().query<AdminDataViewRow>(
    `SELECT * FROM ${TABLE} WHERE ${where} LIMIT 1`,
    [value],
  );
  return rows[0] ? viewFromRow(rows[0]) : null;
}

export async function listDatasets(
  opts: AdminAuthOpts = {},
): Promise<AdminDataDataset[]> {
  const account_id = await requireFreshAdmin(opts);
  await recordAudit({
    account_id,
    operation: "list_datasets",
    details: { count: DATASETS.length },
  });
  return DATASETS;
}

export async function listViews({
  tag,
  query_kind,
  ...opts
}: AdminAuthOpts & {
  tag?: string;
  query_kind?: AdminDataQueryKind;
} = {}): Promise<AdminDataViewSummary[]> {
  const account_id = await requireFreshAdmin(opts);
  await ensureSchema();
  const filters: string[] = [];
  const params: unknown[] = [];
  if (tag) {
    params.push(`${tag}`.trim().toLowerCase());
    filters.push(`$${params.length}=ANY(tags)`);
  }
  if (query_kind) {
    params.push(normalizeQueryKind(query_kind));
    filters.push(`query_kind=$${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { rows } = await getPool().query<AdminDataViewRow>(
    `SELECT * FROM ${TABLE} ${where} ORDER BY updated_at DESC, slug ASC`,
    params,
  );
  const views = rows.map(viewFromRow).map(summarizeView);
  await recordAudit({
    account_id,
    operation: "list_views",
    details: {
      count: views.length,
      tag: tag ?? null,
      query_kind: query_kind ?? null,
    },
  });
  return views;
}

export async function getView({
  id,
  slug,
  ...opts
}: AdminAuthOpts & {
  id?: string;
  slug?: string;
}): Promise<AdminDataView> {
  const account_id = await requireFreshAdmin(opts);
  const view = await loadViewByIdOrSlug({ id, slug });
  if (!view) {
    throw Error("view not found");
  }
  await recordAudit({ account_id, operation: "get_view", view });
  return view;
}

export async function saveView({
  view,
  ...opts
}: AdminAuthOpts & {
  view: AdminDataViewInput;
}): Promise<AdminDataView> {
  const account_id = await requireFreshAdmin(opts);
  await ensureSchema();
  const normalized = normalizeViewInput(view);
  const existingById = normalized.id
    ? await loadViewByIdOrSlug({ id: normalized.id })
    : null;
  const existingBySlug = await loadViewByIdOrSlug({ slug: normalized.slug });
  if (existingById && existingBySlug && existingById.id !== existingBySlug.id) {
    throw Error(
      `view id '${existingById.id}' and slug '${normalized.slug}' refer to different views`,
    );
  }
  const existing = existingById ?? existingBySlug;
  const id = existing?.id ?? normalized.id ?? uuid();
  const params = [
    id,
    normalized.slug,
    normalized.title,
    normalized.description,
    normalized.tags,
    normalized.query_kind,
    JSON.stringify(normalized.query),
    JSON.stringify(normalized.scope),
    normalized.default_columns,
    normalized.default_sort ? JSON.stringify(normalized.default_sort) : null,
    normalized.default_limit,
    normalized.visualization,
    account_id,
  ];
  const { rows } = existing
    ? await getPool().query<AdminDataViewRow>(
        `
        UPDATE ${TABLE}
        SET slug=$2,
            title=$3,
            description=$4,
            tags=$5,
            query_kind=$6,
            query=$7::jsonb,
            scope=$8::jsonb,
            default_columns=$9,
            default_sort=$10::jsonb,
            default_limit=$11,
            visualization=$12,
            updated_at=NOW(),
            version=version + 1
        WHERE id=$1
        RETURNING *
        `,
        params.slice(0, 12),
      )
    : await getPool().query<AdminDataViewRow>(
        `
        INSERT INTO ${TABLE}
          (id, slug, title, description, tags, visibility, query_kind, query,
           scope, default_columns, default_sort, default_limit, visualization,
           owner_account_id)
        VALUES
          ($1, $2, $3, $4, $5, 'admin', $6, $7::jsonb, $8::jsonb, $9,
           $10::jsonb, $11, $12, $13)
        RETURNING *
        `,
        params,
      );
  const saved = viewFromRow(rows[0]);
  await recordAudit({ account_id, operation: "save_view", view: saved });
  return saved;
}

export async function deleteView({
  id,
  slug,
  ...opts
}: AdminAuthOpts & {
  id?: string;
  slug?: string;
}): Promise<{ deleted: boolean; id?: string; slug?: string }> {
  const account_id = await requireFreshAdmin(opts);
  await ensureSchema();
  const existing = await loadViewByIdOrSlug({ id, slug });
  if (!existing) {
    return { deleted: false, id, slug };
  }
  await getPool().query(`DELETE FROM ${TABLE} WHERE id=$1`, [existing.id]);
  await recordAudit({
    account_id,
    operation: "delete_view",
    view: existing,
  });
  return { deleted: true, id: existing.id, slug: existing.slug };
}

export async function exportViews(
  opts: AdminAuthOpts = {},
): Promise<AdminDataViewExport> {
  const account_id = await requireFreshAdmin(opts);
  await ensureSchema();
  const { rows } = await getPool().query<AdminDataViewRow>(
    `SELECT * FROM ${TABLE} ORDER BY slug ASC`,
  );
  const exported = {
    schema_version: 1 as const,
    exported_at: new Date().toISOString(),
    views: rows.map(viewFromRow),
  };
  await recordAudit({
    account_id,
    operation: "export_views",
    details: { count: exported.views.length },
  });
  return exported;
}

function viewsFromImportInput(
  input: AdminDataViewInput[] | AdminDataViewExport,
): AdminDataViewInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (input?.schema_version !== 1 || !Array.isArray(input.views)) {
    throw Error("views import must be an array or schema_version=1 export");
  }
  return input.views;
}

export async function importViews({
  views,
  mode = "upsert",
  ...opts
}: AdminAuthOpts & {
  views: AdminDataViewInput[] | AdminDataViewExport;
  mode?: "upsert" | "create_only";
}): Promise<AdminDataViewImportResult> {
  const account_id = await requireFreshAdmin(opts);
  if (mode !== "upsert" && mode !== "create_only") {
    throw Error("mode must be 'upsert' or 'create_only'");
  }
  const inputs = viewsFromImportInput(views);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const saved: AdminDataViewSummary[] = [];
  for (const input of inputs) {
    const normalized = normalizeViewInput(input);
    const existing = await loadViewByIdOrSlug({ slug: normalized.slug });
    if (existing && mode === "create_only") {
      skipped += 1;
      continue;
    }
    const view = await saveView({
      account_id,
      session_hash: opts.session_hash,
      browser_id: opts.browser_id,
      view: normalized,
    });
    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
    saved.push(summarizeView(view));
  }
  await recordAudit({
    account_id,
    operation: "import_views",
    details: { created, updated, skipped, mode },
  });
  return { created, updated, skipped, views: saved };
}

type CentralLogRow = {
  id: string;
  time: Date | string;
  value: Record<string, unknown> | null;
};

export async function listAuditEvents({
  limit,
  ...opts
}: AdminAuthOpts & {
  limit?: number;
} = {}): Promise<AdminDataAuditEvent[]> {
  await requireFreshAdmin(opts);
  const normalizedLimit = normalizeAuditLimit(limit);
  const { rows } = await getPool().query<CentralLogRow>(
    `
      SELECT id, time, value
      FROM central_log
      WHERE event='admin_data_explorer'
      ORDER BY time DESC
      LIMIT $1
    `,
    [normalizedLimit],
  );
  return rows.map((row) => {
    const value = isObject(row.value) ? row.value : {};
    return {
      id: row.id,
      time: iso(row.time),
      account_id: optionalString(value.account_id, 80) ?? null,
      bay_id: optionalString(value.bay_id, 120) ?? null,
      operation: optionalString(value.operation, 120) ?? null,
      view_id: optionalString(value.view_id, 80) ?? null,
      slug: optionalString(value.slug, MAX_SLUG_LENGTH) ?? null,
      query_kind: optionalQueryKind(value.query_kind),
      row_count: optionalNumber(value.row_count),
      response_bytes: optionalNumber(value.response_bytes),
      duration_ms: optionalNumber(value.duration_ms),
      truncated: optionalBoolean(value.truncated),
      details: value,
    };
  });
}

export async function validateSql({
  sql,
  limit,
  ...opts
}: AdminAuthOpts & {
  sql: string;
  limit?: number;
}): Promise<AdminDataSqlValidationResult> {
  const account_id = await requireFreshAdmin(opts);
  const validation = validateSqlInternal({ sql, limit });
  await recordAudit({
    account_id,
    operation: "validate_sql",
    details: {
      ok: validation.ok,
      errors: validation.errors,
      relations: validation.relations,
      functions: validation.functions,
      enforced_limit: validation.enforced_limit,
    },
  });
  const { sanitized_sql: _sanitized, ...publicValidation } = validation;
  return publicValidation;
}

async function runReadOnlySql({
  sql,
  limit,
  timeout_ms,
}: {
  sql: string;
  limit: number;
  timeout_ms: number;
}): Promise<{
  executed_sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  duration_ms: number;
}> {
  const client: PoolClient = await getPool().connect();
  const executed_sql = `SELECT * FROM (${sql}) AS admin_data_explorer_query LIMIT ${
    limit + 1
  }`;
  const started = Date.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${timeout_ms}ms'`);
    await client.query("SET LOCAL search_path = public");
    const result = await client.query(executed_sql);
    await client.query("COMMIT");
    return {
      executed_sql,
      columns: result.fields.map((field) => field.name),
      rows: result.rows,
      duration_ms: Date.now() - started,
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

function truncateRowsToByteLimit({
  rows,
  max_bytes,
}: {
  rows: Record<string, unknown>[];
  max_bytes: number;
}): {
  rows: Record<string, unknown>[];
  response_bytes: number;
  truncated: boolean;
} {
  let output = rows;
  let encoded = JSON.stringify(output);
  let truncated = false;
  while (encoded.length > max_bytes && output.length > 0) {
    truncated = true;
    output = output.slice(0, -1);
    encoded = JSON.stringify(output);
  }
  return {
    rows: output,
    response_bytes: Buffer.byteLength(encoded, "utf8"),
    truncated,
  };
}

export async function runSql({
  sql,
  limit,
  timeout_ms,
  max_bytes,
  ...opts
}: AdminAuthOpts & {
  sql: string;
  limit?: number;
  timeout_ms?: number;
  max_bytes?: number;
}): Promise<AdminDataSqlRunResult> {
  const account_id = await requireFreshAdmin(opts);
  return await runSqlWithAudit({
    account_id,
    sql,
    limit,
    timeout_ms,
    max_bytes,
    operation: "run_sql",
    denied_operation: "run_sql_denied",
  });
}

async function runSqlWithAudit({
  account_id,
  sql,
  limit,
  timeout_ms,
  max_bytes,
  operation,
  denied_operation,
  view,
}: {
  account_id: string;
  sql: string;
  limit?: number;
  timeout_ms?: number;
  max_bytes?: number;
  operation: string;
  denied_operation: string;
  view?: Pick<AdminDataView, "id" | "slug" | "query_kind">;
}): Promise<AdminDataSqlRunResult> {
  const validation = validateSqlInternal({ sql, limit });
  const { sanitized_sql, ...publicValidation } = validation;
  if (!validation.ok || !sanitized_sql) {
    await recordAudit({
      account_id,
      operation: denied_operation,
      view,
      details: {
        errors: validation.errors,
        relations: validation.relations,
        functions: validation.functions,
      },
    });
    throw Object.assign(
      new Error(`SQL validation failed: ${validation.errors.join("; ")}`),
      {
        code: "admin_data_sql_validation_failed",
        validation: publicValidation,
      },
    );
  }
  const enforcedLimit = validation.enforced_limit;
  const timeoutMs = normalizeSqlTimeoutMs(timeout_ms);
  const maxBytes = normalizeSqlMaxBytes(max_bytes);
  const result = await runReadOnlySql({
    sql: sanitized_sql,
    limit: enforcedLimit,
    timeout_ms: timeoutMs,
  });
  const overLimit = result.rows.length > enforcedLimit;
  const limitedRows = overLimit
    ? result.rows.slice(0, enforcedLimit)
    : result.rows;
  const truncated = truncateRowsToByteLimit({
    rows: limitedRows,
    max_bytes: maxBytes,
  });
  const runResult: AdminDataSqlRunResult = {
    validation: publicValidation,
    executed_sql: result.executed_sql,
    columns: result.columns,
    rows: truncated.rows,
    row_count: truncated.rows.length,
    duration_ms: result.duration_ms,
    response_bytes: truncated.response_bytes,
    truncated: overLimit || truncated.truncated,
  };
  await recordAudit({
    account_id,
    operation,
    view,
    details: {
      relations: validation.relations,
      functions: validation.functions,
      row_count: runResult.row_count,
      response_bytes: runResult.response_bytes,
      duration_ms: runResult.duration_ms,
      truncated: runResult.truncated,
    },
  });
  return runResult;
}

function sqlFromView(view: AdminDataView): string {
  if (view.query_kind !== "sql") {
    throw Error(
      `only sql views can be run in this milestone, not ${view.query_kind}`,
    );
  }
  const sql = (view.query as { sql?: unknown }).sql;
  if (typeof sql !== "string" || !sql.trim()) {
    throw Error("view.query.sql must be a non-empty string");
  }
  return sql;
}

export async function runView({
  id,
  slug,
  limit,
  timeout_ms,
  max_bytes,
  ...opts
}: AdminAuthOpts & {
  id?: string;
  slug?: string;
  limit?: number;
  timeout_ms?: number;
  max_bytes?: number;
}): Promise<AdminDataViewRunResult> {
  const account_id = await requireFreshAdmin(opts);
  const view = await loadViewByIdOrSlug({ id, slug });
  if (!view) {
    throw Error("view not found");
  }
  const sql = sqlFromView(view);
  const result = await runSqlWithAudit({
    account_id,
    sql,
    limit: limit ?? view.default_limit ?? undefined,
    timeout_ms,
    max_bytes,
    operation: "run_view",
    denied_operation: "run_view_denied",
    view,
  });
  return {
    view: summarizeView(view),
    result,
  };
}
