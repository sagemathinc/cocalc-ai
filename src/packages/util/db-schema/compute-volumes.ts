/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_volumes",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "owner_account_id",
      "owning_bay_id",
      "project_id",
      "state",
      "desired_state",
      "attached_vm_id",
      "provider_disk_id",
      "funding_mode",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Stable account-owned volume identifier." },
    name: { type: "string", desc: "Owner-selected volume name." },
    owner_account_id: { type: "uuid", desc: "Account that owns the volume." },
    owning_bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Account-home bay authoritative for this volume.",
    },
    project_id: {
      type: "uuid",
      desc: "Optional project used for budget grouping and discovery.",
    },
    provider: { type: "string", desc: "Managed provider: gcp or nebius." },
    region: { type: "string", desc: "Cloud region." },
    zone: { type: "string", desc: "Cloud zone; attachments must match." },
    role: { type: "string", desc: "Managed volume role; home in v2." },
    funding_mode: {
      type: "string",
      desc: "site-funded, account-postpaid, or account-prepaid.",
    },
    provider_spec: {
      type: "map",
      desc: "Immutable provider-specific volume selection.",
    },
    disk_type: { type: "string", desc: "Provider disk class." },
    filesystem: { type: "string", desc: "Filesystem created on first mount." },
    size_gb: { type: "number", desc: "User-requested logical disk size." },
    desired_size_gb: { type: "number", desc: "Requested grow-only disk size." },
    effective_size_gb: {
      type: "number",
      desc: "Provider-rounded billable volume size.",
    },
    provider_disk_id: { type: "string", desc: "Provider disk identifier." },
    state: { type: "string", desc: "Observed volume lifecycle state." },
    desired_state: { type: "string", desc: "ready or deleted." },
    attached_vm_id: { type: "uuid", desc: "Reserved logical VM writer." },
    attachment_generation: {
      type: "number",
      desc: "Monotonic attachment fencing generation.",
    },
    attachment_state: {
      type: "string",
      desc: "detached, reserved, attached, or unknown.",
    },
    created_at: { type: "timestamp", desc: "Volume creation time." },
    updated_at: { type: "timestamp", desc: "Last control-plane update." },
    ready_at: { type: "timestamp", desc: "Provider disk readiness time." },
    resized_at: { type: "timestamp", desc: "Most recent completed growth." },
    detached_at: { type: "timestamp", desc: "Most recent confirmed detach." },
    deleted_at: { type: "timestamp", desc: "Provider-confirmed deletion." },
    monthly_price_per_gb: {
      type: "string",
      desc: "Immutable storage price snapshot in USD per GB-month.",
    },
    authorized_monthly_cost: {
      type: "string",
      desc: "Owner-confirmed recurring storage cost ceiling.",
    },
    billing_state: { type: "string", desc: "Storage billing state." },
    billing_updated_at: {
      type: "timestamp",
      desc: "End of the last interval written to the usage ledger.",
    },
    idempotency_key: { type: "string", desc: "Owner-scoped create identity." },
    error: { type: "string", desc: "Latest bounded lifecycle error." },
    metadata: { type: "map", desc: "Non-authoritative provider diagnostics." },
  },
});
