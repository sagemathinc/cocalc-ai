/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { MAX_INTEREST_TIMEOUT, type Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { ConatService } from "@cocalc/conat/service/typed";
import type { Options, ServiceCall } from "@cocalc/conat/service/service";
import type {
  AccountFeedProjectRemoveEvent,
  AccountFeedProjectUpsertEvent,
} from "@cocalc/conat/hub/api/account-feed";
import type { LroEvent, LroSummary } from "@cocalc/conat/hub/api/lro";
import type {
  Host,
  HostConnectionInfo,
  Hosts,
} from "@cocalc/conat/hub/api/hosts";
import type {
  ClaimableMembershipPackage,
  AccountEntitlementOverride,
  MembershipDetails,
  MembershipEffectiveLimits,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipResolution,
} from "@cocalc/conat/hub/api/purchases";
import type { BayBackupsInfo, BayLoadInfo } from "@cocalc/conat/hub/api/system";
import type {
  ProjectActiveOperationSummary,
  ProjectBackupSchedule,
  ProjectCollabInviteAction,
  ProjectCollabInviteDirection,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
  ProjectCourseInfo,
  ProjectCreated,
  ProjectEnv,
  ProjectLauncherSettings,
  ProjectLogRow,
  ProjectQuotaSettings,
  ProjectRegion,
  ProjectRootfsConfig,
  ProjectRunQuota,
  ProjectSnapshotSchedule,
} from "@cocalc/conat/hub/api/projects";
import type {
  HostAgentStatus,
  HostControlApi,
  HostCreateProjectRequest,
  HostCreateProjectResponse,
  HostBackupExecutionStatus,
  HostInstalledRuntimeArtifactStatus,
  HostInstalledRuntimeArtifactsRequest,
  HostManagedComponentStatus,
  HostManagedComponentRolloutRequest,
  HostManagedComponentRolloutResponse,
  HostProjectRuntimeLogResponse,
  HostRootfsCacheEntry,
  HostRootfsManifest,
  HostRuntimeLogResponse,
  HostSshAuthorizedKeysResponse,
  HostStaticAppPathInspection,
  UpgradeSoftwareRequest,
  UpgradeSoftwareResponse,
} from "@cocalc/conat/project-host/api";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import type { ProjectState } from "@cocalc/util/db-schema/projects";
import type { MoneyValue } from "@cocalc/util/money";

export interface BayOwnership {
  bay_id: string;
  epoch: number;
}

export interface ProjectReference {
  project_id: string;
  title: string;
  host_id: string | null;
  owning_bay_id: string;
  users?: Record<string, any>;
}

export interface ProjectDetails {
  launcher: ProjectLauncherSettings;
  region: ProjectRegion;
  created: ProjectCreated;
  env: ProjectEnv;
  rootfs: ProjectRootfsConfig | null;
  snapshots: ProjectSnapshotSchedule;
  backups: ProjectBackupSchedule;
  run_quota: ProjectRunQuota;
  settings: ProjectQuotaSettings;
  course: ProjectCourseInfo;
}

export interface ResolveProjectBayRequest {
  project_id: string;
}

export interface ResolveHostBayRequest {
  host_id: string;
  include_deleted?: boolean;
}

export interface ProjectControlStartRequest {
  project_id: string;
  account_id: string;
  restore_backup_id?: string;
  lro_op_id?: string;
  source_bay_id?: string;
  managed_egress_override?: "admin-host-drain";
  epoch?: number;
}

export interface ProjectControlStopRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectControlRestartRequest {
  project_id: string;
  account_id: string;
  lro_op_id?: string;
  source_bay_id?: string;
  epoch?: number;
}

export interface ProjectControlBackupRequest {
  project_id: string;
  account_id?: string;
  tags?: string[];
  managed_egress_override?: "admin-host-drain";
  epoch?: number;
}

export interface ProjectControlStateRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectControlSetUsageAccountRequest {
  project_id: string;
  usage_account_id?: string | null;
  expected_current_usage_account_id?: string | null;
  epoch?: number;
}

export interface ProjectControlSetUsageAccountResponse {
  updated: boolean;
}

export interface ProjectControlAddressRequest {
  project_id: string;
  account_id: string;
  epoch?: number;
}

export interface ProjectControlMoveRequest {
  project_id: string;
  account_id: string;
  dest_host_id?: string;
  allow_offline?: boolean;
  backup_region_cutover?: boolean;
  epoch?: number;
}

export interface ProjectControlMoveResponse {
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}

export interface ProjectControlRehomeRequest {
  project_id: string;
  account_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
  epoch?: number;
}

export interface ProjectControlAcceptRehomeRequest {
  project_id: string;
  account_id?: string;
  source_bay_id: string;
  dest_bay_id: string;
  project: Record<string, unknown>;
  portable_state?: ProjectControlPortableProjectState;
  epoch?: number;
}

export interface ProjectControlPortableProjectState {
  project_log?: ProjectLogRow[];
  api_keys?: Record<string, unknown>[];
}

export interface ProjectControlRehomeResponse {
  op_id?: string;
  project_id: string;
  previous_bay_id: string;
  owning_bay_id: string;
  operation_stage?:
    | "requested"
    | "destination_accepted"
    | "source_flipped"
    | "portable_state_copied"
    | "projected"
    | "complete";
  operation_status?: "running" | "succeeded" | "failed";
  status: "rehomed" | "already-home";
}

export interface ProjectControlActiveOperationRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectAddress {
  host: string;
  port: number;
  secret_token: string;
}

export interface GetProjectReferenceRequest {
  project_id: string;
  account_id: string;
}

export interface GetProjectDetailsRequest {
  project_id: string;
  account_id: string;
}

export interface GetHostConnectionRequest {
  host_id: string;
  account_id: string;
}

export interface HostRehomePrepareRequest {
  host_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  host?: Record<string, unknown>;
  epoch?: number;
}

export interface HostOwnerSshTrustRequest {
  host_id: string;
  account_id: string;
  host?: Record<string, unknown>;
  epoch?: number;
}

export interface HostOwnerSshTrustResponse {
  host_id: string;
  bay_id: string;
  public_key: string;
  host_control_attempted: boolean;
  host_control_succeeded: boolean;
  cloud_provider_attempted: boolean;
  cloud_provider_succeeded: boolean;
}

export interface HostRehomeRequest {
  host_id: string;
  account_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
  epoch?: number;
}

export interface HostRehomePrepareResponse {
  host_id: string;
  dest_bay_id: string;
  owner_bay_public_key?: string;
  owner_bay_public_key_installed: boolean;
  owner_bay_public_key_cloud_attempted?: boolean;
  owner_bay_public_key_trusted_by_cloud?: boolean;
}

export interface HostRehomeAcceptRequest {
  host_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  host: Record<string, unknown>;
  epoch?: number;
}

export interface HostRehomeReconnectRequest {
  host_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  epoch?: number;
}

export interface HostRehomeResponse {
  host_id: string;
  previous_bay_id: string;
  owning_bay_id: string;
  status: "rehomed" | "already-home";
}

export interface HostRehomeLogRequest {
  host_id: string;
  op_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by?: string | null;
  reason?: string | null;
  campaign_id?: string | null;
  duration_ms?: number | null;
  epoch?: number;
}

export interface IssueProjectHostAuthTokenRequest {
  host_id: string;
  account_id?: string;
  actor?: "account" | "hub";
  project_id?: string;
  ttl_seconds?: number;
}

export interface IssueProjectHostAuthTokenResponse {
  host_id: string;
  token: string;
  expires_at: number;
}

export interface ForwardProjectLroProgressRequest {
  project_id: string;
  op_id: string;
  event: Extract<LroEvent, { type: "progress" }>;
}

export interface AccountDirectoryGetRequest {
  account_id: string;
}

export interface AccountDirectoryGetByEmailRequest {
  email_address: string;
}

export interface AccountDirectoryGetManyRequest {
  account_ids: string[];
}

export interface AccountDirectorySearchRequest {
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}

export interface AccountDirectoryHomeBayCountsRequest {}

export interface AccountDirectoryUpdateHomeBayRequest {
  account_id: string;
  home_bay_id: string;
}

export interface AccountDirectoryDeleteRequest {
  account_id: string;
  only_if_tag?: string;
}

export interface AccountDirectoryDeleteResult {
  account_id: string;
  home_bay_id: string;
  status: "deleted";
}

export interface AccountDirectoryEntry extends UserSearchResult {
  email_address?: string;
  home_bay_id?: string;
}

export interface AccountApiKeyDirectoryEntry {
  key_id: string;
  account_id: string;
  home_bay_id: string;
  hash: string;
  expire?: number | null;
  last_active?: number | null;
}

export interface AccountApiKeyDirectoryGetRequest {
  key_id: string;
}

export interface AccountApiKeyDirectoryUpsertRequest {
  key_id: string;
  account_id: string;
  home_bay_id: string;
  hash: string;
  expire?: number | null;
  last_active?: number | null;
}

export interface AccountApiKeyDirectoryDeleteRequest {
  key_id: string;
}

export interface AccountApiKeyDirectoryUpdateHomeBayRequest {
  account_id: string;
  home_bay_id: string;
}

export interface AccountApiKeyDirectoryTouchRequest {
  key_id: string;
}

export interface AccountDirectoryCreateRequest {
  email_address: string;
  password: string;
  first_name: string;
  last_name: string;
  home_bay_id: string;
  account_id?: string;
  owner_id?: string;
  tags?: string[];
  signup_reason?: string;
  ephemeral?: number;
  customize?: any;
}

export type MembershipClaimIdentityState = "pending" | "active" | "revoked";

export interface MembershipClaimIdentityEntry {
  scope_id: string;
  scope_key: string;
  scope_kind: string;
  canonical_identity: string;
  account_id: string;
  state: MembershipClaimIdentityState;
  reservation_id: string;
  package_id?: string;
  assignment_id?: string;
  grant_id?: string;
  matched_email_address: string;
  claimed_domain: string;
  reservation_expires_at?: Date | null;
  activated_at?: Date | null;
  revoked_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export interface MembershipClaimIdentityGetRequest {
  scope_key: string;
  canonical_identity: string;
}

export interface MembershipClaimIdentityReserveRequest extends MembershipClaimIdentityGetRequest {
  scope_kind: string;
  account_id: string;
  reservation_id: string;
  matched_email_address: string;
  claimed_domain: string;
  reservation_ttl_ms?: number;
  metadata?: Record<string, unknown> | null;
}

export interface MembershipClaimIdentityReserveResult {
  scope_id: string;
  reservation_id: string;
}

export interface MembershipClaimIdentityActivateRequest extends MembershipClaimIdentityReserveRequest {
  package_id: string;
  assignment_id: string;
  grant_id?: string | null;
}

export interface MembershipClaimIdentityRevokeRequest extends MembershipClaimIdentityGetRequest {
  account_id: string;
  assignment_id?: string;
  reservation_id?: string;
  revoked_at?: string | number | Date | null;
}

export interface AccountRehomeRequest {
  account_id?: string;
  target_account_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}

export interface AccountRehomeAcceptRequest {
  target_account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  account: Record<string, unknown>;
}

export interface AccountRehomeStateCopyRequest {
  target_account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  account_project_index?: Record<string, unknown>[];
  account_collaborator_index?: Record<string, unknown>[];
  account_notification_index?: Record<string, unknown>[];
  remember_me?: Record<string, unknown>[];
  account_auth_sessions?: Record<string, unknown>[];
  account_auth_challenges?: Record<string, unknown>[];
  account_second_factors?: Record<string, unknown>[];
  account_second_factor_recovery_codes?: Record<string, unknown>[];
  account_impersonation_grants?: Record<string, unknown>[];
  account_impersonation_sessions?: Record<string, unknown>[];
  auth_tokens?: Record<string, unknown>[];
  api_keys?: Record<string, unknown>[];
  account_entitlement_overrides?: Record<string, unknown>[];
  account_entitlement_override_events?: Record<string, unknown>[];
  membership_grants?: Record<string, unknown>[];
  membership_packages?: Record<string, unknown>[];
  membership_package_assignments?: Record<string, unknown>[];
  membership_side_effects_outbox?: Record<string, unknown>[];
}

export interface AccountLocalUpsertMembershipGrantRequest {
  id: string;
  account_id: string;
  membership_class: string;
  source: string;
  package_id?: string | null;
  purchase_id?: number | null;
  granted_by_account_id?: string | null;
  starts_at?: Date | string | number | null;
  expires_at?: Date | string | number | null;
  revoked_at?: Date | string | number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AccountLocalRevokeMembershipGrantRequest {
  account_id: string;
  grant_id: string;
  revoked_at?: Date | string | number | null;
}

export interface AccountLocalGetMembershipRequest {
  account_id: string;
}

export interface AccountLocalGetMembershipDetailsRequest {
  account_id: string;
  refresh_usage_status?: boolean;
}

export interface AccountLocalGetEntitlementOverrideRequest {
  account_id: string;
}

export interface AccountLocalSetEntitlementOverrideRequest {
  account_id: string;
  actor_account_id: string;
  override: Omit<
    Partial<AccountEntitlementOverride>,
    "account_id" | "updated_by" | "updated_at"
  >;
  reason: string;
}

export interface AccountLocalClearEntitlementOverrideRequest {
  account_id: string;
  actor_account_id: string;
  reason: string;
}

export interface AccountLocalDedicatedHostPolicySnapshot {
  account_id: string;
  membership_class: string;
  can_create_hosts: boolean;
  funding_mode: "account-prepaid" | "account-postpaid" | "site-funded";
  effective_limits: MembershipEffectiveLimits;
  has_active_second_factor: boolean;
  has_payment_method: boolean;
  has_usage_subscription: boolean;
  balance: MoneyValue;
  postpaid_unbilled_exposure_usd: MoneyValue;
  dedicated_host_window_usage: {
    prepaid_5h_usd: MoneyValue;
    prepaid_7d_usd: MoneyValue;
    credit_5h_usd: MoneyValue;
    credit_7d_usd: MoneyValue;
  };
  admin_override?: AccountEntitlementOverride;
}

export interface AccountLocalGetDedicatedHostPolicySnapshotRequest {
  account_id: string;
}

export interface AccountLocalReconcileDedicatedHostPurchaseSessionRequest {
  account_id: string;
  host_id: string;
  host_name?: string | null;
  host_bay_id?: string | null;
  provider: string;
  region?: string | null;
  machine_type?: string | null;
  pricing_model?: "on_demand" | "spot" | null;
  funding_lane: "prepaid" | "credit";
  hourly_cost_usd: MoneyValue;
  started_at?: Date | string | number | null;
}

export interface AccountLocalCloseDedicatedHostPurchaseSessionRequest {
  account_id: string;
  host_id: string;
  ended_at?: Date | string | number | null;
}

export interface AccountLocalCreateImpersonationGrantRequest {
  actor_account_id: string;
  subject_account_id: string;
  actor_session_hash: string;
  subject_home_bay_id: string;
  actor_authenticated_at?: Date | string | number | null;
  actor_password_verified_at?: Date | string | number | null;
  actor_factor_verified_at?: Date | string | number | null;
  actor_fresh_auth_until?: Date | string | number | null;
  actor_factor_level?: "none" | "totp" | "recovery_code" | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AccountLocalCreateImpersonationGrantResult {
  grant_id: string;
  subject_account_id: string;
  subject_home_bay_id: string;
  expires_at: Date | string | number;
}

export interface AccountLocalVerifyFreshAuthCredentialsRequest {
  account_id: string;
  current_password: string;
  method?: string;
  code?: string;
}

export interface AccountLocalVerifyFreshAuthCredentialsResult {
  factor_level: "none" | "totp" | "recovery_code";
}

export interface AccountLocalGetMembershipPackagesRequest {
  owner_account_id: string;
}

export interface AccountLocalAdminProvisionMembershipPackageRequest {
  owner_account_id: string;
  actor_account_id: string;
  kind: "site";
  membership_class: string;
  seat_count: number;
  allowed_domains: string[];
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AccountLocalUpdateMembershipPackageRequest {
  package_id: string;
  actor_account_id: string;
  seat_count?: number;
  expires_at?: Date | string | null;
}

export interface AccountLocalGetClaimableMembershipPackagesRequest {
  account_id: string;
  verified_email_addresses: string[];
}

export interface AccountLocalClaimMembershipPackageSeatRequest {
  package_id: string;
  account_id: string;
  verified_email_addresses: string[];
}

export interface AccountMembershipPortableState {
  membership_grants?: Record<string, unknown>[];
  membership_packages?: Record<string, unknown>[];
  membership_package_assignments?: Record<string, unknown>[];
  membership_side_effects_outbox?: Record<string, unknown>[];
}

export interface AccountLocalGetMembershipPortableStateRequest {
  account_id: string;
}

export interface AccountLocalReplaceMembershipPortableStateRequest extends AccountMembershipPortableState {
  account_id: string;
}

export type AccountRehomeOperationStage =
  | "requested"
  | "destination_accepted"
  | "source_flipped"
  | "projections_copied"
  | "directory_updated"
  | "complete";

export type AccountRehomeOperationStatus = "running" | "succeeded" | "failed";

export interface AccountRehomeOperationSummary {
  op_id: string;
  account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by?: string | null;
  reason?: string | null;
  campaign_id?: string | null;
  status: AccountRehomeOperationStatus;
  stage: AccountRehomeOperationStage;
  attempt: number;
  last_error?: string | null;
  created_at?: string | number | Date | null;
  updated_at?: string | number | Date | null;
  finished_at?: string | number | Date | null;
  duration_ms?: number | null;
}

export interface AccountRehomeResponse {
  op_id?: string;
  account_id: string;
  previous_bay_id: string;
  home_bay_id: string;
  operation_stage?: AccountRehomeOperationStage;
  operation_status?: AccountRehomeOperationStatus;
  status: "already-home" | "rehomed";
}

export interface BayRegistryRegisterRequest {
  bay_id: string;
  label?: string;
  region?: string | null;
  role?: string;
  public_origin?: string | null;
  public_target?: string | null;
  public_target_kind?: string | null;
  accepts_project_ownership?: boolean;
  project_ownership_note?: string | null;
}

export interface BayRegistryListRequest {}

export interface BayRegistryEntry {
  bay_id: string;
  label: string;
  region?: string | null;
  role: string;
  public_origin?: string | null;
  public_target?: string | null;
  public_target_kind?: string | null;
  dns_hostname?: string | null;
  dns_record_id?: string | null;
  accepts_project_ownership?: boolean;
  project_ownership_note?: string | null;
  last_seen: string;
}

export interface BayRegistryManagedTunnel {
  id: string;
  name: string;
  hostname: string;
  tunnel_secret: string;
  account_id: string;
  record_id?: string;
  token?: string;
}

export interface BayRegistryRegisterResult extends BayRegistryEntry {
  managed_tunnel?: BayRegistryManagedTunnel | null;
}

export interface BayOpsHealthRequest {
  account_id?: string;
}

export interface AuthTokenRequiresRequest {}

export interface AuthTokenRedeemRequest {
  token: string;
}

export interface AuthTokenDisableRequest {
  token: string;
}

export interface RegistrationTokenInfoWire {
  token: string;
  ephemeral?: number;
  customize?: any;
}

export interface ProjectCollabInviteWire extends Omit<
  ProjectCollabInviteRow,
  "created" | "updated" | "responded" | "expires"
> {
  created: string;
  updated: string;
  responded?: string | null;
  expires?: string | null;
}

export interface ProjectCollabInviteInboxUpsertRequest {
  source_bay_id: string;
  invite: ProjectCollabInviteWire;
}

export interface ProjectCollabInviteInboxDeleteRequest {
  invite_id: string;
}

export interface ProjectCollabInviteRespondRequest {
  invite_id: string;
  account_id: string;
  action: ProjectCollabInviteAction;
  include_email?: boolean;
}

export interface ProjectCollabInviteCreateRequest {
  account_id: string;
  project_id: string;
  invitee_account_id: string;
  message?: string;
  direct?: boolean;
}

export interface ProjectCollabInviteCreateResultWire {
  created: boolean;
  invite: ProjectCollabInviteWire;
}

export interface ProjectCollabInviteListRequest {
  account_id: string;
  project_id?: string;
  direction?: ProjectCollabInviteDirection;
  status?: ProjectCollabInviteStatus;
  limit?: number;
}

export interface ProjectRemoveCollaboratorRequest {
  account_id: string;
  opts: {
    account_id: string;
    project_id: string;
  };
}

export type ProjectControlMethod =
  | "start"
  | "stop"
  | "restart"
  | "backup"
  | "state"
  | "set-usage-account"
  | "address"
  | "move"
  | "rehome"
  | "accept-rehome"
  | "active-op";
export type DirectoryMethod = "resolve-project-bay" | "resolve-host-bay";
export type BayDirectoryMethod = DirectoryMethod;
export type ProjectReferenceMethod = "get";
export type ProjectDetailsMethod = "get";
export type HostConnectionMethod =
  | "get"
  | "list"
  | "get-host-log"
  | "get-host-runtime-log"
  | "get-host-metrics-history"
  | "get-host-runtime-deployment-status"
  | "start-host"
  | "stop-host"
  | "restart-host"
  | "drain-host"
  | "refresh-host-cloud-state"
  | "upgrade-host-software"
  | "reconcile-host-software"
  | "reconcile-host-runtime-deployments"
  | "rollback-host-runtime-deployments"
  | "rollout-host-managed-components"
  | "delete-host"
  | "force-deprovision-host"
  | "remove-self-host-connector"
  | "list-host-rootfs-images"
  | "pull-host-rootfs-image"
  | "delete-host-rootfs-image"
  | "gc-deleted-host-rootfs-images"
  | "list-host-runtime-deployments"
  | "set-host-runtime-deployments"
  | "get-host-managed-component-status"
  | "get-project-start-metadata"
  | "get-backup-config"
  | "get-project-owner-effective-limits"
  | "get-seed-backup-config"
  | "resolve-seed-backup-repo-assignment"
  | "release-seed-backup-repo-assignment"
  | "get-seed-project-backup-shards"
  | "record-project-backup"
  | "record-project-backup-index"
  | "get-project-backup-indexes"
  | "sync-project-backup-indexes"
  | "delete-project-backup-index"
  | "list-host-projects"
  | "ensure-host-owner-ssh-trust"
  | "rehome-host"
  | "prepare-host-rehome"
  | "accept-host-rehome"
  | "reconnect-host-rehome"
  | "record-host-rehome-log";
export type HostControlMethod =
  | "create-project"
  | "start-project"
  | "stop-project"
  | "get-project-status"
  | "update-authorized-keys"
  | "update-project-users"
  | "apply-pending-copies"
  | "delete-project-data"
  | "upgrade-software"
  | "rollout-managed-components"
  | "grow-btrfs"
  | "get-runtime-log"
  | "get-project-runtime-log"
  | "list-rootfs-images"
  | "pull-rootfs-image"
  | "delete-rootfs-image"
  | "list-host-ssh-authorized-keys"
  | "add-host-ssh-authorized-key"
  | "remove-host-ssh-authorized-key"
  | "get-backup-execution-status"
  | "get-managed-component-status"
  | "get-installed-runtime-artifacts"
  | "get-host-agent-status"
  | "inspect-static-app-path"
  | "build-rootfs-image-manifest"
  | "build-project-rootfs-manifest";
export type ProjectHostAuthTokenMethod = "issue";
export type ProjectLroMethod = "publish-progress";
export type AccountDirectoryMethod =
  | "get"
  | "get-by-email"
  | "get-many"
  | "search"
  | "home-bay-counts"
  | "create"
  | "delete"
  | "update-home-bay"
  | "get-api-key"
  | "upsert-api-key"
  | "delete-api-key"
  | "update-api-keys-home-bay"
  | "touch-api-key"
  | "get-membership-claim-identity"
  | "reserve-membership-claim-identity"
  | "activate-membership-claim-identity"
  | "revoke-membership-claim-identity";
export type AccountLocalMethod =
  | "create"
  | "delete"
  | "rehome"
  | "accept-rehome"
  | "copy-rehome-state"
  | "get-rehome-operation"
  | "reconcile-rehome"
  | "create-impersonation-grant"
  | "verify-fresh-auth-credentials"
  | "reconcile-dedicated-host-purchase-session"
  | "close-dedicated-host-purchase-session"
  | "upsert-membership-grant"
  | "revoke-membership-grant"
  | "get-membership"
  | "get-membership-details"
  | "get-account-entitlement-override"
  | "set-account-entitlement-override"
  | "clear-account-entitlement-override"
  | "get-dedicated-host-policy-snapshot"
  | "get-membership-packages"
  | "admin-provision-membership-package"
  | "update-membership-package"
  | "get-claimable-membership-packages"
  | "claim-membership-package-seat"
  | "get-membership-portable-state"
  | "replace-membership-portable-state";
export type AuthTokenMethod = "requires-token" | "redeem" | "disable";
export type BayRegistryMethod = "register" | "list";
export type BayOpsMethod = "get-load" | "get-backups";
export type ProjectCollabInviteMethod =
  | "upsert-inbox"
  | "delete-inbox"
  | "list"
  | "remove-collaborator"
  | "create"
  | "respond";
export type AccountProjectFeedMethod = "upsert" | "remove";

interface ResolveProjectBayApi {
  resolveProjectBay: (
    opts: ResolveProjectBayRequest,
  ) => Promise<BayOwnership | null>;
}

interface ResolveHostBayApi {
  resolveHostBay: (opts: ResolveHostBayRequest) => Promise<BayOwnership | null>;
}

export interface InterBayDirectoryApi {
  resolveProjectBay: (
    opts: ResolveProjectBayRequest,
  ) => Promise<BayOwnership | null>;
  resolveHostBay: (opts: ResolveHostBayRequest) => Promise<BayOwnership | null>;
}

export interface InterBayProjectControlApi {
  start: (opts: ProjectControlStartRequest) => Promise<void>;
  stop: (opts: ProjectControlStopRequest) => Promise<void>;
  restart: (opts: ProjectControlRestartRequest) => Promise<void>;
  backup: (opts: ProjectControlBackupRequest) => Promise<LroSummary>;
  state: (opts: ProjectControlStateRequest) => Promise<ProjectState>;
  setUsageAccount: (
    opts: ProjectControlSetUsageAccountRequest,
  ) => Promise<ProjectControlSetUsageAccountResponse>;
  address: (opts: ProjectControlAddressRequest) => Promise<ProjectAddress>;
  move: (
    opts: ProjectControlMoveRequest,
  ) => Promise<ProjectControlMoveResponse>;
  rehome: (
    opts: ProjectControlRehomeRequest,
  ) => Promise<ProjectControlRehomeResponse>;
  acceptRehome: (
    opts: ProjectControlAcceptRehomeRequest,
  ) => Promise<ProjectControlRehomeResponse>;
  activeOp: (
    opts: ProjectControlActiveOperationRequest,
  ) => Promise<ProjectActiveOperationSummary | null>;
}

export interface InterBayProjectReferenceApi {
  get: (opts: GetProjectReferenceRequest) => Promise<ProjectReference | null>;
}

export interface InterBayProjectDetailsApi {
  get: (opts: GetProjectDetailsRequest) => Promise<ProjectDetails>;
}

export interface InterBayHostConnectionApi {
  get: (opts: GetHostConnectionRequest) => Promise<HostConnectionInfo>;
  list: (opts: Parameters<Hosts["listHosts"]>[0]) => Promise<Host[]>;
  getHostLog: (
    opts: Parameters<Hosts["getHostLog"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getHostLog"]>>>;
  getHostRuntimeLog: (
    opts: Parameters<Hosts["getHostRuntimeLog"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getHostRuntimeLog"]>>>;
  getHostMetricsHistory: (
    opts: Parameters<Hosts["getHostMetricsHistory"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getHostMetricsHistory"]>>>;
  getHostRuntimeDeploymentStatus: (
    opts: Parameters<Hosts["getHostRuntimeDeploymentStatus"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getHostRuntimeDeploymentStatus"]>>>;
  startHost: (
    opts: Parameters<Hosts["startHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["startHost"]>>>;
  stopHost: (
    opts: Parameters<Hosts["stopHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["stopHost"]>>>;
  restartHost: (
    opts: Parameters<Hosts["restartHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["restartHost"]>>>;
  drainHost: (
    opts: Parameters<Hosts["drainHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["drainHost"]>>>;
  refreshHostCloudState: (
    opts: Parameters<Hosts["refreshHostCloudState"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["refreshHostCloudState"]>>>;
  upgradeHostSoftware: (
    opts: Parameters<Hosts["upgradeHostSoftware"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["upgradeHostSoftware"]>>>;
  reconcileHostSoftware: (
    opts: Parameters<Hosts["reconcileHostSoftware"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["reconcileHostSoftware"]>>>;
  reconcileHostRuntimeDeployments: (
    opts: Parameters<Hosts["reconcileHostRuntimeDeployments"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["reconcileHostRuntimeDeployments"]>>>;
  rollbackHostRuntimeDeployments: (
    opts: Parameters<Hosts["rollbackHostRuntimeDeployments"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["rollbackHostRuntimeDeployments"]>>>;
  rolloutHostManagedComponents: (
    opts: Parameters<Hosts["rolloutHostManagedComponents"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["rolloutHostManagedComponents"]>>>;
  deleteHost: (
    opts: Parameters<Hosts["deleteHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["deleteHost"]>>>;
  forceDeprovisionHost: (
    opts: Parameters<Hosts["forceDeprovisionHost"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["forceDeprovisionHost"]>>>;
  removeSelfHostConnector: (
    opts: Parameters<Hosts["removeSelfHostConnector"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["removeSelfHostConnector"]>>>;
  listHostRootfsImages: (
    opts: Parameters<Hosts["listHostRootfsImages"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["listHostRootfsImages"]>>>;
  pullHostRootfsImage: (
    opts: Parameters<Hosts["pullHostRootfsImage"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["pullHostRootfsImage"]>>>;
  deleteHostRootfsImage: (
    opts: Parameters<Hosts["deleteHostRootfsImage"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["deleteHostRootfsImage"]>>>;
  gcDeletedHostRootfsImages: (
    opts: Parameters<Hosts["gcDeletedHostRootfsImages"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["gcDeletedHostRootfsImages"]>>>;
  listHostRuntimeDeployments: (
    opts: Parameters<Hosts["listHostRuntimeDeployments"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["listHostRuntimeDeployments"]>>>;
  setHostRuntimeDeployments: (
    opts: Parameters<Hosts["setHostRuntimeDeployments"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["setHostRuntimeDeployments"]>>>;
  getHostManagedComponentStatus: (
    opts: Parameters<Hosts["getHostManagedComponentStatus"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getHostManagedComponentStatus"]>>>;
  getProjectStartMetadata: (
    opts: Parameters<Hosts["getProjectStartMetadata"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getProjectStartMetadata"]>>>;
  getBackupConfig: (
    opts: Parameters<Hosts["getBackupConfig"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getBackupConfig"]>>>;
  getProjectOwnerEffectiveLimits: (
    opts: Parameters<Hosts["getProjectOwnerEffectiveLimits"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getProjectOwnerEffectiveLimits"]>>>;
  getSeedBackupConfig: (opts: {
    project_id: string;
    project_region?: string | null;
    backup_repo_id?: string | null;
    preferred_backup_repo_id?: string | null;
  }) => Promise<{
    toml: string;
    ttl_seconds: number;
    backup_repo_id: string | null;
    index_store?: {
      kind: "r2-object-store";
      endpoint: string;
      bucket: string;
      access_key_id: string;
      secret_access_key: string;
      key_prefix: string;
      compression: "gzip";
    } | null;
  }>;
  resolveSeedBackupRepoAssignment: (opts: {
    project_id: string;
    project_region?: string | null;
    backup_repo_id?: string | null;
    preferred_backup_repo_id?: string | null;
  }) => Promise<{
    backup_repo_id: string | null;
  }>;
  releaseSeedBackupRepoAssignment: (opts: {
    project_id: string;
  }) => Promise<void>;
  getSeedProjectBackupShards: (opts?: { region?: string | null }) => Promise<{
    checked_at: string;
    active_shards_per_region: number;
    projects_per_shard: number;
    authoritative_bay_id: string;
    regions: Array<{
      region: string;
      total_repos: number;
      active_repos: number;
      sealed_repos: number;
      draining_repos: number;
      disabled_repos: number;
      assigned_projects: number;
      active_capacity_projects: number;
      active_available_project_slots: number;
    }>;
    repos: Array<{
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
    }>;
  }>;
  recordProjectBackup: (
    opts: Parameters<Hosts["recordProjectBackup"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["recordProjectBackup"]>>>;
  recordProjectBackupIndex: (
    opts: Parameters<Hosts["recordProjectBackupIndex"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["recordProjectBackupIndex"]>>>;
  getProjectBackupIndexes: (
    opts: Parameters<Hosts["getProjectBackupIndexes"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["getProjectBackupIndexes"]>>>;
  syncProjectBackupIndexes: (
    opts: Parameters<Hosts["syncProjectBackupIndexes"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["syncProjectBackupIndexes"]>>>;
  deleteProjectBackupIndex: (
    opts: Parameters<Hosts["deleteProjectBackupIndex"]>[0],
  ) => Promise<Awaited<ReturnType<Hosts["deleteProjectBackupIndex"]>>>;
  listHostProjects: (
    opts: Pick<
      Parameters<Hosts["listHostProjects"]>[0],
      | "account_id"
      | "id"
      | "limit"
      | "cursor"
      | "risk_only"
      | "state_filter"
      | "project_state"
    >,
  ) => Promise<Awaited<ReturnType<Hosts["listHostProjects"]>>>;
  ensureHostOwnerSshTrust: (
    opts: HostOwnerSshTrustRequest,
  ) => Promise<HostOwnerSshTrustResponse>;
  rehomeHost: (opts: HostRehomeRequest) => Promise<HostRehomeResponse>;
  prepareHostRehome: (
    opts: HostRehomePrepareRequest,
  ) => Promise<HostRehomePrepareResponse>;
  acceptHostRehome: (
    opts: HostRehomeAcceptRequest,
  ) => Promise<HostRehomeResponse>;
  reconnectHostRehome: (opts: HostRehomeReconnectRequest) => Promise<void>;
  recordHostRehomeLog: (opts: HostRehomeLogRequest) => Promise<void>;
}

const HOST_CONNECTION_METHOD_SPECS = [
  { name: "get", method: "get" },
  { name: "list", method: "list" },
  { name: "getHostLog", method: "get-host-log" },
  { name: "getHostRuntimeLog", method: "get-host-runtime-log" },
  { name: "getHostMetricsHistory", method: "get-host-metrics-history" },
  {
    name: "getHostRuntimeDeploymentStatus",
    method: "get-host-runtime-deployment-status",
  },
  { name: "startHost", method: "start-host" },
  { name: "stopHost", method: "stop-host" },
  { name: "restartHost", method: "restart-host" },
  { name: "drainHost", method: "drain-host" },
  { name: "refreshHostCloudState", method: "refresh-host-cloud-state" },
  { name: "upgradeHostSoftware", method: "upgrade-host-software" },
  { name: "reconcileHostSoftware", method: "reconcile-host-software" },
  {
    name: "reconcileHostRuntimeDeployments",
    method: "reconcile-host-runtime-deployments",
  },
  {
    name: "rollbackHostRuntimeDeployments",
    method: "rollback-host-runtime-deployments",
  },
  {
    name: "rolloutHostManagedComponents",
    method: "rollout-host-managed-components",
  },
  { name: "deleteHost", method: "delete-host" },
  { name: "forceDeprovisionHost", method: "force-deprovision-host" },
  { name: "removeSelfHostConnector", method: "remove-self-host-connector" },
  { name: "listHostRootfsImages", method: "list-host-rootfs-images" },
  { name: "pullHostRootfsImage", method: "pull-host-rootfs-image" },
  { name: "deleteHostRootfsImage", method: "delete-host-rootfs-image" },
  {
    name: "gcDeletedHostRootfsImages",
    method: "gc-deleted-host-rootfs-images",
  },
  {
    name: "listHostRuntimeDeployments",
    method: "list-host-runtime-deployments",
  },
  {
    name: "setHostRuntimeDeployments",
    method: "set-host-runtime-deployments",
  },
  {
    name: "getHostManagedComponentStatus",
    method: "get-host-managed-component-status",
  },
  {
    name: "getProjectStartMetadata",
    method: "get-project-start-metadata",
  },
  {
    name: "getBackupConfig",
    method: "get-backup-config",
  },
  {
    name: "getProjectOwnerEffectiveLimits",
    method: "get-project-owner-effective-limits",
  },
  {
    name: "getSeedBackupConfig",
    method: "get-seed-backup-config",
  },
  {
    name: "resolveSeedBackupRepoAssignment",
    method: "resolve-seed-backup-repo-assignment",
  },
  {
    name: "releaseSeedBackupRepoAssignment",
    method: "release-seed-backup-repo-assignment",
  },
  {
    name: "getSeedProjectBackupShards",
    method: "get-seed-project-backup-shards",
  },
  {
    name: "recordProjectBackup",
    method: "record-project-backup",
  },
  {
    name: "recordProjectBackupIndex",
    method: "record-project-backup-index",
  },
  {
    name: "getProjectBackupIndexes",
    method: "get-project-backup-indexes",
  },
  {
    name: "syncProjectBackupIndexes",
    method: "sync-project-backup-indexes",
  },
  {
    name: "deleteProjectBackupIndex",
    method: "delete-project-backup-index",
  },
  {
    name: "listHostProjects",
    method: "list-host-projects",
  },
  {
    name: "ensureHostOwnerSshTrust",
    method: "ensure-host-owner-ssh-trust",
  },
  {
    name: "rehomeHost",
    method: "rehome-host",
  },
  {
    name: "prepareHostRehome",
    method: "prepare-host-rehome",
  },
  {
    name: "acceptHostRehome",
    method: "accept-host-rehome",
  },
  {
    name: "reconnectHostRehome",
    method: "reconnect-host-rehome",
  },
  {
    name: "recordHostRehomeLog",
    method: "record-host-rehome-log",
  },
] as const satisfies ReadonlyArray<{
  name: keyof InterBayHostConnectionApi;
  method: HostConnectionMethod;
}>;

type HostControlArg<K extends keyof HostControlApi> = Parameters<
  HostControlApi[K]
>[0];

export interface InterBayHostControlApi {
  createProject: (opts: {
    account_id: string;
    host_id: string;
    create: HostCreateProjectRequest;
  }) => Promise<HostCreateProjectResponse>;
  startProject: (opts: {
    host_id: string;
    start: HostControlArg<"startProject">;
  }) => Promise<HostCreateProjectResponse>;
  stopProject: (opts: {
    host_id: string;
    stop: HostControlArg<"stopProject">;
  }) => Promise<HostCreateProjectResponse>;
  getProjectStatus: (opts: {
    host_id: string;
    get: HostControlArg<"getProjectStatus">;
  }) => Promise<Awaited<ReturnType<HostControlApi["getProjectStatus"]>>>;
  updateAuthorizedKeys: (opts: {
    host_id: string;
    update: HostControlArg<"updateAuthorizedKeys">;
  }) => Promise<void>;
  updateProjectUsers: (opts: {
    host_id: string;
    update: HostControlArg<"updateProjectUsers">;
  }) => Promise<void>;
  applyPendingCopies: (opts: {
    host_id: string;
    apply: HostControlArg<"applyPendingCopies">;
  }) => Promise<{ claimed: number }>;
  deleteProjectData: (opts: {
    host_id: string;
    del: HostControlArg<"deleteProjectData">;
  }) => Promise<void>;
  upgradeSoftware: (opts: {
    host_id: string;
    upgrade: UpgradeSoftwareRequest;
  }) => Promise<UpgradeSoftwareResponse>;
  rolloutManagedComponents: (opts: {
    host_id: string;
    rollout: HostManagedComponentRolloutRequest;
  }) => Promise<HostManagedComponentRolloutResponse>;
  growBtrfs: (opts: {
    host_id: string;
    grow: HostControlArg<"growBtrfs">;
  }) => Promise<{ ok: boolean }>;
  getRuntimeLog: (opts: {
    host_id: string;
    get: HostControlArg<"getRuntimeLog">;
  }) => Promise<HostRuntimeLogResponse>;
  getProjectRuntimeLog: (opts: {
    host_id: string;
    get: HostControlArg<"getProjectRuntimeLog">;
  }) => Promise<HostProjectRuntimeLogResponse>;
  listRootfsImages: (opts: {
    host_id: string;
  }) => Promise<HostRootfsCacheEntry[]>;
  pullRootfsImage: (opts: {
    host_id: string;
    pull: HostControlArg<"pullRootfsImage">;
  }) => Promise<HostRootfsCacheEntry>;
  deleteRootfsImage: (opts: {
    host_id: string;
    del: HostControlArg<"deleteRootfsImage">;
  }) => Promise<{ removed: boolean }>;
  listHostSshAuthorizedKeys: (opts: {
    host_id: string;
  }) => Promise<HostSshAuthorizedKeysResponse>;
  addHostSshAuthorizedKey: (opts: {
    host_id: string;
    add: HostControlArg<"addHostSshAuthorizedKey">;
  }) => Promise<HostSshAuthorizedKeysResponse & { added: boolean }>;
  removeHostSshAuthorizedKey: (opts: {
    host_id: string;
    remove: HostControlArg<"removeHostSshAuthorizedKey">;
  }) => Promise<HostSshAuthorizedKeysResponse & { removed: boolean }>;
  getBackupExecutionStatus: (opts: {
    host_id: string;
  }) => Promise<HostBackupExecutionStatus>;
  getManagedComponentStatus: (opts: {
    host_id: string;
  }) => Promise<HostManagedComponentStatus[]>;
  getInstalledRuntimeArtifacts: (opts: {
    host_id: string;
    get?: HostInstalledRuntimeArtifactsRequest;
  }) => Promise<HostInstalledRuntimeArtifactStatus[]>;
  getHostAgentStatus: (opts: { host_id: string }) => Promise<HostAgentStatus>;
  inspectStaticAppPath: (opts: {
    host_id: string;
    inspect: HostControlArg<"inspectStaticAppPath">;
  }) => Promise<HostStaticAppPathInspection>;
  buildRootfsImageManifest: (opts: {
    host_id: string;
    build: HostControlArg<"buildRootfsImageManifest">;
  }) => Promise<HostRootfsManifest>;
  buildProjectRootfsManifest: (opts: {
    host_id: string;
    build: HostControlArg<"buildProjectRootfsManifest">;
  }) => Promise<HostRootfsManifest>;
}

export interface InterBayProjectHostAuthTokenApi {
  issue: (
    opts: IssueProjectHostAuthTokenRequest,
  ) => Promise<IssueProjectHostAuthTokenResponse>;
}

export interface InterBayProjectLroApi {
  publishProgress: (opts: ForwardProjectLroProgressRequest) => Promise<void>;
}

export interface InterBayAccountDirectoryApi {
  get: (
    opts: AccountDirectoryGetRequest,
  ) => Promise<AccountDirectoryEntry | null>;
  getByEmail: (
    opts: AccountDirectoryGetByEmailRequest,
  ) => Promise<AccountDirectoryEntry | null>;
  getMany: (
    opts: AccountDirectoryGetManyRequest,
  ) => Promise<AccountDirectoryEntry[]>;
  search: (
    opts: AccountDirectorySearchRequest,
  ) => Promise<AccountDirectoryEntry[]>;
  getHomeBayCounts: (
    opts: AccountDirectoryHomeBayCountsRequest,
  ) => Promise<Record<string, number>>;
  updateHomeBay: (
    opts: AccountDirectoryUpdateHomeBayRequest,
  ) => Promise<AccountDirectoryEntry>;
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
  delete: (
    opts: AccountDirectoryDeleteRequest,
  ) => Promise<AccountDirectoryDeleteResult>;
  getApiKey: (
    opts: AccountApiKeyDirectoryGetRequest,
  ) => Promise<AccountApiKeyDirectoryEntry | null>;
  upsertApiKey: (opts: AccountApiKeyDirectoryUpsertRequest) => Promise<void>;
  deleteApiKey: (opts: AccountApiKeyDirectoryDeleteRequest) => Promise<void>;
  updateApiKeysHomeBay: (
    opts: AccountApiKeyDirectoryUpdateHomeBayRequest,
  ) => Promise<void>;
  touchApiKey: (opts: AccountApiKeyDirectoryTouchRequest) => Promise<void>;
  getMembershipClaimIdentity: (
    opts: MembershipClaimIdentityGetRequest,
  ) => Promise<MembershipClaimIdentityEntry | null>;
  reserveMembershipClaimIdentity: (
    opts: MembershipClaimIdentityReserveRequest,
  ) => Promise<MembershipClaimIdentityReserveResult>;
  activateMembershipClaimIdentity: (
    opts: MembershipClaimIdentityActivateRequest,
  ) => Promise<void>;
  revokeMembershipClaimIdentity: (
    opts: MembershipClaimIdentityRevokeRequest,
  ) => Promise<void>;
}

export interface InterBayAccountLocalApi {
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
  delete: (
    opts: AccountDirectoryDeleteRequest,
  ) => Promise<AccountDirectoryDeleteResult>;
  rehome: (opts: AccountRehomeRequest) => Promise<AccountRehomeResponse>;
  acceptRehome: (
    opts: AccountRehomeAcceptRequest,
  ) => Promise<AccountRehomeResponse>;
  copyRehomeState: (opts: AccountRehomeStateCopyRequest) => Promise<void>;
  getRehomeOperation: (opts: {
    op_id: string;
  }) => Promise<AccountRehomeOperationSummary | null>;
  reconcileRehome: (opts: {
    account_id?: string;
    op_id: string;
    source_bay_id?: string;
  }) => Promise<AccountRehomeResponse>;
  createImpersonationGrant: (
    opts: AccountLocalCreateImpersonationGrantRequest,
  ) => Promise<AccountLocalCreateImpersonationGrantResult>;
  verifyFreshAuthCredentials: (
    opts: AccountLocalVerifyFreshAuthCredentialsRequest,
  ) => Promise<AccountLocalVerifyFreshAuthCredentialsResult>;
  reconcileDedicatedHostPurchaseSession: (
    opts: AccountLocalReconcileDedicatedHostPurchaseSessionRequest,
  ) => Promise<void>;
  closeDedicatedHostPurchaseSession: (
    opts: AccountLocalCloseDedicatedHostPurchaseSessionRequest,
  ) => Promise<void>;
  upsertMembershipGrant: (
    opts: AccountLocalUpsertMembershipGrantRequest,
  ) => Promise<{ grant_id: string }>;
  revokeMembershipGrant: (
    opts: AccountLocalRevokeMembershipGrantRequest,
  ) => Promise<void>;
  getMembership: (
    opts: AccountLocalGetMembershipRequest,
  ) => Promise<MembershipResolution>;
  getMembershipDetails: (
    opts: AccountLocalGetMembershipDetailsRequest,
  ) => Promise<MembershipDetails>;
  getAccountEntitlementOverride: (
    opts: AccountLocalGetEntitlementOverrideRequest,
  ) => Promise<AccountEntitlementOverride | undefined>;
  setAccountEntitlementOverride: (
    opts: AccountLocalSetEntitlementOverrideRequest,
  ) => Promise<AccountEntitlementOverride>;
  clearAccountEntitlementOverride: (
    opts: AccountLocalClearEntitlementOverrideRequest,
  ) => Promise<void>;
  getDedicatedHostPolicySnapshot: (
    opts: AccountLocalGetDedicatedHostPolicySnapshotRequest,
  ) => Promise<AccountLocalDedicatedHostPolicySnapshot>;
  getMembershipPackages: (
    opts: AccountLocalGetMembershipPackagesRequest,
  ) => Promise<MembershipPackageDetails[]>;
  adminProvisionMembershipPackage: (
    opts: AccountLocalAdminProvisionMembershipPackageRequest,
  ) => Promise<MembershipPackageDetails>;
  updateMembershipPackage: (
    opts: AccountLocalUpdateMembershipPackageRequest,
  ) => Promise<MembershipPackageDetails>;
  getClaimableMembershipPackages: (
    opts: AccountLocalGetClaimableMembershipPackagesRequest,
  ) => Promise<ClaimableMembershipPackage[]>;
  claimMembershipPackageSeat: (
    opts: AccountLocalClaimMembershipPackageSeatRequest,
  ) => Promise<MembershipPackageAssignment>;
  getMembershipPortableState: (
    opts: AccountLocalGetMembershipPortableStateRequest,
  ) => Promise<AccountMembershipPortableState>;
  replaceMembershipPortableState: (
    opts: AccountLocalReplaceMembershipPortableStateRequest,
  ) => Promise<void>;
}

export interface InterBayBayRegistryApi {
  register: (
    opts: BayRegistryRegisterRequest,
  ) => Promise<BayRegistryRegisterResult>;
  list: (opts: BayRegistryListRequest) => Promise<BayRegistryEntry[]>;
}

export interface InterBayBayOpsApi {
  getLoad: (opts: BayOpsHealthRequest) => Promise<BayLoadInfo>;
  getBackups: (opts: BayOpsHealthRequest) => Promise<BayBackupsInfo>;
}

export interface InterBayAuthTokenApi {
  requiresToken: (opts: AuthTokenRequiresRequest) => Promise<boolean>;
  redeem: (
    opts: AuthTokenRedeemRequest,
  ) => Promise<RegistrationTokenInfoWire | null>;
  disable: (opts: AuthTokenDisableRequest) => Promise<void>;
}

export interface InterBayProjectCollabInviteApi {
  upsertInbox: (opts: ProjectCollabInviteInboxUpsertRequest) => Promise<void>;
  deleteInbox: (opts: ProjectCollabInviteInboxDeleteRequest) => Promise<void>;
  list: (
    opts: ProjectCollabInviteListRequest,
  ) => Promise<ProjectCollabInviteWire[]>;
  removeCollaborator: (opts: ProjectRemoveCollaboratorRequest) => Promise<void>;
  create: (
    opts: ProjectCollabInviteCreateRequest,
  ) => Promise<ProjectCollabInviteCreateResultWire>;
  respond: (
    opts: ProjectCollabInviteRespondRequest,
  ) => Promise<ProjectCollabInviteWire>;
}

export interface InterBayAccountProjectFeedApi {
  upsert: (opts: AccountFeedProjectUpsertEvent) => Promise<void>;
  remove: (opts: AccountFeedProjectRemoveEvent) => Promise<void>;
}

function serviceClientOptions({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): Omit<ServiceCall, "mesg"> & {
  transport?: "fast-rpc" | "request";
} {
  return {
    service: "inter-bay",
    client,
    timeout,
    // Fast RPC relies on a socket.io ack from the target service handler,
    // and that ack path is capped by MAX_INTEREST_TIMEOUT. For longer-lived
    // cross-bay operations, use request/reply transport instead.
    transport:
      timeout != null && timeout > MAX_INTEREST_TIMEOUT ? "request" : undefined,
  };
}

export function projectControlSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectControlMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-control.${method}`;
}

export function projectReferenceSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectReferenceMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-reference.${method}`;
}

export function projectDetailsSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectDetailsMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-details.${method}`;
}

export function hostConnectionSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: HostConnectionMethod;
}): string {
  return `bay.${dest_bay}.rpc.host-connection.${method}`;
}

export function hostControlSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: HostControlMethod;
}): string {
  return `bay.${dest_bay}.rpc.host-control.${method}`;
}

type HostControlName = keyof InterBayHostControlApi;

const HOST_CONTROL_METHOD_SPECS = [
  { name: "createProject", method: "create-project" },
  { name: "startProject", method: "start-project" },
  { name: "stopProject", method: "stop-project" },
  { name: "getProjectStatus", method: "get-project-status" },
  { name: "updateAuthorizedKeys", method: "update-authorized-keys" },
  { name: "updateProjectUsers", method: "update-project-users" },
  { name: "applyPendingCopies", method: "apply-pending-copies" },
  { name: "deleteProjectData", method: "delete-project-data" },
  { name: "upgradeSoftware", method: "upgrade-software" },
  { name: "rolloutManagedComponents", method: "rollout-managed-components" },
  { name: "growBtrfs", method: "grow-btrfs" },
  { name: "getRuntimeLog", method: "get-runtime-log" },
  { name: "getProjectRuntimeLog", method: "get-project-runtime-log" },
  { name: "listRootfsImages", method: "list-rootfs-images" },
  { name: "pullRootfsImage", method: "pull-rootfs-image" },
  { name: "deleteRootfsImage", method: "delete-rootfs-image" },
  {
    name: "listHostSshAuthorizedKeys",
    method: "list-host-ssh-authorized-keys",
  },
  { name: "addHostSshAuthorizedKey", method: "add-host-ssh-authorized-key" },
  {
    name: "removeHostSshAuthorizedKey",
    method: "remove-host-ssh-authorized-key",
  },
  {
    name: "getBackupExecutionStatus",
    method: "get-backup-execution-status",
  },
  {
    name: "getManagedComponentStatus",
    method: "get-managed-component-status",
  },
  {
    name: "getInstalledRuntimeArtifacts",
    method: "get-installed-runtime-artifacts",
  },
  {
    name: "getHostAgentStatus",
    method: "get-host-agent-status",
  },
  { name: "inspectStaticAppPath", method: "inspect-static-app-path" },
  {
    name: "buildRootfsImageManifest",
    method: "build-rootfs-image-manifest",
  },
  {
    name: "buildProjectRootfsManifest",
    method: "build-project-rootfs-manifest",
  },
] as const satisfies ReadonlyArray<{
  name: HostControlName;
  method: HostControlMethod;
}>;

function createInterBayHostControlMethodClient<K extends HostControlName>({
  client,
  dest_bay,
  timeout,
  name,
  method,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
  name: K;
  method: HostControlMethod;
}): InterBayHostControlApi[K] {
  const methodClient = createServiceClient<Pick<InterBayHostControlApi, K>>({
    ...serviceClientOptions({ client, timeout }),
    subject: hostControlSubject({ dest_bay, method }),
  });
  return (async (...args: Parameters<InterBayHostControlApi[K]>) =>
    await (methodClient[name] as any)(...args)) as InterBayHostControlApi[K];
}

function createInterBayHostControlMethodHandler<K extends HostControlName>({
  bay_id,
  impl,
  name,
  method,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostControlApi;
  name: K;
  method: HostControlMethod;
}): ConatService {
  return createServiceHandler<Pick<InterBayHostControlApi, K>>({
    ...options,
    service: "inter-bay-host-control",
    subject: hostControlSubject({
      dest_bay: bay_id,
      method,
    }),
    impl: {
      [name]: async (...args: Parameters<InterBayHostControlApi[K]>) =>
        await (impl[name] as any)(...args),
    } as Pick<InterBayHostControlApi, K>,
  });
}

export function projectHostAuthTokenSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectHostAuthTokenMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-host-auth-token.${method}`;
}

export function directorySubject({
  method,
}: {
  method: DirectoryMethod;
}): string {
  return `global.directory.rpc.${method}`;
}

export function bayDirectorySubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: BayDirectoryMethod;
}): string {
  return `bay.${dest_bay}.rpc.directory.${method}`;
}

export function projectLroSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectLroMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-lro.${method}`;
}

export function accountDirectorySubject({
  method,
}: {
  method: AccountDirectoryMethod;
}): string {
  return `global.account-directory.rpc.${method}`;
}

export function accountLocalSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: AccountLocalMethod;
}): string {
  return `bay.${dest_bay}.rpc.account-local.${method}`;
}

export function bayRegistrySubject({
  method,
}: {
  method: BayRegistryMethod;
}): string {
  return `global.bay-registry.rpc.${method}`;
}

export function bayOpsSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: BayOpsMethod;
}): string {
  return `bay.${dest_bay}.rpc.bay-ops.${method}`;
}

export function authTokenSubject({
  method,
}: {
  method: AuthTokenMethod;
}): string {
  return `global.auth-token.rpc.${method}`;
}

export function projectCollabInviteSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectCollabInviteMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-collab-invite.${method}`;
}

export function accountProjectFeedSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: AccountProjectFeedMethod;
}): string {
  return `bay.${dest_bay}.rpc.account-project-feed.${method}`;
}

export function createInterBayDirectoryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayDirectoryApi {
  const resolveProjectBayClient = createServiceClient<ResolveProjectBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: directorySubject({ method: "resolve-project-bay" }),
  });
  const resolveHostBayClient = createServiceClient<ResolveHostBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: directorySubject({ method: "resolve-host-bay" }),
  });
  return {
    resolveProjectBay: async (opts) =>
      await resolveProjectBayClient.resolveProjectBay(opts),
    resolveHostBay: async (opts) =>
      await resolveHostBayClient.resolveHostBay(opts),
  };
}

type ServiceHandlerOptions = Omit<Options, "handler" | "service" | "subject">;

export function createInterBayDirectoryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & { impl: InterBayDirectoryApi }): ConatService[] {
  return [
    createServiceHandler<ResolveProjectBayApi>({
      ...options,
      service: "inter-bay-directory",
      subject: directorySubject({ method: "resolve-project-bay" }),
      impl: {
        resolveProjectBay: async (opts) => await impl.resolveProjectBay(opts),
      },
    }),
    createServiceHandler<ResolveHostBayApi>({
      ...options,
      service: "inter-bay-directory",
      subject: directorySubject({ method: "resolve-host-bay" }),
      impl: {
        resolveHostBay: async (opts) => await impl.resolveHostBay(opts),
      },
    }),
  ];
}

export function createInterBayBayDirectoryClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayDirectoryApi {
  const resolveProjectBayClient = createServiceClient<ResolveProjectBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayDirectorySubject({
      dest_bay,
      method: "resolve-project-bay",
    }),
  });
  const resolveHostBayClient = createServiceClient<ResolveHostBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayDirectorySubject({
      dest_bay,
      method: "resolve-host-bay",
    }),
  });
  return {
    resolveProjectBay: async (opts) =>
      await resolveProjectBayClient.resolveProjectBay(opts),
    resolveHostBay: async (opts) =>
      await resolveHostBayClient.resolveHostBay(opts),
  };
}

export function createInterBayBayDirectoryHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayDirectoryApi;
}): ConatService[] {
  return [
    createServiceHandler<ResolveProjectBayApi>({
      ...options,
      service: "inter-bay-bay-directory",
      subject: bayDirectorySubject({
        dest_bay: bay_id,
        method: "resolve-project-bay",
      }),
      impl: {
        resolveProjectBay: async (opts) => await impl.resolveProjectBay(opts),
      },
    }),
    createServiceHandler<ResolveHostBayApi>({
      ...options,
      service: "inter-bay-bay-directory",
      subject: bayDirectorySubject({
        dest_bay: bay_id,
        method: "resolve-host-bay",
      }),
      impl: {
        resolveHostBay: async (opts) => await impl.resolveHostBay(opts),
      },
    }),
  ];
}

export function createInterBayProjectControlClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectControlApi {
  const startClient = createServiceClient<
    Pick<InterBayProjectControlApi, "start">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "start" }),
  });
  const stopClient = createServiceClient<
    Pick<InterBayProjectControlApi, "stop">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "stop" }),
  });
  const restartClient = createServiceClient<
    Pick<InterBayProjectControlApi, "restart">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "restart" }),
  });
  const backupClient = createServiceClient<
    Pick<InterBayProjectControlApi, "backup">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "backup" }),
  });
  const stateClient = createServiceClient<
    Pick<InterBayProjectControlApi, "state">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "state" }),
  });
  const setUsageAccountClient = createServiceClient<
    Pick<InterBayProjectControlApi, "setUsageAccount">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({
      dest_bay,
      method: "set-usage-account",
    }),
  });
  const addressClient = createServiceClient<
    Pick<InterBayProjectControlApi, "address">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "address" }),
  });
  const moveClient = createServiceClient<
    Pick<InterBayProjectControlApi, "move">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "move" }),
  });
  const rehomeClient = createServiceClient<
    Pick<InterBayProjectControlApi, "rehome">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "rehome" }),
  });
  const acceptRehomeClient = createServiceClient<
    Pick<InterBayProjectControlApi, "acceptRehome">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "accept-rehome" }),
  });
  const activeOpClient = createServiceClient<
    Pick<InterBayProjectControlApi, "activeOp">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "active-op" }),
  });
  return {
    start: async (opts) => await startClient.start(opts),
    stop: async (opts) => await stopClient.stop(opts),
    restart: async (opts) => await restartClient.restart(opts),
    backup: async (opts) => await backupClient.backup(opts),
    state: async (opts) => await stateClient.state(opts),
    setUsageAccount: async (opts) =>
      await setUsageAccountClient.setUsageAccount(opts),
    address: async (opts) => await addressClient.address(opts),
    move: async (opts) => await moveClient.move(opts),
    rehome: async (opts) => await rehomeClient.rehome(opts),
    acceptRehome: async (opts) => await acceptRehomeClient.acceptRehome(opts),
    activeOp: async (opts) => await activeOpClient.activeOp(opts),
  };
}

export function createInterBayProjectControlHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "start">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "start" }),
    impl: {
      start: async (opts) => await impl.start(opts),
    },
  });
}

export function createInterBayProjectReferenceClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectReferenceApi {
  const refClient = createServiceClient<
    Pick<InterBayProjectReferenceApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectReferenceSubject({ dest_bay, method: "get" }),
  });
  return {
    get: async (opts) => await refClient.get(opts),
  };
}

export function createInterBayProjectDetailsClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectDetailsApi {
  const detailsClient = createServiceClient<
    Pick<InterBayProjectDetailsApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectDetailsSubject({ dest_bay, method: "get" }),
  });
  return {
    get: async (opts) => await detailsClient.get(opts),
  };
}

