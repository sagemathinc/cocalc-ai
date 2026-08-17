/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  authFirstRequireAccount,
  authFirstRequireHost,
  authFirstRequireComputeProject,
  authFirstRequireAccountOrComputeAgent,
} from "./util";
import type { HostCatalog } from "./hosts";

export const COMPUTE_AGENT_GRANTS_PROJECT_DETAIL_FIELD = "compute_agent_grants";

export type ComputeVmPricingModel = "spot" | "on_demand";
export type ComputeVmDesiredState = "running" | "stopped" | "deleted";
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

export interface ComputeEgressSummary {
  current_month_bytes: number;
  current_month_cost_usd: string;
  lifetime_bytes: number;
  lifetime_cost_usd: string;
  unit_price_per_gb_usd: string;
  free: boolean;
  updated_at?: string | Date | null;
  complete_through?: string | Date | null;
  stale: boolean;
  error?: string | null;
}

export interface ComputeOrphan {
  id: string;
  provider: "gcp" | "nebius" | "cloudflare";
  resource_type: "instance" | "boot_disk" | "address" | "dns_record";
  resource_id: string;
  resource_name?: string | null;
  region?: string | null;
  zone?: string | null;
  state: string;
  observation_count: number;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  stopped_at?: string | Date | null;
  eligible_delete_at?: string | Date | null;
  resolved_at?: string | Date | null;
  last_error?: string | null;
  metadata: Record<string, any>;
}

export interface ComputeAgentGrant {
  grant_id: string;
  owner_account_id: string;
  project_id: string;
  turn_id: string;
  session_id: string;
  issued_by_account_id: string;
  allowed_actions: string[];
  allowed_vm_ids: string[];
  allow_create: boolean;
  allowed_providers: string[];
  allowed_machine_classes: string[];
  funding_mode?: ManagedComputeFundingMode | null;
  max_active_vms: number;
  max_hourly_usd: number;
  max_total_authorized_usd: number;
  max_ttl_minutes: number;
  expires_at: string | Date;
  revoked_at?: string | Date | null;
  created_at: string | Date;
  last_used_at?: string | Date | null;
  metadata: Record<string, any>;
}

export interface ComputeVm {
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
  state: string;
  desired_state: ComputeVmDesiredState;
  instance_generation: number;
  provider_instance_id: string;
  public_address_id?: string | null;
  public_address_state: string;
  public_ip?: string | null;
  public_hostname: string;
  dns_state: string;
  dns_error?: string | null;
  public_ports: number[];
  ssh_alias: string;
  egress_summary: ComputeEgressSummary;
  private_ip?: string | null;
  internal_hostname?: string | null;
  ssh_user: string;
  created_at: string | Date;
  updated_at: string | Date;
  ready_at?: string | Date | null;
  expires_at?: string | Date | null;
  stopped_at?: string | Date | null;
  deleted_at?: string | Date | null;
  allow_on_demand_fallback: boolean;
  authorized_fallback_hours: number;
  spot_hourly_price: string;
  on_demand_hourly_price: string;
  authorized_cost: string;
  accrued_cost: string;
  billing_state: string;
  spot_recovery_policy: Record<string, any>;
  spot_recovery_state: Record<string, any>;
  error?: string | null;
  metadata: Record<string, any>;
}

export interface CreateComputeVmRequest {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  project_id: string;
  name: string;
  provider: ManagedComputeProviderId;
  operating_system?: ManagedComputeOperatingSystem;
  architecture?: "x86_64" | "arm64";
  region: string;
  zone?: string;
  machine_type: string;
  gpu_type?: string;
  gpu_count?: number;
  provider_spec?: Record<string, any>;
  pricing_model: ComputeVmPricingModel;
  allow_on_demand_fallback?: boolean;
  ttl_minutes?: number | null;
  boot_disk_gb?: number;
  home_volume?: string;
  funding_mode?: ManagedComputeFundingMode;
  ssh_public_key?: string;
  configure_project_ssh?: boolean;
  idempotency_key: string;
}

export interface ComputeVolume {
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
  state: string;
  desired_state: "ready" | "deleted";
  attached_vm_id?: string | null;
  attachment_generation: number;
  attachment_state: "detached" | "reserved" | "attached" | "unknown";
  created_at: string | Date;
  updated_at: string | Date;
  ready_at?: string | Date | null;
  resized_at?: string | Date | null;
  detached_at?: string | Date | null;
  deleted_at?: string | Date | null;
  monthly_price_per_gb: string;
  authorized_monthly_cost: string;
  billing_state: string;
  error?: string | null;
  metadata: Record<string, any>;
}

export interface CreateComputeVolumeRequest {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  project_id: string;
  name: string;
  provider: ManagedComputeProviderId;
  region: string;
  zone?: string;
  size_gb: number;
  funding_mode?: ManagedComputeFundingMode;
  provider_spec?: Record<string, any>;
  idempotency_key: string;
}

export interface ComputeCatalog {
  providers: ManagedComputeProviderId[];
  provider_catalogs: Partial<Record<ManagedComputeProviderId, HostCatalog>>;
  funding_modes: Array<{
    value: ManagedComputeFundingMode;
    label: string;
    allowed: boolean;
    reason?: string;
  }>;
  default_funding_mode: ManagedComputeFundingMode;
  operating_systems: Array<{
    value: ManagedComputeOperatingSystem;
    label: string;
    providers: ManagedComputeProviderId[];
    architectures: Array<"x86_64" | "arm64">;
    versions: string[];
    minimum_boot_disk_gb: number;
    license_per_vcpu_hourly_usd: string;
  }>;
  defaults: {
    provider: ManagedComputeProviderId;
    operating_system: ManagedComputeOperatingSystem;
    architecture: "x86_64" | "arm64";
    region: string;
    zone: string;
    machine_type: string;
    ttl_minutes?: number | null;
    boot_disk_gb: number;
  };
  limits: {
    max_active_per_project: number;
    max_ttl_minutes: number;
    max_boot_disk_gb: number;
    max_volume_gb: number;
  };
}

