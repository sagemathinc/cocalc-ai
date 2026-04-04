/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "notification_target_outbox",
  rules: {
    primary_key: "outbox_id",
    pg_indexes: [
      "target_home_bay_id",
      "target_account_id",
      "notification_id",
      "kind",
      "event_type",
      "created_at",
      "published_at",
    ],
  },
  fields: {
    outbox_id: {
      type: "uuid",
      desc: "Stable id for this source-to-home-bay transport row.",
    },
    target_home_bay_id: {
      type: "string",
      desc: "Home bay that should consume this transport row.",
    },
    target_account_id: {
      type: "uuid",
      desc: "Account that should receive the projected notification row.",
    },
    notification_id: {
      type: "uuid",
      desc: "Stable account-facing notification id for this target.",
    },
    kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Notification kind such as mention or account_notice.",
    },
    event_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Transport event type such as notification.upserted.",
    },
    payload_json: {
      type: "map",
      desc: "Projected payload that the home bay uses to upsert inbox rows.",
    },
    created_at: {
      type: "timestamp",
      desc: "When the source-bay write and outbox append committed.",
    },
    published_at: {
      type: "timestamp",
      desc: "When the row was successfully consumed downstream.",
    },
  },
});