export function createInterBayHostConnectionClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayHostConnectionApi {
  const api = {} as InterBayHostConnectionApi;
  for (const { name, method } of HOST_CONNECTION_METHOD_SPECS) {
    const methodClient = createServiceClient<
      Pick<InterBayHostConnectionApi, typeof name>
    >({
      ...serviceClientOptions({ client, timeout }),
      subject: hostConnectionSubject({ dest_bay, method }),
    });
    (api as any)[name] = async (...args: any[]) =>
      await (methodClient as any)[name](...args);
  }
  return api;
}

export function createInterBayHostControlClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayHostControlApi {
  const api = {} as InterBayHostControlApi;
  for (const { name, method } of HOST_CONTROL_METHOD_SPECS) {
    (api as any)[name] = createInterBayHostControlMethodClient({
      client,
      dest_bay,
      timeout,
      name,
      method,
    });
  }
  return api;
}

export function createInterBayProjectHostAuthTokenClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectHostAuthTokenApi {
  const tokenClient = createServiceClient<
    Pick<InterBayProjectHostAuthTokenApi, "issue">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectHostAuthTokenSubject({ dest_bay, method: "issue" }),
  });
  return {
    issue: async (opts) => await tokenClient.issue(opts),
  };
}

export function createInterBayProjectReferenceHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectReferenceApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectReferenceApi, "get">>({
    ...options,
    service: "inter-bay-project-reference",
    subject: projectReferenceSubject({ dest_bay: bay_id, method: "get" }),
    impl: {
      get: async (opts) => await impl.get(opts),
    },
  });
}

export function createInterBayProjectDetailsHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectDetailsApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectDetailsApi, "get">>({
    ...options,
    service: "inter-bay-project-details",
    subject: projectDetailsSubject({ dest_bay: bay_id, method: "get" }),
    impl: {
      get: async (opts) => await impl.get(opts),
    },
  });
}

export function createInterBayHostConnectionHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostConnectionApi;
}): ConatService[] {
  return HOST_CONNECTION_METHOD_SPECS.map(({ name, method }) =>
    createServiceHandler<Pick<InterBayHostConnectionApi, typeof name>>({
      ...options,
      service: "inter-bay-host-connection",
      subject: hostConnectionSubject({ dest_bay: bay_id, method }),
      impl: {
        [name]: async (...args: any[]) => await (impl as any)[name](...args),
      } as Pick<InterBayHostConnectionApi, typeof name>,
    }),
  );
}

export function createInterBayHostControlHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostControlApi;
}): ConatService[] {
  return HOST_CONTROL_METHOD_SPECS.map(({ name, method }) =>
    createInterBayHostControlMethodHandler({
      bay_id,
      impl,
      name,
      method,
      ...options,
    }),
  );
}

export function createInterBayProjectHostAuthTokenHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectHostAuthTokenApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectHostAuthTokenApi, "issue">>({
    ...options,
    service: "inter-bay-project-host-auth-token",
    subject: projectHostAuthTokenSubject({ dest_bay: bay_id, method: "issue" }),
    impl: {
      issue: async (opts) => await impl.issue(opts),
    },
  });
}

