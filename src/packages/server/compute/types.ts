/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ComputeVmState =
  | "requested"
  | "provisioning"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "recovering"
  | "deleting"
  | "deleted"
  | "failed";

export type ComputeVmDesiredState = "running" | "stopped" | "deleted";
export type ComputeVmPricingModel = "spot" | "on_demand";
export type ManagedComputeProviderId = "gcp" | "nebius";
export type ManagedComputeOperatingSystem = "linux" | "windows";
export type ManagedComputeVolumeDiskType =
  | "balanced"
  | "ssd"
  | "ssd_io_m3"
  | "standard";
export type ManagedComputeFundingMode =
  | "site-funded"
  | "account-postpaid"
  | "account-prepaid";

export interface ComputeVmRow {
  id: string;
  name: string;
  owner_account_id: string;
  owning_bay_id: string;
  project_id: string;
  provider: ManagedComputeProviderId;
  operating_system: ManagedComputeOperatingSystem;
  operating_system_version: string;
  os_license_hourly_price: string;
  region: string;
  zone?: string | null;
  architecture: "x86_64" | "arm64";
  machine_type: string;
  cpu: number;
  ram_gb: number;
  gpu_type?: string | null;
  gpu_count: number;
  provider_spec: Record<string, any>;
  funding_mode: ManagedComputeFundingMode;
  desired_pricing_model: ComputeVmPricingModel;
  effective_pricing_model: ComputeVmPricingModel;
  boot_disk_gb: number;
  boot_disk_id: string;
  home_volume_id?: string | null;
  state: ComputeVmState;
  desired_state: ComputeVmDesiredState;
  instance_generation: number;
  provider_instance_id: string;
  public_address_id?: string | null;
  public_address_state: string;
  public_address_updated_at?: Date | null;
  public_ip?: string | null;
  public_hostname: string;
  dns_record_id?: string | null;
  dns_state: string;
  dns_updated_at?: Date | null;
  dns_error?: string | null;
  public_ports: number[];
  ssh_user: string;
  ssh_public_key: string;
  created_at: Date;
  updated_at: Date;
  ready_at?: Date | null;
  expires_at?: Date | null;
  stopped_at?: Date | null;
  deleted_at?: Date | null;
  allow_on_demand_fallback: boolean;
  authorized_fallback_hours: number;
  spot_hourly_price: string;
  on_demand_hourly_price: string;
  authorized_cost: string;
  accrued_cost: string;
  billing_updated_at?: Date | null;
  billing_state: string;
  bootstrap_revision: number;
  observed_bootstrap_revision?: number | null;
  public_port_policy_revision: number;
  spot_recovery_policy: Record<string, any>;
  spot_recovery_state: Record<string, any>;
  idempotency_key: string;
  error?: string | null;
  metadata: Record<string, any>;
}

export interface ComputeWorkRow {
  id: string;
  queue_order: string;
  resource_kind: "vm" | "volume";
  resource_id: string;
  action: string;
  idempotency_key: string;
  payload: Record<string, any>;
  state: string;
  attempt: number;
  not_before?: Date | null;
  locked_by?: string | null;
  locked_at?: Date | null;
  error?: string | null;
}

export type ComputeVolumeState =
  | "requested"
  | "provisioning"
  | "ready"
  | "resizing"
  | "deleting"
  | "deleted"
  | "failed";

export interface ComputeVolumeRow {
  id: string;
  name: string;
  owner_account_id: string;
  owning_bay_id: string;
  project_id?: string | null;
  provider: ManagedComputeProviderId;
  region: string;
  zone?: string | null;
  role: "home";
  funding_mode: ManagedComputeFundingMode;
  provider_spec: Record<string, any>;
  disk_type: ManagedComputeVolumeDiskType;
  filesystem: "ext4";
  size_gb: number;
  desired_size_gb: number;
  effective_size_gb: number;
  provider_disk_id: string;
  state: ComputeVolumeState;
  desired_state: "ready" | "deleted";
  attached_vm_id?: string | null;
  attachment_generation: number;
  attachment_state: "detached" | "reserved" | "attached" | "unknown";
  created_at: Date;
  updated_at: Date;
  ready_at?: Date | null;
  resized_at?: Date | null;
  detached_at?: Date | null;
  deleted_at?: Date | null;
  monthly_price_per_gb: string;
  authorized_monthly_cost: string;
  billing_state: string;
  billing_updated_at?: Date | null;
  idempotency_key: string;
  error?: string | null;
  metadata: Record<string, any>;
}
