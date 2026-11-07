/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { Table } from "./types";

// Internal tables only. Browser reads go through authorized catalog APIs.
Table({
  name: "artifact_catalog_sources",
  rules: {
    primary_key: "source_id",
    pg_indexes: ["project_id", "owning_bay_id", "project_id, chat_path"],
  },
  fields: {
    source_id: {
      type: "string",
      desc: "Hash of project id and canonical chat path.",
    },
    project_id: { type: "uuid" },
    chat_path: { type: "string" },
    owning_bay_id: { type: "string" },
    writer_host_id: { type: "uuid" },
    epoch: {
      type: "uuid",
      desc: "Owner-issued writer fence; rotated when the source writer is replaced.",
    },
    registration_id: {
      type: "uuid",
      desc: "Stable retry identity for the most recent writer registration.",
    },
    source_sequence: {
      type: "integer",
      pg_type: "BIGINT",
      pg_default: "0",
      not_null: true,
    },
    catalog_revision: {
      type: "integer",
      pg_type: "BIGINT",
      pg_default: "0",
      not_null: true,
    },
    payload_hash: { type: "string" },
    metadata_hash: {
      type: "string",
      desc: "Skips catalog writes when chat changes leave artifact metadata unchanged.",
    },
    updated_at: { type: "timestamp" },
  },
});

Table({
  name: "artifact_catalog",
  rules: {
    primary_key: "entry_id",
    pg_indexes: [
      "project_id",
      "source_id",
      "project_id, created_at, entry_id",
      "project_id, entry_id",
    ],
  },
  fields: {
    entry_id: {
      type: "string",
      desc: "Hash of source, thread and artifact identity.",
    },
    source_id: { type: "string" },
    project_id: { type: "uuid" },
    thread_id: { type: "string" },
    artifact_id: { type: "string" },
    metadata: {
      type: "map",
      desc: "Bounded content-free artifact metadata; not document contents.",
    },
    created_at: { type: "timestamp" },
    revision: { type: "integer", pg_type: "BIGINT" },
    deleted: { type: "boolean", pg_default: "FALSE", not_null: true },
  },
});

// Per-project catalog version. Readers fence on (epoch, seq): every committed
// change to what a reader can see advances seq in the same transaction, and a
// new epoch (for example after rehome) invalidates everything a reader holds.
Table({
  name: "artifact_catalog_project_state",
  rules: {
    primary_key: "project_id",
    pg_custom_indexes: [
      {
        // Projects that owe readers a change hint (the outbox).
        name: "artifact_catalog_project_state_hints_due",
        query:
          "(project_id) WHERE published_seq IS NOT NULL AND (target_seq IS NOT NULL OR seq > published_seq)",
      },
    ],
  },
  fields: {
    project_id: { type: "uuid", not_null: true },
    epoch: {
      type: "uuid",
      not_null: true,
      desc: "Version epoch; a reader holding another epoch must reload the project.",
    },
    seq: {
      type: "integer",
      pg_type: "BIGINT",
      pg_default: "0",
      not_null: true,
      desc: "Committed catalog change sequence for this project.",
    },
    retention_floor_seq: {
      type: "integer",
      pg_type: "BIGINT",
      pg_default: "0",
      not_null: true,
      desc: "Changes at or below this seq were pruned; older readers must reload.",
    },
    latest_created_at: {
      type: "timestamp",
      desc: "Newest artifact creation time in the project; orders projects for bounded account reads.",
    },
    published_seq: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Change hints are delivered (or given up on) up to this seq; NULL means none is owed (catalogs unchanged since hints were introduced).",
    },
    target_seq: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "The retained hint delivery target; NULL when none is open.",
    },
    attempts: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      desc: "Failed delivery attempts for the retained target.",
    },
    retry_at: { type: "timestamp", desc: "No hint claim before this time." },
    claim_token: {
      type: "uuid",
      desc: "Token of the current hint delivery claim.",
    },
    claim_expires_at: {
      type: "timestamp",
      desc: "The hint delivery claim lapses at this time.",
    },
    change_rows: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Exact number of retained change rows; NULL until measured.",
    },
    updated_at: { type: "timestamp" },
  },
});

// Durable per-project change log, written in the same transaction as the
// catalog change it describes. op 'reset' means visibility may have changed
// for the whole project, so readers reload it instead of applying deltas.
Table({
  name: "artifact_catalog_changes",
  rules: {
    primary_key: ["project_id", "seq", "entry_id"],
    pg_indexes: ["project_id, entry_id"],
  },
  fields: {
    project_id: { type: "uuid", not_null: true },
    seq: { type: "integer", pg_type: "BIGINT", not_null: true },
    entry_id: {
      type: "string",
      not_null: true,
      desc: "Changed catalog entry, or '' for a project-wide reset.",
    },
    op: {
      type: "string",
      pg_type: "VARCHAR(16)",
      not_null: true,
      desc: "upsert, remove or reset.",
    },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "artifact_catalog_project_budget",
  rules: { primary_key: "project_id" },
  fields: {
    project_id: { type: "uuid", not_null: true },
    window_start: { type: "timestamp", not_null: true },
    work_units: { type: "integer", pg_type: "BIGINT", not_null: true },
  },
});