export function createInterBayProjectLroClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectLroApi {
  const progressClient = createServiceClient<
    Pick<InterBayProjectLroApi, "publishProgress">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectLroSubject({
      dest_bay,
      method: "publish-progress",
    }),
  });
  return {
    publishProgress: async (opts) => await progressClient.publishProgress(opts),
  };
}

export function createInterBayAccountDirectoryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayAccountDirectoryApi {
  const getClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get" }),
  });
  const getByEmailClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getByEmail">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get-by-email" }),
  });
  const getManyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getMany">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get-many" }),
  });
  const searchClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "search">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "search" }),
  });
  const homeBayCountsClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getHomeBayCounts">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "home-bay-counts" }),
  });
  const updateHomeBayClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "updateHomeBay">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "update-home-bay" }),
  });
  const createClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "create">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "create" }),
  });
  const deleteClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "delete">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "delete" }),
  });
  const getApiKeyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getApiKey">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get-api-key" }),
  });
  const upsertApiKeyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "upsertApiKey">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "upsert-api-key" }),
  });
  const deleteApiKeyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "deleteApiKey">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "delete-api-key" }),
  });
  const updateApiKeysHomeBayClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "updateApiKeysHomeBay">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "update-api-keys-home-bay" }),
  });
  const touchApiKeyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "touchApiKey">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "touch-api-key" }),
  });
  const getMembershipClaimIdentityClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getMembershipClaimIdentity">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({
      method: "get-membership-claim-identity",
    }),
  });
  const reserveMembershipClaimIdentityClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "reserveMembershipClaimIdentity">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({
      method: "reserve-membership-claim-identity",
    }),
  });
  const activateMembershipClaimIdentityClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "activateMembershipClaimIdentity">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({
      method: "activate-membership-claim-identity",
    }),
  });
  const revokeMembershipClaimIdentityClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "revokeMembershipClaimIdentity">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({
      method: "revoke-membership-claim-identity",
    }),
  });
  return {
    get: async (opts) => await getClient.get(opts),
    getByEmail: async (opts) => await getByEmailClient.getByEmail(opts),
    getMany: async (opts) => await getManyClient.getMany(opts),
    search: async (opts) => await searchClient.search(opts),
    getHomeBayCounts: async (opts) =>
      await homeBayCountsClient.getHomeBayCounts(opts),
    updateHomeBay: async (opts) =>
      await updateHomeBayClient.updateHomeBay(opts),
    create: async (opts) => await createClient.create(opts),
    delete: async (opts) => await deleteClient.delete(opts),
    getApiKey: async (opts) => await getApiKeyClient.getApiKey(opts),
    upsertApiKey: async (opts) => await upsertApiKeyClient.upsertApiKey(opts),
    deleteApiKey: async (opts) => await deleteApiKeyClient.deleteApiKey(opts),
    updateApiKeysHomeBay: async (opts) =>
      await updateApiKeysHomeBayClient.updateApiKeysHomeBay(opts),
    touchApiKey: async (opts) => await touchApiKeyClient.touchApiKey(opts),
    getMembershipClaimIdentity: async (opts) =>
      await getMembershipClaimIdentityClient.getMembershipClaimIdentity(opts),
    reserveMembershipClaimIdentity: async (opts) =>
      await reserveMembershipClaimIdentityClient.reserveMembershipClaimIdentity(
        opts,
      ),
    activateMembershipClaimIdentity: async (opts) =>
      await activateMembershipClaimIdentityClient.activateMembershipClaimIdentity(
        opts,
      ),
    revokeMembershipClaimIdentity: async (opts) =>
      await revokeMembershipClaimIdentityClient.revokeMembershipClaimIdentity(
        opts,
      ),
  };
}

export function createInterBayAccountDirectoryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & {
  impl: InterBayAccountDirectoryApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "get">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get" }),
      impl: {
        get: async (opts) => await impl.get(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getByEmail">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get-by-email" }),
      impl: {
        getByEmail: async (opts) => await impl.getByEmail(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getMany">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get-many" }),
      impl: {
        getMany: async (opts) => await impl.getMany(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "search">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "search" }),
      impl: {
        search: async (opts) => await impl.search(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getHomeBayCounts">>(
      {
        ...options,
        service: "inter-bay-account-directory",
        subject: accountDirectorySubject({ method: "home-bay-counts" }),
        impl: {
          getHomeBayCounts: async (opts) => await impl.getHomeBayCounts(opts),
        },
      },
    ),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "updateHomeBay">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "update-home-bay" }),
      impl: {
        updateHomeBay: async (opts) => await impl.updateHomeBay(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "create">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "create" }),
      impl: {
        create: async (opts) => await impl.create(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "delete">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "delete" }),
      impl: {
        delete: async (opts) => await impl.delete(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getApiKey">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get-api-key" }),
      impl: {
        getApiKey: async (opts) => await impl.getApiKey(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "upsertApiKey">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "upsert-api-key" }),
      impl: {
        upsertApiKey: async (opts) => await impl.upsertApiKey(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "deleteApiKey">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "delete-api-key" }),
      impl: {
        deleteApiKey: async (opts) => await impl.deleteApiKey(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountDirectoryApi, "updateApiKeysHomeBay">
    >({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "update-api-keys-home-bay" }),
      impl: {
        updateApiKeysHomeBay: async (opts) =>
          await impl.updateApiKeysHomeBay(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "touchApiKey">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "touch-api-key" }),
      impl: {
        touchApiKey: async (opts) => await impl.touchApiKey(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountDirectoryApi, "getMembershipClaimIdentity">
    >({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({
        method: "get-membership-claim-identity",
      }),
      impl: {
        getMembershipClaimIdentity: async (opts) =>
          await impl.getMembershipClaimIdentity(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountDirectoryApi, "reserveMembershipClaimIdentity">
    >({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({
        method: "reserve-membership-claim-identity",
      }),
      impl: {
        reserveMembershipClaimIdentity: async (opts) =>
          await impl.reserveMembershipClaimIdentity(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountDirectoryApi, "activateMembershipClaimIdentity">
    >({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({
        method: "activate-membership-claim-identity",
      }),
      impl: {
        activateMembershipClaimIdentity: async (opts) =>
          await impl.activateMembershipClaimIdentity(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountDirectoryApi, "revokeMembershipClaimIdentity">
    >({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({
        method: "revoke-membership-claim-identity",
      }),
      impl: {
        revokeMembershipClaimIdentity: async (opts) =>
          await impl.revokeMembershipClaimIdentity(opts),
      },
    }),
  ];
}

export function createInterBayAccountLocalClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayAccountLocalApi {
  const createClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "create">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "create" }),
  });
  const deleteClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "delete">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "delete" }),
  });
  const rehomeClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "rehome">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "rehome" }),
  });
  const acceptRehomeClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "acceptRehome">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "accept-rehome" }),
  });
  const copyRehomeStateClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "copyRehomeState">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "copy-rehome-state" }),
  });
  const getRehomeOperationClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getRehomeOperation">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "get-rehome-operation" }),
  });
  const reconcileRehomeClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "reconcileRehome">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "reconcile-rehome" }),
  });
  const createImpersonationGrantClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "createImpersonationGrant">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "create-impersonation-grant",
    }),
  });
  const verifyFreshAuthCredentialsClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "verifyFreshAuthCredentials">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "verify-fresh-auth-credentials",
    }),
  });
  const reconcileDedicatedHostPurchaseSessionClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "reconcileDedicatedHostPurchaseSession">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "reconcile-dedicated-host-purchase-session",
    }),
  });
  const closeDedicatedHostPurchaseSessionClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "closeDedicatedHostPurchaseSession">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "close-dedicated-host-purchase-session",
    }),
  });
  const upsertMembershipGrantClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "upsertMembershipGrant">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "upsert-membership-grant",
    }),
  });
  const revokeMembershipGrantClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "revokeMembershipGrant">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "revoke-membership-grant",
    }),
  });
  const getMembershipClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getMembership">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-membership",
    }),
  });
  const getMembershipDetailsClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getMembershipDetails">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-membership-details",
    }),
  });
  const getAccountEntitlementOverrideClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getAccountEntitlementOverride">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-account-entitlement-override",
    }),
  });
  const setAccountEntitlementOverrideClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "setAccountEntitlementOverride">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "set-account-entitlement-override",
    }),
  });
  const clearAccountEntitlementOverrideClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "clearAccountEntitlementOverride">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "clear-account-entitlement-override",
    }),
  });
  const getDedicatedHostPolicySnapshotClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getDedicatedHostPolicySnapshot">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-dedicated-host-policy-snapshot",
    }),
  });
  const getMembershipPackagesClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getMembershipPackages">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-membership-packages",
    }),
  });
  const adminProvisionMembershipPackageClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "adminProvisionMembershipPackage">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "admin-provision-membership-package",
    }),
  });
  const updateMembershipPackageClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "updateMembershipPackage">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "update-membership-package",
    }),
  });
  const getClaimableMembershipPackagesClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getClaimableMembershipPackages">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-claimable-membership-packages",
    }),
  });
  const claimMembershipPackageSeatClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "claimMembershipPackageSeat">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "claim-membership-package-seat",
    }),
  });
  const getMembershipPortableStateClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "getMembershipPortableState">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "get-membership-portable-state",
    }),
  });
  const replaceMembershipPortableStateClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "replaceMembershipPortableState">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({
      dest_bay,
      method: "replace-membership-portable-state",
    }),
  });
  return {
    create: async (opts) => await createClient.create(opts),
    delete: async (opts) => await deleteClient.delete(opts),
    rehome: async (opts) => await rehomeClient.rehome(opts),
    acceptRehome: async (opts) => await acceptRehomeClient.acceptRehome(opts),
    copyRehomeState: async (opts) =>
      await copyRehomeStateClient.copyRehomeState(opts),
    getRehomeOperation: async (opts) =>
      await getRehomeOperationClient.getRehomeOperation(opts),
    reconcileRehome: async (opts) =>
      await reconcileRehomeClient.reconcileRehome(opts),
    createImpersonationGrant: async (opts) =>
      await createImpersonationGrantClient.createImpersonationGrant(opts),
    verifyFreshAuthCredentials: async (opts) =>
      await verifyFreshAuthCredentialsClient.verifyFreshAuthCredentials(opts),
    reconcileDedicatedHostPurchaseSession: async (opts) =>
      await reconcileDedicatedHostPurchaseSessionClient.reconcileDedicatedHostPurchaseSession(
        opts,
      ),
    closeDedicatedHostPurchaseSession: async (opts) =>
      await closeDedicatedHostPurchaseSessionClient.closeDedicatedHostPurchaseSession(
        opts,
      ),
    upsertMembershipGrant: async (opts) =>
      await upsertMembershipGrantClient.upsertMembershipGrant(opts),
    revokeMembershipGrant: async (opts) =>
      await revokeMembershipGrantClient.revokeMembershipGrant(opts),
    getMembership: async (opts) =>
      await getMembershipClient.getMembership(opts),
    getMembershipDetails: async (opts) =>
      await getMembershipDetailsClient.getMembershipDetails(opts),
    getAccountEntitlementOverride: async (opts) =>
      await getAccountEntitlementOverrideClient.getAccountEntitlementOverride(
        opts,
      ),
    setAccountEntitlementOverride: async (opts) =>
      await setAccountEntitlementOverrideClient.setAccountEntitlementOverride(
        opts,
      ),
    clearAccountEntitlementOverride: async (opts) =>
      await clearAccountEntitlementOverrideClient.clearAccountEntitlementOverride(
        opts,
      ),
    getDedicatedHostPolicySnapshot: async (opts) =>
      await getDedicatedHostPolicySnapshotClient.getDedicatedHostPolicySnapshot(
        opts,
      ),
    getMembershipPackages: async (opts) =>
      await getMembershipPackagesClient.getMembershipPackages(opts),
    adminProvisionMembershipPackage: async (opts) =>
      await adminProvisionMembershipPackageClient.adminProvisionMembershipPackage(
        opts,
      ),
    updateMembershipPackage: async (opts) =>
      await updateMembershipPackageClient.updateMembershipPackage(opts),
    getClaimableMembershipPackages: async (opts) =>
      await getClaimableMembershipPackagesClient.getClaimableMembershipPackages(
        opts,
      ),
    claimMembershipPackageSeat: async (opts) =>
      await claimMembershipPackageSeatClient.claimMembershipPackageSeat(opts),
    getMembershipPortableState: async (opts) =>
      await getMembershipPortableStateClient.getMembershipPortableState(opts),
    replaceMembershipPortableState: async (opts) =>
      await replaceMembershipPortableStateClient.replaceMembershipPortableState(
        opts,
      ),
  };
}