export interface PrepareComputeWindowsRdpResult {
  id: string;
  name: string;
  hostname: string;
  ssh_user: string;
  windows_user: string;
  windows_password: string;
  remote_port: 3389;
}

export const compute = {
  getCatalog: authFirstRequireAccountOrComputeAgent,
  createVm: authFirstRequireAccountOrComputeAgent,
  listVms: authFirstRequireAccount,
  getVm: authFirstRequireAccount,
  listProjectVms: authFirstRequireComputeProject,
  getProjectVm: authFirstRequireComputeProject,
  authorizeSshKey: authFirstRequireAccount,
  prepareWindowsRdp: authFirstRequireAccount,
  authorizeProjectSshKey: authFirstRequireComputeProject,
  authorizeProjectSshKeyFromHost: authFirstRequireHost,
  startVm: authFirstRequireAccountOrComputeAgent,
  stopVm: authFirstRequireAccountOrComputeAgent,
  deleteVm: authFirstRequireAccountOrComputeAgent,
  setVmTtl: authFirstRequireAccountOrComputeAgent,
  setVmFundingMode: authFirstRequireAccountOrComputeAgent,
  setVmMachineType: authFirstRequireAccountOrComputeAgent,
  createVolume: authFirstRequireAccountOrComputeAgent,
  listVolumes: authFirstRequireAccount,
  getVolume: authFirstRequireAccount,
  listProjectVolumes: authFirstRequireComputeProject,
  getProjectVolume: authFirstRequireComputeProject,
  resizeVolume: authFirstRequireAccountOrComputeAgent,
  setVolumeFundingMode: authFirstRequireAccountOrComputeAgent,
  deleteVolume: authFirstRequireAccountOrComputeAgent,
  listAgentGrants: authFirstRequireAccount,
  approveAgentGrant: authFirstRequireAccount,
  revokeAgentGrant: authFirstRequireAccount,
  listOrphans: authFirstRequireAccount,
  resolveOrphan: authFirstRequireAccount,
};

export interface ComputeApi {
  getCatalog: (opts: { account_id?: string }) => Promise<ComputeCatalog>;
  createVm: (opts: CreateComputeVmRequest) => Promise<ComputeVm>;
  listVms: (opts: {
    account_id?: string;
    project_id?: string;
    include_deleted?: boolean;
  }) => Promise<ComputeVm[]>;
  getVm: (opts: {
    account_id?: string;
    id_or_name: string;
  }) => Promise<ComputeVm>;
  listProjectVms: (opts: {
    host_id?: string;
    project_id?: string;
    include_deleted?: boolean;
  }) => Promise<ComputeVm[]>;
  getProjectVm: (opts: {
    host_id?: string;
    project_id?: string;
    id_or_name: string;
  }) => Promise<ComputeVm>;
  authorizeSshKey: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    ssh_public_key: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  prepareWindowsRdp: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
  }) => Promise<PrepareComputeWindowsRdpResult>;
  authorizeProjectSshKey: (opts: {
    project_id?: string;
    id_or_name: string;
    ssh_public_key: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  authorizeProjectSshKeyFromHost: (opts: {
    host_id?: string;
    project_id: string;
    id_or_name: string;
    ssh_public_key: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  startVm: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  stopVm: (opts: {
    account_id?: string;
    id_or_name: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  deleteVm: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  setVmTtl: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    ttl_minutes?: number | null;
    extend_minutes?: number;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  setVmFundingMode: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    funding_mode: ManagedComputeFundingMode;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  setVmMachineType: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    machine_type: string;
    idempotency_key: string;
  }) => Promise<ComputeVm>;
  createVolume: (opts: CreateComputeVolumeRequest) => Promise<ComputeVolume>;
  listVolumes: (opts: {
    account_id?: string;
    project_id?: string;
    include_deleted?: boolean;
  }) => Promise<ComputeVolume[]>;
  getVolume: (opts: {
    account_id?: string;
    id_or_name: string;
  }) => Promise<ComputeVolume>;
  listProjectVolumes: (opts: {
    host_id?: string;
    project_id?: string;
    include_deleted?: boolean;
  }) => Promise<ComputeVolume[]>;
  getProjectVolume: (opts: {
    host_id?: string;
    project_id?: string;
    id_or_name: string;
  }) => Promise<ComputeVolume>;
  resizeVolume: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    size_gb: number;
    funding_mode?: ManagedComputeFundingMode;
    idempotency_key: string;
  }) => Promise<ComputeVolume>;
  setVolumeFundingMode: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    funding_mode: ManagedComputeFundingMode;
    idempotency_key: string;
  }) => Promise<ComputeVolume>;
  deleteVolume: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id_or_name: string;
    confirm_name: string;
    idempotency_key: string;
  }) => Promise<ComputeVolume>;
  listAgentGrants: (opts: {
    account_id?: string;
    project_id: string;
    include_expired?: boolean;
  }) => Promise<ComputeAgentGrant[]>;
  approveAgentGrant: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    grant_id: string;
  }) => Promise<ComputeAgentGrant>;
  revokeAgentGrant: (opts: {
    account_id?: string;
    grant_id: string;
  }) => Promise<void>;
  listOrphans: (opts: {
    account_id?: string;
    include_resolved?: boolean;
  }) => Promise<ComputeOrphan[]>;
  resolveOrphan: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    orphan_id: string;
    action: "stop" | "delete" | "ignore";
  }) => Promise<ComputeOrphan>;
}
