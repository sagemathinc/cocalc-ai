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

// Things an account keeps private choices about. Artifacts, agents and
// projects keep using their existing stores (Library, named agents,
// project bookmarks).
// "project" rows only record when this account last scanned that project.
export const PEOPLE_STATE_KINDS = [
  "conversation",
  "person",
  "project",
] as const;
export type PeopleStateKind = (typeof PEOPLE_STATE_KINDS)[number];

export const MAX_ALIAS_LENGTH = 64;

// One account's private choices about one conversation or person.
export interface PersonalState {
  // Pinned items form this account's collection; their manual order lives in
  // the account's collection preferences, shared with Library and Projects.
  pinned: boolean;
  // Private, stable handle (without "@"). Unique per account and kind.
  alias?: string | null;
  following: boolean;
  muted: boolean;
  // Conversations only: activity time this account has read through.
  last_read?: number | null;
  // Projects only: when this account last scanned it for .chat files.
  scanned_at?: number | null;
}

export type PersonalStatePatch = Partial<
  Pick<PersonalState, "pinned" | "alias" | "following" | "muted" | "scanned_at">
>;

export interface PersonalStateRow extends PersonalState {
  kind: PeopleStateKind;
  target_id: string;
  project_id?: string | null;
}

export const DEFAULT_PERSONAL_STATE: PersonalState = {
  pinned: false,
  alias: null,
  following: false,
  muted: false,
  last_read: null,
};

export type ListedConversation = Conversation &
  PersonalState & {
    // Latest time someone explicitly @mentioned this account here.
    mentioned_at?: number | null;
  };

export function assertPeopleStateKind(kind: unknown): PeopleStateKind {
  if (!PEOPLE_STATE_KINDS.includes(kind as PeopleStateKind)) {
    throw Error(`invalid kind: ${kind}`);
  }
  return kind as PeopleStateKind;
}

// Aliases are case-insensitive handles like @chat2 or @bella. Returns null to
// clear the alias.
export function normalizeAlias(alias: unknown): string | null {
  const value = `${alias ?? ""}`.trim().replace(/^@/, "").toLowerCase();
  if (!value) return null;
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(value) ||
    value.length > MAX_ALIAS_LENGTH
  ) {
    throw Error(
      "an alias uses letters, digits, '.', '_' or '-', starts with a letter or digit, and has at most 64 characters",
    );
  }
  return value;
}

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
