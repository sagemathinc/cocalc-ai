/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The conversations this browser is showing right now: a chat open in a
// project or on the People page, or a direct conversation. A notification
// about one of them, arriving while the person is looking at it (the tab is
// visible and focused), is marked read at once: they are reading it, so it
// shouldn't add to the count or wait to be dismissed.

import { useEffect } from "react";
import { normalizeConversationPath } from "@cocalc/util/people";

const viewing = new Map<string, number>();

// A chat's path as the editor or a notification gives it (relative to the
// home directory, or absolute), in one form.
export function chatViewKey(project_id: string, path: string): string {
  let normalized = path;
  try {
    normalized = normalizeConversationPath(path);
  } catch {
    // not a .chat path: kept as given
  }
  return `chat:${project_id}:${normalized}`;
}

export function directViewKey(conversation_id: string): string {
  return `direct:${conversation_id}`;
}

// Register a conversation as shown; returns the function that unregisters
// it. Counted, so two views of one conversation are both respected.
export function showingConversation(key: string): () => void {
  viewing.set(key, (viewing.get(key) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const count = (viewing.get(key) ?? 1) - 1;
    if (count > 0) viewing.set(key, count);
    else viewing.delete(key);
  };
}

export function useShowingConversation(key: string | undefined): void {
  useEffect(() => (key ? showingConversation(key) : undefined), [key]);
}

function personIsLooking(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.visibilityState === "visible" &&
    (typeof document.hasFocus !== "function" || document.hasFocus())
  );
}

// Whether a notification is about a conversation the person is reading now.
export function isAboutShownConversation(notification: {
  project_id?: string | null;
  summary?: Record<string, any> | null;
}): boolean {
  if (viewing.size === 0 || !personIsLooking()) return false;
  const summary = notification.summary ?? {};
  if (
    summary.notice_type === "direct_message" &&
    typeof summary.conversation_id === "string" &&
    viewing.has(directViewKey(summary.conversation_id))
  ) {
    return true;
  }
  const path = typeof summary.path === "string" ? summary.path : "";
  return (
    !!notification.project_id &&
    path.endsWith(".chat") &&
    viewing.has(chatViewKey(notification.project_id, path))
  );
}

// For tests.
export function resetShownConversationsForTests(): void {
  viewing.clear();
}
