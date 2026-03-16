/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "@cocalc/conat/workspaces";
import { pathMatchesWorkspaceRoot } from "@cocalc/conat/workspaces";

export function generatedWorkspaceChatLabel(
  path: string,
  workspace?: Pick<WorkspaceRecord, "root_path" | "chat_path" | "theme"> | null,
): string | undefined {
  if (!workspace) return;
  const normalizedPath = `${path ?? ""}`.trim();
  const chatPath = `${workspace.chat_path ?? ""}`.trim();
  if (!normalizedPath || !chatPath || normalizedPath !== chatPath) return;
  if (pathMatchesWorkspaceRoot(normalizedPath, workspace.root_path)) return;
  const title = `${workspace.theme.title ?? ""}`.trim() || "Workspace";
  return `${title} Chat`;
}
