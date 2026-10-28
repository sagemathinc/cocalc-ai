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
    body: { type: "string", desc: "Markdown, bounded." },
  },
});

// Index updates for a member's home bay that could not be delivered yet; the
// owning bay retries them.
Table({
  name: "direct_fanout_pending",
  rules: {
    primary_key: ["conversation_id", "account_id"],
  },
  fields: {
    conversation_id: { type: "uuid", desc: "Conversation to deliver." },
    account_id: { type: "uuid", desc: "Member whose home bay needs it." },
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
