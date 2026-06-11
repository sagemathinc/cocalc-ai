/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { uuid } from "@cocalc/util/misc";
import type {
  AdminDataDataset,
  AdminDataQuery,
  AdminDataQueryKind,
  AdminDataScope,
  AdminDataSort,
  AdminDataView,
  AdminDataViewExport,
  AdminDataViewImportResult,
  AdminDataViewInput,
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
const TABLE = "admin_data_explorer_views";

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
      { name: "host_id", type: "uuid", filterable: true, sortable: true },
      { name: "name", type: "string", filterable: true, sortable: true },
      { name: "bay_id", type: "string", filterable: true, sortable: true },
      { name: "state", type: "string", filterable: true },
      { name: "provider", type: "string", filterable: true },
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
