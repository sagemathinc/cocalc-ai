import {
  noAuth,
  authFirst,
  authFirstRequireAccount,
  requireSignedIn,
} from "./util";
import type { Customize } from "@cocalc/util/db-schema/server-settings";
import type {
  ApiKey,
  Action as ApiKeyAction,
  ApiKeyCapability,
} from "@cocalc/util/db-schema/api-keys";
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";
import type { AccountEntitlementOverride } from "./purchases";
import type {
  ProjectRootfsStateEntry,
  ProjectRootfsPublishLroRef,
  PublishProjectRootfsBody,
  RootfsAdminCatalogEntry,
  RootfsCatalogSaveBody,
  RootfsDeleteRequestResult,
  RootfsImageManifest,
  RootfsImageEntry,
  RootfsReleaseGcRunResult,
} from "@cocalc/util/rootfs-images";
import type { NewsItemWebapp } from "@cocalc/util/types/news";
import type {
  AccountRehomeOperationSummary,
  AccountRehomeResponse,
} from "@cocalc/conat/inter-bay/api";

export const system = {
  getCustomize: noAuth,
  listNews: noAuth,
  ping: noAuth,
  terminate: authFirst,
  listBays: authFirst,
  getBayOpsOverview: authFirstRequireAccount,
  getBayOpsDetail: authFirstRequireAccount,
  setBayProjectOwnershipAdmission: authFirstRequireAccount,
  getBayLoad: authFirst,
  getBayBackups: authFirst,
  getAcpAdmissionDenialReport: authFirstRequireAccount,
  getServiceAdmissionDenialReport: authFirstRequireAccount,
  getProjectBackupShards: authFirst,
  runBayBackup: authFirst,
  runBayRestore: authFirst,
  runBayRestoreTest: authFirst,
  getAccountBay: authFirstRequireAccount,
  getProjectBay: authFirstRequireAccount,
  getHostBay: authFirstRequireAccount,
  getRoutingContext: authFirstRequireAccount,
  backfillBayOwnership: authFirst,
  rebuildAccountProjectIndex: authFirst,
  drainAccountProjectIndexProjection: authFirst,
  getAccountProjectIndexProjectionStatus: authFirst,
  rebuildAccountCollaboratorIndex: authFirst,
  drainAccountCollaboratorIndexProjection: authFirst,
  getAccountCollaboratorIndexProjectionStatus: authFirst,
  rebuildAccountNotificationIndex: authFirst,
  drainAccountNotificationIndexProjection: authFirst,
  getAccountNotificationIndexProjectionStatus: authFirst,
  getParallelOpsStatus: authFirst,
  getProjectHostParallelOpsLimit: authFirst,
  setParallelOpsLimit: authFirst,
  clearParallelOpsLimit: authFirst,
  userTracking: authFirst,
  logClientError: authFirst,
  webappError: authFirst,
  manageApiKeys: authFirst,
  generateUserAuthToken: authFirst,
  createImpersonationGrant: authFirst,
  revokeUserAuthToken: noAuth,
  userSearch: authFirst,
  getNames: requireSignedIn,
  adminCreateUser: authFirst,
  deleteAccount: authFirst,
  rehomeAccount: authFirstRequireAccount,
  getAccountRehomeOperation: authFirstRequireAccount,
  reconcileAccountRehome: authFirstRequireAccount,
  drainAccountRehome: authFirstRequireAccount,
  repairAccountMembershipPortability: authFirstRequireAccount,
  adminResetPasswordLink: authFirst,
  sendEmailVerification: authFirst,
  deletePassport: authFirst,
  getAdminAssignedMembership: authFirst,
  setAdminAssignedMembership: authFirst,
  clearAdminAssignedMembership: authFirst,
  getAccountEntitlementOverride: authFirst,
  setAccountEntitlementOverride: authFirst,
  clearAccountEntitlementOverride: authFirst,
  listExternalCredentials: authFirst,
  revokeExternalCredential: authFirst,
  setOpenAiApiKey: authFirst,
  deleteOpenAiApiKey: authFirst,
  getOpenAiApiKeyStatus: authFirst,
  getCodexPaymentSource: authFirst,
  getFrontendSourceFingerprint: authFirst,
  getRootfsCatalog: authFirst,
  getRootfsCatalogAdmin: authFirstRequireAccount,
  saveRootfsCatalogEntry: authFirstRequireAccount,
  requestRootfsImageDeletion: authFirstRequireAccount,
  runRootfsReleaseGc: authFirstRequireAccount,
  publishProjectRootfsImage: authFirstRequireAccount,
  getProjectRootfsStates: authFirstRequireAccount,
  setProjectRootfsImage: authFirstRequireAccount,
  getPublicSiteUrl: authFirst,
  testR2Credentials: authFirst,
  bootstrapCloudflareConfiguration: authFirst,
  createCloudflareTeardownPlan: authFirst,
  getCloudflareTeardownPlan: authFirst,
  startCloudflareTeardownApply: authFirst,
  getCloudflareR2Usage: authFirst,
  auditCloudflareR2Bucket: authFirst,
  startCloudflareR2Audit: authFirst,
  getCloudflareR2BayBackupCleanupPlan: authFirst,
  startCloudflareR2BayBackupCleanup: authFirst,
  createProviderSetupChallenge: authFirst,
  getProviderSetupChallenge: authFirst,
  clearProviderSetupChallenge: authFirst,
  upsertBrowserSession: authFirst,
  listBrowserSessions: authFirst,
  removeBrowserSession: authFirst,
  issueBrowserSignInCookie: requireSignedIn,
  assertProjectPublicSharingAllowed: authFirst,
  getProjectAppPublicPolicy: authFirst,
  tracePublicAppHostname: authFirst,
  reserveProjectAppPublicSubdomain: authFirst,
  releaseProjectAppPublicSubdomain: authFirst,
  recordManagedProjectEgress: authFirst,
  getManagedProjectEgressPolicy: authFirst,
  resolveManagedProjectSshKeyAccount: authFirst,

  adminSalesloftSync: authFirst,
  userSalesloftSync: authFirst,
};

export type ProviderSetupChallengeProvider = "gcp" | "nebius";
export type ProviderSetupChallengeStatus = "pending" | "uploaded" | "expired";