export function createInterBayAccountLocalHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayAccountLocalApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAccountLocalApi, "create">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({ dest_bay: bay_id, method: "create" }),
      impl: {
        create: async (opts) => await impl.create(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "delete">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({ dest_bay: bay_id, method: "delete" }),
      impl: {
        delete: async (opts) => await impl.delete(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "rehome">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({ dest_bay: bay_id, method: "rehome" }),
      impl: {
        rehome: async (opts) => await impl.rehome(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "acceptRehome">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "accept-rehome",
      }),
      impl: {
        acceptRehome: async (opts) => await impl.acceptRehome(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "copyRehomeState">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "copy-rehome-state",
      }),
      impl: {
        copyRehomeState: async (opts) => await impl.copyRehomeState(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "getRehomeOperation">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-rehome-operation",
      }),
      impl: {
        getRehomeOperation: async (opts) => await impl.getRehomeOperation(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "reconcileRehome">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "reconcile-rehome",
      }),
      impl: {
        reconcileRehome: async (opts) => await impl.reconcileRehome(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "createImpersonationGrant">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "create-impersonation-grant",
      }),
      impl: {
        createImpersonationGrant: async (opts) =>
          await impl.createImpersonationGrant(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "verifyFreshAuthCredentials">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "verify-fresh-auth-credentials",
      }),
      impl: {
        verifyFreshAuthCredentials: async (opts) =>
          await impl.verifyFreshAuthCredentials(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "reconcileDedicatedHostPurchaseSession">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "reconcile-dedicated-host-purchase-session",
      }),
      impl: {
        reconcileDedicatedHostPurchaseSession: async (opts) =>
          await impl.reconcileDedicatedHostPurchaseSession(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "closeDedicatedHostPurchaseSession">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "close-dedicated-host-purchase-session",
      }),
      impl: {
        closeDedicatedHostPurchaseSession: async (opts) =>
          await impl.closeDedicatedHostPurchaseSession(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "upsertMembershipGrant">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "upsert-membership-grant",
      }),
      impl: {
        upsertMembershipGrant: async (opts) =>
          await impl.upsertMembershipGrant(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "revokeMembershipGrant">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "revoke-membership-grant",
      }),
      impl: {
        revokeMembershipGrant: async (opts) =>
          await impl.revokeMembershipGrant(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "getMembership">>({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-membership",
      }),
      impl: {
        getMembership: async (opts) => await impl.getMembership(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountLocalApi, "getMembershipDetails">>(
      {
        ...options,
        service: "inter-bay-account-local",
        subject: accountLocalSubject({
          dest_bay: bay_id,
          method: "get-membership-details",
        }),
        impl: {
          getMembershipDetails: async (opts) =>
            await impl.getMembershipDetails(opts),
        },
      },
    ),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "getAccountEntitlementOverride">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-account-entitlement-override",
      }),
      impl: {
        getAccountEntitlementOverride: async (opts) =>
          await impl.getAccountEntitlementOverride(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "setAccountEntitlementOverride">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "set-account-entitlement-override",
      }),
      impl: {
        setAccountEntitlementOverride: async (opts) =>
          await impl.setAccountEntitlementOverride(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "clearAccountEntitlementOverride">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "clear-account-entitlement-override",
      }),
      impl: {
        clearAccountEntitlementOverride: async (opts) =>
          await impl.clearAccountEntitlementOverride(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "getDedicatedHostPolicySnapshot">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-dedicated-host-policy-snapshot",
      }),
      impl: {
        getDedicatedHostPolicySnapshot: async (opts) =>
          await impl.getDedicatedHostPolicySnapshot(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "getMembershipPackages">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-membership-packages",
      }),
      impl: {
        getMembershipPackages: async (opts) =>
          await impl.getMembershipPackages(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "adminProvisionMembershipPackage">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "admin-provision-membership-package",
      }),
      impl: {
        adminProvisionMembershipPackage: async (opts) =>
          await impl.adminProvisionMembershipPackage(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "updateMembershipPackage">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "update-membership-package",
      }),
      impl: {
        updateMembershipPackage: async (opts) =>
          await impl.updateMembershipPackage(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "getClaimableMembershipPackages">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-claimable-membership-packages",
      }),
      impl: {
        getClaimableMembershipPackages: async (opts) =>
          await impl.getClaimableMembershipPackages(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "claimMembershipPackageSeat">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "claim-membership-package-seat",
      }),
      impl: {
        claimMembershipPackageSeat: async (opts) =>
          await impl.claimMembershipPackageSeat(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "getMembershipPortableState">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "get-membership-portable-state",
      }),
      impl: {
        getMembershipPortableState: async (opts) =>
          await impl.getMembershipPortableState(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayAccountLocalApi, "replaceMembershipPortableState">
    >({
      ...options,
      service: "inter-bay-account-local",
      subject: accountLocalSubject({
        dest_bay: bay_id,
        method: "replace-membership-portable-state",
      }),
      impl: {
        replaceMembershipPortableState: async (opts) =>
          await impl.replaceMembershipPortableState(opts),
      },
    }),
  ];
}

export function createInterBayBayRegistryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayBayRegistryApi {
  const registerClient = createServiceClient<
    Pick<InterBayBayRegistryApi, "register">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: bayRegistrySubject({ method: "register" }),
  });
  const listClient = createServiceClient<Pick<InterBayBayRegistryApi, "list">>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayRegistrySubject({ method: "list" }),
  });
  return {
    register: async (opts) => await registerClient.register(opts),
    list: async (opts) => await listClient.list(opts),
  };
}

export function createInterBayBayOpsClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayBayOpsApi {
  const loadClient = createServiceClient<Pick<InterBayBayOpsApi, "getLoad">>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayOpsSubject({ dest_bay, method: "get-load" }),
  });
  const backupsClient = createServiceClient<
    Pick<InterBayBayOpsApi, "getBackups">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: bayOpsSubject({ dest_bay, method: "get-backups" }),
  });
  return {
    getLoad: async (opts) => await loadClient.getLoad(opts),
    getBackups: async (opts) => await backupsClient.getBackups(opts),
  };
}

