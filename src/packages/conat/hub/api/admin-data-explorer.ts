/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";

export const adminData = {
  listDatasets: authFirstRequireAccount,
  listViews: authFirstRequireAccount,
  getView: authFirstRequireAccount,
  saveView: authFirstRequireAccount,
  deleteView: authFirstRequireAccount,
  exportViews: authFirstRequireAccount,
  importViews: authFirstRequireAccount,
  listAuditEvents: authFirstRequireAccount,
  runView: authFirstRequireAccount,
  validateSql: authFirstRequireAccount,
  runSql: authFirstRequireAccount,
};

export type AdminDataViewVisibility = "admin";
export type AdminDataQueryKind = "structured" | "sql" | "dataset";
export type AdminDataVisualization =
  | "table"
  | "chart"
  | "retention"
  | "summary";

export type AdminDataScopeKind =
  | "local"
  | "all_bays"
  | "bay"
  | "host"
  | "project"
  | "account";

export interface AdminDataScope {
  kind: AdminDataScopeKind;
  bay_id?: string;
  host_id?: string;
  project_id?: string;
  account_id?: string;
}

export type AdminDataSortDirection = "asc" | "desc";

export interface AdminDataSort {
  field: string;
  direction: AdminDataSortDirection;
}

export interface StructuredQuery {
  dataset: string;
  filter?: Record<string, unknown>;
}

export interface SqlQuery {
  sql: string;
  parameters?: unknown[];
}

export interface DatasetQuery {
  dataset: string;
  parameters?: Record<string, unknown>;
}

export type AdminDataQuery = StructuredQuery | SqlQuery | DatasetQuery;

export interface AdminDataView {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  tags: string[];
  visibility: AdminDataViewVisibility;
  query_kind: AdminDataQueryKind;
  query: AdminDataQuery;
  scope: AdminDataScope;
  default_columns?: string[] | null;
  default_sort?: AdminDataSort[] | null;
  default_limit?: number | null;
  visualization?: AdminDataVisualization | null;
  owner_account_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export type AdminDataViewInput = Partial<
  Omit<
    AdminDataView,
    "visibility" | "owner_account_id" | "created_at" | "updated_at" | "version"
  >
> & {
  slug: string;
  title: string;
  query_kind: AdminDataQueryKind;
  query: AdminDataQuery;
};

export type AdminDataViewSummary = Pick<
  AdminDataView,
  | "id"
  | "slug"
  | "title"
  | "description"
  | "tags"
  | "query_kind"
  | "scope"
  | "updated_at"
  | "version"
>;

export interface AdminDataDatasetField {
  name: string;
  type: string;
  description?: string;
  filterable?: boolean;
  sortable?: boolean;
}

export interface AdminDataDataset {
  id: string;
  title: string;
  description: string;
  source: "postgres" | "control-plane" | "project-host";
  scope_kinds: AdminDataScopeKind[];
  default_limit: number;
  max_limit: number;
  fields: AdminDataDatasetField[];
}

export interface AdminDataViewExport {
  schema_version: 1;
  exported_at: string;
  views: AdminDataView[];
}

export interface AdminDataViewImportResult {
  created: number;
  updated: number;
  skipped: number;
  views: AdminDataViewSummary[];
}

export const ADMIN_DATA_EXPLORER_STARTER_VIEWS = [
  {
    slug: "recent-accounts",
    title: "Recent Accounts",
    description: "Newest account records for launch and support triage.",
    tags: ["accounts", "support", "launch"],
    query_kind: "sql",
    query: {
      sql: `select account_id, email_address, created, last_active
from accounts
order by created desc
limit 100`,
    },
    scope: { kind: "local" },
    default_limit: 100,
    visualization: "table",
  },
  {
    slug: "recent-projects",
    title: "Recent Projects",
    description: "Newest project records and current placement metadata.",
    tags: ["projects", "placement", "launch"],
    query_kind: "sql",
    query: {
      sql: `select project_id, title, host_id, owning_bay_id, created
from projects
order by created desc
limit 100`,
    },
    scope: { kind: "local" },
    default_limit: 100,
    visualization: "table",
  },
  {
    slug: "project-host-inventory",
    title: "Project Host Inventory",
    description: "Project host placement, provider, and rollout state.",
    tags: ["hosts", "project-hosts", "operations"],
    query_kind: "sql",
    query: {
      sql: `select id as host_id, name, bay_id, status, region, last_seen, version, updated
from project_hosts
order by updated desc
limit 100`,
    },
    scope: { kind: "local" },
    default_limit: 100,
    visualization: "table",
  },
  {
    slug: "slow-launch-events",
    title: "Slow Launch Events",
    description: "Recent high-latency UX launch observations.",
    tags: ["latency", "launch", "ux"],
    query_kind: "sql",
    query: {
      sql: `select event_type, metric, duration_ms, project_id, host_id, bay_id, started_at
from ux_latency_events
where duration_ms is not null
order by duration_ms desc, started_at desc
limit 100`,
    },
    scope: { kind: "local" },
    default_limit: 100,
    visualization: "table",
  },
] satisfies readonly AdminDataViewInput[];

export interface AdminDataSqlValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  relations: string[];
  functions: string[];
  normalized_sql?: string;
  enforced_limit: number;
}

export interface AdminDataSqlRunResult {
  validation: AdminDataSqlValidationResult;
  executed_sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  duration_ms: number;
  response_bytes: number;
  truncated: boolean;
}

export interface AdminDataViewRunResult {
  view: AdminDataViewSummary;
  result: AdminDataSqlRunResult;
}

export interface AdminDataAuditEvent {
  id: string;
  time: string;
  account_id?: string | null;
  bay_id?: string | null;
  operation?: string | null;
  view_id?: string | null;
  slug?: string | null;
  query_kind?: AdminDataQueryKind | null;
  row_count?: number | null;
  response_bytes?: number | null;
  duration_ms?: number | null;
  truncated?: boolean | null;
  details: Record<string, unknown>;
}

export interface AdminData {
  listDatasets(opts?: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  }): Promise<AdminDataDataset[]>;

  listViews(opts?: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    tag?: string;
    query_kind?: AdminDataQueryKind;
  }): Promise<AdminDataViewSummary[]>;

  getView(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    id?: string;
    slug?: string;
  }): Promise<AdminDataView>;

  saveView(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    view: AdminDataViewInput;
  }): Promise<AdminDataView>;

  deleteView(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    id?: string;
    slug?: string;
  }): Promise<{ deleted: boolean; id?: string; slug?: string }>;

  exportViews(opts?: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  }): Promise<AdminDataViewExport>;

  importViews(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    views: AdminDataViewInput[] | AdminDataViewExport;
    mode?: "upsert" | "create_only";
  }): Promise<AdminDataViewImportResult>;

  listAuditEvents(opts?: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    limit?: number;
  }): Promise<AdminDataAuditEvent[]>;

  runView(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    id?: string;
    slug?: string;
    limit?: number;
    timeout_ms?: number;
    max_bytes?: number;
  }): Promise<AdminDataViewRunResult>;

  validateSql(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    sql: string;
    limit?: number;
  }): Promise<AdminDataSqlValidationResult>;

  runSql(opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    sql: string;
    limit?: number;
    timeout_ms?: number;
    max_bytes?: number;
  }): Promise<AdminDataSqlRunResult>;
}
