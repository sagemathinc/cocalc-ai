/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import { useProjectContext } from "@cocalc/frontend/project/context";

export function defaultWorkingDirectoryForChat(
  chatPath: string,
  workspaceRootPath?: string,
): string {
  const workspaceRoot = `${workspaceRootPath ?? ""}`.trim();
  if (workspaceRoot) return workspaceRoot;
  const normalized = `${chatPath ?? ""}`.trim();
  if (!normalized) return ".";
  const i = normalized.lastIndexOf("/");
  if (i <= 0) return ".";
  return normalized.slice(0, i);
}

export function useWorkspaceChatWorkingDirectory(
  chatPath?: string,
): string | undefined {
  const { workspaces } = useProjectContext();
  return useMemo(() => {
    const normalized = `${chatPath ?? ""}`.trim();
    if (!normalized) return undefined;
    return workspaces.resolveWorkspaceForPath(normalized)?.root_path;
  }, [chatPath, workspaces.resolveWorkspaceForPath, workspaces.records]);
}
