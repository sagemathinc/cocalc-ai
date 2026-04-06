/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { meta_file, original_path } from "@cocalc/util/misc";

import type { ChatActions } from "./actions";
import { isChatPath } from "./paths";
import { getChatActions, initChat } from "./register";

export interface UnreadChatThread {
  key: string;
  messageCount: number;
}

export function getSideChatPath(path: string): string {
  return isChatPath(path) ? path : meta_file(original_path(path), "chat");
}

export function ensureSideChatActions(
  project_id: string,
  path: string,
): ChatActions {
  const chatPath = getSideChatPath(path);
  return getChatActions(project_id, chatPath) ?? initChat(project_id, chatPath);
}

export function getExistingSideChatActions(
  project_id: string,
  path: string,
): ChatActions | undefined {
  return getChatActions(project_id, getSideChatPath(path));
}

export function listUnreadChatThreads(opts: {
  actions?: ChatActions;
  account_id?: string;
}): UnreadChatThread[] {
  const { actions, account_id } = opts;
  const accountId = `${account_id ?? ""}`.trim();
  if (!actions || !accountId || !actions.isProjectReadStateReady?.()) {
    return [];
  }
  const unread: UnreadChatThread[] = [];
  for (const entry of actions.getThreadIndex().values()) {
    const metadata = actions.getThreadMetadata?.(entry.key);
    if (metadata?.archived) {
      continue;
    }
    const readCount = Math.max(
      0,
      actions.getThreadReadCount?.(entry.key, accountId) ?? 0,
    );
    const unreadCount = Math.max(entry.messageCount - readCount, 0);
    if (unreadCount > 0) {
      unread.push({
        key: entry.key,
        messageCount: entry.messageCount,
      });
    }
  }
  return unread;
}

export function hasUnreadSideChat(opts: {
  actions?: ChatActions;
  account_id?: string;
}): boolean {
  return listUnreadChatThreads(opts).length > 0;
}
