/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ListedConversation } from "@cocalc/util/people";

export const SCOPES = {
  "for-you": "For you",
  following: "Following",
  all: "All accessible",
  collection: "My collection",
} as const;
export type Scope = keyof typeof SCOPES;

export function isUnread(c: ListedConversation, account_id?: string): boolean {
  if (c.muted) return false;
  if (c.last_sender_id != null && c.last_sender_id === account_id) return false;
  return c.last_read == null || c.last_activity > c.last_read;
}

// Mentioned since this account last read the conversation.
export function isMentioned(c: ListedConversation): boolean {
  return (
    c.mentioned_at != null &&
    (c.last_read == null || c.mentioned_at > c.last_read)
  );
}

export function matchesScope(
  c: ListedConversation,
  scope: Scope,
  account_id?: string,
): boolean {
  switch (scope) {
    case "all":
      return true;
    case "following":
      return c.following;
    case "collection":
      return c.pinned;
    case "for-you":
      if (c.muted) return false;
      return (
        c.following ||
        isMentioned(c) ||
        (account_id != null &&
          (c.created_by === account_id ||
            c.participant_ids.includes(account_id)))
      );
  }
}

export function matchesSearch(
  c: ListedConversation,
  query: string,
  projectTitle?: string,
): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return true;
  return (
    c.title.toLowerCase().includes(q) ||
    (c.alias ?? "").includes(q) ||
    (projectTitle ?? "").toLowerCase().includes(q)
  );
}
