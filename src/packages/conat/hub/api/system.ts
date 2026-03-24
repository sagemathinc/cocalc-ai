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
} from "@cocalc/util/db-schema/api-keys";
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";
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

export const system = {
  getCustomize: noAuth,
  ping: noAuth,
  terminate: authFirst,
  getParallelOpsStatus: authFirst,
  getProjectHostParallelOpsLimit: authFirst,
  setParallelOpsLimit: authFirst,
  clearParallelOpsLimit: authFirst,
  userTracking: authFirst,
  logClientError: authFirst,
  webappError: authFirst,
  manageApiKeys: authFirst,
  generateUserAuthToken: authFirst,
  revokeUserAuthToken: noAuth,
  userSearch: authFirst,
  getNames: requireSignedIn,
  adminCreateUser: authFirst,
  adminResetPasswordLink: authFirst,
  sendEmailVerification: authFirst,
  deletePassport: authFirst,
  getAdminAssignedMembership: authFirst,
  setAdminAssignedMembership: authFirst,
  clearAdminAssignedMembership: authFirst,
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
  upsertBrowserSession: authFirst,
  listBrowserSessions: authFirst,
  removeBrowserSession: authFirst,
  issueBrowserSignInCookie: requireSignedIn,
  getProjectAppPublicPolicy: authFirst,
  tracePublicAppHostname: authFirst,
  reserveProjectAppPublicSubdomain: authFirst,
  releaseProjectAppPublicSubdomain: authFirst,

  adminSalesloftSync: authFirst,
  userSalesloftSync: authFirst,
};

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
  config_source: "constant" | "env-legacy" | "db-override";
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
  config_source: "constant" | "env-legacy" | "db-override";
}

export interface ReserveProjectAppPublicSubdomainResult {
  hostname: string;
  label: string;
  base_path: string;
  url_public: string;
  warnings: string[];
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
  // ping server and get back the current time
  ping: () => { now: number };
  // terminate a service:
  //   - only admin can do this.
  //   - useful for development
  terminate: (service: "database" | "api") => Promise<void>;

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
    project_id?: string;
    name?: string;
    expire?: Date;
    id?: number;
  }) => Promise<ApiKey[] | undefined>;

  generateUserAuthToken: (opts: {
    account_id?: string;
    user_account_id: string;
    password?: string;
  }) => Promise<string>;

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
    no_first_project?: boolean;
    tags?: string[];
  }) => Promise<{
    account_id: string;
    email_address: string;
    first_name: string;
    last_name: string;
    created_by: string;
    no_first_project: boolean;
    password_generated: boolean;
    generated_password?: string;
  }>;

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
    user_account_id: string;
    membership_class: string;
    expires_at?: Date | null;
    notes?: string | null;
  }) => Promise<void>;

  clearAdminAssignedMembership: (opts: {
    account_id?: string;
    user_account_id: string;
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
}
