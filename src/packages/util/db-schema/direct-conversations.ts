/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// Direct conversations (see @cocalc/util/direct-conversations). The record
// and its messages live on the owning bay; each member's home bay keeps an
// index row and the member's blocks.

Table({
  name: "direct_conversations",
  rules: {
    primary_key: "conversation_id",
    pg_indexes: ["created_by, created"],
    pg_custom_indexes: [
      {
        name: "direct_conversations_pair",
        unique: true,
        query: "(pair_key) WHERE pair_key IS NOT NULL",
      },
    ],
  },
  fields: {
    conversation_id: { type: "uuid", desc: "Conversation identity." },
    member_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "Everyone in it, the creator first.",
    },
    member_states: {
      type: "map",
      pg_type: "JSONB",
      desc: "Each member's standing: active, requested, declined or blocked.",
    },
    created_by: { type: "uuid", desc: "Account that started it." },
    created: { type: "timestamp", desc: "When it was started." },
    last_activity: { type: "timestamp", desc: "Time of the latest message." },
    last_sender_id: {
      type: "uuid",
      desc: "Account that sent the latest message.",
    },
    preview: {
      type: "string",
      desc: "The start of the latest message, for lists.",
    },
    title: { type: "string", desc: "Optional title (group conversations)." },
    pair_key: {
      type: "string",
      desc: "For a two-person untitled conversation: its pair, unique (directPairKey).",
    },
    revision: {
      type: "integer",
      desc: "Bumped by every change; home bays apply only newer revisions.",
    },
    messages_version: {
      type: "integer",
      desc: "Bumped when a message is added or deleted (not by anyone's answer to a request): what a member's open view reloads on.",
    },
  },
});

Table({
  name: "direct_messages",
  rules: {
    primary_key: "message_id",
    pg_indexes: ["conversation_id, sent"],
  },
  fields: {
    message_id: { type: "uuid", desc: "Message identity." },
    conversation_id: { type: "uuid", desc: "Conversation it belongs to." },
    sender_id: { type: "uuid", desc: "Account that sent it." },
    sent: { type: "timestamp", desc: "When it was sent." },
    body: { type: "string", desc: "Markdown, bounded; empty once deleted." },
    deleted: {
      type: "timestamp",
      desc: "When its sender deleted it (for everyone); the body is cleared.",
    },
  },
});

// Every conversation started with a message request, on the starter's home
// bay, kept for the daily quota: a later accept, decline or block doesn't
// give it back.
Table({
  name: "direct_request_admissions",
  rules: {
    primary_key: "conversation_id",
    pg_indexes: ["account_id, created"],
  },
  fields: {
    conversation_id: { type: "uuid", desc: "The conversation started." },
    account_id: { type: "uuid", desc: "Account that started it." },
    recipients: {
      type: "integer",
      desc: "How many people got a request in it.",
    },
    created: { type: "timestamp", desc: "When." },
  },
});

// The owning bay's outbox: written in the same transaction as each change, so
// every member's home bay hears of it even if the process stops right after;
// cleared once delivered.
Table({
  name: "direct_fanout_pending",
  rules: {
    primary_key: ["conversation_id", "account_id"],
    pg_indexes: ["next_attempt"],
  },
  fields: {
    conversation_id: { type: "uuid", desc: "Conversation to deliver." },
    account_id: { type: "uuid", desc: "Member whose home bay needs it." },
    revision: { type: "integer", desc: "Revision to deliver (at least)." },
    message_id: {
      type: "uuid",
      desc: "Latest message not yet delivered, for the member's notification.",
    },
    deleted_message_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "Messages deleted since the last delivery: the member's notices about them lose their text.",
    },
    attempts: { type: "integer", desc: "Delivery attempts so far." },
    next_attempt: { type: "timestamp", desc: "Earliest next attempt." },
    last_error: { type: "string", desc: "Last delivery error." },
  },
});

Table({
  name: "account_direct_conversations",
  rules: {
    primary_key: ["account_id", "conversation_id"],
    pg_indexes: ["account_id, last_activity"],
  },
  fields: {
    account_id: { type: "uuid", desc: "Member this row belongs to." },
    conversation_id: { type: "uuid", desc: "The conversation." },
    owner_bay_id: { type: "string", desc: "Bay that stores the conversation." },
    member_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "Everyone in it, the creator first.",
    },
    member_states: {
      type: "map",
      pg_type: "JSONB",
      desc: "Each member's standing, as of the last update.",
    },
    created_by: { type: "uuid", desc: "Account that started it." },
    created: { type: "timestamp", desc: "When it was started." },
    last_activity: { type: "timestamp", desc: "Time of the latest message." },
    last_sender_id: { type: "uuid", desc: "Sender of the latest message." },
    preview: { type: "string", desc: "Start of the latest message." },
    title: { type: "string", desc: "Optional title." },
    last_read: {
      type: "timestamp",
      desc: "Activity time this member has read through.",
    },
    muted: { type: "boolean", desc: "This member muted it." },
    pinned: { type: "boolean", desc: "This member pinned it." },
    archived_through: {
      type: "timestamp",
      desc: "This member archived messages up to this time: hidden from them, not deleted.",
    },
    revision: {
      type: "integer",
      desc: "Owning bay revision of this copy; older updates are ignored.",
    },
    messages_version: {
      type: "integer",
      desc: "The conversation's messages_version in this copy.",
    },
    notified_message_id: {
      type: "uuid",
      desc: "Last message this member was notified of (notifications are retried until recorded).",
    },
    request_notified: {
      type: "boolean",
      desc: "This member was notified of the message request (only once).",
    },
    updated: { type: "timestamp", desc: "Last change to this row." },
  },
});

Table({
  name: "account_direct_blocks",
  rules: {
    primary_key: ["account_id", "blocked_account_id"],
  },
  fields: {
    account_id: { type: "uuid", desc: "Account that blocked someone." },
    blocked_account_id: {
      type: "uuid",
      desc: "Account that may no longer message them.",
    },
    created: { type: "timestamp", desc: "When." },
  },
});
