/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectSubject } from "@cocalc/conat/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";

export interface ProjectStorageBreakdown {
  path: string;
  bytes: number;
  children: { bytes: number; path: string }[];
  collected_at: string;
  estimated?: boolean;
  stale?: boolean;
  scan_status?: "running" | "budget_exhausted" | "failed";
  warning?: string;
}

export interface ProjectStorageQuotaSummary {
  key: "project";
  label: string;
  // (as in ProjectDiskQuota)
  used: number;
  size: number;
  files_used?: number;
  history_used?: number;
  history_reserve?: number;
  qgroupid?: string;
  scope?: "subvolume";
  warning?: string;
}

export interface ProjectStorageVisibleSummary {
  key: "home" | "environment";
  label: string;
  summaryLabel: string;
  path: string;
  summaryBytes: number;
  usage: ProjectStorageBreakdown;
  estimated?: boolean;
  stale?: boolean;
  scan_status?: "running" | "budget_exhausted" | "failed";
  warning?: string;
}

export interface ProjectStorageLiveSummary {
  key: "live";
  label: string;
  bytes: number;
  path: string;
}

export interface ProjectStorageRetainedSummary {
  key: "retained";
  label: string;
  bytes: number;
  detail?: string;
  // Number of entries in the project's .snapshots directory, when it could be
  // determined.  undefined means "unknown" and must never be treated as 0:
  // consumers only get to say the retained bytes are not snapshot-related when
  // this is explicitly 0.
  snapshotCount?: number;
}

export interface ProjectStorageSharedScratchSummary {
  key: "shared_scratch";
  label: string;
  path: "/scratch";
  used: number;
  size: number;
  free: number;
  available: number;
  collected_at: string;
  warning?: string;
}

export interface ProjectStorageOverview {
  collected_at: string;
  refresh?: ProjectStorageOverviewRefresh;
  quotas: ProjectStorageQuotaSummary[];
  live: ProjectStorageLiveSummary;
  retained: ProjectStorageRetainedSummary;
  shared_scratch?: ProjectStorageSharedScratchSummary;
  visible: ProjectStorageVisibleSummary[];
}

export interface ProjectStorageOverviewRefresh {
  status: "sampled" | "cached" | "rate_limited" | "inflight";
  requested_at: string;
  next_allowed_at?: string;
}

export interface ProjectStorageHistoryPoint {
  collected_at: string;
  quota_used_bytes?: number;
  quota_size_bytes?: number;
  quota_used_percent?: number;
  live_bytes?: number;
  retained_bytes?: number;
  home_visible_bytes?: number;
  environment_visible_bytes?: number;
}

export interface ProjectStorageHistoryGrowth {
  window_minutes: number;
  quota_used_bytes_per_hour?: number;
}

export interface ProjectStorageHistory {
  window_minutes: number;
  point_count: number;
  points: ProjectStorageHistoryPoint[];
  growth?: ProjectStorageHistoryGrowth;
}

export interface ProjectDiskQuota {
  // the project's files and edit history together, split as well as btrfs
  // can tell below
  used: number;
  size: number;
  files_used?: number;
  history_used?: number;
  // what the history may use beyond `size`
  history_reserve?: number;
  qgroupid?: string;
  scope?: "subvolume";
  warning?: string;
}

const SERVICE_NAME = "storage-info";

interface Api {
  getQuota: () => Promise<ProjectDiskQuota>;
  getOverview: (opts?: {
    home?: string;
    force_sample?: boolean;
  }) => Promise<ProjectStorageOverview>;
  getSnapshotUsage: () => Promise<SnapshotUsage[]>;
  getBreakdown: (opts: { path: string }) => Promise<ProjectStorageBreakdown>;
  getHistory: (opts?: {
    window_minutes?: number;
    max_points?: number;
  }) => Promise<ProjectStorageHistory>;
}

function requireExplicitConatClient(client?: ConatClient): ConatClient {
  if (client != null) {
    return client;
  }
  throw new Error("must provide an explicit Conat client");
}

export function getSubject({ project_id }: { project_id: string }): string {
  return projectSubject({
    project_id,
    service: SERVICE_NAME,
  });
}

export async function getDiskQuota({
  client,
  project_id,
}: {
  client?: ConatClient;
  project_id: string;
}): Promise<ProjectDiskQuota> {
  const subject = getSubject({ project_id });
  return await requireExplicitConatClient(client).call<Api>(subject).getQuota();
}

export async function getStorageOverview({
  client,
  project_id,
  home,
  force_sample,
}: {
  client?: ConatClient;
  project_id: string;
  home?: string;
  force_sample?: boolean;
}): Promise<ProjectStorageOverview> {
  const subject = getSubject({ project_id });
  return await requireExplicitConatClient(client)
    .call<Api>(subject)
    .getOverview({ home, force_sample });
}

export async function getSnapshotUsage({
  client,
  project_id,
}: {
  client?: ConatClient;
  project_id: string;
}): Promise<SnapshotUsage[]> {
  const subject = getSubject({ project_id });
  return await requireExplicitConatClient(client)
    .call<Api>(subject)
    .getSnapshotUsage();
}

export async function getStorageBreakdown({
  client,
  project_id,
  path,
}: {
  client?: ConatClient;
  project_id: string;
  path: string;
}): Promise<ProjectStorageBreakdown> {
  const subject = getSubject({ project_id });
  return await requireExplicitConatClient(client)
    .call<Api>(subject)
    .getBreakdown({ path });
}

export async function getStorageHistory({
  client,
  project_id,
  window_minutes,
  max_points,
}: {
  client?: ConatClient;
  project_id: string;
  window_minutes?: number;
  max_points?: number;
}): Promise<ProjectStorageHistory> {
  const subject = getSubject({ project_id });
  return await requireExplicitConatClient(client)
    .call<Api>(subject)
    .getHistory({ window_minutes, max_points });
}
