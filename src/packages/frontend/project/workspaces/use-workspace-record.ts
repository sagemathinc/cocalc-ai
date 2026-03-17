/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import { useProjectContext } from "@cocalc/frontend/project/context";
import type { WorkspaceRecord } from "./types";
import { resolveRuntimeWorkspaceForPath } from "./records-runtime";

export function useWorkspaceRecordForPath(
  project_id?: string,
  path?: string | null,
): WorkspaceRecord | null {
  const context = useProjectContext();
  return useMemo(() => {
    const normalizedProjectId = `${project_id ?? ""}`.trim();
    const normalizedPath = `${path ?? ""}`.trim();
    if (!normalizedProjectId || !normalizedPath) {
      return null;
    }
    if (context.project_id === normalizedProjectId) {
      return context.workspaces.resolveWorkspaceForPath(normalizedPath);
    }
    return resolveRuntimeWorkspaceForPath(normalizedProjectId, normalizedPath);
  }, [context.project_id, context.workspaces, path, project_id]);
}
