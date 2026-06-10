/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import { useProjectContext } from "@cocalc/frontend/project/context";
export { defaultWorkingDirectoryForChat } from "./chat-working-directory";

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
