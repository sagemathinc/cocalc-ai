/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectSubject } from "@cocalc/conat/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";

export interface ProjectStorageBreakdown {
  path: string;
  bytes: number;
  children: { bytes: number; path: string }[];
  collected_at: string;
}

export interface ProjectStorageQuotaSummary {
  key: "project";
  label: string;
  used: number;
  size: number;
  qgroupid?: string;
  scope?: "tracking" | "subvolume";
  warning?: string;
}

export interface ProjectStorageVisibleSummary {
  key: "home" | "scratch" | "environment";
  label: string;
  summaryLabel: string;
  path: string;
  summaryBytes: number;
  usage: ProjectStorageBreakdown;
}

export interface ProjectStorageCountedSummary {
  key: "snapshots";
  label: string;
  bytes: number;
  detail?: string;
  compactLabel?: string;
}

export interface ProjectStorageOverview {
  collected_at: string;
  quotas: ProjectStorageQuotaSummary[];
  visible: ProjectStorageVisibleSummary[];
  counted: ProjectStorageCountedSummary[];
}

export interface ProjectStorageHistoryPoint {
  collected_at: string;
  quota_used_bytes?: number;
  quota_size_bytes?: number;
  quota_used_percent?: number;
  home_visible_bytes?: number;
  scratch_visible_bytes?: number;
  environment_visible_bytes?: number;
  snapshot_counted_bytes?: number;
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

const SERVICE_NAME = "storage-info";

interface Api {
  getOverview: (opts?: {
    home?: string;
    force_sample?: boolean;
  }) => Promise<ProjectStorageOverview>;
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
