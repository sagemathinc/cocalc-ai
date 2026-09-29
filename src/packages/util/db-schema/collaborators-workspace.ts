/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";
import type { FieldSpec } from "./types";

const uuid: FieldSpec = { type: "uuid" };
const text: FieldSpec = { type: "string" };
const bigint: FieldSpec = {
  type: "integer",
  pg_type: "BIGINT",
  pg_default: "0",
  not_null: true,
};
const time: FieldSpec = { type: "timestamp" };

Table({
  name: "collaboration_relation_sets",
  rules: {
    primary_key: "set_key",
    pg_indexes: ["project_id, created_at", "source_id, created_at"],
  },
  fields: {
    set_key: text,
    project_id: uuid,
    source_id: text,
    epoch: uuid,
    sequence: bigint,
    manifest: { type: "map" },
    byte_count: bigint,
    row_count: bigint,
    created_at: { ...time, pg_default: "now()", not_null: true },
  },
});
Table({
  name: "collaboration_relation_pages",
  rules: { primary_key: "id", pg_indexes: ["project_id", "set_key, page"] },
  fields: {
    id: text,
    project_id: uuid,
    set_key: text,
    page: bigint,
    payload: { type: "map" },
    digest: text,
  },
});
Table({
  name: "collaboration_participants",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "project_id",
      "set_key, thread_key, participant_id",
      "participant_id, set_key, thread_key",
    ],
  },
  fields: {
    id: text,
    project_id: uuid,
    set_key: text,
    thread_key: text,
    participant_id: uuid,
  },
});
Table({
  name: "collaboration_references",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "project_id",
      "set_key, thread_key, id",
      "set_key, thread_key, message_id, id",
    ],
  },
  fields: {
    id: text,
    project_id: uuid,
    set_key: text,
    thread_key: text,
    message_id: text,
    payload: { type: "map" },
  },
});
Table({
  name: "collaboration_participant_index",
  rules: {
    primary_key: ["account_id", "entry_key", "set_key", "participant_id"],
    pg_indexes: [
      "account_id, project_id",
      "account_id, participant_id, entry_key",
      "account_id, entry_key, set_key",
    ],
  },
  fields: {
    account_id: uuid,
    entry_key: text,
    project_id: uuid,
    set_key: text,
    participant_id: uuid,
  },
});

