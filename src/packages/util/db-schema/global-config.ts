/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "global_config_versions",
  rules: {
    primary_key: "scope",
  },
  fields: {
    scope: {
      type: "string",
      desc: "The cluster-global configuration namespace, e.g. server_settings.",
    },
    version: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Monotonically increasing seed-authored version for this configuration scope.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When the seed last committed this configuration scope.",
    },
    updated_by: {
      type: "uuid",
      desc: "Account that committed this version, when known.",
    },
    metadata: {
      type: "map",
      desc: "Small seed-authored metadata about the latest commit.",
    },
  },
});

Table({
  name: "global_config_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["scope", "version", "created_at", "created_by"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Stable identifier for this configuration commit event.",
    },
    scope: {
      type: "string",
      desc: "The cluster-global configuration namespace, e.g. server_settings.",
    },
    version: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "The scope version created by this event.",
    },
    changes: {
      type: "map",
      desc: "Seed-authored summary of the configuration changes.",
    },
    created_at: {
      type: "timestamp",
      desc: "When the seed committed this event.",
    },
    created_by: {
      type: "uuid",
      desc: "Account that committed this event, when known.",
    },
    source_bay_id: {
      type: "string",
      desc: "Bay where the admin request originated, or the seed bay for local seed writes.",
    },
  },
});

Table({
  name: "global_config_bay_state",
  rules: {
    primary_key: ["bay_id", "scope"],
    pg_indexes: ["scope", "applied_version", "applied_at"],
  },
  fields: {
    bay_id: {
      type: "string",
      desc: "Bay whose local mirror state is being tracked.",
    },
    scope: {
      type: "string",
      desc: "The cluster-global configuration namespace, e.g. server_settings.",
    },
    applied_version: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Latest seed-authored version known to have been applied on this bay.",
    },
    applied_at: {
      type: "timestamp",
      desc: "When this bay most recently confirmed applying this scope.",
    },
    last_error: {
      type: "string",
      desc: "Most recent propagation error for this bay and scope, if any.",
    },
  },
});
