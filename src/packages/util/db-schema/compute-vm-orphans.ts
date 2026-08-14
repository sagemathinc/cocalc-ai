/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_vm_orphans",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "provider",
      "resource_type",
      "state",
      "first_seen_at",
      "last_seen_at",
      "eligible_delete_at",
      "resolved_at",
    ],
  },
  fields: {
    id: {
      type: "string",
      desc: "Stable provider/type/resource identity for this observation.",
    },
    provider: { type: "string", desc: "gcp, nebius, or cloudflare." },
    resource_type: {
      type: "string",
      desc: "instance, boot_disk, address, or dns_record.",
    },
    resource_id: { type: "string", desc: "Opaque provider resource ID." },
    resource_name: { type: "string", desc: "Provider display name." },
    region: { type: "string" },
    zone: { type: "string" },
    state: {
      type: "string",
      desc: "observed, stopped, deleting, deleted, ignored, or error.",
    },
    observation_count: { type: "number" },
    first_seen_at: { type: "timestamp" },
    last_seen_at: { type: "timestamp" },
    stopped_at: { type: "timestamp" },
    eligible_delete_at: { type: "timestamp" },
    resolved_at: { type: "timestamp" },
    last_error: { type: "string" },
    metadata: { type: "map", desc: "Bounded inventory diagnostics." },
  },
});
