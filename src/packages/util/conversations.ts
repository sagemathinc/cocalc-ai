/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A conversation is an explicit record naming one .chat file in a project.
// The record is the authority for "which conversations exist"; the .chat
// file is only where the messages are stored. Nothing crawls projects.

import { normalizeAbsolutePath } from "./path-model";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "./project-runtime";

export const MAX_CONVERSATION_TITLE_LENGTH = 200;
export const MAX_CONVERSATION_PATH_LENGTH = 1024;
export const MAX_CONVERSATION_PARTICIPANTS = 32;
export const MAX_CONVERSATIONS_PER_PROJECT = 1000;
export const MAX_LISTED_PROJECTS = 2000;

export interface Conversation {
  conversation_id: string;
  project_id: string;
  path: string;
  title: string;
  created_by: string;
  created: number;
  last_activity: number;
  last_sender_id?: string | null;
  // Recent human senders, most recent first, bounded.
  participant_ids: string[];
}

export interface ConversationPersonalState {
  pinned: boolean;
  last_read?: number | null;
}

export type ListedConversation = Conversation & ConversationPersonalState;

export function normalizeConversationTitle(title: unknown): string {
  const value = `${title ?? ""}`.replace(/\s+/g, " ").trim();
  if (!value) throw Error("conversation title is required");
  if (value.length > MAX_CONVERSATION_TITLE_LENGTH) {
    throw Error(
      `conversation title must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters`,
    );
  }
  return value;
}

// Canonical absolute path so the same file always has the same key, however
// the client spelled it (relative to HOME, "~/", duplicate slashes, ...).
export function normalizeConversationPath(path: unknown): string {
  let value = `${path ?? ""}`.trim();
  if (value === "~" || value.startsWith("~/")) value = value.slice(1);
  if (!value) throw Error("conversation path is required");
  const normalized = normalizeAbsolutePath(
    value.startsWith("/") ? value : value.replace(/^\/+/, ""),
    DEFAULT_PROJECT_RUNTIME_HOME,
  );
  if (!normalized.endsWith(".chat") || normalized.endsWith("/.chat")) {
    throw Error("a conversation must be a .chat file");
  }
  if (normalized.length > MAX_CONVERSATION_PATH_LENGTH) {
    throw Error("conversation path is too long");
  }
  return normalized;
}

// Where a brand new conversation's chat file goes. It is just storage.
export function newConversationPath(home: string, id: string): string {
  return normalizeConversationPath(`${home}/.cocalc/conversations/${id}.chat`);
}

export function isConversationUnread(
  conversation: Pick<ListedConversation, "last_activity" | "last_read">,
): boolean {
  return (
    conversation.last_read == null ||
    conversation.last_activity > conversation.last_read
  );
}
