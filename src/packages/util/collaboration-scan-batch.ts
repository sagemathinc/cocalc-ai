/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
export const SCAN_BATCH_KIND = "people-project-scan";
export const SCAN_ACCOUNT_INTERVAL_MS = 60_000;
export const SCAN_PROJECT_INTERVAL_MS = 300_000;
export const SCAN_PAGE_SIZE = 25;
export type ScanChildState =
  | "queued"
  | "running"
  | "cancelling"
  | "successful"
  | "failed"
  | "unavailable"
  | "truncated"
  | "cancelled"
  | "deferred";
export const scanChildTerminal = (state: ScanChildState) =>
  !["queued", "running", "cancelling"].includes(state);
export interface ScanChild {
  project_id: string;
  request_id: string;
  state: ScanChildState;
  entries?: number;
  candidates?: number;
  message?: string;
  next_eligible_at?: number;
}
export type ScanProjectsRequest = { account_id?: string } & (
  | { action: "projects"; search?: string; after?: string }
  | { action: "start"; request_id: string; project_ids: string[] | "all" }
  | { action: "status"; op_id?: string; after?: string }
  | { action: "cancel"; op_id: string }
);
export interface ScanBatchSummary {
  op_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  cancelling: boolean;
  total: number;
  processed: number;
  counts: Partial<Record<ScanChildState, number>>;
  next_eligible_at: number;
  children: ScanChild[];
  next?: string;
}
export interface ScanProjectsResponse {
  enabled: boolean;
  next_eligible_at?: number;
  operation?: ScanBatchSummary;
  projects?: { project_id: string; title: string }[];
  next?: string;
  total?: number;
}
/** Trusted home-to-owner operation. The child identity is persisted before RPC. */
export interface ScanChildRequest {
  project_id: string;
  account_id: string;
  request_id: string;
  batch_id: string;
  action: "inspect" | "start" | "cancel";
}
