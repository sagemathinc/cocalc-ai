/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Map as ImmutableMap } from "immutable";
import { listRecent } from "@cocalc/conat/project/document-activity";
import { MAX_FILENAME_SEARCH_RESULTS } from "@cocalc/util/db-schema/projects";
import type { RecentDocumentActivityEntry } from "./types";
import { webapp_client } from "../webapp-client";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_RECENT_PROJECTS = 50;
const DEFAULT_FILENAME_SEARCH_PROJECTS = 100;
const DEFAULT_RECENT_ROWS_PER_PROJECT = 25;
const MAX_RECENT_ROWS_TOTAL = 250;
const DOCUMENT_ACTIVITY_TTL_S = 90 * 24 * 60 * 60;
const DEFAULT_FIRST_WAVE_PROJECTS = 12;
const DEFAULT_FIRST_WAVE_TIMEOUT_MS = 1500;

type ProjectMap = ImmutableMap<string, any> | undefined;

export interface FilenameSearchRow {
  project_id: string;
  filename: string;
  time: Date;
}

export interface RecentDocumentActivityStageUpdate {
  rows: RecentDocumentActivityEntry[];
  complete: boolean;
}

function makeId(project_id: string, path: string): string {
  return `${project_id}\u0000${path}`;
}

function rankRecentProjectIds(
  project_map: ProjectMap,
  maxProjects: number,
): string[] {
  if (!project_map) {
    return [];
  }
  return project_map
    .keySeq()
    .toArray()
    .filter(
      (project_id) =>
        !project_map.getIn([project_id, "deleted"]) &&
        !!project_map.getIn([project_id, "host_id"]),
    )
    .sort((left, right) => {
      const a = Number(project_map.getIn([left, "last_edited"]) ?? 0);
      const b = Number(project_map.getIn([right, "last_edited"]) ?? 0);
      if (b !== a) {
        return b - a;
      }
      return `${left}`.localeCompare(`${right}`);
    })
    .slice(0, maxProjects);
}

export function parseIntervalToSeconds(interval?: string): number {
  const input = `${interval ?? ""}`.trim();
  if (!input) {
    return 24 * 60 * 60;
  }
  const m = input.match(
    /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?$/i,
  );
  if (!m) {
    return 24 * 60 * 60;
  }
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 24 * 60 * 60;
  }
  const unit = m[2].toLowerCase();
  const secondsPerUnit: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 60 * 60,
    day: 24 * 60 * 60,
    week: 7 * 24 * 60 * 60,
    month: 30 * 24 * 60 * 60,
    year: 365 * 24 * 60 * 60,
  };
  return Math.min(
    DOCUMENT_ACTIVITY_TTL_S,
    Math.max(60, Math.floor(amount * (secondsPerUnit[unit] ?? 24 * 60 * 60))),
  );
}

function finalizeRows(
  rows: RecentDocumentActivityEntry[],
  totalLimit: number,
): RecentDocumentActivityEntry[] {
  const sorted = [...rows];
  sorted.sort((left, right) => {
    const a = left.last_accessed?.valueOf() ?? 0;
    const b = right.last_accessed?.valueOf() ?? 0;
    if (b !== a) {
      return b - a;
    }
    if (left.project_id !== right.project_id) {
      return left.project_id.localeCompare(right.project_id);
    }
    return left.path.localeCompare(right.path);
  });
  const deduped = new Map<string, RecentDocumentActivityEntry>();
  for (const row of sorted) {
    deduped.set(row.id, row);
  }
  return Array.from(deduped.values()).slice(0, totalLimit);
}

