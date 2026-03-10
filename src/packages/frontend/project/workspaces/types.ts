/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type {
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
  WorkspaceSource,
  WorkspaceTheme,
  WorkspaceUpdatePatch,
} from "@cocalc/conat/workspaces";

import type {
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceSelection,
  WorkspaceUpdatePatch,
} from "@cocalc/conat/workspaces";

export type ProjectWorkspaceState = {
  loading: boolean;
  records: WorkspaceRecord[];
  selection: WorkspaceSelection;
  current: WorkspaceRecord | null;
  filterPaths: (paths: readonly string[]) => string[];
  matchesPath: (path: string) => boolean;
  resolveWorkspaceForPath: (path: string) => WorkspaceRecord | null;
  setSelection: (selection: WorkspaceSelection) => void;
  createWorkspace: (input: WorkspaceCreateInput) => WorkspaceRecord;
  updateWorkspace: (
    workspace_id: string,
    patch: WorkspaceUpdatePatch,
  ) => WorkspaceRecord | null;
  deleteWorkspace: (workspace_id: string) => void;
  touchWorkspace: (workspace_id: string) => void;
};
