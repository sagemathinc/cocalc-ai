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
// Conversations someone may start per day that include a request (someone
// who is not a collaborator).
export const MAX_DIRECT_REQUESTS_PER_DAY = 20;
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
}

// A conversation in one member's list: the shared record plus their own
// standing and private state.
export interface ListedDirectConversation extends DirectConversation {
  state: DirectMemberState;
  last_read: number | null;
  muted: boolean;
}

export interface DirectMessage {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  sent: number;
  body: string;
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

export function directPreview(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
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
  c: ListedDirectConversation,
  account_id?: string,
): boolean {
  if (c.muted || c.state !== "active") return false;
  if (c.last_sender_id == null || c.last_sender_id === account_id) return false;
  return c.last_read == null || c.last_activity > c.last_read;
}

export function isDirectRequest(c: ListedDirectConversation): boolean {
  return c.state === "requested";
}

// The URL route (under /people) of a direct conversation.
export function directRoute(conversation_id: string): string {
  return `messages/${conversation_id}`;
}
