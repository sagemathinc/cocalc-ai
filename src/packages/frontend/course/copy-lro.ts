/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { ProjectCopyRow } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "../webapp-client";

export interface CourseCopyLro {
  op_id: string;
  scope_type: "project";
  scope_id: string;
}

export interface CourseCopyDestination {
  student_id: string;
  project_id: string;
}

export type CourseCopyResultByStudent = Record<string, string>;

type CourseCollectItemResult = {
  student_id: string;
  status: string;
  error?: string;
};

const TERMINAL_COPY_STATUSES = new Set([
  "done",
  "failed",
  "canceled",
  "expired",
]);

function aggregateError(summary: LroSummary): string {
  return summary.error ?? `copy ${summary.status}`;
}

function rowError(row: ProjectCopyRow): string {
  if (row.status === "done") {
    return "";
  }
  return row.last_error ?? `copy ${row.status}`;
}

function allRowsTerminal(rows: ProjectCopyRow[]): boolean {
  return rows.every((row) => TERMINAL_COPY_STATUSES.has(row.status));
}

function summarizeRows({
  summary,
  rows,
  dests,
}: {
  summary: LroSummary;
  rows: ProjectCopyRow[];
  dests: CourseCopyDestination[];
}): CourseCopyResultByStudent {
  const result: CourseCopyResultByStudent = {};
  const rowsByProject = new Map<string, ProjectCopyRow[]>();
  for (const row of rows) {
    const existing = rowsByProject.get(row.dest_project_id) ?? [];
    existing.push(row);
    rowsByProject.set(row.dest_project_id, existing);
  }

  for (const dest of dests) {
    const projectRows = rowsByProject.get(dest.project_id) ?? [];
    if (projectRows.length === 0) {
      result[dest.student_id] =
        summary.status === "succeeded" ? "" : aggregateError(summary);
      continue;
    }
    const failed = projectRows.find((row) => row.status !== "done");
    result[dest.student_id] = failed ? rowError(failed) : "";
  }
  return result;
}

export async function waitForCourseCopyLro({
  op,
  dests,
  onSummary,
}: {
  op: CourseCopyLro;
  dests: CourseCopyDestination[];
  onSummary?: (summary: LroSummary) => void;
}): Promise<CourseCopyResultByStudent> {
  const summary = await webapp_client.conat_client.lroWait({
    op_id: op.op_id,
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    timeout_ms: 2 * 60 * 60 * 1000,
    onSummary,
  });
  const rows = await webapp_client.project_client.listCopyRowsByOpId({
    op_id: op.op_id,
  });
  if (rows.length === 0 || allRowsTerminal(rows)) {
    return summarizeRows({ summary, rows, dests });
  }
  const currentSummary =
    (await webapp_client.conat_client.hub.lro.get({ op_id: op.op_id })) ??
    summary;
  return summarizeRows({ summary: currentSummary, rows, dests });
}

export function courseCollectResultByStudent(
  summary: LroSummary,
): CourseCopyResultByStudent {
  const result: CourseCopyResultByStudent = {};
  const items = summary.result?.items;
  if (!Array.isArray(items)) {
    return result;
  }
  for (const item of items as CourseCollectItemResult[]) {
    if (!item?.student_id) continue;
    result[item.student_id] =
      item.status === "done" ? "" : (item.error ?? item.status);
  }
  return result;
}
