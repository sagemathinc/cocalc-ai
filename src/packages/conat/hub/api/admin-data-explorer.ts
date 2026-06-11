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
}
