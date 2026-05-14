import { authFirstRequireAccount, authFirstRequireHost } from "./util";
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import type {
  HostManagedComponentRolloutResponse,
  HostManagedComponentStatus,
  HostRuntimeLogSource,
  HostRuntimeArtifactRetentionPolicy,
  ManagedComponentKind,
  ManagedComponentRuntimeState,
  ManagedComponentUpgradePolicy,
  ManagedComponentVersionState,
} from "@cocalc/conat/project-host/api";
import {
  type ProjectCopyRow,
  type ProjectCopyState,
  type ProjectEnv,
} from "@cocalc/conat/hub/api/projects";
import type { ProjectSecretsRuntimeCache } from "@cocalc/util/project-secrets";
import type {
  RootfsReleaseArtifactAccess,
  RootfsReleaseGcStatus,
  RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";

export type HostStatus =
  | "deprovisioned"
  | "deprovisioning"
  | "draining"
  | "off"
  | "error"
  | "starting"
  | "restarting"
  | "running"
  | "stopping";

export type HostAccessRole = "user" | "manager";
export type HostEffectiveAccessRole =
  | "owner"
  | "manager"
  | "user"
  | "pool"
  | "shared"
  | "admin";

export type AcpAdmissionDenialLimit =
  | "queued_per_account"
  | "queued_per_thread"
  | "created_5h_per_account"
  | "created_7d_per_account"
  | "running_per_account"
  | "running_per_project"
  | "active_automations_per_project";

export type AcpAdmissionDenialSource =
  | "automation"
  | "chat"
  | "claim"
  | "recovery"
  | "resend"
  | "unknown";

export interface AcpAdmissionDenialRecord {
  host_id?: string;
  account_id?: string;
  project_id: string;
  path?: string;
  thread_id?: string;
  limit: AcpAdmissionDenialLimit;
  current: number;
  maximum: number;
  source?: AcpAdmissionDenialSource;
  time?: number;
}

export interface ServiceAdmissionDenialRecord {
  host_id?: string;
  account_id?: string;
  project_id?: string;
  surface: string;
  limit: string;
  current: number;
  maximum: number;
  source?: string;
  reason?: string;
  subject?: string;
  path?: string;
  key?: string;
  time?: number;
}

export interface HostAccessEntry {
  host_id: string;
  account_id: string;
  role: HostAccessRole;
  created_by?: string | null;
  created_at?: string | Date | null;
  updated_by?: string | null;
  updated_at?: string | Date | null;
  revoked_at?: string | Date | null;
  revoked_by?: string | null;
}

export type HostPricingModel = "on_demand" | "spot";
export type HostInterruptionRestorePolicy = "none" | "immediate";
export type HostFundingMode =
  | "account-prepaid"
  | "account-postpaid"
  | "site-funded";
export type HostBillingEnforcementState =
  | "ok"
  | "at_risk"
  | "draining"
  | "stopped_billing_blocked"
  | "deprovision_pending"
  | "deprovisioned_recoverable";
export type HostBillingRecoveryAction =
  | "add_funds"
  | "fix_payment"
  | "support_limit_increase";
export type HostSpotRecoveryPhase =
  | "idle"
  | "retrying_spot"
  | "running_standard_fallback"
  | "probing_spot"
  | "returning_to_spot";

export interface HostSpotRecoveryPolicy {
  spot_restore_retry_window_minutes?: number;
  spot_restore_backoff_seconds?: number;
  standard_fallback_enabled?: boolean;
  standard_fallback_min_minutes?: number;
  spot_probe_interval_minutes?: number;
  spot_return_requires_probe?: boolean;
  max_restore_attempts_before_fallback?: number;
  max_standard_runtime_minutes?: number;
}

export interface HostSpotRecoveryState {
  phase: HostSpotRecoveryPhase;
  outage_started_at?: string;
  attempt?: number;
  next_retry_at?: string;
  fallback_started_at?: string;
  last_probe_at?: string;
  last_probe_result?: "success" | "failure";
  last_probe_error?: string;
  verification_started_at?: string;
  verification_deadline_at?: string;
}

export interface HostBillingEnforcement {
  state: HostBillingEnforcementState;
  reason_code?: string;
  reason?: string;
  first_detected_at?: string;
  at_risk_at?: string;
  drain_requested_at?: string;
  drain_completed_at?: string;
  final_backup_status?: "unknown" | "running" | "succeeded" | "failed";
  final_backup_completed_at?: string;
  stopped_at?: string;
  grace_until?: string;
  deprovision_after?: string;
  deprovision_requested_at?: string;
  deprovisioned_at?: string;
  recovery_actions?: HostBillingRecoveryAction[];
  hourly_cost_usd?: string | number;
  limiting_runway_hours?: number;
  limiting_window?: string;
}

export const HOST_LRO_KINDS = [
  "host-start",
  "host-stop",
  "host-restart",
  "host-drain",
  "host-stop-projects",
  "host-restart-projects",
  "host-reconcile-software",
  "host-reconcile-runtime-deployments",
  "host-rollback-runtime-deployments",
  "host-upgrade-software",
  "host-rollout-managed-components",
  "host-deprovision",
  "host-delete",
  "host-force-deprovision",
  "host-remove-connector",
] as const;

export type HostLroKind = (typeof HOST_LRO_KINDS)[number];

export type HostLroResponse = {
  op_id: string;
  scope_type: "host";
  scope_id: string;
  service: string;
  stream_name: string;
  kind: HostLroKind;
};

export type HostDrainOptions = {
  id: string;
  dest_host_id?: string;
  force?: boolean;
  allow_offline?: boolean;
  parallel?: number;
};

export type HostDrainResult = {
  host_id: string;
  mode: "move" | "force";
  total: number;
  moved: number;
  unassigned: number;
  failed: number;
  dest_host_id?: string;
  parallel?: number;
};

export type HostRehomeOperationStage =
  | "requested"
  | "destination_prepared"
  | "destination_accepted"
  | "source_flipped"
  | "host_reconnected"
  | "complete";

export type HostRehomeOperationStatus = "running" | "succeeded" | "failed";

export interface HostRehomeOperationSummary {
  op_id: string;
  host_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by?: string | null;
  reason?: string | null;
  campaign_id?: string | null;
  status: HostRehomeOperationStatus;
  stage: HostRehomeOperationStage;
  attempt: number;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
  duration_ms?: number;
}

export interface HostRehomeResponse {
  op_id?: string;
  host_id: string;
  previous_bay_id: string;
  owning_bay_id: string;
  operation_stage?: HostRehomeOperationStage;
  operation_status?: HostRehomeOperationStatus;
  status: "rehomed" | "already-home";
}

export interface HostOwnerSshTrustResult {
  host_id: string;
  bay_id: string;
  public_key: string;
  host_control_attempted: boolean;
  host_control_succeeded: boolean;
  cloud_provider_attempted: boolean;
  cloud_provider_succeeded: boolean;
}

export interface HostCloudRefreshResult {
  host_id: string;
  provider: string;
  scope: "provider";
  refreshed_at: string;
  ran: boolean;
  passes?: number;
  skipped?: "locked" | "not_due";
  next_at?: string;
  status?: HostStatus | string | null;
  deleted?: boolean;
  runtime_provider_status?: string | null;
  runtime_missing_count?: number | null;
  runtime_observed_at?: string | null;
  public_ip?: string | null;
}

export interface HostCloudOrphanInstance {
  provider: string;
  category: "untracked" | "deleted-host" | "deprovisioned-host";
  instance_id: string;
  name?: string;
  status?: string;
  zone?: string;
  public_ip?: string;
  matched_host_id?: string;
  matched_host_name?: string;
  matched_host_status?: string;
  matched_host_deleted?: string | Date | null;
}

export interface HostCloudOrphansResult {
  provider: string;
  refreshed_at: string;
  count: number;
  instances: HostCloudOrphanInstance[];
}

export interface ProjectBackupIndexStoreConfig {
  kind: "r2-object-store";
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  key_prefix: string;
  compression: "gzip";
}

export interface ProjectBackupConfig {
  toml: string;
  ttl_seconds: number;
  index_store?: ProjectBackupIndexStoreConfig | null;
}

export interface ProjectBackupIndexRecord {
  backup_id: string;
  backup_time: string;
  status: "complete" | "failed";
  storage_backend: "r2-object-store";
  bucket_id?: string | null;
  object_key?: string | null;
  compression?: string | null;
  sqlite_bytes?: number | null;
  object_bytes?: number | null;
  sha256?: string | null;
  error?: string | null;
  host_id?: string | null;
  created?: string | null;
  updated?: string | null;
}

export interface HostMachine {
  cloud?: string; // e.g., gcp, hyperstack, lambda, nebius, self-host, local
  machine_type?: string; // e.g., n2-standard-4, custom specs
  gpu_type?: string;
  gpu_count?: number;
  storage_mode?: "ephemeral" | "persistent";
  disk_gb?: number;
  disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
  zone?: string;
  source_image?: string;
  bootstrap_url?: string;
  startup_script?: string;
  metadata?: Record<string, any>;
}

export interface HostAutoGrowConfig {
  enabled?: boolean;
  max_disk_gb?: number;
  growth_step_gb?: number;
  min_grow_interval_minutes?: number;
  last_grow_at?: string;
  last_grow_from_disk_gb?: number;
  last_grow_to_disk_gb?: number;
}

export interface HostCatalogRegion {
  name: string;
  status?: string | null;
  zones: string[];
}

export interface HostCatalogZone {
  name: string;
  status?: string | null;
  region?: string | null;
  location?: string | null;
  lowC02?: boolean | null;
}

export interface HostCatalogMachineType {
  name?: string | null;
  guestCpus?: number | null;
  memoryMb?: number | null;
  isSharedCpu?: boolean | null;
  deprecated?: any;
}

export interface HostCatalogGpuType {
  name?: string | null;
  maximumCardsPerInstance?: number | null;
  description?: string | null;
  deprecated?: any;
}

export interface HostCatalogEntry {
  kind: string;
  scope: string;
  payload: any;
}

export interface HostProviderCapabilities {
  supportsStop: boolean;
  supportsRestart?: boolean;
  supportsHardRestart?: boolean;
  supportsDiskType: boolean;
  supportsDiskResize: boolean;
  diskResizeRequiresStop?: boolean;
  supportsCustomImage: boolean;
  supportsGpu: boolean;
  supportsZones: boolean;
  persistentStorage: {
    supported: boolean;
    growable: boolean;
  };
  hasRegions?: boolean;
  hasZones?: boolean;
  hasImages?: boolean;
  hasGpus?: boolean;
  supportsPersistentStorage?: boolean;
  supportsEphemeral?: boolean;
  supportsLocalDisk?: boolean;
  supportsGpuImages?: boolean;
  requiresRegion?: boolean;
  requiresZone?: boolean;
}

export interface HostBackupStatus {
  total: number;
  provisioned: number;
  running: number;
  provisioned_up_to_date: number;
  provisioned_needs_backup: number;
}

export interface HostBootstrapStatus {
  status?: string;
  updated_at?: string;
  message?: string;
}

export type HostBootstrapLifecycleSummaryStatus =
  | "in_sync"
  | "drifted"
  | "reconciling"
  | "error"
  | "unknown";

export type HostBootstrapLifecycleItemStatus =
  | "match"
  | "drift"
  | "missing"
  | "disabled"
  | "unknown";

export interface HostBootstrapLifecycleItem {
  key: string;
  label: string;
  desired?: string | boolean | number | null;
  installed?: string | boolean | number | null;
  status: HostBootstrapLifecycleItemStatus;
  message?: string;
}

export interface HostBootstrapLifecycle {
  bootstrap_dir?: string;
  desired_recorded_at?: string;
  installed_recorded_at?: string;
  current_operation?: string;
  last_provision_result?: string;
  last_provision_started_at?: string;
  last_provision_finished_at?: string;
  last_reconcile_result?: string;
  last_reconcile_started_at?: string;
  last_reconcile_finished_at?: string;
  last_error?: string;
  summary_status: HostBootstrapLifecycleSummaryStatus;
  summary_message?: string;
  drift_count: number;
  items: HostBootstrapLifecycleItem[];
}

export interface HostProjectRow {
  project_id: string;
  title: string;
  state: string;
  provisioned: boolean | null;
  last_edited: string | null;
  last_backup: string | null;
  needs_backup: boolean;
  collab_count: number;
}

export type HostProjectStateFilter =
  | "all"
  | "running"
  | "stopped"
  | "unprovisioned";

export interface HostProjectsResponse {
  rows: HostProjectRow[];
  summary: HostBackupStatus;
  next_cursor?: string;
  host_last_seen?: string;
}

export interface HostProjectsActionRequest {
  id: string;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
  risk_only?: boolean;
  parallel?: number;
}

export interface HostProjectsActionResultRow {
  project_id: string;
  status: "succeeded" | "failed" | "skipped";
  state?: string;
  error?: string;
}

export interface HostProjectsActionResult {
  host_id: string;
  action: "stop" | "restart";
  state_filter: HostProjectStateFilter;
  project_state?: string;
  risk_only?: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  projects: HostProjectsActionResultRow[];
}

export interface HostRootfsImage {
  image: string;
  cache_path: string;
  inspect_path?: string;
  digest?: string;
  size_bytes?: number;
  cached_at?: string;
  project_count: number;
  running_project_count: number;
  project_ids: string[];
  running_project_ids: string[];
  managed?: boolean;
  release_id?: string;
  release_gc_status?: RootfsReleaseGcStatus;
  centrally_deleted?: boolean;
  host_gc_eligible?: boolean;
}

export interface HostRootfsGcItem {
  image: string;
  status: "removed" | "skipped" | "failed";
  reason?: string;
}

export interface HostRootfsGcResult {
  scanned: number;
  removed: number;
  skipped: number;
  failed: number;
  items: HostRootfsGcItem[];
}

export interface HostManagedRootfsReleaseLifecycle {
  image: string;
  release_id?: string;
  gc_status?: RootfsReleaseGcStatus;
}

export interface HostCurrentMetrics {
  collected_at?: string;
  cpu_percent?: number;
  load_1?: number;
  load_5?: number;
  load_15?: number;
  memory_total_bytes?: number;
  memory_used_bytes?: number;
  memory_available_bytes?: number;
  memory_used_percent?: number;
  swap_total_bytes?: number;
  swap_used_bytes?: number;
  disk_device_total_bytes?: number;
  disk_device_used_bytes?: number;
  disk_unallocated_bytes?: number;
  btrfs_data_total_bytes?: number;
  btrfs_data_used_bytes?: number;
  btrfs_metadata_total_bytes?: number;
  btrfs_metadata_used_bytes?: number;
  btrfs_system_total_bytes?: number;
  btrfs_system_used_bytes?: number;
  btrfs_global_reserve_total_bytes?: number;
  btrfs_global_reserve_used_bytes?: number;
  disk_available_conservative_bytes?: number;
  disk_available_for_admission_bytes?: number;
  reservation_bytes?: number;
  assigned_project_count?: number;
  running_project_count?: number;
  starting_project_count?: number;
  stopping_project_count?: number;
}

export type HostPressureZone = "normal" | "observe" | "pressure" | "emergency";

export interface HostPressureState {
  zone: HostPressureZone;
  reason?: string;
  since_ms?: number;
  evaluated_at_ms?: number;
  candidate_count?: number;
  settle_until_ms?: number;
  recent_pressure_stop_count?: number;
  last_action_at_ms?: number;
  last_action_project_id?: string;
  last_action_status?: "stopped" | "stop_failed" | "cooldown" | "no_candidates";
  last_action_reason?: string;
}

export interface HostMetricsHistoryPoint extends HostCurrentMetrics {
  disk_used_percent?: number;
  metadata_used_percent?: number;
}

export interface HostMetricsHistoryGrowth {
  window_minutes: number;
  disk_used_bytes_per_hour?: number;
  metadata_used_bytes_per_hour?: number;
}

export type HostMetricsRiskLevel = "healthy" | "warning" | "critical";

export interface HostMetricsRiskState {
  level: HostMetricsRiskLevel;
  reason?: string;
  used_percent?: number;
  available_bytes?: number;
  hours_to_exhaustion?: number;
}

export interface HostMetricsAlert {
  kind: "disk" | "metadata";
  level: Exclude<HostMetricsRiskLevel, "healthy">;
  message: string;
}

export interface HostMetricsDerived {
  window_minutes: number;
  disk: HostMetricsRiskState;
  metadata: HostMetricsRiskState;
  alerts: HostMetricsAlert[];
  admission_allowed: boolean;
  auto_grow_recommended: boolean;
}

export interface HostMetricsHistory {
  window_minutes: number;
  point_count: number;
  points: HostMetricsHistoryPoint[];
  growth?: HostMetricsHistoryGrowth;
  derived?: HostMetricsDerived;
}

export interface HostMetrics {
  current?: HostCurrentMetrics;
  history?: HostMetricsHistory;
}

export interface HostRuntimeExceptionSummary {
  host_override_count: number;
  host_override_targets: HostRuntimeDeploymentTarget[];
}

export interface HostCatalog {
  provider: string;
  entries: HostCatalogEntry[];
  provider_capabilities?: Record<string, HostProviderCapabilities>;
}

export interface Host {
  id: string;
  name: string;
  owner: string; // account_id
  bay_id?: string | null;
  region: string;
  size: string; // ui preset label/key
  host_cpu_count?: number;
  host_ram_gb?: number;
  gpu: boolean;
  status: HostStatus;
  updated?: string;
  reprovision_required?: boolean;
  version?: string;
  project_host_build_id?: string;
  project_bundle_version?: string;
  project_bundle_build_id?: string;
  tools_version?: string;
  host_session_id?: string;
  host_session_started_at?: string;
  metrics?: HostMetrics;
  pressure?: HostPressureState;
  machine?: HostMachine;
  provider_instance_id?: string;
  public_ip?: string;
  public_url?: string | null;
  internal_url?: string | null;
  ssh_server?: string | null;
  last_error?: string;
  last_error_at?: string;
  projects?: number;
  last_seen?: string;
  tier?: number;
  scope?: "owned" | "collab" | "shared" | "pool";
  access_role?: HostEffectiveAccessRole;
  can_manage_access?: boolean;
  can_view_host_projects?: boolean;
  billing_owner_account_id?: string;
  project_ram_limit_mb?: number;
  host_ram_mb?: number;
  owner_spend_limit_5h_usd?: number;
  owner_spend_limit_7d_usd?: number;
  owner_spend_5h_usd?: string;
  owner_spend_7d_usd?: string;
  owner_spend_limit_state?: "ok" | "at_risk" | "stopped_limit_exceeded";
  can_start?: boolean;
  can_place?: boolean;
  reason_unavailable?: string;
  starred?: boolean;
  funding_mode?: HostFundingMode;
  billing_enforcement?: HostBillingEnforcement;
  pricing_model?: HostPricingModel;
  desired_pricing_model?: HostPricingModel;
  effective_pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
  spot_recovery_policy?: HostSpotRecoveryPolicy;
  spot_recovery_state?: HostSpotRecoveryState;
  recovery_phase?: HostSpotRecoveryPhase;
  desired_state?: "running" | "stopped";
  last_action?: string;
  last_action_at?: string;
  last_action_status?: string;
  last_action_error?: string;
  provider_observed_at?: string;
  observed_host_agent?: HostRuntimeHostAgentObservation;
  observed_components?: HostManagedComponentStatus[];
  runtime_exception_summary?: HostRuntimeExceptionSummary;
  deleted?: string;
  backup_status?: HostBackupStatus;
  bootstrap?: HostBootstrapStatus;
  bootstrap_lifecycle?: HostBootstrapLifecycle;
}

export interface HostConnectionInfo {
  host_id: string;
  bay_id?: string | null;
  name?: string | null;
  can_place?: boolean;
  region?: string | null;
  size?: string | null;
  ssh_server?: string | null;
  connect_url?: string | null;
  host_session_id?: string;
  local_proxy?: boolean;
  ready?: boolean;
  status?: HostStatus | null;
  tier?: number | null;
  pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
  desired_state?: "running" | "stopped";
  last_seen?: string;
  online?: boolean;
  reason_unavailable?: string;
}

export interface HostLogEntry {
  id: string;
  vm_id: string;
  ts?: string | null;
  action: string;
  status: string;
  provider?: string | null;
  spec?: Record<string, any> | null;
  error?: string | null;
}

export interface HostRuntimeLog {
  host_id: string;
  source: string;
  lines: number;
  text: string;
}

export interface HostSshAuthorizedKeys {
  host_id: string;
  user: string;
  home: string;
  path: string;
  keys: string[];
}

export interface HostSoftwareAvailableVersion {
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  version?: string;
  url?: string;
  sha256?: string;
  size_bytes?: number;
  built_at?: string;
  message?: string;
  available: boolean;
  error?: string;
}

export type HostSoftwareArtifact =
  | "project-host"
  | "project"
  | "project-bundle"
  | "tools"
  | "bootstrap-environment";

export type HostSoftwareChannel = "latest" | "staging";

export interface HostSoftwareUpgradeTarget {
  artifact: HostSoftwareArtifact;
  channel?: HostSoftwareChannel;
  version?: string;
}

export interface HostSoftwareUpgradeRequest {
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
  align_runtime_stack?: boolean;
}

export interface HostSoftwareUpgradeResponse {
  results: Array<{
    artifact: HostSoftwareArtifact;
    version: string;
    status: "updated" | "noop";
  }>;
}

export const HOST_RUNTIME_ARTIFACTS = [
  "project-host",
  "project-bundle",
  "tools",
  "bootstrap-environment",
] as const;

export type HostRuntimeArtifact = (typeof HOST_RUNTIME_ARTIFACTS)[number];
export type HostRuntimeDeploymentScopeType = "global" | "host";
export type HostRuntimeDeploymentTargetType = "component" | "artifact";
export type HostRuntimeDeploymentTarget =
  | ManagedComponentKind
  | HostRuntimeArtifact;
export type HostRuntimeDeploymentPolicy = ManagedComponentUpgradePolicy;

export interface HostRuntimeDeploymentRecord {
  scope_type: HostRuntimeDeploymentScopeType;
  scope_id: string;
  host_id?: string;
  target_type: HostRuntimeDeploymentTargetType;
  target: HostRuntimeDeploymentTarget;
  desired_version: string;
  rollout_policy?: HostRuntimeDeploymentPolicy;
  drain_deadline_seconds?: number;
  rollout_reason?: string;
  requested_by: string;
  requested_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
}

export interface HostRuntimeDeploymentStatus {
  host_id: string;
  configured: HostRuntimeDeploymentRecord[];
  effective: HostRuntimeDeploymentRecord[];
  observed_artifacts?: HostRuntimeArtifactObservation[];
  observed_components?: HostManagedComponentStatus[];
  observed_host_agent?: HostRuntimeHostAgentObservation;
  observed_targets?: HostRuntimeDeploymentObservedTarget[];
  rollback_targets?: HostRuntimeRollbackTarget[];
  observation_error?: string;
}

export type HostRuntimeDeploymentObservedVersionState =
  | ManagedComponentVersionState
  | "unobserved"
  | "missing"
  | "unsupported";

export interface HostRuntimeArtifactObservation {
  artifact: HostRuntimeArtifact;
  current_version?: string;
  current_build_id?: string;
  installed_versions: string[];
  version_bytes?: Array<{
    version: string;
    bytes: number;
  }>;
  installed_bytes_total?: number;
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
  retention_policy?: HostRuntimeArtifactRetentionPolicy;
}

export interface HostRuntimeHostAgentProjectHostPendingRollout {
  target_version: string;
  previous_version: string;
  started_at: string;
  deadline_at: string;
}

export interface HostRuntimeHostAgentProjectHostAutomaticRollback {
  target_version: string;
  rollback_version: string;
  started_at: string;
  finished_at: string;
  reason: "health_deadline_exceeded";
}

export type HostRuntimeHostAgentProjectHostRolloutPhase =
  | "stable"
  | "candidate_pending"
  | "restart_requested"
  | "candidate_starting"
  | "candidate_running_unhealthy"
  | "candidate_running_healthy"
  | "promoted"
  | "rollback_requested"
  | "rolled_back";

export type HostRuntimeHostAgentProjectHostRolloutFailureReason =
  "health_deadline_exceeded";

export interface HostRuntimeHostAgentProjectHostRolloutState {
  phase: HostRuntimeHostAgentProjectHostRolloutPhase;
  target_version?: string;
  previous_version?: string;
  started_at?: string;
  deadline_at?: string;
  running_pid?: number;
  running_version?: string;
  healthy?: boolean;
  accepted_at?: string;
  rollback_started_at?: string;
  rollback_finished_at?: string;
  failure_reason?: HostRuntimeHostAgentProjectHostRolloutFailureReason;
}

export interface HostRuntimeHostAgentProjectHostObservation {
  last_known_good_version?: string;
  rollout?: HostRuntimeHostAgentProjectHostRolloutState;
  pending_rollout?: HostRuntimeHostAgentProjectHostPendingRollout;
  last_automatic_rollback?: HostRuntimeHostAgentProjectHostAutomaticRollback;
}

export interface HostRuntimeHostAgentObservation {
  project_host?: HostRuntimeHostAgentProjectHostObservation;
}

export interface HostRuntimeDeploymentObservedTarget {
  target_type: HostRuntimeDeploymentTargetType;
  target: HostRuntimeDeploymentTarget;
  desired_version: string;
  rollout_policy?: HostRuntimeDeploymentPolicy;
  observed_runtime_state?: ManagedComponentRuntimeState;
  observed_version_state: HostRuntimeDeploymentObservedVersionState;
  current_version?: string;
  current_build_id?: string;
  installed_versions?: string[];
  running_versions?: string[];
  running_pids?: number[];
  enabled?: boolean;
  managed?: boolean;
}

export interface HostRuntimeRollbackTarget {
  target_type: HostRuntimeDeploymentTargetType;
  target: HostRuntimeDeploymentTarget;
  artifact: HostRuntimeArtifact;
  desired_version?: string;
  current_version?: string;
  previous_version?: string;
  last_known_good_version?: string;
  retained_versions: string[];
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
  protected_versions: string[];
  prune_candidate_versions: string[];
  retained_bytes_total?: number;
  protected_bytes_total?: number;
  prune_candidate_bytes_total?: number;
  retention_policy?: HostRuntimeArtifactRetentionPolicy;
}

export interface HostRuntimeDeploymentReconcileDecision {
  component: ManagedComponentKind;
  decision: "rollout" | "skip";
  reason: string;
  artifact?: string;
  desired_version?: string;
  current_artifact_version?: string;
  observed_version_state?: HostRuntimeDeploymentObservedVersionState;
  running_versions?: string[];
}

export interface HostRuntimeDeploymentReconcileResult {
  host_id: string;
  requested_components?: ManagedComponentKind[];
  reconciled_components: ManagedComponentKind[];
  decisions: HostRuntimeDeploymentReconcileDecision[];
  rollout_results?: any[];
}

export interface HostRuntimeDeploymentRollbackResult {
  host_id: string;
  target_type: HostRuntimeDeploymentTargetType;
  target: HostRuntimeDeploymentTarget;
  artifact: HostRuntimeArtifact;
  rollback_version: string;
  rollback_source: "explicit_version" | "previous_version" | "last_known_good";
  deployment?: HostRuntimeDeploymentRecord;
  upgrade_results?: HostSoftwareUpgradeResponse["results"];
  reconcile_result?: HostRuntimeDeploymentReconcileResult;
  managed_component_rollout?: HostManagedComponentRolloutResponse["results"];
  project_host_rollback?: {
    host_id: string;
    rollback_version: string;
  };
}

export interface HostRuntimeDeploymentUpsert {
  target_type: HostRuntimeDeploymentTargetType;
  target: HostRuntimeDeploymentTarget;
  desired_version: string;
  rollout_policy?: HostRuntimeDeploymentPolicy;
  drain_deadline_seconds?: number;
  rollout_reason?: string;
  metadata?: Record<string, any>;
}

export interface HostManagedComponentRolloutRequest {
  id: string;
  components: ManagedComponentKind[];
  reason?: string;
}

export type ExternalCredentialScope =
  | "account"
  | "project"
  | "organization"
  | "site";

export interface ExternalCredentialSelector {
  provider: string;
  kind: string;
  scope: ExternalCredentialScope;
  owner_account_id?: string;
  project_id?: string;
  organization_id?: string;
}

export interface ExternalCredentialRecord {
  id: string;
  payload: string;
  metadata: Record<string, any>;
  created: Date;
  updated: Date;
  revoked: Date | null;
  last_used: Date | null;
}

export const hosts = {
  listHosts: authFirstRequireAccount,
  listHostAccess: authFirstRequireAccount,
  setHostAccess: authFirstRequireAccount,
  removeHostAccess: authFirstRequireAccount,
  setHostProjectRamLimit: authFirstRequireAccount,
  setHostOwnerSpendLimits: authFirstRequireAccount,
  listHostProjects: authFirstRequireAccount,
  stopHostProjects: authFirstRequireAccount,
  restartHostProjects: authFirstRequireAccount,
  resolveHostConnection: authFirstRequireAccount,
  getCatalog: authFirstRequireAccount,
  updateCloudCatalog: authFirstRequireAccount,
  getHostLog: authFirstRequireAccount,
  getHostRuntimeLog: authFirstRequireAccount,
  getHostMetricsHistory: authFirstRequireAccount,
  listHostRootfsImages: authFirstRequireAccount,
  pullHostRootfsImage: authFirstRequireAccount,
  deleteHostRootfsImage: authFirstRequireAccount,
  gcDeletedHostRootfsImages: authFirstRequireAccount,
  listHostSshAuthorizedKeys: authFirstRequireAccount,
  addHostSshAuthorizedKey: authFirstRequireAccount,
  removeHostSshAuthorizedKey: authFirstRequireAccount,
  listHostSoftwareVersions: authFirstRequireAccount,
  createHost: authFirstRequireAccount,
  startHost: authFirstRequireAccount,
  stopHost: authFirstRequireAccount,
  restartHost: authFirstRequireAccount,
  drainHost: authFirstRequireAccount,
  forceDeprovisionHost: authFirstRequireAccount,
  ensureHostOwnerSshTrust: authFirstRequireAccount,
  rehomeHost: authFirstRequireAccount,
  getHostRehomeOperation: authFirstRequireAccount,
  reconcileHostRehome: authFirstRequireAccount,
  refreshHostCloudState: authFirstRequireAccount,
  listHostCloudOrphans: authFirstRequireAccount,
  removeSelfHostConnector: authFirstRequireAccount,
  renameHost: authFirstRequireAccount,
  updateHostMachine: authFirstRequireAccount,
  deleteHost: authFirstRequireAccount,
  upgradeHostSoftware: authFirstRequireAccount,
  reconcileHostSoftware: authFirstRequireAccount,
  listHostRuntimeDeployments: authFirstRequireAccount,
  getHostRuntimeDeploymentStatus: authFirstRequireAccount,
  setHostRuntimeDeployments: authFirstRequireAccount,
  reconcileHostRuntimeDeployments: authFirstRequireAccount,
  rollbackHostRuntimeDeployments: authFirstRequireAccount,
  getHostManagedComponentStatus: authFirstRequireAccount,
  rolloutHostManagedComponents: authFirstRequireAccount,
  upgradeHostConnector: authFirstRequireAccount,
  setHostStar: authFirstRequireAccount,
  getBackupConfig: authFirstRequireHost,
  getProjectOwnerEffectiveLimits: authFirstRequireHost,
  recordAcpAdmissionDenial: authFirstRequireHost,
  recordServiceAdmissionDenial: authFirstRequireHost,
  recordProjectBackup: authFirstRequireHost,
  recordProjectBackupIndex: authFirstRequireHost,
  getProjectBackupIndexes: authFirstRequireHost,
  syncProjectBackupIndexes: authFirstRequireHost,
  deleteProjectBackupIndex: authFirstRequireHost,
  touchProject: authFirstRequireHost,
  claimPendingCopies: authFirstRequireHost,
  getProjectStartMetadata: authFirstRequireHost,
  updateCopyStatus: authFirstRequireHost,
  hasExternalCredential: authFirstRequireHost,
  getExternalCredential: authFirstRequireHost,
  touchExternalCredential: authFirstRequireHost,
  upsertExternalCredential: authFirstRequireHost,
  getSiteOpenAiApiKey: authFirstRequireHost,
  checkCodexSiteUsageAllowance: authFirstRequireHost,
  recordCodexSiteUsage: authFirstRequireHost,
  issueProjectHostAgentAuthToken: authFirstRequireHost,
  getManagedRootfsReleaseArtifact: authFirstRequireHost,
  recordManagedRootfsReleaseReplica: authFirstRequireHost,
  listManagedRootfsReleaseLifecycle: authFirstRequireHost,
  issueProjectHostAuthToken: authFirstRequireAccount,
};

export interface HostConnectorUpgradeRequest {
  id: string;
  version?: string;
}

export interface Hosts {
  listHosts: (opts: {
    account_id?: string;
    admin_view?: boolean;
    include_deleted?: boolean;
    catalog?: boolean;
    show_all?: boolean;
  }) => Promise<Host[]>;
  listHostAccess: (opts: {
    account_id?: string;
    id: string;
    include_revoked?: boolean;
  }) => Promise<HostAccessEntry[]>;
  setHostAccess: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id: string;
    target_account_id?: string;
    target_email_address?: string;
    role: HostAccessRole;
  }) => Promise<HostAccessEntry>;
  removeHostAccess: (opts: {
    account_id?: string;
    id: string;
    target_account_id: string;
  }) => Promise<HostAccessEntry | undefined>;
  setHostProjectRamLimit: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id: string;
    project_ram_limit_mb?: number | null;
  }) => Promise<Host>;
  setHostOwnerSpendLimits: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id: string;
    owner_spend_limit_5h_usd?: number | null;
    owner_spend_limit_7d_usd?: number | null;
  }) => Promise<Host>;
  listHostProjects: (opts: {
    account_id?: string;
    id: string;
    limit?: number;
    cursor?: string;
    risk_only?: boolean;
    state_filter?: HostProjectStateFilter;
    project_state?: string;
  }) => Promise<HostProjectsResponse>;
  stopHostProjects: (opts: {
    account_id?: string;
    id: string;
    state_filter?: HostProjectStateFilter;
    project_state?: string;
    risk_only?: boolean;
    parallel?: number;
  }) => Promise<HostLroResponse>;
  restartHostProjects: (opts: {
    account_id?: string;
    id: string;
    state_filter?: HostProjectStateFilter;
    project_state?: string;
    risk_only?: boolean;
    parallel?: number;
  }) => Promise<HostLroResponse>;
  resolveHostConnection: (opts: {
    account_id?: string;
    host_id: string;
  }) => Promise<HostConnectionInfo>;
  getCatalog: (opts: {
    account_id?: string;
    provider?: string;
  }) => Promise<HostCatalog>;
  updateCloudCatalog: (opts: {
    account_id?: string;
    provider?: string;
  }) => Promise<void>;
  getHostLog: (opts: {
    account_id?: string;
    id: string;
    limit?: number;
  }) => Promise<HostLogEntry[]>;
  getHostRuntimeLog: (opts: {
    account_id?: string;
    id: string;
    lines?: number;
    source?: HostRuntimeLogSource;
  }) => Promise<HostRuntimeLog>;
  getHostMetricsHistory: (opts: {
    account_id?: string;
    id: string;
    window_minutes?: number;
    max_points?: number;
  }) => Promise<HostMetricsHistory>;
  listHostRootfsImages: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostRootfsImage[]>;
  pullHostRootfsImage: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
    image: string;
  }) => Promise<HostRootfsImage>;
  deleteHostRootfsImage: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
    image: string;
  }) => Promise<{ removed: boolean }>;
  gcDeletedHostRootfsImages: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
  }) => Promise<HostRootfsGcResult>;
  listHostSshAuthorizedKeys: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostSshAuthorizedKeys>;
  addHostSshAuthorizedKey: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
    public_key: string;
    user?: string;
  }) => Promise<HostSshAuthorizedKeys & { added: boolean }>;
  removeHostSshAuthorizedKey: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
    public_key: string;
  }) => Promise<HostSshAuthorizedKeys & { removed: boolean }>;
  listHostSoftwareVersions: (opts: {
    account_id?: string;
    base_url?: string;
    artifacts?: HostSoftwareArtifact[];
    channels?: HostSoftwareChannel[];
    os?: "linux" | "darwin";
    arch?: "amd64" | "arm64";
    history_limit?: number;
  }) => Promise<HostSoftwareAvailableVersion[]>;
  listHostRuntimeDeployments: (opts: {
    account_id?: string;
    scope_type: HostRuntimeDeploymentScopeType;
    id?: string;
  }) => Promise<HostRuntimeDeploymentRecord[]>;
  getHostRuntimeDeploymentStatus: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostRuntimeDeploymentStatus>;
  setHostRuntimeDeployments: (opts: {
    account_id?: string;
    scope_type: HostRuntimeDeploymentScopeType;
    id?: string;
    deployments: HostRuntimeDeploymentUpsert[];
    replace?: boolean;
  }) => Promise<HostRuntimeDeploymentRecord[]>;
  reconcileHostRuntimeDeployments: (opts: {
    account_id?: string;
    id: string;
    components?: ManagedComponentKind[];
    reason?: string;
  }) => Promise<HostLroResponse>;
  rollbackHostRuntimeDeployments: (opts: {
    account_id?: string;
    id: string;
    target_type: HostRuntimeDeploymentTargetType;
    target: HostRuntimeDeploymentTarget;
    version?: string;
    last_known_good?: boolean;
    reason?: string;
  }) => Promise<HostLroResponse>;

  // host calls getBackupConfig function to get backup configuration
  getBackupConfig: (opts: {
    host_id?: string;
    project_id?: string;
    host_region?: string | null;
    host_machine?: HostMachine | null;
  }) => Promise<ProjectBackupConfig>;
  getProjectOwnerEffectiveLimits: (opts: {
    host_id?: string;
    project_id?: string;
  }) => Promise<MembershipEffectiveLimits>;
  recordAcpAdmissionDenial: (opts: AcpAdmissionDenialRecord) => Promise<void>;
  recordServiceAdmissionDenial: (
    opts: ServiceAdmissionDenialRecord,
  ) => Promise<void>;
  recordProjectBackup: (opts: {
    host_id?: string;
    project_id: string;
    time: Date;
  }) => Promise<void>;
  recordProjectBackupIndex: (opts: {
    host_id?: string;
    project_id: string;
    backup_id: string;
    backup_time: Date | string;
    status: "complete" | "failed";
    storage_backend?: "r2-object-store";
    object_key?: string | null;
    compression?: string | null;
    sqlite_bytes?: number | null;
    object_bytes?: number | null;
    sha256?: string | null;
    error?: string | null;
  }) => Promise<void>;
  getProjectBackupIndexes: (opts: {
    host_id?: string;
    project_id: string;
  }) => Promise<ProjectBackupIndexRecord[]>;
  syncProjectBackupIndexes: (opts: {
    host_id?: string;
    project_id: string;
    backup_ids: string[];
  }) => Promise<void>;
  deleteProjectBackupIndex: (opts: {
    host_id?: string;
    project_id: string;
    backup_id: string;
  }) => Promise<void>;
  touchProject: (opts: {
    host_id?: string;
    project_id: string;
  }) => Promise<void>;
  claimPendingCopies: (opts: {
    host_id?: string;
    project_id?: string;
    limit?: number;
  }) => Promise<ProjectCopyRow[]>;
  getProjectStartMetadata: (opts: {
    host_id?: string;
    project_id: string;
  }) => Promise<{
    title?: string;
    users?: any;
    image?: string;
    authorized_keys?: string;
    run_quota?: any;
    env?: ProjectEnv;
    project_secrets_cache?: ProjectSecretsRuntimeCache;
  }>;
  updateCopyStatus: (opts: {
    host_id?: string;
    copy_id?: string;
    src_project_id?: string;
    src_path?: string;
    dest_project_id?: string;
    dest_path?: string;
    status: ProjectCopyState;
    last_error?: string;
  }) => Promise<void>;
  hasExternalCredential: (opts: {
    host_id?: string;
    project_id: string;
    selector: ExternalCredentialSelector;
  }) => Promise<boolean>;
  getExternalCredential: (opts: {
    host_id?: string;
    project_id: string;
    selector: ExternalCredentialSelector;
  }) => Promise<ExternalCredentialRecord | undefined>;
  touchExternalCredential: (opts: {
    host_id?: string;
    project_id: string;
    selector: ExternalCredentialSelector;
  }) => Promise<boolean>;
  upsertExternalCredential: (opts: {
    host_id?: string;
    project_id: string;
    selector: ExternalCredentialSelector;
    payload: string;
    metadata?: Record<string, any>;
  }) => Promise<{ id: string; created: boolean }>;
  getSiteOpenAiApiKey: (opts: { host_id?: string }) => Promise<{
    enabled: boolean;
    has_api_key: boolean;
    api_key?: string;
  }>;
  checkCodexSiteUsageAllowance: (opts: {
    host_id?: string;
    project_id: string;
    account_id: string;
    model?: string;
  }) => Promise<{
    allowed: boolean;
    reason?: string;
    window?: "5h" | "7d";
    reset_in?: string;
  }>;
  recordCodexSiteUsage: (opts: {
    host_id?: string;
    project_id: string;
    account_id: string;
    model?: string;
    path?: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_time_s: number;
  }) => Promise<{
    usage_units: number;
  }>;
  getManagedRootfsReleaseArtifact: (opts: {
    host_id?: string;
    image: string;
  }) => Promise<RootfsReleaseArtifactAccess>;
  recordManagedRootfsReleaseReplica: (opts: {
    host_id?: string;
    image: string;
    upload: Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>;
  }) => Promise<{
    artifact_id: string;
    release_id: string;
    content_key: string;
    backend: string;
    region?: string | null;
    artifact_path: string;
    artifact_sha256: string;
    artifact_bytes: number;
    status: string;
  }>;
  listManagedRootfsReleaseLifecycle: (opts: {
    host_id?: string;
    images: string[];
  }) => Promise<HostManagedRootfsReleaseLifecycle[]>;
  issueProjectHostAuthToken: (opts: {
    account_id?: string;
    host_id: string;
    project_id?: string;
    ttl_seconds?: number;
  }) => Promise<{
    host_id: string;
    token: string;
    expires_at: number;
  }>;
  issueProjectHostAgentAuthToken: (opts: {
    host_id?: string;
    account_id: string;
    project_id: string;
    ttl_seconds?: number;
  }) => Promise<{
    host_id: string;
    token: string;
    expires_at: number;
  }>;

  createHost: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    name: string;
    region: string;
    size: string;
    gpu?: boolean;
    funding_mode?: HostFundingMode;
    pricing_model?: HostPricingModel;
    interruption_restore_policy?: HostInterruptionRestorePolicy;
    machine?: HostMachine;
  }) => Promise<Host>;

  startHost: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id: string;
  }) => Promise<HostLroResponse>;
  stopHost: (opts: {
    account_id?: string;
    id: string;
    skip_backups?: boolean;
  }) => Promise<HostLroResponse>;
  restartHost: (opts: {
    account_id?: string;
    id: string;
    mode?: "reboot" | "hard";
  }) => Promise<HostLroResponse>;
  drainHost: (opts: {
    account_id?: string;
    id: string;
    dest_host_id?: string;
    force?: boolean;
    allow_offline?: boolean;
    parallel?: number;
  }) => Promise<HostLroResponse>;
  forceDeprovisionHost: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
  }) => Promise<HostLroResponse>;
  ensureHostOwnerSshTrust: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostOwnerSshTrustResult>;
  rehomeHost: (opts: {
    account_id?: string;
    id: string;
    dest_bay_id: string;
    reason?: string | null;
    campaign_id?: string | null;
  }) => Promise<HostRehomeResponse>;
  getHostRehomeOperation: (opts: {
    account_id?: string;
    op_id: string;
  }) => Promise<HostRehomeOperationSummary | null>;
  reconcileHostRehome: (opts: {
    account_id?: string;
    op_id: string;
  }) => Promise<HostRehomeResponse>;
  refreshHostCloudState: (opts: {
    account_id?: string;
    id: string;
    confirm_missing?: boolean;
  }) => Promise<HostCloudRefreshResult>;
  listHostCloudOrphans: (opts: {
    account_id?: string;
    provider: string;
  }) => Promise<HostCloudOrphansResult>;
  removeSelfHostConnector: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
  }) => Promise<HostLroResponse>;
  renameHost: (opts: {
    account_id?: string;
    id: string;
    name: string;
  }) => Promise<Host>;
  setHostStar: (opts: {
    account_id?: string;
    id: string;
    starred: boolean;
  }) => Promise<void>;
  updateHostMachine: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    id: string;
    cloud?: HostMachine["cloud"];
    cpu?: number;
    ram_gb?: number;
    disk_gb?: number;
    disk_type?: HostMachine["disk_type"];
    machine_type?: HostMachine["machine_type"];
    gpu_type?: HostMachine["gpu_type"];
    gpu_count?: number;
    storage_mode?: HostMachine["storage_mode"];
    boot_disk_gb?: number;
    self_host_ssh_target?: string;
    region?: string;
    zone?: string;
    auto_grow_enabled?: boolean;
    auto_grow_max_disk_gb?: number;
    auto_grow_growth_step_gb?: number;
    auto_grow_min_grow_interval_minutes?: number;
    funding_mode?: HostFundingMode;
    pricing_model?: HostPricingModel;
    interruption_restore_policy?: HostInterruptionRestorePolicy;
  }) => Promise<Host>;
  upgradeHostSoftware: (opts: {
    account_id?: string;
    id: string;
    targets: HostSoftwareUpgradeTarget[];
    base_url?: string;
    align_runtime_stack?: boolean;
  }) => Promise<HostLroResponse>;
  reconcileHostSoftware: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostLroResponse>;
  getHostManagedComponentStatus: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<HostManagedComponentStatus[]>;
  rolloutHostManagedComponents: (opts: {
    account_id?: string;
    id: string;
    components: ManagedComponentKind[];
    reason?: string;
  }) => Promise<HostLroResponse>;
  upgradeHostConnector: (opts: {
    account_id?: string;
    id: string;
    version?: string;
  }) => Promise<void>;
  deleteHost: (opts: {
    account_id?: string;
    session_hash?: string | null;
    id: string;
    skip_backups?: boolean;
  }) => Promise<HostLroResponse>;
}
