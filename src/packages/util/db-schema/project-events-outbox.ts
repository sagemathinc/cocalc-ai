/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_events_outbox",
  rules: {
    primary_key: "event_id",
    pg_indexes: [
      "project_id",
      "owning_bay_id",
      "event_type",
      "created_at",
      "published_at",
      "collaborator_index_pending",
    ],
    pg_custom_indexes: [
      {
        name: "project_events_outbox_project_history_idx",
        query: "(project_id, created_at DESC, event_id DESC)",
      },
      {
        name: "project_events_outbox_remote_feed_pending_idx",
        query:
          "(remote_feed_next_attempt_at, created_at) WHERE remote_feed_pending",
      },
      {
        name: "project_events_outbox_collaborator_history_idx",
        query:
          "(project_id, created_at DESC, event_id DESC) WHERE event_type IN ('project.created', 'project.membership_changed', 'project.deleted')",
      },
    ],
  },
  fields: {
    event_id: {
      type: "uuid",
      desc: "Stable id for this authoritative project event.",
    },
    project_id: {
      type: "uuid",
      desc: "Project whose authoritative state change produced this event.",
    },
    owning_bay_id: {
      type: "string",
      desc: "Bay that authored the event and owns the project.",
    },
    event_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Event type such as project.created or project.summary_changed.",
    },
    payload_json: {
      type: "map",
      desc: "Authoritative event payload published to projection consumers.",
    },
    created_at: {
      type: "timestamp",
      desc: "When the authoritative write and outbox append committed.",
    },
    published_at: {
      type: "timestamp",
      desc: "When this outbox event was successfully applied to the account project index.",
    },
    collaborator_index_pending: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Whether this event still needs to be applied to the account collaborator index.",
    },
    collaborator_index_published_at: {
      type: "timestamp",
      desc: "When this outbox event was successfully applied to the account collaborator index.",
    },
    remote_feed_pending: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Whether this event still needs to reach the project lists of collaborators homed on other bays (multi-bay clusters only).",
    },
    remote_feed_published_at: {
      type: "timestamp",
      desc: "When this event reached every other bay that needed it.",
    },
    remote_feed_attempts: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      desc: "Failed attempts to forward this event to other bays.",
    },
    remote_feed_next_attempt_at: {
      type: "timestamp",
      desc: "Earliest time to (re)try forwarding; also a short lease while a forward is in flight.",
    },
    remote_feed_last_error: {
      type: "string",
      desc: "The last error from forwarding this event to other bays.",
    },
  },
});
