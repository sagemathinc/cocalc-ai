/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  resolveWorkspaceForPath,
  type WorkspaceRecord,
} from "@cocalc/conat/workspaces";

const runtimeWorkspaceRecords = new Map<string, WorkspaceRecord[]>();
export const WORKSPACE_RECORDS_EVENT = "cocalc:project-workspace-records";

export function setRuntimeWorkspaceRecords(
  project_id: string,
  records: WorkspaceRecord[],
): void {
  runtimeWorkspaceRecords.set(project_id, records);
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_RECORDS_EVENT, {
        detail: { project_id },
      }),
    );
  }
}

export function clearRuntimeWorkspaceRecords(project_id: string): void {
  runtimeWorkspaceRecords.delete(project_id);
}

export function getRuntimeWorkspaceRecords(
  project_id: string,
): WorkspaceRecord[] {
  return runtimeWorkspaceRecords.get(project_id) ?? [];
}

export function resolveRuntimeWorkspaceForPath(
  project_id: string,
  path: string,
): WorkspaceRecord | null {
  return resolveWorkspaceForPath(getRuntimeWorkspaceRecords(project_id), path);
}
