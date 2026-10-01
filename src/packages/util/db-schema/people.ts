/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// One row per conversation, stored on the project's owning bay. Rows are
// created explicitly (new conversation or "add existing chat file"), never by
// scanning. Access is always the project's current collaborator list.
Table({
  name: "project_conversations",
  rules: {
    primary_key: ["project_id", "path"],
    pg_unique_indexes: ["conversation_id"],
    pg_indexes: ["project_id, last_activity"],
  },
  fields: {
    project_id: { type: "uuid", desc: "Project that stores the chat file." },
    path: {
      type: "string",
      desc: "Absolute path of the .chat file that stores the messages.",
    },
    conversation_id: { type: "uuid", desc: "Stable conversation identity." },
    title: { type: "string", desc: "Conversation title." },
    created_by: { type: "uuid", desc: "Account that created the record." },
    created: { type: "timestamp", desc: "When the record was created." },
    last_activity: {
      type: "timestamp",
      desc: "Time of the most recent human message sent through CoCalc chat.",
    },
    last_sender_id: {
      type: "uuid",
      desc: "Account that sent the most recent human message.",
    },
    participant_ids: {
      type: "array",
      pg_type: "UUID[]",
      desc: "Bounded list of recent human senders, most recent first.",
    },
  },
});

// Per-account private choices about conversations and people, stored on the
// account's home bay. One row per (account, kind, target).
Table({
  name: "account_people_state",
  rules: {
    primary_key: ["account_id", "kind", "target_id"],
    pg_custom_indexes: [
      {
        name: "account_people_state_alias",
        unique: true,
        query: "(account_id, kind, alias) WHERE alias IS NOT NULL",
      },
    ],
  },
  fields: {
    account_id: { type: "uuid", desc: "Account these choices belong to." },
    kind: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "What the target is: conversation or person.",
    },
    target_id: {
      type: "uuid",
      desc: "conversation_id or the person's account_id.",
    },
    project_id: {
      type: "uuid",
      desc: "Project of a conversation (reference only, not authority).",
    },
    pinned: { type: "boolean", desc: "Pinned by this account." },
    alias: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Private lowercase handle, unique per account and kind.",
    },
    following: { type: "boolean", desc: "Explicitly followed." },
    muted: { type: "boolean", desc: "Explicitly muted." },
    last_read: {
      type: "timestamp",
      desc: "Conversation activity time this account has read through.",
    },
    updated: { type: "timestamp", desc: "Last change to this row." },
  },
});
