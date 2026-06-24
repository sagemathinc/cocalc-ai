/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "@cocalc/conat/workspaces";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";

interface GeneratedChatLabelOptions {
  currentAccountId?: string;
  userMap?: any;
}

export function generatedWorkspaceChatLabel(
  path: string,
  workspace?: Pick<
    WorkspaceRecord,
    "workspace_id" | "chat_path" | "theme"
  > | null,
  options?: GeneratedChatLabelOptions,
): string | undefined {
  const normalizedPath = `${path ?? ""}`.trim();
  if (!normalizedPath) return;
  const workspaceLabel = generatedWorkspaceLabel(normalizedPath, workspace);
  if (workspaceLabel) return workspaceLabel;
  return generatedImplicitNavigatorChatLabel(normalizedPath, options);
}

function generatedWorkspaceLabel(
  normalizedPath: string,
  workspace?: Pick<
    WorkspaceRecord,
    "workspace_id" | "chat_path" | "theme"
  > | null,
): string | undefined {
  if (!workspace) return;
  const chatPath = `${workspace.chat_path ?? ""}`.trim();
  if (!chatPath || normalizedPath !== chatPath) return;
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

export function generatedImplicitNavigatorChatLabel(
  path: string,
  options?: GeneratedChatLabelOptions,
): string | undefined {
  const ownerAccountId = implicitNavigatorChatOwnerAccountId(path);
  if (ownerAccountId === undefined) return;
  if (
    ownerAccountId === null ||
    ownerAccountId === `${options?.currentAccountId ?? ""}`.trim()
  ) {
    return "Main Chat";
  }
  const ownerName = userNameFromMap(options?.userMap, ownerAccountId);
  return `${ownerName ?? ownerAccountId}'s Main Chat`;
}

export function implicitNavigatorChatOwnerAccountId(
  path: string,
): string | null | undefined {
  const normalized = `${path ?? ""}`.trim();
  if (!normalized) return;
  if (
    /(?:^|\/)\.local\/share\/cocalc\/navigator\.chat$/.test(normalized) ||
    /(?:^|\/)Library\/Application Support\/cocalc\/navigator\.chat$/.test(
      normalized,
    )
  ) {
    return null;
  }
  const match = normalized.match(
    /(?:^|\/)\.local\/share\/cocalc\/navigator-([^/]+)\.chat$/,
  );
  const accountId = `${match?.[1] ?? ""}`.trim();
  return accountId || undefined;
}

function userNameFromMap(userMap: any, accountId: string): string | undefined {
  const user = userMap?.get?.(accountId) ?? userMap?.[accountId];
  if (user == null) return;
  return displayNameFromUserRecord(user) || undefined;
}