export interface ProviderSetupChallenge {
  id: string;
  provider: ProviderSetupChallengeProvider;
  status: ProviderSetupChallengeStatus;
  created_at: string;
  expires_at: string;
  uploaded_at?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface ExternalCredentialInfo {
  id: string;
  provider: string;
  kind: string;
  scope: string;
  owner_account_id?: string;
  project_id?: string;
  organization_id?: string;
  metadata?: Record<string, any>;
  created: Date;
  updated: Date;
  revoked?: Date | null;
  last_used?: Date | null;
}

export interface CloudflareBootstrapResult {
  account_id?: string;
  account_name?: string;
  zone_id?: string;
  zone_name?: string;
  durable_token_id?: string;
  bootstrap_token_id?: string;
  bootstrap_token_invalidated?: boolean;
  bootstrap_token_invalidation_error?: string;
  tunnel_token: { ok: boolean; message?: string };
  visitor_location_headers: {
    ok: boolean;
    message?: string;
    transform_id?: string;
  };
  r2: { ok: boolean; message?: string };
  values: Record<string, string>;
  notes: string[];
}

export type CloudflareTeardownClassification =
  | "safe_owned"
  | "probably_owned"
  | "unknown"
  | "protected";

export interface CloudflareTeardownResource {
  kind: "tunnel" | "dns_record" | "r2_bucket" | "api_token";
  classification: CloudflareTeardownClassification;
  id?: string;
  name?: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface CloudflareTeardownPlanSummary {
  plan_id: string;
  status: string;
  include_r2: boolean;
  expires_at: string;
  confirmation_text: string;
  cloudflare_account_id?: string;
  zone_id?: string;
  zone_name?: string;
  selected: {
    tunnels: number;
    dns_records: number;
    r2_buckets: number;
    api_tokens: number;
  };
  counts: {
    active_projects: number;
    archived_project_candidates: number;
    projects_with_backups: number;
    r2_bucket_records: number;
    cloudflare_r2_buckets: number;
    r2_buckets_with_usage?: number;
    r2_buckets_missing_usage?: number;
    r2_objects?: number;
    r2_total_bytes?: number;
  };
  warnings: string[];
  notes: string[];
}

export interface CloudflareTeardownPlan {
  id: string;
  account_id: string;
  cloudflare_account_id?: string;
  zone_id?: string;
  zone_name?: string;
  status: string;
  include_r2: boolean;
  plan_json: {
    resources: CloudflareTeardownResource[];
    counts: CloudflareTeardownPlanSummary["counts"];
    warnings: string[];
    notes: string[];
  };
  confirmation_text: string;
  created_at: string;
  expires_at: string;
  applied_at?: string;
  summary: CloudflareTeardownPlanSummary;
}

export interface CloudflareR2BucketUsage {
  bucket: string;
  location?: string;
  jurisdiction?: string;
  storage_class?: string;
  creation_date?: string;
  object_count?: number;
  payload_bytes?: number;
  metadata_bytes?: number;
  total_bytes?: number;
  upload_count?: number;
  measured_at?: string;
  metrics_source?: "graphql" | "s3-scan" | "s3-cache" | "unavailable";
  database?: {
    known: boolean;
    provider?: string;
    purpose?: string;
    region?: string;
    status?: string;
    project_backup_repos?: number;
    assigned_projects?: number;
  };
}

export interface CloudflareR2UsageResult {
  checked_at: string;
  account_id: string;
  bucket_prefix?: string;
  filtered_by_prefix: boolean;
  bucket_count: number;
  cloudflare_bucket_count: number;
  totals: {
    object_count?: number;
    payload_bytes?: number;
    metadata_bytes?: number;
    total_bytes?: number;
    upload_count?: number;
  };
  buckets: CloudflareR2BucketUsage[];
  warnings: string[];
  notes: string[];
}

export interface CloudflareR2AuditCategory {
  category: string;
  object_count: number;
  total_bytes: number;
  examples: string[];
}

export interface CloudflareR2AuditPrefix {
  prefix: string;
  object_count: number;
  total_bytes: number;
}

export interface CloudflareR2AuditObject {
  key: string;
  size: number;
}

export interface CloudflareR2AuditUsageGroup {
  object_count: number;
  total_bytes: number;
  examples: string[];
}

export interface CloudflareR2AuditRusticRepo extends CloudflareR2AuditUsageGroup {
  repo: string;
  kind: "project-backup" | "bay-backup" | "rootfs" | "other";
}

export interface CloudflareR2AuditResult {
  audit_schema_version?: number;
  account_id: string;
  bucket: string;
  prefix?: string;
  scanned_at: string;
  cache: {
    hit: boolean;
    max_age_minutes: number;
    expires_at: string;
  };
  object_count: number;
  total_bytes: number;
  rustic_repos?: CloudflareR2AuditRusticRepo[];
  project_backup_index?: CloudflareR2AuditUsageGroup;
  rootfs_images?: CloudflareR2AuditUsageGroup;
  bay_backup_files?: CloudflareR2AuditUsageGroup;
  other?: CloudflareR2AuditUsageGroup;
  other_prefixes?: CloudflareR2AuditPrefix[];
  categories: CloudflareR2AuditCategory[];
  top_prefixes: CloudflareR2AuditPrefix[];
  top_objects: CloudflareR2AuditObject[];
  database?: CloudflareR2BucketUsage["database"];
  warnings: string[];
  notes: string[];
}

export interface CloudflareR2AuditLroRef {
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}

export interface CloudflareR2BayBackupCleanupPlan {
  bucket: string;
  prefix: string;
  checked_at: string;
  object_count: number;
  total_bytes: number;
  wal_object_count: number;
  wal_total_bytes: number;
  manifest_object_count: number;
  manifest_total_bytes: number;
  other_object_count: number;
  other_total_bytes: number;
  bay_prefixes: CloudflareR2AuditPrefix[];
  confirmation_text: string;
  warnings: string[];
  notes: string[];
}

export interface AccountMembershipPortabilityRepairCounts {
  membership_grants: number;
  membership_packages: number;
  membership_package_assignments: number;
  membership_side_effects_outbox: number;
  total: number;
}

export interface AccountMembershipPortabilityRepairBaySummary extends AccountMembershipPortabilityRepairCounts {
  bay_id: string;
}

export interface CodexPaymentSourceInfo {
  source:
    | "subscription"
    | "project-api-key"
    | "account-api-key"
    | "site-api-key"
    | "shared-home"
    | "none";
  hasSubscription: boolean;
  hasProjectApiKey: boolean;
  hasAccountApiKey: boolean;
  hasSiteApiKey: boolean;
  sharedHomeMode: "disabled" | "fallback" | "prefer" | "always";
  project_id?: string;
}

export interface FrontendSourceFingerprintInfo {
  available: boolean;
  fingerprint: string;
  git_revision: string;
  latest_mtime_ms: number | null;
  latest_mtime_iso?: string;
  latest_path?: string;
  watched_roots: string[];
  scanned_file_count: number;
  checked_at: string;
  reason?: string;
}

export interface OpenAiApiKeyStatus {
  account?: ExternalCredentialInfo;
  project?: ExternalCredentialInfo;
  project_id?: string;
}

export interface R2CredentialCheck {
  ok: boolean;
  error?: string;
  bucket_count?: number;
}

export interface R2CredentialsTestResult {
  ok: boolean;
  checked_at: string;
  account_id: string;
  endpoint: string;
  bucket_prefix?: string;
  api_token: R2CredentialCheck;
  s3: R2CredentialCheck;
  matched_buckets: string[];
  notes: string[];
}

export interface BrowserOpenProjectState {
  project_id: string;
  title?: string;
  open_files: string[];
}

export interface BrowserSessionInfo {
  browser_id: string;
  session_name?: string;
  url?: string;
  spawn_marker?: string;
  active_project_id?: string;
  open_projects: BrowserOpenProjectState[];
  created_at: string;
  updated_at: string;
  stale: boolean;
  connected?: boolean;
  connection_count?: number;
}

export interface AcpAdmissionDenialSummary {
  account_id: string | null;
  project_id: string | null;
  limit: string;
  source: string;
  count: number;
  first_time: string;
  last_time: string;
  max_current: number;
  max_maximum: number;
  sample_path?: string | null;
  sample_thread_id?: string | null;
}

export interface AcpAdmissionDenialReport {
  checked_at: string;
  since: string;
  window_minutes: number;
  min_count: number;
  groups: AcpAdmissionDenialSummary[];
}

export interface ServiceAdmissionDenialSummary {
  host_id: string | null;
  account_id: string | null;
  project_id: string | null;
  surface: string;
  limit: string;
  source: string;
  count: number;
  first_time: string;
  last_time: string;
  max_current: number;
  max_maximum: number;
  sample_subject?: string | null;
  sample_path?: string | null;
  sample_key?: string | null;
  sample_reason?: string | null;
}

export interface ServiceAdmissionDenialReport {
  checked_at: string;
  since: string;
  window_minutes: number;
  min_count: number;
  groups: ServiceAdmissionDenialSummary[];
}

export interface BrowserSignInCookieInfo {
  remember_me?: string;
  account_id?: string;
  max_age_ms?: number;
}

export interface ProjectAppPublicPolicy {
  enabled: boolean;
  launchpad: boolean;
  site_hostname?: string;
  host_hostname?: string;
  dns_domain?: string;
  subdomain_suffix: string;
  provider?: string;
  metered_egress: boolean;
  warnings: string[];
}

export type ManagedProjectEgressCategory =
  | "file-download"
  | "http-proxy"
  | "ws-proxy"
  | "ssh"
  | "interactive-conat"
  | "raw-network"
  | "backup-upload";

export interface ParallelOpsWorkerOwnerStatus {
  owner_id: string;
  active_count: number;
  stale_count: number;
}

export interface ParallelOpsWorkerBreakdownStatus {
  key: string;
  queued_count: number;
  running_count: number;
  limit?: number | null;
  extra?: Record<string, number>;
}

export interface ParallelOpsWorkerStatus {
  worker_kind: string;
  category: "lro" | "cloud-work" | "host-local";
  scope_model: "global" | "per-provider" | "per-project-host";
  dynamic_limit_supported: boolean;
  default_limit: number | null;
  configured_limit: number | null;
  effective_limit: number | null;
  config_source: "constant" | "env-legacy" | "db-override" | "env-debug-cap";
  extra_limits?: Record<string, number>;
  queued_count: number;
  running_count: number;
  stale_running_count: number | null;
  oldest_queued_ms: number | null;
  worker_instances: number;
  owners: ParallelOpsWorkerOwnerStatus[];
  breakdown: ParallelOpsWorkerBreakdownStatus[];
  notes: string[];
}

export interface ParallelOpsLimitOverride {
  worker_kind: string;
  scope_type: "global" | "provider" | "project_host";
  scope_id: string;
  limit_value: number;
  enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
  note: string | null;
}

export interface ParallelOpsLimitResolution {
  worker_kind: string;
  scope_type: "global" | "provider" | "project_host";
  scope_id: string;
  default_limit: number | null;
  configured_limit: number | null;
  effective_limit: number | null;
  config_source: "constant" | "env-legacy" | "db-override" | "env-debug-cap";
}

export interface ReserveProjectAppPublicSubdomainResult {
  hostname: string;
  label: string;
  base_path: string;
  url_public: string;
  warnings: string[];
}

export interface BayInfo {
  bay_id: string;
  label: string;
  region: string | null;
  deployment_mode: "single-bay" | "multi-bay";
  role: "combined" | "seed" | "attached";
  is_default: boolean;
  accepts_project_ownership?: boolean;
  project_ownership_note?: string | null;
}

export interface BayOpsOwnershipCounts {
  accounts: number;
  projects: number;
  project_hosts: number;
}

export interface BayOpsRehomeDirectionCounts {
  running: number;
  failed: number;
  recent_success: number;
}

export interface BayOpsRehomeCounts {
  outbound: BayOpsRehomeDirectionCounts;
  inbound: BayOpsRehomeDirectionCounts;
}

export interface BayOpsRehomeStatus {
  account: BayOpsRehomeCounts;
  project: BayOpsRehomeCounts;
  project_host: BayOpsRehomeCounts;
}

export interface BayOpsOverviewBay extends BayInfo {
  public_origin: string | null;
  public_target: string | null;
  public_target_kind: string | null;
  dns_hostname: string | null;
  last_seen: string | null;
  ownership: BayOpsOwnershipCounts;
  rehome: BayOpsRehomeStatus;
}

export interface BayOpsOverview {
  checked_at: string;
  current_bay_id: string;
  bays: BayOpsOverviewBay[];
}

export interface BayOpsDetail {
  bay_id: string;
  checked_at: string;
  load?: BayLoadInfo;
  backups?: BayBackupsInfo;
  load_error?: string | null;
  backups_error?: string | null;
  routed: boolean;
}

export interface BayLoadBrowserControlStatus {
  active_accounts: number;
  active_browsers: number;
  active_connections: number;
}

export interface BayLoadHostsStatus {
  total_hosts: number;
}

export interface BayLoadParallelOpsHotspot {
  worker_kind: string;
  category: "lro" | "cloud-work" | "host-local";
  queued_count: number;
  running_count: number;
  stale_running_count: number | null;
  worker_instances: number;
}

export interface BayLoadParallelOpsStatus {
  worker_count: number;
  queued_total: number;
  running_total: number;
  stale_running_total: number;
  hotspots: BayLoadParallelOpsHotspot[];
}

export interface BayLoadProjectionStatus {
  unpublished_events: number;
  oldest_unpublished_event_age_ms: number | null;
  maintenance_running: boolean;
  last_success_at: string | null;
}

export interface BayLoadInfo extends BayInfo {
  checked_at: string;
  browser_control: BayLoadBrowserControlStatus;
  hosts: BayLoadHostsStatus;
  parallel_ops: BayLoadParallelOpsStatus;
  projections: {
    account_project_index: BayLoadProjectionStatus;
    account_collaborator_index: BayLoadProjectionStatus;
    account_notification_index: BayLoadProjectionStatus;
  };
}

export interface BayBackupsBucketInfo {
  id: string;
  name: string;
  region: string | null;
  location: string | null;
  status: string | null;
}

export interface BayBackupsR2Status {
  configured: boolean;
  account_id_configured: boolean;
  access_key_configured: boolean;
  secret_key_configured: boolean;
  bucket_prefix: string | null;
  total_buckets: number;
  active_buckets: number;
  buckets: BayBackupsBucketInfo[];
}

export interface BayBackupsRepoInfo {
  id: string;
  region: string | null;
  bucket_id: string | null;
  bucket_name: string | null;
  root: string | null;
  status: string | null;
  assigned_project_count: number;
  created: string | null;
  updated: string | null;
}

export interface BayBackupsReposStatus {
  total_repos: number;
  active_repos: number;
  assigned_projects: number;
  repos: BayBackupsRepoInfo[];
}

export interface BayBackupsProjectsStatus {
  total_projects: number;
  host_assigned_projects: number;
  provisioned_projects: number;
  running_projects: number;
  repo_assigned_projects: number;
  repo_unassigned_projects: number;
  provisioned_up_to_date: number;
  provisioned_needs_backup: number;
  never_backed_up: number;
  latest_last_backup_at: string | null;
}

export interface ProjectBackupShardAdminRepoInfo {
  id: string;
  region: string | null;
  bucket_id: string | null;
  bucket_name: string | null;
  root: string | null;
  status: string | null;
  assigned_project_count: number;
  project_cap: number;
  available_project_slots: number;
  created: string | null;
  updated: string | null;
}

export interface ProjectBackupShardAdminRegionInfo {
  region: string;
  total_repos: number;
  active_repos: number;
  sealed_repos: number;
  draining_repos: number;
  disabled_repos: number;
  assigned_projects: number;
  active_capacity_projects: number;
  active_available_project_slots: number;
}

export interface ProjectBackupShardAdminStatus {
  checked_at: string;
  active_shards_per_region: number;
  projects_per_shard: number;
  authoritative_bay_id: string;
  regions: ProjectBackupShardAdminRegionInfo[];
  repos: ProjectBackupShardAdminRepoInfo[];
}

export interface BayBackupsPostgresStatus {
  host: string | null;
  port: number;
  user: string;
  database: string;
  current_user: string | null;
  role_superuser: boolean | null;
  role_replication: boolean | null;
  data_directory: string | null;
  config_file: string | null;
  archive_mode: string | null;
  archive_command: string | null;
  archive_timeout: string | null;
  wal_level: string | null;
  max_wal_senders: number | null;
  can_basebackup: boolean;
  preferred_strategy: "pg_basebackup" | "pg_dumpall";
}

export interface BayBackupArtifactInfo {
  name: string;
  local_path: string | null;
  object_key: string | null;
  bytes: number;
  sha256: string;
  content_type: string;
}

export interface BayBackupStatus {
  enabled: boolean;
  backup_root: string | null;
  state_file: string | null;
  archives_dir: string | null;
  manifests_dir: string | null;
  staging_dir: string | null;
  wal_archive_dir: string | null;
  r2_configured: boolean;
  current_storage_backend: "local" | "r2" | "rustic";
  bucket_name: string | null;
  bucket_region: string | null;
  bucket_endpoint: string | null;
  object_prefix_root: string | null;
  wal_object_prefix: string | null;
  rustic_repo_selector: string | null;
  latest_backup_set_id: string | null;
  latest_format: "pg_basebackup" | "pg_dumpall" | null;
  latest_storage_backend: "local" | "r2" | "rustic" | null;
  latest_local_manifest_path: string | null;
  latest_remote_manifest_key: string | null;
  latest_object_prefix: string | null;
  latest_remote_snapshot_id: string | null;
  latest_remote_snapshot_host: string | null;
  latest_artifact_count: number;
  latest_artifact_bytes: number;
  last_archived_wal_segment: string | null;
  last_uploaded_wal_segment: string | null;
  archived_wal_count: number;
  pending_wal_count: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_successful_backup_at: string | null;
  last_successful_remote_backup_at: string | null;
  last_successful_wal_archive_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  restore_state: string | null;
  full_snapshot_scheduler_enabled: boolean;
  full_snapshot_interval_ms: number | null;
  full_snapshot_retry_interval_ms: number;
  full_snapshot_retention_count: number;
  restore_workspace_retention_days: number;
  local_wal_retention_count: number;
  remote_wal_retention_backups: number;
  maintenance_running: boolean;
  maintenance_next_run_at: string | null;
  maintenance_last_started_at: string | null;
  maintenance_last_finished_at: string | null;
  maintenance_last_success_at: string | null;
  maintenance_last_error_at: string | null;
  maintenance_last_error: string | null;
  last_pruned_at: string | null;
  last_pruned_wal_count: number;
  last_pruned_remote_wal_count: number;
  last_pruned_local_archive_count: number;
  last_pruned_restore_count: number;
}

export interface BayRestoreReadinessStatus {
  latest_backup_set_id: string | null;
  latest_backup_format: "pg_basebackup" | "pg_dumpall" | null;
  latest_backup_restore_test_status:
    | "no-backup"
    | "not-run"
    | "stale"
    | "passed"
    | "failed";
  latest_backup_restore_tested: boolean;
  latest_backup_restore_tested_at: string | null;
  latest_backup_pitr_test_status:
    | "no-backup"
    | "not-recovery-ready"
    | "not-run"
    | "stale"
    | "passed"
    | "failed";
  latest_backup_pitr_tested: boolean;
  latest_backup_pitr_tested_at: string | null;
  gold_star: boolean;
  last_restore_test_backup_set_id: string | null;
  last_restore_test_status: "passed" | "failed" | null;
  last_restore_tested_at: string | null;
  last_restore_test_target_dir: string | null;
  last_restore_test_recovery_ready: boolean | null;
  last_pitr_test_backup_set_id: string | null;
  last_pitr_test_status: "passed" | "failed" | null;
  last_pitr_tested_at: string | null;
  last_pitr_test_target_time: string | null;
  last_pitr_test_target_dir: string | null;
  last_pitr_test_remote_only: boolean | null;
  summary: string;
}

export interface BayBackupsInfo extends BayInfo {
  checked_at: string;
  postgres: BayBackupsPostgresStatus;
  bay_backup: BayBackupStatus;
  restore_readiness: BayRestoreReadinessStatus;
  r2: BayBackupsR2Status;
  repos: BayBackupsReposStatus;
  projects: BayBackupsProjectsStatus;
  backup_admission: ParallelOpsWorkerStatus | null;
  backup_execution: ParallelOpsWorkerStatus | null;
}

export interface BayBackupRunResult extends BayInfo {
  started_at: string;
  finished_at: string;
  backup_set_id: string;
  format: "pg_basebackup" | "pg_dumpall";
  bucket_name: string | null;
  object_prefix: string | null;
  remote_snapshot_id: string | null;
  remote_snapshot_host: string | null;
  rustic_repo_selector: string | null;
  local_manifest_path: string;
  storage_backend: "local" | "r2" | "rustic";
  artifact_count: number;
  artifact_bytes: number;
  artifacts: BayBackupArtifactInfo[];
  postgres: BayBackupsPostgresStatus;
  bay_backup: BayBackupStatus;
}

export interface BayRestoreRunResult extends BayInfo {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  remote_only: boolean;
  target_time: string | null;
  backup_set_id: string;
  format: "pg_basebackup" | "pg_dumpall";
  target_dir: string;
  data_dir: string | null;
  sync_dir: string | null;
  secrets_dir: string | null;
  backup_manifest_path: string | null;
  restore_manifest_path: string | null;
  source_storage_backend: "local" | "r2" | "rustic";
  source_snapshot_id: string | null;
  rustic_repo_selector: string | null;
  wal_archive_dir: string | null;
  wal_storage_backend: "local" | "r2" | null;
  artifact_count: number;
  wal_segment_count: number;
  recovery_ready: boolean;
  notes: string[];
}

export interface BayRestoreTestRunResult extends BayInfo {
  started_at: string;
  finished_at: string;
  remote_only: boolean;
  target_time: string | null;
  backup_set_id: string;
  target_dir: string;
  data_dir: string | null;
  sync_dir: string | null;
  secrets_dir: string | null;
  backup_manifest_path: string | null;
  restore_manifest_path: string | null;
  source_storage_backend: "local" | "r2" | "rustic";
  source_snapshot_id: string | null;
  rustic_repo_selector: string | null;
  wal_archive_dir: string | null;
  wal_storage_backend: "local" | "r2" | null;
  wal_segment_count: number;
  recovery_ready: boolean;
  pitr_verified: boolean;
  pitr_run_id: string | null;
  kept_on_disk: boolean;
  verified_queries: string[];
  notes: string[];
}

export interface AccountBayLocation {
  account_id: string;
  email_address?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  home_bay_id: string;
  source: "account-row" | "cluster-directory" | "single-bay-default";
}

export interface ProjectBayLocation {
  project_id: string;
  owning_bay_id: string;
  host_id: string | null;
  title: string;
  source: "project-row" | "single-bay-default";
}

export interface HostBayLocation {
  host_id: string;
  bay_id: string;
  name: string;
  source: "host-row" | "single-bay-default";
}

export interface RoutingContextLocation {
  account: AccountBayLocation;
  project: ProjectBayLocation;
  host: HostBayLocation | null;
}

export interface AccountRehomeDrainResult {
  source_bay_id: string;
  dest_bay_id: string;
  dry_run: boolean;
  limit: number;
  campaign_id: string | null;
  only_if_tag: string | null;
  candidate_count: number;
  candidates: string[];
  rehomed: AccountRehomeResponse[];
  errors: Array<{ account_id: string; error: string }>;
}

export interface BayOwnershipBackfillResult {
  bay_id: string;
  dry_run: boolean;
  limit_per_table: number | null;
  accounts_missing: number;
  projects_missing: number;
  hosts_missing: number;
  accounts_updated: number;
  projects_updated: number;
  hosts_updated: number;
}

export interface AccountProjectIndexRebuildResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_rows: number;
  visible_rows: number;
  hidden_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountProjectIndexProjectionDrainResult {
  bay_id: string;
  dry_run: boolean;
  requested_limit: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountProjectIndexProjectionBacklogStatus {
  bay_id: string;
  checked_at: string;
  unpublished_events: number;
  unpublished_event_types: Record<string, number>;
  oldest_unpublished_event_at: string | null;
  newest_unpublished_event_at: string | null;
  oldest_unpublished_event_age_ms: number | null;
  newest_unpublished_event_age_ms: number | null;
}

export interface AccountProjectIndexProjectionPassSummary {
  bay_id: string;
  batches: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountProjectIndexProjectionMaintenanceStatus {
  enabled: boolean;
  observed_bay_id: string;
  interval_ms: number;
  batch_limit: number;
  max_batches_per_tick: number;
  running: boolean;
  started_at: string | null;
  last_tick_started_at: string | null;
  last_tick_finished_at: string | null;
  last_tick_duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_result: AccountProjectIndexProjectionPassSummary | null;
}

export interface AccountProjectIndexProjectionStatus {
  bay_id: string;
  backlog: AccountProjectIndexProjectionBacklogStatus;
  maintenance: AccountProjectIndexProjectionMaintenanceStatus;
}

export interface AccountCollaboratorIndexRebuildResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_project_rows: number;
  source_collaborator_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountCollaboratorIndexProjectionDrainResult {
  bay_id: string;
  dry_run: boolean;
  requested_limit: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountCollaboratorIndexProjectionBacklogStatus {
  bay_id: string;
  checked_at: string;
  unpublished_events: number;
  unpublished_event_types: Record<string, number>;
  oldest_unpublished_event_at: string | null;
  newest_unpublished_event_at: string | null;
  oldest_unpublished_event_age_ms: number | null;
  newest_unpublished_event_age_ms: number | null;
}

export interface AccountCollaboratorIndexProjectionPassSummary {
  bay_id: string;
  batches: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountCollaboratorIndexProjectionMaintenanceStatus {
  enabled: boolean;
  observed_bay_id: string;
  interval_ms: number;
  batch_limit: number;
  max_batches_per_tick: number;
  running: boolean;
  started_at: string | null;
  last_tick_started_at: string | null;
  last_tick_finished_at: string | null;
  last_tick_duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_result: AccountCollaboratorIndexProjectionPassSummary | null;
}

export interface AccountCollaboratorIndexProjectionStatus {
  bay_id: string;
  backlog: AccountCollaboratorIndexProjectionBacklogStatus;
  maintenance: AccountCollaboratorIndexProjectionMaintenanceStatus;
}

export interface AccountNotificationIndexRebuildResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_rows: number;
  unread_rows: number;
  saved_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountNotificationIndexProjectionDrainResult {
  bay_id: string;
  dry_run: boolean;
  requested_limit: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountNotificationIndexProjectionBacklogStatus {
  bay_id: string;
  checked_at: string;
  unpublished_events: number;
  unpublished_event_types: Record<string, number>;
  oldest_unpublished_event_at: string | null;
  newest_unpublished_event_at: string | null;
  oldest_unpublished_event_age_ms: number | null;
  newest_unpublished_event_age_ms: number | null;
}

export interface AccountNotificationIndexProjectionPassSummary {
  bay_id: string;
  batches: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  event_types: Record<string, number>;
}

export interface AccountNotificationIndexProjectionMaintenanceStatus {
  enabled: boolean;
  observed_bay_id: string;
  interval_ms: number;
  batch_limit: number;
  max_batches_per_tick: number;
  running: boolean;
  started_at: string | null;
  last_tick_started_at: string | null;
  last_tick_finished_at: string | null;
  last_tick_duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_result: AccountNotificationIndexProjectionPassSummary | null;
}

export interface AccountNotificationIndexProjectionStatus {
  bay_id: string;
  backlog: AccountNotificationIndexProjectionBacklogStatus;
  maintenance: AccountNotificationIndexProjectionMaintenanceStatus;
}

export interface PublicAppHostnameTrace {
  matched: boolean;
  hostname: string;
  project_id?: string;
  app_id?: string;
  base_path?: string;
  site_hostname?: string;
  host_hostname?: string;
  dns_domain?: string;
  subdomain_suffix?: string;
  dns_target?: string;
  metered_egress?: boolean;
  warnings?: string[];
}

export interface System {
  // get all or specific customize data
  getCustomize: (fields?: string[]) => Promise<Customize>;
  listNews: () => Promise<NewsItemWebapp[]>;
  // ping server and get back the current time
  ping: () => { now: number };
  // terminate a service:
  //   - only admin can do this.
  //   - useful for development
  terminate: (service: "database" | "api") => Promise<void>;

  listBays: (opts?: { account_id?: string }) => Promise<BayInfo[]>;

  getBayOpsOverview: (opts?: {
    account_id?: string;
  }) => Promise<BayOpsOverview>;

  getBayOpsDetail: (opts: {
    account_id?: string;
    bay_id: string;
  }) => Promise<BayOpsDetail>;

  setBayProjectOwnershipAdmission: (opts: {
    account_id?: string;
    bay_id: string;
    accepts_project_ownership: boolean;
    note?: string | null;
  }) => Promise<BayInfo>;

  getBayLoad: (opts?: {
    account_id?: string;
    bay_id?: string;
  }) => Promise<BayLoadInfo>;

  getBayBackups: (opts?: {
    account_id?: string;
    bay_id?: string;
  }) => Promise<BayBackupsInfo>;

  getAcpAdmissionDenialReport: (opts?: {
    account_id?: string;
    window_minutes?: number;
    min_count?: number;
    limit?: number;
    user_account_id?: string | null;
    project_id?: string | null;
    denial_limit?: string | null;
    source?: string | null;
  }) => Promise<AcpAdmissionDenialReport>;

  getServiceAdmissionDenialReport: (opts?: {
    account_id?: string;
    window_minutes?: number;
    min_count?: number;
    limit?: number;
    user_account_id?: string | null;
    project_id?: string | null;
    surface?: string | null;
    denial_limit?: string | null;
    source?: string | null;
  }) => Promise<ServiceAdmissionDenialReport>;

  getProjectBackupShards: (opts?: {
    account_id?: string;
    region?: string | null;
  }) => Promise<ProjectBackupShardAdminStatus>;

  runBayBackup: (opts?: {
    account_id?: string;
    bay_id?: string;
  }) => Promise<BayBackupRunResult>;

  runBayRestore: (opts?: {
    account_id?: string;
    bay_id?: string;
    backup_set_id?: string;
    target_dir?: string;
    dry_run?: boolean;
    remote_only?: boolean;
    target_time?: string;
  }) => Promise<BayRestoreRunResult>;

  runBayRestoreTest: (opts?: {
    account_id?: string;
    bay_id?: string;
    backup_set_id?: string;
    target_dir?: string;
    keep?: boolean;
    remote_only?: boolean;
  }) => Promise<BayRestoreTestRunResult>;

  getAccountBay: (opts?: {
    account_id?: string;
    user_account_id?: string;
  }) => Promise<AccountBayLocation>;

  getProjectBay: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectBayLocation>;

  getHostBay: (opts: {
    account_id?: string;
    host_id: string;
  }) => Promise<HostBayLocation>;

  getRoutingContext: (opts: {
    account_id?: string;
    user_account_id?: string;
    project_id: string;
    host_id?: string | null;
  }) => Promise<RoutingContextLocation>;

  getParallelOpsStatus: (opts?: {
    account_id?: string;
  }) => Promise<ParallelOpsWorkerStatus[]>;

  getProjectHostParallelOpsLimit: (opts?: {
    account_id?: string;
    host_id?: string;
    worker_kind: string;
  }) => Promise<ParallelOpsLimitResolution>;

  setParallelOpsLimit: (opts: {
    account_id?: string;
    worker_kind: string;
    scope_type?: "global" | "provider" | "project_host";
    scope_id?: string;
    limit_value: number;
    note?: string;
  }) => Promise<ParallelOpsLimitOverride>;

  clearParallelOpsLimit: (opts: {
    account_id?: string;
    worker_kind: string;
    scope_type?: "global" | "provider" | "project_host";
    scope_id?: string;
  }) => Promise<void>;

  userTracking: (opts: {
    event: string;
    value: object;
    account_id?: string;
  }) => Promise<void>;

  logClientError: (opts: {
    account_id?: string;
    event: string;
    error: string;
  }) => Promise<void>;

  webappError: (opts: object) => Promise<void>;

  manageApiKeys: (opts: {
    account_id?: string;
    action: ApiKeyAction;
    name?: string;
    expire?: Date;
    capabilities?: ApiKeyCapability[];
    allowed_project_ids?: string[];
    id?: number;
  }) => Promise<ApiKey[] | undefined>;

  generateUserAuthToken: (opts: {
    account_id?: string;
    user_account_id: string;
    password?: string;
  }) => Promise<string>;

  createImpersonationGrant: (opts: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    subject_account_id: string;
    reason?: string | null;
    lang_temp?: string | null;
  }) => Promise<{
    grant_id: string;
    subject_account_id: string;
    subject_home_bay_id: string;
    home_bay_url?: string;
    url: string;
    expires_at: Date;
  }>;

  revokeUserAuthToken: (authToken: string) => Promise<void>;

  userSearch: (opts: {
    account_id?: string;
    query: string;
    limit?: number;
    admin?: boolean;
    only_email?: boolean;
  }) => Promise<UserSearchResult[]>;

  getNames: (account_ids: string[]) => Promise<{
    [account_id: string]:
      | {
          first_name: string;
          last_name: string;
          profile?: { color?: string; image?: string };
        }
      | undefined;
  }>;

  adminCreateUser: (opts: {
    account_id?: string;
    email: string;
    password?: string;
    first_name?: string;
    last_name?: string;
    tags?: string[];
  }) => Promise<{
    account_id: string;
    email_address: string;
    first_name: string;
    last_name: string;
    created_by: string;
    password_generated: boolean;
    generated_password?: string;
  }>;

  deleteAccount: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    only_if_tag?: string;
  }) => Promise<{
    account_id: string;
    home_bay_id: string;
    status: "deleted";
  }>;

  rehomeAccount: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    dest_bay_id: string;
    reason?: string | null;
    campaign_id?: string | null;
  }) => Promise<AccountRehomeResponse>;

  getAccountRehomeOperation: (opts: {
    account_id?: string;
    op_id: string;
    source_bay_id?: string;
  }) => Promise<AccountRehomeOperationSummary | null>;

  reconcileAccountRehome: (opts: {
    account_id?: string;
    op_id: string;
    source_bay_id?: string;
  }) => Promise<AccountRehomeResponse>;

  drainAccountRehome: (opts: {
    account_id?: string;
    session_hash?: string | null;
    source_bay_id?: string;
    dest_bay_id: string;
    limit?: number;
    dry_run?: boolean;
    campaign_id?: string | null;
    reason?: string | null;
    only_if_tag?: string | null;
  }) => Promise<AccountRehomeDrainResult>;

  repairAccountMembershipPortability: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    dry_run?: boolean;
    clear_stale?: boolean;
  }) => Promise<{
    account_id: string;
    home_bay_id: string;
    dry_run: boolean;
    clear_stale: boolean;
    scanned_bays: AccountMembershipPortabilityRepairBaySummary[];
    source_bays_with_rows: string[];
    stale_bay_ids: string[];
    cleared_stale_bay_ids: string[];
    merged_counts: AccountMembershipPortabilityRepairCounts;
    applied: boolean;
  }>;

