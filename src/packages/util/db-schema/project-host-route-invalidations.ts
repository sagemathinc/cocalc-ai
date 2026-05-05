/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_host_route_invalidations",
  rules: {
    primary_key: "event_id",
    pg_indexes: ["project_id", "host_id", "created_at"],
  },
  fields: {
    event_id: {
      type: "integer",
      pg_type: "BIGSERIAL",
      desc: "Monotonic event id for durable route cache invalidation polling.",
      noCoerce: true,
    },
    project_id: {
      type: "uuid",
      desc: "Project whose routing state changed, if known.",
    },
    host_id: {
      type: "uuid",
      desc: "Host whose routing state changed, if known.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this route invalidation event was recorded.",
    },
  },
});