// Internal metadata only. No generic browser or project queries are authorized.
Table({
  name: "collaboration_discovery",
  rules: { primary_key: "project_id" },
  fields: {
    project_id: uuid,
    writer_host_id: uuid,
    run_id: uuid,
    sequence: bigint,
    report: { type: "map", pg_type: "JSONB" },
    updated_at: time,
  },
});
Table({
  name: "collaboration_memberships",
  rules: { primary_key: ["project_id", "account_id"] },
  fields: {
    project_id: uuid,
    account_id: uuid,
    epoch: uuid,
    notification_position: bigint,
  },
});
Table({
  name: "collaboration_projects",
  rules: {
    primary_key: "project_id",
    pg_indexes: ["notification_due,project_id"],
  },
  fields: {
    project_id: uuid,
    generation: uuid,
    revision: bigint,
    window_start: time,
    work_units: bigint,
    notification_due: { ...time, pg_type: "TIMESTAMPTZ" },
    notification_claim: uuid,
  },
});
Table({
  name: "collaboration_sources",
  rules: {
    primary_key: "source_id",
    pg_indexes: ["project_id, chat_path"],
  },
  fields: {
    source_id: text,
    project_id: uuid,
    chat_path: text,
    owning_bay_id: text,
    writer_host_id: uuid,
    epoch: uuid,
    registration_id: uuid,
    source_sequence: bigint,
    revision: bigint,
    payload_hash: text,
    metadata_hash: text,
    coverage: text,
    coverage_message: text,
    relocated_to: text,
    retired_room_id: uuid,
    relation_set: text,
  },
});
Table({
  name: "collaboration_source_requests",
  rules: { primary_key: ["project_id", "chat_path"] },
  fields: {
    project_id: uuid,
    chat_path: text,
    requested_by: uuid,
    requested_at: { ...time, pg_default: "now()", not_null: true },
  },
});
Table({
  name: "collaboration_catalog",
  rules: {
    primary_key: "entry_key",
    pg_indexes: [
      "relation_set, relation_thread",
      "source_id",
      "source_id, entry_key",
      "project_id, revision, entry_key",
      "project_id, activity, entry_key",
      "project_id, kind, activity, entry_key",
    ],
    pg_custom_indexes: [
      {
        name: "collaboration_catalog_agent_references",
        query: "USING GIN(agent_resource_ids)",
      },
      {
        name: "collaboration_catalog_title",
        query:
          "USING GIN(to_tsvector('simple',COALESCE(metadata->>'title',''))) WHERE deleted_at IS NULL",
      },
      {
        name: "collaboration_catalog_participants",
        query:
          "USING GIN((metadata->'participant_ids')) WHERE deleted_at IS NULL",
      },
      {
        name: "collaboration_catalog_creator",
        query:
          "(project_id,(metadata->>'created_by'),activity,entry_key) WHERE deleted_at IS NULL",
      },
    ],
  },
  fields: {
    entry_key: text,
    source_id: text,
    project_id: uuid,
    kind: text,
    resource_id: text,
    activity_floor: bigint,
    metadata: { type: "map" },
    artifact_entry_ids: { type: "array", pg_type: "TEXT[]" },
    agent_resource_ids: { type: "array", pg_type: "TEXT[]" },
    agent_source_activity: bigint,
    relation_set: text,
    relation_thread: text,
    relation_count: bigint,
    revision: bigint,
    activity: bigint,
    deleted_at: time,
  },
});
Table({
  name: "collaboration_rooms",
  rules: { primary_key: "project_id" },
  fields: {
    project_id: uuid,
    room_id: uuid,
    chat_path: text,
    request_id: uuid,
    initialized: { type: "boolean", pg_default: "FALSE", not_null: true },
  },
});
Table({
  name: "collaboration_room_replacements",
  rules: {
    primary_key: "operation_id",
    pg_indexes: [
      "project_id",
      "project_id, previous_room_id",
      "previous_source_id",
    ],
  },
  fields: {
    operation_id: uuid,
    project_id: uuid,
    requesting_account_id: uuid,
    request_id: uuid,
    previous_room_id: uuid,
    previous_source_id: text,
    receipt: { type: "map", pg_type: "JSONB", not_null: true },
  },
});
Table({
  name: "collaboration_access",
  rules: {
    primary_key: ["account_id", "project_id"],
    pg_indexes: [
      "project_id",
      "due_at, account_id, project_id",
      "lease_due_at, account_id, project_id",
      "account_id, lease_until",
      "account_id, due_at, project_id",
      "account_id, lease_due_at, project_id",
    ],
  },
  fields: {
    account_id: uuid,
    project_id: uuid,
    generation: uuid,
    revision: bigint,
    after_key: { ...text, pg_default: "''", not_null: true },
    relation_after: { type: "map" },
    lease_until: time,
    granted_generation: uuid,
    grant_request_id: uuid,
    lease_due_at: { ...time, pg_default: "now()", not_null: true },
    attention_generation: uuid,
    lease_claim_until: time,
    due_at: time,
    claim_id: uuid,
    claim_until: time,
    failures: bigint,
    last_error: text,
    complete: { type: "boolean", pg_default: "FALSE", not_null: true },
  },
});
Table({
  name: "collaboration_index",
  rules: {
    primary_key: ["account_id", "entry_key"],
    pg_indexes: [
      "account_id, relation_set, relation_thread",
      "account_id, activity, entry_key",
      "account_id, kind, activity, entry_key",
      "account_id, project_id, kind, activity, entry_key",
      "account_id, project_id, entry_key",
      "account_id, created_by, activity, entry_key",
    ],
    pg_custom_indexes: [
      {
        name: "collaboration_index_relations_pending",
        query: "(account_id,project_id) WHERE NOT relations_complete",
      },
      {
        name: "collaboration_index_agent_pin",
        query:
          "(account_id,(metadata->>'agent_id'),entry_key) WHERE kind='agent'",
      },
      {
        name: "collaboration_index_artifact_pin",
        query:
          "(account_id,project_id,(metadata->>'chat_path'),(metadata->>'thread_id'),(metadata->>'artifact_id')) WHERE kind='artifact'",
      },
      {
        name: "collaboration_index_agent_identity",
        query:
          "(account_id,project_id,(metadata->>'agent_id')) WHERE kind='agent'",
      },
      {
        name: "collaboration_index_artifact_identity",
        query:
          "(account_id,project_id,(metadata->>'entry_id')) WHERE kind='artifact'",
      },
      {
        name: "collaboration_index_search",
        query: "USING GIN (to_tsvector('simple', search_text))",
      },
      {
        name: "collaboration_index_participants",
        query: "USING GIN (participant_ids)",
      },
    ],
  },
  fields: {
    account_id: uuid,
    entry_key: text,
    project_id: uuid,
    generation: uuid,
    kind: text,
    activity: bigint,
    metadata: { type: "map" },
    created_by: uuid,
    participant_ids: { type: "array", pg_type: "UUID[]" },
    search_text: text,
    relation_set: text,
    relation_thread: text,
    relations_complete: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
    },
    relation_budget: bigint,
  },
});
Table({
  name: "collaboration_personal",
  rules: {
    primary_key: ["account_id", "entry_key"],
    pg_indexes: ["account_id, project_id"],
    pg_custom_indexes: [
      {
        name: "collaboration_personal_following",
        query: "(account_id,entry_key) WHERE following",
      },
      {
        name: "collaboration_personal_collected",
        query: "(account_id,entry_key) WHERE collected",
      },
      {
        name: "collaboration_personal_mentions",
        query:
          "(account_id,entry_key) WHERE last_mention>GREATEST(read_through,notify_after)",
      },
    ],
  },
  fields: {
    account_id: uuid,
    entry_key: text,
    project_id: uuid,
    alias: text,
    collected: { type: "boolean", pg_default: "FALSE", not_null: true },
    following: { type: "boolean", pg_default: "FALSE", not_null: true },
    muted: { type: "boolean", pg_default: "FALSE", not_null: true },
    read_through: bigint,
    attention_generation: uuid,
    notify_after: bigint,
    last_mention: bigint,
    legacy_migrated: { type: "boolean", pg_default: "FALSE", not_null: true },
    following_explicit: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
    },
    muted_explicit: { type: "boolean", pg_default: "FALSE", not_null: true },
  },
});
Table({
  name: "collaboration_maintenance",
  rules: { primary_key: "id" },
  fields: {
    id: text,
    cursor: { type: "map" },
  },
});
Table({
  name: "collaboration_account_state",
  rules: { primary_key: "account_id" },
  fields: { account_id: uuid, revision: bigint, revision_xid: bigint },
});
Table({
  name: "collaboration_relocations",
  rules: {
    primary_key: "operation_id",
    pg_indexes: ["project_id, created_at"],
  },
  fields: {
    operation_id: uuid,
    project_id: uuid,
    request_hash: text,
    epoch: uuid,
    revision: bigint,
    created_at: time,
  },
});
Table({
  name: "collaboration_artifact_bindings",
  rules: {
    primary_key: ["account_id", "entry_key"],
    pg_indexes: ["account_id, project_id"],
  },
  fields: {
    account_id: uuid,
    entry_key: text,
    project_id: uuid,
    entry_id: text,
    pin_key: text,
  },
});
Table({
  name: "collaboration_notification_events",
  rules: {
    primary_key: "event_id",
    pg_indexes: ["project_id, position", "created_at"],
    pg_custom_indexes: [
      {
        name: "collaboration_notification_fanout_due",
        query: "(fanout_due,event_id) WHERE fanout_pending",
      },
      {
        name: "collaboration_notification_thread_position",
        query: "(project_id,(event_json->>'thread_id'),position)",
      },
    ],
  },
  fields: {
    event_id: uuid,
    project_id: uuid,
    generation: uuid,
    position: { type: "integer", pg_type: "BIGSERIAL", not_null: true },
    event_json: { type: "map" },
    event_hash: text,
    fanout_pending: { type: "boolean", pg_default: "FALSE", not_null: true },
    fanout_after: uuid,
    fanout_due: { ...time, pg_type: "TIMESTAMPTZ" },
    created_at: {
      ...time,
      pg_type: "TIMESTAMPTZ",
      pg_default: "now()",
      not_null: true,
    },
  },
});
Table({
  name: "collaboration_notification_recipients",
  rules: {
    primary_key: "id",
    pg_indexes: ["project_id", "event_id", "due_at,id", "project_id,due_at,id"],
  },
  fields: {
    id: uuid,
    event_id: uuid,
    project_id: uuid,
    account_id: uuid,
    membership_epoch: uuid,
    due_at: {
      ...time,
      pg_type: "TIMESTAMPTZ",
      pg_default: "now()",
      not_null: true,
    },
    claim_id: uuid,
    claim_until: { ...time, pg_type: "TIMESTAMPTZ" },
  },
});
Table({
  name: "collaboration_notification_floors",
  rules: { primary_key: "project_id" },
  fields: { project_id: uuid, position: bigint },
});
Table({
  name: "collaboration_notification_cursors",
  rules: {
    primary_key: ["account_id", "project_id"],
    pg_indexes: ["due_at, account_id, project_id"],
  },
  fields: {
    account_id: uuid,
    project_id: uuid,
    generation: uuid,
    cursor: text,
    due_at: {
      ...time,
      pg_type: "TIMESTAMPTZ",
      pg_default: "now()",
      not_null: true,
    },
    claim_id: uuid,
    claim_until: { ...time, pg_type: "TIMESTAMPTZ" },
    failures: bigint,
    last_error: text,
  },
});
