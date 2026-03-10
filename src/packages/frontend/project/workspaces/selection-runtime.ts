/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceSelection } from "@cocalc/conat/workspaces";

const SESSION_SELECTION_PREFIX = "project-workspace-selection";
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
