/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_image_events",
  rules: {
    primary_key: "event_id",
    pg_indexes: [
      "image_id",
      "release_id",
      "event_type",
      "actor_account_id",
      "created",
    ],
  },
  fields: {
    event_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable identifier for this RootFS lifecycle event.",
    },
    image_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Catalog image id this lifecycle event applies to.",
    },
    release_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Optional immutable release referenced by this lifecycle event.",
    },
    event_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Machine-readable RootFS lifecycle event type.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Account that triggered this event, if any.",
    },
    reason: {
      type: "string",
      desc: "Optional operator-facing reason recorded with the event.",
    },
    payload: {
      type: "map",
      desc: "Optional structured event metadata for UI and audit display.",
    },
    created: {
      type: "timestamp",
      desc: "When this event was recorded.",
    },
  },
});