  backfillBayOwnership: (opts: {
    account_id?: string;
    bay_id?: string;
    dry_run?: boolean;
    limit_per_table?: number;
  }) => Promise<BayOwnershipBackfillResult>;

  rebuildAccountProjectIndex: (opts: {
    account_id?: string;
    target_account_id: string;
    dry_run?: boolean;
  }) => Promise<AccountProjectIndexRebuildResult>;
  drainAccountProjectIndexProjection: (opts?: {
    account_id?: string;
    bay_id?: string;
    limit?: number;
    dry_run?: boolean;
  }) => Promise<AccountProjectIndexProjectionDrainResult>;
  getAccountProjectIndexProjectionStatus: (opts?: {
    account_id?: string;
  }) => Promise<AccountProjectIndexProjectionStatus>;
  rebuildAccountCollaboratorIndex: (opts: {
    account_id?: string;
    target_account_id: string;
    dry_run?: boolean;
  }) => Promise<AccountCollaboratorIndexRebuildResult>;
  drainAccountCollaboratorIndexProjection: (opts?: {
    account_id?: string;
    bay_id?: string;
    limit?: number;
    dry_run?: boolean;
  }) => Promise<AccountCollaboratorIndexProjectionDrainResult>;
  getAccountCollaboratorIndexProjectionStatus: (opts?: {
    account_id?: string;
  }) => Promise<AccountCollaboratorIndexProjectionStatus>;
  rebuildAccountNotificationIndex: (opts: {
    account_id?: string;
    target_account_id: string;
    dry_run?: boolean;
  }) => Promise<AccountNotificationIndexRebuildResult>;
  drainAccountNotificationIndexProjection: (opts?: {
    account_id?: string;
    bay_id?: string;
    limit?: number;
    dry_run?: boolean;
  }) => Promise<AccountNotificationIndexProjectionDrainResult>;
  getAccountNotificationIndexProjectionStatus: (opts?: {
    account_id?: string;
  }) => Promise<AccountNotificationIndexProjectionStatus>;

