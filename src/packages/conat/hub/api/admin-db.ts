/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";

export type AdminDbDiagnostic =
  | "activity"
  | "locks"
  | "table-sizes"
  | "lro"
  | "backup-health"
  | "host-health"
  | "project"
  | "project-recovery"
  | "project-restore-drills"
  | "migration-health";

export interface AdminDbField {
  name: string;
  data_type_id?: number;
}

export interface AdminDbExecuteRequest {
  bay_id?: string;
  host_id?: string;
  mode?: "query" | "diagnostic" | "write" | "host-query";
  sql?: string;
  diagnostic?: AdminDbDiagnostic;
  params?: Record<string, unknown>;
  reason?: string;
  write?: boolean;
  commit?: boolean;
  limit?: number;
  max_bytes?: number;
  statement_timeout_ms?: number;
  lock_timeout_ms?: number;
}

export interface AdminDbExecuteResponse {
  audit_id: string;
  bay_id: string;
  host_id?: string;
  server_time: string;
  mode: "query" | "diagnostic" | "write" | "host-query";
  diagnostic?: AdminDbDiagnostic;
  committed?: boolean;
  duration_ms: number;
  fields: AdminDbField[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  result_bytes: number;
  executed_sql?: string;
}

export interface AdminDbRestoreDrillAttestationRequest {
  bay_id?: string;
  op_id: string;
  expected_sha256: string;
  observed_sha256: string;
  reason: string;
}

export interface AdminDbRestoreDrillAttestationResponse {
  audit_id: string;
  bay_id: string;
  op_id: string;
  project_id: string;
  backup_id: string;
  passed: boolean;
  created: boolean;
  recorded_at: string;
  evidence_source: "operator_supplied";
}

export const adminDb = {
  attestProjectRestoreDrill: authFirstRequireAccount,
  query: authFirstRequireAccount,
  diagnostic: authFirstRequireAccount,
  exec: authFirstRequireAccount,
  queryHost: authFirstRequireAccount,
};

export interface AdminDbApi {
  attestProjectRestoreDrill: (
    opts: AdminDbRestoreDrillAttestationRequest,
  ) => Promise<AdminDbRestoreDrillAttestationResponse>;
  query: (opts: AdminDbExecuteRequest) => Promise<AdminDbExecuteResponse>;
  diagnostic: (opts: AdminDbExecuteRequest) => Promise<AdminDbExecuteResponse>;
  exec: (opts: AdminDbExecuteRequest) => Promise<AdminDbExecuteResponse>;
  queryHost: (opts: AdminDbExecuteRequest) => Promise<AdminDbExecuteResponse>;
}
