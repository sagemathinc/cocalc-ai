/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";

export interface ProjectWindowState {
  rows: AccountProjectListWindowRow[];
  offset: number;
  hasMore: boolean;
}

export const EMPTY_PROJECT_WINDOW: ProjectWindowState = {
  rows: [],
  offset: 0,
  hasMore: true,
};

export function updateProjectWindow({
  state,
  page,
  pageSize,
  replace,
}: {
  state: ProjectWindowState;
  page: AccountProjectListWindowRow[];
  pageSize: number;
  replace: boolean;
}): ProjectWindowState {
  const rows = replace ? [] : state.rows;
  const byId = new Map(rows.map((row) => [row.project_id, row]));
  for (const row of page) byId.set(row.project_id, row);
  return {
    rows: [...byId.values()],
    offset: (replace ? 0 : state.offset) + page.length,
    hasMore: page.length === pageSize,
  };
}

export function projectStateLabel(row: AccountProjectListWindowRow): string {
  const state = row.state_summary as Record<string, unknown>;
  for (const key of ["state", "project_state", "status"]) {
    const value = state?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return row.host_id ? "assigned" : "not assigned";
}