  // adminResetPasswordLink: Enables admins (and only admins!) to generate and get a password reset
  // for another user.  The response message contains a password reset link,
  // though without the site part of the url (the client should fill that in).
  // This makes it possible for admins to reset passwords of users, even if
  // sending email is not setup, e.g., for cocalc-docker, and also deals with the
  // possibility that users have no email address, or broken email, or they
  // can't receive email due to crazy spam filtering.
  // Non-admins always get back an error.
  adminResetPasswordLink: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
  }) => Promise<string>;

  // user must be an admin or get an error. Sync's the given salesloft accounts.
  adminSalesloftSync: (opts: {
    account_id?: string;
    account_ids: string[];
  }) => Promise<void>;

  userSalesloftSync: (opts: { account_id?: string }) => Promise<void>;

  sendEmailVerification: (opts: {
    account_id?: string;
    only_verify?: boolean;
  }) => Promise<void>;

  deletePassport: (opts: {
    account_id?: string;
    strategy: string;
    id: string;
  }) => Promise<void>;

  getAdminAssignedMembership: (opts: {
    account_id?: string;
    user_account_id: string;
  }) => Promise<
    | {
        account_id: string;
        membership_class: string;
        assigned_by: string;
        assigned_at: Date;
        expires_at?: Date | null;
        notes?: string | null;
      }
    | undefined
  >;

  setAdminAssignedMembership: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    membership_class: string;
    expires_at?: Date | null;
    notes?: string | null;
  }) => Promise<void>;

  clearAdminAssignedMembership: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
  }) => Promise<void>;

  getAccountEntitlementOverride: (opts: {
    account_id?: string;
    user_account_id: string;
  }) => Promise<AccountEntitlementOverride | undefined>;

  setAccountEntitlementOverride: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    override: Omit<
      Partial<AccountEntitlementOverride>,
      "account_id" | "updated_by" | "updated_at"
    >;
    reason: string;
  }) => Promise<AccountEntitlementOverride>;

  clearAccountEntitlementOverride: (opts: {
    account_id?: string;
    session_hash?: string | null;
    user_account_id: string;
    reason: string;
  }) => Promise<void>;

  listExternalCredentials: (opts: {
    account_id?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    include_revoked?: boolean;
  }) => Promise<ExternalCredentialInfo[]>;

  revokeExternalCredential: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<{ revoked: boolean }>;

  setOpenAiApiKey: (opts: {
    account_id?: string;
    api_key: string;
    project_id?: string;
  }) => Promise<{
    id: string;
    created: boolean;
    scope: "account" | "project";
    project_id?: string;
  }>;

  deleteOpenAiApiKey: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<{
    revoked: boolean;
    scope: "account" | "project";
    project_id?: string;
  }>;

  getOpenAiApiKeyStatus: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<OpenAiApiKeyStatus>;

  getCodexPaymentSource: (opts: {
    account_id?: string;
    project_id?: string;
  }) => Promise<CodexPaymentSourceInfo>;

  getFrontendSourceFingerprint: (opts?: {
    account_id?: string;
  }) => Promise<FrontendSourceFingerprintInfo>;

  getRootfsCatalog: (opts?: {
    account_id?: string;
  }) => Promise<RootfsImageManifest>;

  getRootfsCatalogAdmin: (opts?: {
    account_id?: string;
  }) => Promise<RootfsAdminCatalogEntry[]>;

  saveRootfsCatalogEntry: (
    opts: RootfsCatalogSaveBody & { account_id?: string },
  ) => Promise<RootfsImageEntry>;

  requestRootfsImageDeletion: (opts: {
    image_id: string;
    reason?: string;
    account_id?: string;
  }) => Promise<RootfsDeleteRequestResult>;

  runRootfsReleaseGc: (opts: {
    limit?: number;
    account_id?: string;
  }) => Promise<RootfsReleaseGcRunResult>;

  publishProjectRootfsImage: (
    opts: PublishProjectRootfsBody & { account_id?: string },
  ) => Promise<ProjectRootfsPublishLroRef>;

  getProjectRootfsStates: (opts: {
    project_id: string;
    account_id?: string;
  }) => Promise<ProjectRootfsStateEntry[]>;

  setProjectRootfsImage: (opts: {
    project_id: string;
    image: string;
    image_id?: string;
    account_id?: string;
  }) => Promise<ProjectRootfsStateEntry[]>;

  getPublicSiteUrl: (opts?: {
    account_id?: string;
  }) => Promise<{ url: string }>;

  testR2Credentials: (opts: {
    account_id?: string;
    overrides?: {
      r2_account_id?: string;
      r2_api_token?: string;
      r2_access_key_id?: string;
      r2_secret_access_key?: string;
      r2_bucket_prefix?: string;
      r2_endpoint?: string;
    };
  }) => Promise<R2CredentialsTestResult>;

  bootstrapCloudflareConfiguration: (opts: {
    account_id?: string;
    domain: string;
    token: string;
    tunnelPrefix?: string;
    hostSuffix?: string;
    r2BucketPrefix?: string;
    invalidateBootstrapToken?: boolean;
  }) => Promise<CloudflareBootstrapResult>;

  createCloudflareTeardownPlan: (opts: {
    account_id?: string;
    include_r2?: boolean;
  }) => Promise<CloudflareTeardownPlan>;

  getCloudflareTeardownPlan: (opts: {
    account_id?: string;
    plan_id: string;
  }) => Promise<CloudflareTeardownPlan>;

  startCloudflareTeardownApply: (opts: {
    account_id?: string;
    session_hash?: string;
    plan_id: string;
    confirm: string;
    delete_r2_contents?: boolean;
    reset_local_settings?: boolean;
  }) => Promise<CloudflareR2AuditLroRef>;

  getCloudflareR2Usage: (opts: {
    account_id?: string;
    all_buckets?: boolean;
    scan?: boolean;
    refresh?: boolean;
    max_age_minutes?: number;
  }) => Promise<CloudflareR2UsageResult>;

  auditCloudflareR2Bucket: (opts: {
    account_id?: string;
    bucket: string;
    prefix?: string;
    refresh?: boolean;
    max_age_minutes?: number;
  }) => Promise<CloudflareR2AuditResult>;

  startCloudflareR2Audit: (opts: {
    account_id?: string;
    bucket: string;
    prefix?: string;
    refresh?: boolean;
    max_age_minutes?: number;
  }) => Promise<CloudflareR2AuditLroRef>;

  getCloudflareR2BayBackupCleanupPlan: (opts: {
    account_id?: string;
    bucket: string;
    prefix?: string;
  }) => Promise<CloudflareR2BayBackupCleanupPlan>;

  startCloudflareR2BayBackupCleanup: (opts: {
    account_id?: string;
    bucket: string;
    prefix?: string;
    confirm: string;
  }) => Promise<CloudflareR2AuditLroRef>;

  createProviderSetupChallenge: (opts: {
    account_id?: string;
    provider: ProviderSetupChallengeProvider;
  }) => Promise<ProviderSetupChallenge & { token: string }>;

  getProviderSetupChallenge: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<ProviderSetupChallenge>;

  clearProviderSetupChallenge: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<{ deleted: boolean }>;

  upsertBrowserSession: (opts: {
    account_id?: string;
    browser_id: string;
    session_name?: string;
    url?: string;
    spawn_marker?: string;
    active_project_id?: string;
    open_projects?: BrowserOpenProjectState[];
  }) => Promise<{
    browser_id: string;
    created_at: string;
    updated_at: string;
  }>;

  listBrowserSessions: (opts?: {
    account_id?: string;
    max_age_ms?: number;
    include_stale?: boolean;
  }) => Promise<BrowserSessionInfo[]>;

  removeBrowserSession: (opts: {
    account_id?: string;
    browser_id: string;
  }) => Promise<{ removed: boolean }>;

  issueBrowserSignInCookie: (opts?: {
    account_id?: string;
    max_age_ms?: number;
  }) => Promise<BrowserSignInCookieInfo>;

  assertProjectPublicSharingAllowed: (opts?: {
    account_id?: string;
    project_id?: string;
  }) => Promise<{
    allowed: true;
    project_id: string;
    checked_account_ids: string[];
  }>;

  getProjectAppPublicPolicy: (opts?: {
    account_id?: string;
    project_id?: string;
  }) => Promise<ProjectAppPublicPolicy>;

  tracePublicAppHostname: (opts: {
    account_id?: string;
    host_id?: string;
    hostname: string;
  }) => Promise<PublicAppHostnameTrace>;

  reserveProjectAppPublicSubdomain: (opts: {
    account_id?: string;
    project_id?: string;
    app_id: string;
    base_path: string;
    ttl_s: number;
    preferred_label?: string;
    random_subdomain?: boolean;
  }) => Promise<ReserveProjectAppPublicSubdomainResult>;

  releaseProjectAppPublicSubdomain: (opts: {
    account_id?: string;
    project_id?: string;
    app_id: string;
  }) => Promise<{ released: boolean }>;

  recordManagedProjectEgress: (opts: {
    account_id?: string;
    project_id?: string;
    category: ManagedProjectEgressCategory;
    bytes: number;
    metadata?: Record<string, unknown>;
  }) => Promise<{ recorded: boolean; account_id?: string }>;

  getManagedProjectEgressPolicy: (opts: {
    account_id?: string;
    project_id?: string;
    category: ManagedProjectEgressCategory;
  }) => Promise<{
    account_id?: string;
    category: ManagedProjectEgressCategory;
    allowed: boolean;
    blocked_by?: "5h" | "7d";
    managed_egress_5h_bytes?: number;
    managed_egress_7d_bytes?: number;
    egress_5h_bytes?: number;
    egress_7d_bytes?: number;
    managed_egress_categories_5h_bytes?: Record<string, number>;
    managed_egress_categories_7d_bytes?: Record<string, number>;
  }>;

  resolveManagedProjectSshKeyAccount: (opts: {
    project_id: string;
    fingerprint: string;
  }) => Promise<{ account_id?: string }>;
}
