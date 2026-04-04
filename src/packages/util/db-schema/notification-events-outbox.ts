/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "notification_events_outbox",
  rules: {
    primary_key: "event_id",
    pg_indexes: [
      "account_id",
      "notification_id",
      "project_id",
      "owning_bay_id",
      "kind",
      "event_type",
      "created_at",
      "published_at",
    ],
  },
  fields: {
    event_id: {
      type: "uuid",
      desc: "Stable id for this authoritative notification event.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that receives the projected notification row.",
    },
    notification_id: {
      type: "uuid",
      desc: "Stable notification id within the account notification projection.",
    },
    project_id: {
      type: "uuid",
      desc: "Optional related project id for project-scoped notifications.",
    },
    owning_bay_id: {
      type: "string",
      desc: "Bay that authored this authoritative notification event.",
    },
    kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Notification kind such as mention.",
    },
    event_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Event type such as notification.mention_upserted.",
    },
    payload_json: {
      type: "map",
      desc: "Authoritative notification payload published to projection consumers.",
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
