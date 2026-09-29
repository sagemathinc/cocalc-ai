/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/** Internal trusted-service input, never a caller-provided account identity. */
export interface ScanAdmissionRequest {
  project_id: string;
  account_id: string;
  request_id: string;
  mode: "check" | "reconcile";
}
export interface ScanReceipt {
  job_id: string;
  admission: "accepted" | "coalesced";
  expires_at: number;
}
export type ScanAdmissionResult =
  | ScanReceipt
  | { admission: "throttled"; retry_after_ms: number };