export function createInterBayBayRegistryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & {
  impl: InterBayBayRegistryApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayBayRegistryApi, "register">>({
      ...options,
      service: "inter-bay-bay-registry",
      subject: bayRegistrySubject({ method: "register" }),
      impl: {
        register: async (opts) => await impl.register(opts),
      },
    }),
    createServiceHandler<Pick<InterBayBayRegistryApi, "list">>({
      ...options,
      service: "inter-bay-bay-registry",
      subject: bayRegistrySubject({ method: "list" }),
      impl: {
        list: async (opts) => await impl.list(opts),
      },
    }),
  ];
}

export function createInterBayBayOpsHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayBayOpsApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayBayOpsApi, "getLoad">>({
      ...options,
      service: "inter-bay-bay-ops",
      subject: bayOpsSubject({ dest_bay: bay_id, method: "get-load" }),
      impl: {
        getLoad: async (opts) => await impl.getLoad(opts),
      },
    }),
    createServiceHandler<Pick<InterBayBayOpsApi, "getBackups">>({
      ...options,
      service: "inter-bay-bay-ops",
      subject: bayOpsSubject({ dest_bay: bay_id, method: "get-backups" }),
      impl: {
        getBackups: async (opts) => await impl.getBackups(opts),
      },
    }),
  ];
}

