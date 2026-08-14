/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_vms",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "owner_account_id",
      "project_id",
      "owning_bay_id",
      "state",
      "desired_state",
      "expires_at",
      "provider_instance_id",
      "public_address_id",
      "public_hostname",
      "dns_record_id",
      "funding_mode",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Stable logical compute VM identifier." },
    name: { type: "string", desc: "Owner-selected VM name." },
    owner_account_id: {
      type: "uuid",
      desc: "Account that owns the VM and its costs.",
    },
    owning_bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Account-home bay authoritative for this VM.",
    },
    project_id: {
      type: "uuid",
      desc: "Project used for discovery and scoped agent access.",
    },
    provider: { type: "string", desc: "Managed provider: gcp or nebius." },
    operating_system: {
      type: "string",
      pg_default: "'linux'",
      not_null: true,
      desc: "Immutable guest operating-system family: linux or windows.",
    },
    operating_system_version: {
      type: "string",
      pg_default: "'ubuntu-24.04'",
      not_null: true,
      desc: "Immutable normalized guest operating-system version.",
    },
    os_license_hourly_price: {
      type: "string",
      pg_default: "'0.000000'",
      not_null: true,
      desc: "Immutable customer OS-license price per running hour in USD.",
    },
    region: { type: "string", desc: "Cloud region." },
    zone: { type: "string", desc: "Cloud zone." },
    architecture: { type: "string", desc: "Guest CPU architecture." },
    machine_type: { type: "string", desc: "Provider machine type." },
    cpu: { type: "number", desc: "Normalized virtual CPU count." },
    ram_gb: { type: "number", desc: "Normalized guest memory in GiB." },
    gpu_type: { type: "string", desc: "Optional normalized GPU type." },
    gpu_count: { type: "number", desc: "Normalized GPU count." },
    provider_spec: {
      type: "map",
      desc: "Immutable provider-specific machine and image selection.",
    },
    funding_mode: {
      type: "string",
      desc: "site-funded, account-postpaid, or account-prepaid.",
    },
    desired_pricing_model: {
      type: "string",
      desc: "Owner-authorized pricing model.",
    },
    effective_pricing_model: {
      type: "string",
      desc: "Pricing model used by the current provider generation.",
    },
    boot_disk_gb: { type: "number", desc: "Persistent boot disk size." },
    boot_disk_id: {
      type: "string",
      desc: "Provider boot disk retained across instance recovery.",
    },
    home_volume_id: {
      type: "uuid",
      desc: "Optional account-owned persistent home volume.",
    },
    state: { type: "string", desc: "Observed logical VM state." },
    desired_state: { type: "string", desc: "Requested logical VM state." },
    instance_generation: {
      type: "number",
      desc: "Monotonic provider generation number.",
    },
    provider_instance_id: {
      type: "string",
      desc: "Current provider instance identifier.",
    },
    public_address_id: {
      type: "string",
      desc: "Durable provider public-address resource identifier.",
    },
    public_address_state: {
      type: "string",
      desc: "Observed provider public-address lifecycle state.",
    },
    public_address_updated_at: {
      type: "timestamp",
      desc: "Most recent public-address reconciliation.",
    },
    public_ip: { type: "string", desc: "Current assigned public IPv4." },
    public_hostname: {
      type: "string",
      unique: true,
      desc: "Immutable random public DNS hostname.",
    },
    dns_record_id: {
      type: "string",
      desc: "Current Cloudflare DNS record identifier.",
    },
    dns_state: { type: "string", desc: "Observed DNS lifecycle state." },
    dns_updated_at: {
      type: "timestamp",
      desc: "Most recent DNS reconciliation.",
    },
    dns_error: { type: "string", desc: "Latest bounded DNS error." },
    public_ports: {
      type: "array",
      pg_type: "INTEGER[]",
      desc: "Fixed public TCP port policy, currently 22 and 443.",
    },
    ssh_user: { type: "string", desc: "SSH login user." },
    ssh_public_key: {
      type: "string",
      desc: "Optional initial public key installed for owner access; additional authorized keys are stored in metadata and no private key is retained.",
    },
    created_at: { type: "timestamp", desc: "Lease creation time." },
    updated_at: { type: "timestamp", desc: "Last control-plane update." },
    ready_at: { type: "timestamp", desc: "Current generation readiness." },
    expires_at: {
      type: "timestamp",
      desc: "Optional guest-independent deletion deadline; membership spending limits still apply when null.",
    },
    stopped_at: { type: "timestamp", desc: "Most recent stop time." },
    deleted_at: { type: "timestamp", desc: "Logical deletion completion." },
    allow_on_demand_fallback: {
      type: "boolean",
      desc: "Whether bounded Spot fallback is authorized.",
    },
    authorized_fallback_hours: {
      type: "number",
      desc: "Maximum authorized on-demand fallback duration.",
    },
    spot_hourly_price: {
      type: "string",
      desc: "Immutable customer Spot price snapshot in USD.",
    },
    on_demand_hourly_price: {
      type: "string",
      desc: "Immutable customer on-demand price snapshot in USD.",
    },
    authorized_cost: {
      type: "string",
      desc: "Maximum fixed compute cost authorized by the actor.",
    },
    accrued_cost: {
      type: "string",
      desc: "Reconciled fixed compute cost accrued so far.",
    },
    billing_updated_at: {
      type: "timestamp",
      desc: "End of the last interval written to the usage ledger.",
    },
    billing_state: {
      type: "string",
      desc: "Billing and price-envelope enforcement state.",
    },
    bootstrap_revision: {
      type: "number",
      desc: "Required managed guest bootstrap revision.",
    },
    observed_bootstrap_revision: {
      type: "number",
      desc: "Most recently SSH-verified guest bootstrap revision.",
    },
    public_port_policy_revision: {
      type: "number",
      desc: "Required public firewall policy revision.",
    },
    spot_recovery_policy: {
      type: "map",
      desc: "Normalized project-host-compatible Spot policy.",
    },
    spot_recovery_state: {
      type: "map",
      desc: "Observed Spot interruption and fallback state.",
    },
    idempotency_key: {
      type: "string",
      desc: "Owner-scoped create idempotency key.",
    },
    error: { type: "string", desc: "Latest bounded lifecycle error." },
    metadata: {
      type: "map",
      desc: "Non-authoritative provider and staging diagnostics.",
    },
  },
});
