/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { Table } from "./types";

// Internal tables only. Browser reads go through authorized catalog APIs;
// account-home feed projections remain the target for steady-state discovery.
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
      desc: "Suppresses feed churn when chat writes do not change artifact metadata.",
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

Table({
  name: "artifact_catalog_outbox",
  rules: {
    primary_key: "event_id",
    pg_indexes: ["project_id", "source_id", "created_at", "published_at"],
  },
  fields: {
    event_id: { type: "uuid" },
    project_id: { type: "uuid" },
    source_id: { type: "string" },
    revision: { type: "integer", pg_type: "BIGINT" },
    payload: {
      type: "map",
      desc: "Complete source projection at this catalog revision, including removal by omission.",
    },
    created_at: { type: "timestamp" },
    published_at: { type: "timestamp" },
  },
});
