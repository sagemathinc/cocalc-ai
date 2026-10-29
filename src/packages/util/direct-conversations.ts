/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Direct conversations: messages between people that live in no project.
//
// A conversation is stored once, on its owning bay (the creator's home bay
// when it was started): its members and messages. Each member's home bay
// keeps an index row for it (owning bay, last activity, read state, mute),
// so lists and unread counts are local, and learns of changes by fan-out
// from the owning bay.
//
// Consent: people who are collaborators (share or shared a project) can
// message each other directly. Anyone else receives a message request,
// which they accept, decline or block; until they accept they are not
// notified again and cannot reply.

export const MAX_DIRECT_MEMBERS = 8;
export const MAX_DIRECT_MESSAGE_LENGTH = 20_000;
export const MAX_DIRECT_TITLE_LENGTH = 200;
// Message requests (conversations that include someone who isn't a
// collaborator) per rolling day, and the people they may reach. These are
// defaults: a membership tier sets its own with the usage limits
// direct_message_requests_per_day and
// direct_message_request_recipients_per_day.
export const DEFAULT_DIRECT_REQUESTS_PER_DAY = 20;
export const DEFAULT_DIRECT_REQUEST_RECIPIENTS_PER_DAY = 40;
export const DIRECT_MESSAGES_PAGE = 50;
// Shown in lists and notifications.
export const DIRECT_PREVIEW_LENGTH = 200;

// A member's standing in a conversation. "requested" is a message request
// not yet accepted; "declined" and "blocked" stop delivery to that member.
export const DIRECT_MEMBER_STATES = [
  "active",
  "requested",
  "declined",
  "blocked",
] as const;
export type DirectMemberState = (typeof DIRECT_MEMBER_STATES)[number];

export type DirectResponse = "accept" | "decline" | "block";

export interface DirectConversation {
  conversation_id: string;
  owner_bay_id: string;
  member_ids: string[];
  member_states: Record<string, DirectMemberState>;
  created_by: string;
  created: number;
  last_activity: number;
  last_sender_id: string | null;
  preview: string;
  title: string | null;
  // Bumped by every change on the owning bay; home bays ignore anything
  // older than what they have, so updates arriving out of order can't undo
  // a newer one.
  revision: number;
}

// The one key of a two-person, untitled conversation: there is only one per
// pair, stored on the home bay of the smaller account id.
export function directPairKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(":");
}

// A conversation in one member's list: the shared record plus their own
// standing and private state. Server side only: it includes every member's
// standing.
export interface ListedDirectConversation extends DirectConversation {
  state: DirectMemberState;
  last_read: number | null;
  muted: boolean;
  pinned: boolean;
  // Archived: messages up to this time are hidden from this member (not
  // deleted; they can show them again).
  archived_through: number | null;
}

// A member's own settings for a conversation.
export interface DirectPersonalPatch {
  muted?: boolean;
  pinned?: boolean;
  // A time to archive through (now, normally), or null to show everything.
  archived_through?: number | null;
}

// What a member's browser gets: their own standing only. Others' standings
// (whether someone declined or blocked) are never sent, nor the owning bay.
export interface MemberDirectConversation {
  conversation_id: string;
  member_ids: string[];
  created_by: string;
  created: number;
  last_activity: number;
  last_sender_id: string | null;
  preview: string;
  title: string | null;
  state: DirectMemberState;
  last_read: number | null;
  muted: boolean;
  pinned: boolean;
  archived_through: number | null;
}

export function memberView(
  c: ListedDirectConversation,
): MemberDirectConversation {
  return {
    conversation_id: c.conversation_id,
    member_ids: c.member_ids,
    created_by: c.created_by,
    created: c.created,
    last_activity: c.last_activity,
    last_sender_id: c.last_sender_id,
    preview: c.preview,
    title: c.title,
    state: c.state,
    last_read: c.last_read,
    muted: c.muted,
    pinned: c.pinned,
    archived_through: c.archived_through,
  };
}

export interface DirectMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  sent: number;
  // Empty once deleted by its sender.
  body: string;
  deleted?: boolean;
}

export function normalizeDirectBody(body: unknown): string {
  const value = `${body ?? ""}`.replace(/\r\n/g, "\n").trim();
  if (!value) throw Error("the message is empty");
  if (value.length > MAX_DIRECT_MESSAGE_LENGTH) {
    throw Error(`at most ${MAX_DIRECT_MESSAGE_LENGTH} characters`);
  }
  return value;
}

export function normalizeDirectTitle(title: unknown): string | null {
  const value = `${title ?? ""}`.replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.slice(0, MAX_DIRECT_TITLE_LENGTH);
}

// Plain text for lists and notifications: no images, links or HTML (nothing
// that loads a resource or is rendered as Markdown), so a message from someone
// not yet accepted can't track who read the notification.
export function directPreview(body: string): string {
  const text = body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DIRECT_PREVIEW_LENGTH
    ? `${text.slice(0, DIRECT_PREVIEW_LENGTH - 1)}…`
    : text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The creator first, then the others once each: 2 to MAX_DIRECT_MEMBERS.
export function normalizeDirectMembers(
  creator: string,
  others: unknown,
): string[] {
  if (!Array.isArray(others)) throw Error("member_ids must be an array");
  const result: string[] = [];
  for (const id of [creator, ...others]) {
    if (typeof id !== "string" || !UUID.test(id)) {
      throw Error(`invalid member: ${id}`);
    }
    const value = id.toLowerCase();
    if (!result.includes(value)) result.push(value);
  }
  if (result.length < 2) throw Error("choose someone to message");
  if (result.length > MAX_DIRECT_MEMBERS) {
    throw Error(`at most ${MAX_DIRECT_MEMBERS} people in a conversation`);
  }
  return result;
}

// Unread for this member: someone else wrote after what they read, and they
// are active in it (a pending request is shown as a request instead).
export function isDirectUnread(
  c: Pick<
    MemberDirectConversation,
    "muted" | "state" | "last_sender_id" | "last_activity" | "last_read"
  >,
  account_id?: string,
): boolean {
  if (c.muted || c.state !== "active") return false;
  if (c.last_sender_id == null || c.last_sender_id === account_id) return false;
  return c.last_read == null || c.last_activity > c.last_read;
}

export function isDirectRequest(
  c: Pick<MemberDirectConversation, "state">,
): boolean {
  return c.state === "requested";
}

const UUID_LIKE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// An exact username to message someone who isn't a collaborator: never an
// account id or an email address.
export function normalizeDirectUsername(value: unknown): string | null {
  const text = `${value ?? ""}`.trim().replace(/^@/, "");
  if (!text || UUID_LIKE.test(text) || text.includes("@")) return null;
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(text)) return null;
  return text;
}

// The URL route (under /people) of a direct conversation.
export function directRoute(conversation_id: string): string {
  return `messages/${conversation_id}`;
}
