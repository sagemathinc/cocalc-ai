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
      desc: "When this outbox event was successfully published downstream.",
    },
  },
});
