/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  WorkspaceRecord,
  WorkspaceSelection,
} from "@cocalc/conat/workspaces";

const SESSION_SELECTION_PREFIX = "project-workspace-selection";
const SESSION_WORKSPACE_RECORD_PREFIX = "project-workspace-record";
export const WORKSPACE_SELECTION_EVENT = "cocalc:project-workspace-selection";

export function sessionSelectionKey(project_id: string): string {
  return `${SESSION_SELECTION_PREFIX}:${project_id}`;
}

export function loadSessionSelection(project_id: string): WorkspaceSelection {
  if (typeof sessionStorage === "undefined") return { kind: "all" };
  try {
    const raw = sessionStorage.getItem(sessionSelectionKey(project_id));
    if (!raw) return { kind: "all" };
    const parsed = JSON.parse(raw);
    if (
      parsed?.kind === "workspace" &&
      typeof parsed.workspace_id === "string"
    ) {
      return { kind: "workspace", workspace_id: parsed.workspace_id };
    }
    if (parsed?.kind === "unscoped") {
      return { kind: "unscoped" };
    }
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
  }
  return { kind: "all" };
}

export function persistSessionSelection(
  project_id: string,
  selection: WorkspaceSelection,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      sessionSelectionKey(project_id),
      JSON.stringify(selection),
    );
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
  }
}

function sessionWorkspaceRecordKey(project_id: string): string {
  return `${SESSION_WORKSPACE_RECORD_PREFIX}:${project_id}`;
}

export function loadSessionWorkspaceRecord(
  project_id: string,
): WorkspaceRecord | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(sessionWorkspaceRecordKey(project_id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.workspace_id !== "string" ||
      typeof parsed?.root_path !== "string"
    ) {
      return null;
    }
    return parsed as WorkspaceRecord;
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
    return null;
  }
}

export function persistSessionWorkspaceRecord(
  project_id: string,
  record: WorkspaceRecord | null,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const key = sessionWorkspaceRecordKey(project_id);
    if (record == null) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(record));
  } catch (err) {
    console.warn(`workspace selection sessionStorage warning -- ${err}`);
  }
}

export function dispatchWorkspaceSelectionEvent(
  project_id: string,
  selection: WorkspaceSelection,
): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function"
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_SELECTION_EVENT, {
      detail: {
        project_id,
        selection,
      },
    }),
  );
}
