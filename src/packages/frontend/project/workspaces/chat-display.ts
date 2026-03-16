/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "@cocalc/conat/workspaces";

export function generatedWorkspaceChatLabel(
  path: string,
  workspace?: Pick<
    WorkspaceRecord,
    "workspace_id" | "chat_path" | "theme"
  > | null,
): string | undefined {
  if (!workspace) return;
  const normalizedPath = `${path ?? ""}`.trim();
  const chatPath = `${workspace.chat_path ?? ""}`.trim();
  if (!normalizedPath || !chatPath || normalizedPath !== chatPath) return;
  if (!isGeneratedWorkspaceChatPath(normalizedPath, workspace.workspace_id)) {
    return;
  }
  const title = `${workspace.theme.title ?? ""}`.trim() || "Workspace";
  return `${title} Chat`;
}

function isGeneratedWorkspaceChatPath(
  chatPath: string,
  workspaceId: string,
): boolean {
  const normalized = `${chatPath ?? ""}`.trim();
  const workspace_id = `${workspaceId ?? ""}`.trim();
  if (!normalized || !workspace_id) return false;
  return (
    normalized.includes("/.local/share/cocalc/workspaces/") &&
    normalized.endsWith(`/${workspace_id}.chat`)
  );
}
