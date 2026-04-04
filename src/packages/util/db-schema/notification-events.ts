/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "notification_events",
  rules: {
    primary_key: "event_id",
    pg_indexes: ["kind", "source_bay_id", "source_project_id", "created_at"],
  },
  fields: {
    event_id: {
      type: "uuid",
      desc: "Stable id for this authoritative notification event.",
    },
    kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Notification kind such as mention or account_notice.",
    },
    source_bay_id: {
      type: "string",
      desc: "Bay that owns this authoritative notification event.",
    },
    source_project_id: {
      type: "uuid",
      desc: "Optional project id for project-scoped notifications.",
    },
    source_path: {
      type: "string",
      desc: "Optional source path within the source project.",
    },
    source_fragment_id: {
      type: "string",
      desc: "Optional source fragment id within the source object.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Optional account id that triggered this notification event.",
    },
    origin_kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Origin category such as project, account, system, or admin.",
    },
    payload_json: {
      type: "map",
      desc: "Immutable authoritative payload for this notification event.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this authoritative notification event was created.",
    },
  },
});