export function createInterBayAuthTokenClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayAuthTokenApi {
  const requiresTokenClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "requiresToken">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "requires-token" }),
  });
  const redeemClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "redeem">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "redeem" }),
  });
  const disableClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "disable">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "disable" }),
  });
  return {
    requiresToken: async (opts) =>
      await requiresTokenClient.requiresToken(opts),
    redeem: async (opts) => await redeemClient.redeem(opts),
    disable: async (opts) => await disableClient.disable(opts),
  };
}

export function createInterBayAuthTokenHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & { impl: InterBayAuthTokenApi }): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAuthTokenApi, "requiresToken">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "requires-token" }),
      impl: {
        requiresToken: async (opts) => await impl.requiresToken(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAuthTokenApi, "redeem">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "redeem" }),
      impl: {
        redeem: async (opts) => await impl.redeem(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAuthTokenApi, "disable">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "disable" }),
      impl: {
        disable: async (opts) => await impl.disable(opts),
      },
    }),
  ];
}

export function createInterBayProjectCollabInviteClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectCollabInviteApi {
  const upsertInboxClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "upsertInbox">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "upsert-inbox" }),
  });
  const deleteInboxClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "deleteInbox">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "delete-inbox" }),
  });
  const createClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "create">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "create" }),
  });
  const listClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "list">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "list" }),
  });
  const removeCollaboratorClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "removeCollaborator">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({
      dest_bay,
      method: "remove-collaborator",
    }),
  });
  const respondClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "respond">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "respond" }),
  });
  return {
    upsertInbox: async (opts) => await upsertInboxClient.upsertInbox(opts),
    deleteInbox: async (opts) => await deleteInboxClient.deleteInbox(opts),
    list: async (opts) => await listClient.list(opts),
    removeCollaborator: async (opts) =>
      await removeCollaboratorClient.removeCollaborator(opts),
    create: async (opts) => await createClient.create(opts),
    respond: async (opts) => await respondClient.respond(opts),
  };
}

export function createInterBayAccountProjectFeedClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayAccountProjectFeedApi {
  const upsertClient = createServiceClient<
    Pick<InterBayAccountProjectFeedApi, "upsert">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountProjectFeedSubject({ dest_bay, method: "upsert" }),
  });
  const removeClient = createServiceClient<
    Pick<InterBayAccountProjectFeedApi, "remove">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountProjectFeedSubject({ dest_bay, method: "remove" }),
  });
  return {
    upsert: async (opts) => await upsertClient.upsert(opts),
    remove: async (opts) => await removeClient.remove(opts),
  };
}

export function createInterBayProjectCollabInviteHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectCollabInviteApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "upsertInbox">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "upsert-inbox",
      }),
      impl: {
        upsertInbox: async (opts) => await impl.upsertInbox(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "deleteInbox">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "delete-inbox",
      }),
      impl: {
        deleteInbox: async (opts) => await impl.deleteInbox(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "create">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "create",
      }),
      impl: {
        create: async (opts) => await impl.create(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "list">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "list",
      }),
      impl: {
        list: async (opts) => await impl.list(opts),
      },
    }),
    createServiceHandler<
      Pick<InterBayProjectCollabInviteApi, "removeCollaborator">
    >({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "remove-collaborator",
      }),
      impl: {
        removeCollaborator: async (opts) => await impl.removeCollaborator(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "respond">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "respond",
      }),
      impl: {
        respond: async (opts) => await impl.respond(opts),
      },
    }),
  ];
}

export function createInterBayAccountProjectFeedHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayAccountProjectFeedApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAccountProjectFeedApi, "upsert">>({
      ...options,
      service: "inter-bay-account-project-feed",
      subject: accountProjectFeedSubject({
        dest_bay: bay_id,
        method: "upsert",
      }),
      impl: {
        upsert: async (opts) => await impl.upsert(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountProjectFeedApi, "remove">>({
      ...options,
      service: "inter-bay-account-project-feed",
      subject: accountProjectFeedSubject({
        dest_bay: bay_id,
        method: "remove",
      }),
      impl: {
        remove: async (opts) => await impl.remove(opts),
      },
    }),
  ];
}

export function createInterBayProjectLroHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectLroApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectLroApi, "publishProgress">>({
    ...options,
    service: "inter-bay-project-lro",
    subject: projectLroSubject({
      dest_bay: bay_id,
      method: "publish-progress",
    }),
    impl: {
      publishProgress: async (opts) => await impl.publishProgress(opts),
    },
  });
}

export function createInterBayProjectControlStopHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "stop">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "stop" }),
    impl: {
      stop: async (opts) => await impl.stop(opts),
    },
  });
}

export function createInterBayProjectControlRestartHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "restart">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "restart" }),
    impl: {
      restart: async (opts) => await impl.restart(opts),
    },
  });
}

export function createInterBayProjectControlBackupHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "backup">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "backup" }),
    impl: {
      backup: async (opts) => await impl.backup(opts),
    },
  });
}

export function createInterBayProjectControlStateHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "state">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "state" }),
    impl: {
      state: async (opts) => await impl.state(opts),
    },
  });
}

export function createInterBayProjectControlAddressHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "address">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "address" }),
    impl: {
      address: async (opts) => await impl.address(opts),
    },
  });
}

export function createInterBayProjectControlSetUsageAccountHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<
    Pick<InterBayProjectControlApi, "setUsageAccount">
  >({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({
      dest_bay: bay_id,
      method: "set-usage-account",
    }),
    impl: {
      setUsageAccount: async (opts) => await impl.setUsageAccount(opts),
    },
  });
}

export function createInterBayProjectControlMoveHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "move">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "move" }),
    impl: {
      move: async (opts) => await impl.move(opts),
    },
  });
}

export function createInterBayProjectControlRehomeHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "rehome">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "rehome" }),
    impl: {
      rehome: async (opts) => await impl.rehome(opts),
    },
  });
}

export function createInterBayProjectControlAcceptRehomeHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "acceptRehome">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({
      dest_bay: bay_id,
      method: "accept-rehome",
    }),
    impl: {
      acceptRehome: async (opts) => await impl.acceptRehome(opts),
    },
  });
}

export function createInterBayProjectControlActiveOpHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "activeOp">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "active-op" }),
    impl: {
      activeOp: async (opts) => await impl.activeOp(opts),
    },
  });
}
