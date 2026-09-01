/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";
import type {
  HostAbuseFilesystemSnapshotResponse,
  HostAbuseProcessSnapshotResponse,
  HostFilesystemSnapshotResponse,
  HostIntrusionSnapshotResponse,
  HostNetworkSnapshotResponse,
  HostPodmanSnapshotResponse,
  HostProcessSnapshotResponse,
  HostRuntimeLogSource,
} from "@cocalc/conat/project-host/api";

export interface AdminHostLogsRequest {
  host_id: string;
  source?: HostRuntimeLogSource;
  lines?: number;
  grep?: string;
  max_bytes?: number;
  reason?: string;
}

export interface AdminHostLogsResponse {
  audit_id: string;
  host_id: string;
  source: string;
  requested_source?: HostRuntimeLogSource;
  server_time: string;
  lines: number;
  text: string;
  result_bytes: number;
  truncated: boolean;
}

export interface AdminHostDescribeRequest {
  host?: string;
  host_id?: string;
  recent_limit?: number;
  include_live?: boolean;
  reason?: string;
}

export interface AdminHostEvent {
  timestamp: string;
  category:
    | "availability"
    | "lro"
    | "heartbeat"
    | "host-record"
    | "operator_action";
  summary: string;
  details?: Record<string, unknown>;
}

export interface AdminHostDescribeResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  host: Record<string, unknown>;
  heartbeat_age_ms?: number;
  project_counts: Record<string, number>;
  recent_lros: Record<string, unknown>[];
  availability_events: Record<string, unknown>[];
  host_agent_status?: Record<string, unknown>;
  managed_components?: Record<string, unknown>[];
  live_errors?: string[];
}

export interface AdminHostEventsRequest {
  host?: string;
  host_id?: string;
  since_minutes?: number;
  limit?: number;
  reason?: string;
}

export interface AdminHostEventsResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  events: AdminHostEvent[];
  truncated: boolean;
}

export interface AdminHostTopRequest {
  host?: string;
  host_id?: string;
  window_minutes?: number;
  max_points?: number;
  reason?: string;
}

export interface AdminHostTopResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  window_minutes: number;
  point_count: number;
  current?: Record<string, unknown>;
  derived?: Record<string, unknown>;
  growth?: Record<string, unknown>;
  points?: Record<string, unknown>[];
}

export interface AdminHostProcessRequest {
  host?: string;
  host_id?: string;
  limit?: number;
  sort?: "rss" | "cpu";
  reason?: string;
}

export interface AdminHostProcessResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostProcessSnapshotResponse;
}

export interface AdminHostAbuseProcessesRequest {
  host?: string;
  host_id?: string;
  max_projects?: number;
  max_processes?: number;
  timeout_ms?: number;
  reason?: string;
}

export interface AdminHostAbuseProcessesResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostAbuseProcessSnapshotResponse;
}

export interface AdminHostAbuseFilesystemsRequest {
  host?: string;
  host_id?: string;
  max_projects?: number;
  max_entries_per_project?: number;
  max_total_entries?: number;
  max_depth?: number;
  timeout_ms?: number;
  reason?: string;
}

export interface AdminHostAbuseFilesystemsResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostAbuseFilesystemSnapshotResponse;
}

export interface AdminHostNetworkRequest {
  host?: string;
  host_id?: string;
  limit?: number;
  reason?: string;
}

export interface AdminHostNetworkResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostNetworkSnapshotResponse;
}

export interface AdminHostFilesystemRequest {
  host?: string;
  host_id?: string;
  reason?: string;
}

export interface AdminHostFilesystemResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostFilesystemSnapshotResponse;
}

export interface AdminHostIntrusionSnapshotRequest {
  host?: string;
  host_id?: string;
  reason?: string;
}

export interface AdminHostIntrusionSnapshotResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostIntrusionSnapshotResponse;
}

export interface AdminHostPodmanRequest {
  host?: string;
  host_id?: string;
  limit?: number;
  reason?: string;
}

export interface AdminHostPodmanResponse {
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: HostPodmanSnapshotResponse;
}

export const adminHost = {
  scanAbuseFilesystems: authFirstRequireAccount,
  scanAbuseProcesses: authFirstRequireAccount,
  describe: authFirstRequireAccount,
  events: authFirstRequireAccount,
  filesystem: authFirstRequireAccount,
  intrusionSnapshot: authFirstRequireAccount,
  logs: authFirstRequireAccount,
  net: authFirstRequireAccount,
  podman: authFirstRequireAccount,
  ps: authFirstRequireAccount,
  top: authFirstRequireAccount,
};

export interface AdminHostApi {
  scanAbuseFilesystems: (
    opts: AdminHostAbuseFilesystemsRequest,
  ) => Promise<AdminHostAbuseFilesystemsResponse>;
  scanAbuseProcesses: (
    opts: AdminHostAbuseProcessesRequest,
  ) => Promise<AdminHostAbuseProcessesResponse>;
  describe: (
    opts: AdminHostDescribeRequest,
  ) => Promise<AdminHostDescribeResponse>;
  events: (opts: AdminHostEventsRequest) => Promise<AdminHostEventsResponse>;
  filesystem: (
    opts: AdminHostFilesystemRequest,
  ) => Promise<AdminHostFilesystemResponse>;
  intrusionSnapshot: (
    opts: AdminHostIntrusionSnapshotRequest,
  ) => Promise<AdminHostIntrusionSnapshotResponse>;
  logs: (opts: AdminHostLogsRequest) => Promise<AdminHostLogsResponse>;
  net: (opts: AdminHostNetworkRequest) => Promise<AdminHostNetworkResponse>;
  podman: (opts: AdminHostPodmanRequest) => Promise<AdminHostPodmanResponse>;
  ps: (opts: AdminHostProcessRequest) => Promise<AdminHostProcessResponse>;
  top: (opts: AdminHostTopRequest) => Promise<AdminHostTopResponse>;
}
