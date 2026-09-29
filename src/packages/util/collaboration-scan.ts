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

/** Discovery completion is not owner ingestion or account projection completion. */
export type ScanDiscoveryStatus =
  | { state: "unknown" }
  | { state: "queued" }
  | {
      state: "running";
      started_at: number;
      deferred?: { reason: ScanDeferralReason; retry_after_ms: number };
    }
  | { state: "discovered" | "failed"; settled_at: number };

export type ScanDeferralReason =
  | "host_busy"
  | "report_pending"
  | "host_throttled"
  | "host_deferred";

export type ScanInspectionRequest = Omit<ScanAdmissionRequest, "mode">;
export interface ScanStatusRequest {
  project_id: string;
  account_id: string;
  job_id: string;
}
export type ScanReadResult<T> =
  | { allowed: true; value: T; poll_after_ms: number }
  | { allowed: false; retry_after_ms: number };
