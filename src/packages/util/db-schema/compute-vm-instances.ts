/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_vm_instances",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "vm_id",
      "owner_account_id",
      "project_id",
      "provider_instance_id",
      "created_at",
      "deleted_at",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Provider generation record identifier." },
    vm_id: { type: "uuid", desc: "Stable logical compute VM." },
    owner_account_id: { type: "uuid", desc: "Logical VM owner." },
    owning_bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Account-home bay authoritative for this generation.",
    },
    project_id: { type: "uuid", desc: "Attached project." },
    generation: { type: "number", desc: "Monotonic provider generation." },
    provider_instance_id: {
      type: "string",
      desc: "Provider instance identifier for this generation.",
    },
    public_address_id: {
      type: "string",
      desc: "Provider address used by this generation.",
    },
    machine_type: { type: "string", desc: "Generation machine type." },
    pricing_model: { type: "string", desc: "Generation pricing model." },
    public_ip: { type: "string", desc: "Generation public IPv4." },
    hourly_price: { type: "string", desc: "Immutable generation price." },
    created_at: { type: "timestamp", desc: "Provider creation start." },
    running_at: { type: "timestamp", desc: "Provider running observation." },
    ready_at: { type: "timestamp", desc: "SSH readiness observation." },
    preempted_at: { type: "timestamp", desc: "Confirmed Spot interruption." },
    stopped_at: { type: "timestamp", desc: "Provider stop observation." },
    deleted_at: { type: "timestamp", desc: "Provider deletion observation." },
    terminal_reason: { type: "string", desc: "Why the generation ended." },
    diagnostics: { type: "map", desc: "Bounded provider diagnostics." },
  },
});