async function fetchRecentActivityBatch({
  requester_account_id,
  projectIds,
  rowsPerProject,
  max_age_s,
  search,
  timeout,
}: {
  requester_account_id: string;
  projectIds: string[];
  rowsPerProject: number;
  max_age_s?: number;
  search?: string;
  timeout: number;
}): Promise<RecentDocumentActivityEntry[]> {
  if (!projectIds.length) {
    return [];
  }
  const settled = await Promise.allSettled(
    projectIds.map(async (project_id) => {
      return await listRecent({
        client: webapp_client.conat_client.conat(),
        account_id: requester_account_id,
        project_id,
        limit: rowsPerProject,
        max_age_s,
        search,
        timeout,
      });
    }),
  );
  const merged: RecentDocumentActivityEntry[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue;
    }
    for (const row of result.value) {
      merged.push({
        id: makeId(row.project_id, row.path),
        project_id: row.project_id,
        path: row.path,
        last_accessed: row.last_accessed ? new Date(row.last_accessed) : null,
        recent_account_ids: row.recent_account_ids,
      });
    }
  }
  return merged;
}

export async function listRecentDocumentActivityBestEffort({
  account_id,
  project_map,
  maxProjects = DEFAULT_RECENT_PROJECTS,
  rowsPerProject = DEFAULT_RECENT_ROWS_PER_PROJECT,
  totalLimit = MAX_RECENT_ROWS_TOTAL,
  max_age_s,
  search,
  timeout = DEFAULT_TIMEOUT_MS,
  firstWaveProjects = DEFAULT_FIRST_WAVE_PROJECTS,
  firstWaveTimeout = DEFAULT_FIRST_WAVE_TIMEOUT_MS,
  onRows,
}: {
  account_id?: string;
  project_map: ProjectMap;
  maxProjects?: number;
  rowsPerProject?: number;
  totalLimit?: number;
  max_age_s?: number;
  search?: string;
  timeout?: number;
  firstWaveProjects?: number;
  firstWaveTimeout?: number;
  onRows?: (update: RecentDocumentActivityStageUpdate) => void;
}): Promise<RecentDocumentActivityEntry[]> {
  const requester_account_id = `${account_id ?? ""}`.trim();
  if (!requester_account_id || !project_map) {
    return [];
  }
  const candidateProjectIds = rankRecentProjectIds(project_map, maxProjects);
  const firstIds = candidateProjectIds.slice(0, firstWaveProjects);
  const laterIds = candidateProjectIds.slice(firstIds.length);

  const firstRows = finalizeRows(
    await fetchRecentActivityBatch({
      requester_account_id,
      projectIds: firstIds,
      rowsPerProject,
      max_age_s,
      search,
      timeout: firstWaveTimeout,
    }),
    totalLimit,
  );
  onRows?.({
    rows: firstRows,
    complete: laterIds.length === 0,
  });
  if (laterIds.length === 0) {
    return firstRows;
  }

  const laterRows = await fetchRecentActivityBatch({
    requester_account_id,
    projectIds: laterIds,
    rowsPerProject,
    max_age_s,
    search,
    timeout,
  });
  const finalRows = finalizeRows([...firstRows, ...laterRows], totalLimit);
  onRows?.({
    rows: finalRows,
    complete: true,
  });
  return finalRows;
}

export async function searchRecentFilenamesBestEffort({
  account_id,
  project_map,
  search,
}: {
  account_id?: string;
  project_map: ProjectMap;
  search: string;
}): Promise<FilenameSearchRow[]> {
  const rows = await listRecentDocumentActivityBestEffort({
    account_id,
    project_map,
    search,
    maxProjects: DEFAULT_FILENAME_SEARCH_PROJECTS,
    rowsPerProject: MAX_FILENAME_SEARCH_RESULTS,
    totalLimit: DEFAULT_FILENAME_SEARCH_PROJECTS * MAX_FILENAME_SEARCH_RESULTS,
    max_age_s: DOCUMENT_ACTIVITY_TTL_S,
    timeout: 5000,
  });
  const deduped = new Map<string, FilenameSearchRow>();
  for (const row of rows) {
    const when = row.last_accessed ?? new Date(0);
    if (!deduped.has(row.path)) {
      deduped.set(row.path, {
        project_id: row.project_id,
        filename: row.path,
        time: when,
      });
    }
  }
  return Array.from(deduped.values()).slice(0, MAX_FILENAME_SEARCH_RESULTS);
}
