/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT = 100;
export const ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT = 5_000;
export const ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS = 5_000;
export const ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS = 30_000;
export const ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const ADMIN_DATA_EXPLORER_SQL_MAX_BYTES = 32 * 1024 * 1024;

export const ADMIN_DATA_EXPLORER_ALLOWED_SQL_RELATIONS = [
  "account_cpu_usage_events",
  "account_managed_egress_events",
  "account_security_state",
  "account_usage_windows",
  "accounts",
  "admin_data_explorer_views",
  "ai_usage_log",
  "central_log",
  "launch_smoke_results",
  "project_hosts",
  "project_runtime_slots",
  "projects",
  "purchases",
  "statements",
  "usage_info",
  "ux_latency_events",
  "voucher_codes",
  "vouchers",
] as const;

export const ADMIN_DATA_EXPLORER_ALLOWED_SQL_FUNCTIONS = [
  "abs",
  "avg",
  "ceil",
  "coalesce",
  "count",
  "date_trunc",
  "floor",
  "greatest",
  "jsonb_array_length",
  "jsonb_extract_path_text",
  "least",
  "left",
  "length",
  "lower",
  "max",
  "min",
  "now",
  "right",
  "round",
  "split_part",
  "substring",
  "sum",
  "to_char",
  "upper",
] as const;

export type AdminDataExplorerAllowedSqlRelation =
  (typeof ADMIN_DATA_EXPLORER_ALLOWED_SQL_RELATIONS)[number];

export type AdminDataExplorerAllowedSqlFunction =
  (typeof ADMIN_DATA_EXPLORER_ALLOWED_SQL_FUNCTIONS)[number];

export const ADMIN_DATA_EXPLORER_SQL_CONSTRAINTS = {
  default_limit: ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
  max_limit: ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
  default_timeout_ms: ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS,
  max_timeout_ms: ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS,
  default_max_bytes: ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES,
  max_bytes: ADMIN_DATA_EXPLORER_SQL_MAX_BYTES,
  allowed_relations: ADMIN_DATA_EXPLORER_ALLOWED_SQL_RELATIONS,
  allowed_functions: ADMIN_DATA_EXPLORER_ALLOWED_SQL_FUNCTIONS,
} as const;
