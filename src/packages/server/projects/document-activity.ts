/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import {
  listRecent,
  type RecentProjectDocumentActivityEntry,
} from "@cocalc/conat/project/document-activity";
import { listProjectedProjectsForAccount } from "@cocalc/database/postgres/account-project-index";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { MAX_FILENAME_SEARCH_RESULTS } from "@cocalc/util/db-schema/projects";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FILE_ACCESS_PROJECTS = 50;
const DEFAULT_FILENAME_SEARCH_PROJECTS = 100;
const DOCUMENT_ACTIVITY_TTL_S = 90 * 24 * 60 * 60;

export interface FileAccessRow {
  project_id: string;
  title: string;
  path: string;
}

export interface FilenameSearchRow {
  project_id: string;
  filename: string;
  time: Date;
}

interface ProjectCandidate {
  project_id: string;
  title: string;
}

let routedClient: Client | undefined;

function getRoutedClient(): Client {
  routedClient ??= conatWithProjectRouting();
  return routedClient;
}

function parseIntervalToSeconds(interval?: string): number {
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

async function listCandidateProjects({
  account_id,
  limit,
}: {
  account_id: string;
  limit: number;
}): Promise<ProjectCandidate[]> {
  const rows = await listProjectedProjectsForAccount({
    account_id,
    limit,
    include_hidden: false,
  });
  return rows.map((row) => ({
    project_id: row.project_id,
    title: row.title ?? "",
  }));
}

async function listRecentForProjects({
  account_id,
  projects,
  max_age_s,
  search,
  limit,
  timeout = DEFAULT_TIMEOUT_MS,
}: {
  account_id: string;
  projects: ProjectCandidate[];
  max_age_s: number;
  search?: string;
  limit: number;
  timeout?: number;
}): Promise<
  Array<{
    project: ProjectCandidate;
    rows: RecentProjectDocumentActivityEntry[];
  }>
> {
  const client = getRoutedClient();
  const settled = await Promise.allSettled(
    projects.map(async (project) => ({
      project,
      rows: await listRecent({
        client,
        account_id,
        project_id: project.project_id,
        limit,
        max_age_s,
        search,
        timeout,
      }),
    })),
  );
  return settled
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        project: ProjectCandidate;
        rows: RecentProjectDocumentActivityEntry[];
      }> => result.status === "fulfilled",
    )
    .map((result) => result.value);
}

export async function fileAccess({
  account_id,
  interval,
}: {
  account_id: string;
  interval?: string;
}): Promise<FileAccessRow[]> {
  const projects = await listCandidateProjects({
    account_id,
    limit: DEFAULT_FILE_ACCESS_PROJECTS,
  });
  const activity = await listRecentForProjects({
    account_id,
    projects,
    max_age_s: parseIntervalToSeconds(interval),
    limit: 500,
  });
  const deduped = new Map<string, FileAccessRow>();
  for (const { project, rows } of activity) {
    for (const row of rows) {
      const key = `${project.project_id}\u0000${row.path}`;
      if (!deduped.has(key)) {
        deduped.set(key, {
          project_id: project.project_id,
          title: project.title,
          path: row.path,
        });
      }
    }
  }
  return Array.from(deduped.values()).sort((left, right) => {
    const titleOrder = left.title.localeCompare(right.title);
    if (titleOrder !== 0) {
      return titleOrder;
    }
    const pathOrder = left.path.localeCompare(right.path);
    if (pathOrder !== 0) {
      return pathOrder;
    }
    return left.project_id.localeCompare(right.project_id);
  });
}

export async function filenameSearch({
  search,
  account_id,
}: {
  search: string;
  account_id: string;
}): Promise<FilenameSearchRow[]> {
  const projects = await listCandidateProjects({
    account_id,
    limit: DEFAULT_FILENAME_SEARCH_PROJECTS,
  });
  const activity = await listRecentForProjects({
    account_id,
    projects,
    search,
    max_age_s: DOCUMENT_ACTIVITY_TTL_S,
    limit: MAX_FILENAME_SEARCH_RESULTS,
  });
  const deduped = new Map<string, FilenameSearchRow>();
  for (const { project, rows } of activity) {
    for (const row of rows) {
      const time = row.last_accessed
        ? new Date(row.last_accessed)
        : new Date(0);
      const current = deduped.get(row.path);
      if (!current || time > current.time) {
        deduped.set(row.path, {
          project_id: project.project_id,
          filename: row.path,
          time,
        });
      }
    }
  }
  return Array.from(deduped.values())
    .sort((left, right) => {
      const delta = right.time.valueOf() - left.time.valueOf();
      if (delta !== 0) {
        return delta;
      }
      const pathOrder = left.filename.localeCompare(right.filename);
      if (pathOrder !== 0) {
        return pathOrder;
      }
      return left.project_id.localeCompare(right.project_id);
    })
    .slice(0, MAX_FILENAME_SEARCH_RESULTS);
}
