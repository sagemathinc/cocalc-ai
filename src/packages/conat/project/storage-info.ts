/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectSubject } from "@cocalc/conat/names";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  ProjectStorageBreakdown,
  ProjectStorageHistory,
  ProjectStorageOverview,
} from "@cocalc/conat/hub/api/projects";
export type {
  ProjectStorageBreakdown,
  ProjectStorageCountedSummary,
  ProjectStorageHistory,
  ProjectStorageHistoryGrowth,
  ProjectStorageHistoryPoint,
  ProjectStorageOverview,
  ProjectStorageQuotaSummary,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/hub/api/projects";

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
