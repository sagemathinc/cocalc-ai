import getCustomize from "@cocalc/database/settings/customize";
export { getCustomize };
import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import { getFrontendSourceFingerprint as getFrontendSourceFingerprint0 } from "@cocalc/backend/frontend-build-fingerprint";
import {
  getSingleBayInfo,
  listConfiguredBays,
  resolveAccountHomeBay,
  resolveHostBay,
  resolveProjectOwningBay,
  resolveRoutingContext,
} from "@cocalc/server/bay-directory";
import {
  listClusterBayRegistry,
  setBayProjectOwnershipAdmissionLocal,
} from "@cocalc/server/bay-registry";
import { backfillBayOwnership as backfillBayOwnership0 } from "@cocalc/server/bay-backfill";
import { rebuildAccountProjectIndex as rebuildAccountProjectIndex0 } from "@cocalc/database/postgres/account-project-index";
import {
  drainAccountProjectIndexProjection as drainAccountProjectIndexProjection0,
  getAccountProjectIndexProjectionBacklogStatus,
} from "@cocalc/database/postgres/account-project-index-projector";
import { rebuildAccountCollaboratorIndex as rebuildAccountCollaboratorIndex0 } from "@cocalc/database/postgres/account-collaborator-index";
import {
  drainAccountCollaboratorIndexProjection as drainAccountCollaboratorIndexProjection0,
  getAccountCollaboratorIndexProjectionBacklogStatus,
} from "@cocalc/database/postgres/account-collaborator-index-projector";
import { rebuildAccountNotificationIndex as rebuildAccountNotificationIndex0 } from "@cocalc/database/postgres/account-notification-index";
import {
  drainAccountNotificationIndexProjection as drainAccountNotificationIndexProjection0,
  getAccountNotificationIndexProjectionBacklogStatus,
} from "@cocalc/database/postgres/account-notification-index-projector";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { runBayDrainPreflight } from "@cocalc/server/bay-drain/preflight";
import { recordBrowserAutomationAuditEvent } from "./browser-automation-audit";
import { db } from "@cocalc/database";
import manageApiKeys0 from "@cocalc/server/api/manage";
import { type UserSearchResult } from "@cocalc/util/db-schema/accounts";
import type {
  ApiKey,
  Action as ApiKeyAction,
  ApiKeyCapability,
} from "@cocalc/util/db-schema/api-keys";
import isAdmin from "@cocalc/server/accounts/is-admin";
import getName from "@cocalc/server/accounts/get-name";
import { searchRelatedClusterAccounts } from "@cocalc/server/accounts/search-policy";
import type { AccountEntitlementOverride } from "@cocalc/conat/hub/api/purchases";
import {
  clearAccountEntitlementOverrideLocal,
  getAccountEntitlementOverrideLocal,
  setAccountEntitlementOverrideLocal,
  type AccountEntitlementOverrideInput,
} from "@cocalc/server/membership/entitlement-overrides";
import {
  clearAdminAssignedMembershipLocal,
  getAdminAssignedMembershipLocal,
  setAdminAssignedMembershipLocal,
  type AdminAssignedMembershipRow,
} from "@cocalc/server/membership/admin-assigned";
import {
  adminDisableClusterAccountTwoFactor,
  adminGrantClusterAccountAdminRole,
  adminRevokeClusterAccountAdminRole,
  adminVerifyClusterAccountEmailAddress,
  createClusterAccount,
  deleteClusterAccount,
  searchClusterAccounts,
  touchClusterAccountDirectoryEntry,
} from "@cocalc/server/inter-bay/accounts";
import {
  drainAccountRehome as drainAccountRehomeInternal,
  getAccountRehomeOperationForOperator,
  repairAccountMembershipPortability as repairAccountMembershipPortabilityInternal,
  reconcileAccountRehome as reconcileAccountRehomeInternal,
  rehomeAccount as rehomeAccountInternal,
} from "@cocalc/server/accounts/rehome";
export { getNames } from "@cocalc/server/accounts/get-name";
import { callback2 } from "@cocalc/util/async-utils";
import getLogger from "@cocalc/backend/logger";
import basePath from "@cocalc/backend/base-path";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  getExternalCredentialRouted,
  hasExternalCredentialRouted,
  listAccountExternalCredentialsRouted,
  revokeAccountExternalCredentialRouted,
  revokeExternalCredentialBySelectorRouted,
  upsertExternalCredentialRouted,
} from "@cocalc/server/external-credentials/routing";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isAiLaunchDisabled } from "@cocalc/server/launch/kill-switches";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { EXTRAS as SITE_SETTINGS_EXTRAS } from "@cocalc/util/db-schema/site-settings-extras";
import { is_valid_email_address } from "@cocalc/util/misc";
import { site_settings_conf } from "@cocalc/util/schema";
import {
  normalizeSignupEmailDomainPolicy,
  SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS,
  type DomainRule,
  type SignupEmailDomainPolicy,
  type SignupEmailDomainPolicySettings,
} from "@cocalc/util/accounts/signup-email-domain-policy";
import { v4 as uuid } from "uuid";
import { secureRandomString } from "@cocalc/backend/misc";
import {
  testR2Credentials as testR2Credentials0,
  type R2CredentialsTestResult,
} from "@cocalc/server/project-backup/r2";
import { applyLaunchpadCloudflareTunnelSettings } from "@cocalc/server/launchpad/onprem-sshd";
import { hasActiveSecondFactor } from "@cocalc/server/auth/two-factor";
import { ensureStarInviteRegistrationToken } from "@cocalc/server/auth/bootstrap-admin";
import { getNebiusRegionConfigFromSettings } from "@cocalc/server/cloud/nebius-credentials";
import type {
  CloudflareTunnelApplyResult,
  SiteSetupStatus,
  SiteSetupStep,
  SiteSetupStepState,
  StarServerInfo,
  UxLatencyEventInput,
  UxLatencySummary,
} from "@cocalc/conat/hub/api/system";
import {
  bootstrapCloudflareConfiguration as bootstrapCloudflareConfiguration0,
  type CloudflareBootstrapResult,
} from "@cocalc/server/cloud/cloudflare-bootstrap";
import {
  createCloudflareTeardownPlan as createCloudflareTeardownPlan0,
  getCloudflareTeardownPlan as getCloudflareTeardownPlan0,
  runCloudflareTeardownApplyLro,
  type CloudflareTeardownPlan,
} from "@cocalc/server/cloud/cloudflare-teardown";
import {
  auditCloudflareR2Bucket as auditCloudflareR2Bucket0,
  getCloudflareR2BayBackupCleanupPlan as getCloudflareR2BayBackupCleanupPlan0,
  getCloudflareR2Usage as getCloudflareR2Usage0,
  runCloudflareR2BayBackupCleanupLro,
  runCloudflareR2AuditLro,
  type CloudflareR2BayBackupCleanupPlan,
  type CloudflareR2AuditResult,
  type CloudflareR2UsageResult,
} from "@cocalc/server/cloud/cloudflare-r2-usage";
import {
  arch,
  hostname,
  platform,
  release as osRelease,
  totalmem,
} from "node:os";
import { readFile, readlink } from "node:fs/promises";
import {
  clearProviderSetupChallenge as clearProviderSetupChallenge0,
  createProviderSetupChallenge as createProviderSetupChallenge0,
  getProviderSetupChallenge as getProviderSetupChallenge0,
  type ProviderSetupChallenge,
  type ProviderSetupChallengeProvider,
} from "@cocalc/server/provider-setup/challenges";
import {
  getProjectBackupInfrastructureStatus,
  getProjectBackupShardAdminStatus,
} from "@cocalc/server/project-backup";
import {
  getBayBackupStatus as getBayBackupStatus0,
  runBayBackup as runBayBackup0,
  runBayRestore as runBayRestore0,
  runBayRestoreTest as runBayRestoreTest0,
} from "@cocalc/server/bay-backup";
import {
  listRootfsImagesAdmin,
  listRootfsImagesAdminPage,
  listVisibleRootfsImages,
  listVisibleRootfsImagesPage,
  requestRootfsImageDeletion as requestRootfsImageDeletion0,
  saveRootfsImage,
} from "@cocalc/server/rootfs/catalog";
import { getRootfsReleaseScanReport } from "@cocalc/server/rootfs/scans";
import {
  runProjectRootfsPreflightScan,
  runRootfsReleaseScan,
} from "@cocalc/server/rootfs/scan-execution";
import {
  listRootfsRusticReposAdmin,
  runPendingRootfsReleaseGc,
} from "@cocalc/server/rootfs/releases";
import type {
  ProjectRootfsStateEntry,
  ProjectRootfsPublishLroRef,
  PublishProjectRootfsBody,
  RootfsAdminCatalogPage,
  RootfsCatalogPageRequest,
  RootfsCatalogSaveBody,
  RootfsImageCatalogPage,
} from "@cocalc/util/rootfs-images";
import type {
  RootfsProjectPreflightScanResult,
  RootfsReleaseScanReport,
  RootfsReleaseScanRun,
} from "@cocalc/util/rootfs-scan";
import {
  getProjectRootfsStates as getProjectRootfsStates0,
  setProjectRootfsImageWithRollback,
} from "@cocalc/server/projects/rootfs-state";
import {
  assertCanCreateOrUpdateRootfs,
  assertCanSelectProjectRootfsImage,
} from "@cocalc/server/membership/rootfs-limits";
import { getRootfsQuotaReport as getRootfsQuotaReport0 } from "@cocalc/server/membership/rootfs-report";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import { createLro } from "@cocalc/server/lro/lro-db";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  listBrowserSessionsForAccount,
  removeBrowserSessionRecord,
  upsertBrowserSessionRecord,
} from "./browser-sessions";
import { getLiveBrowserSessionInfo } from "./browser-sessions-live";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import { createImpersonationGrantLocal } from "@cocalc/server/auth/impersonation";
import { upsertAccountImpersonationGrantDirectory } from "@cocalc/server/auth/impersonation-grant-directory";
import {
  getProjectAppPublicPolicy as getProjectAppPublicPolicyRaw,
  getPublicAppRouteByHostname as getPublicAppRouteByHostnameRaw,
  releaseProjectAppPublicSubdomain as releaseProjectAppPublicSubdomainRaw,
  resolvePublicAppDnsTarget,
  reserveProjectAppPublicSubdomain as reserveProjectAppPublicSubdomainRaw,
} from "@cocalc/server/app-public-subdomains";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";
import { conat } from "@cocalc/backend/conat";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import { getParallelOpsStatus as getParallelOpsStatus0 } from "@cocalc/server/lro/worker-status";
import {
  clearParallelOpsLimitOverride,
  getEffectiveParallelOpsLimit,
  setParallelOpsLimitOverride,
  type ParallelOpsLimitScopeType,
} from "@cocalc/server/lro/worker-config";
import { getParallelOpsWorkerRegistration } from "@cocalc/server/lro/worker-registry";
import { getProjectHostDefaultParallelLimit } from "@cocalc/server/lro/project-host-defaults";
import {
  getUxLatencySummary as getUxLatencySummary0,
  recordUxLatencyEvent as recordUxLatencyEvent0,
} from "@cocalc/server/monitoring/ux-latency";
import { getAccountProjectIndexProjectionMaintenanceStatus } from "@cocalc/server/projections/account-project-index-maintenance";
import { getAccountCollaboratorIndexProjectionMaintenanceStatus } from "@cocalc/server/projections/account-collaborator-index-maintenance";
import { getAccountNotificationIndexProjectionMaintenanceStatus } from "@cocalc/server/projections/account-notification-index-maintenance";
import { getManagedProjectEgressPolicy as getManagedProjectEgressPolicyRaw } from "@cocalc/server/membership/managed-egress-policy";
import { recordManagedProjectEgress as recordManagedProjectEgressRaw } from "@cocalc/server/membership/managed-egress";
import { recordManagedProjectCpuUsage as recordManagedProjectCpuUsageRaw } from "@cocalc/server/membership/managed-cpu";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import sshKeys from "@cocalc/server/projects/get-ssh-keys";
import { getAppFeedData as listAppNews0 } from "@cocalc/database/postgres/news";
import type { NewsItemWebapp } from "@cocalc/util/types/news";
import type {
  BayBackupRunResult,
  BayRestoreRunResult,
  BayRestoreTestRunResult,
  BayBackupsInfo,
  BayInfo,
  BayOpsDetail,
  BayOpsOverview,
  BayOpsOverviewBay,
  BayOpsRehomeCounts,
  BayOpsRehomeDirectionCounts,
  BayOpsRehomeStatus,
  BayLoadBrowserControlStatus,
  BayLoadInfo,
  BayLoadParallelOpsStatus,
  BayLoadProjectionStatus,
  AcpAdmissionDenialReport,
  AcpAdmissionDenialSummary,
  ProjectRuntimeSlotReport,
  ProjectRuntimeSlotReportSlot,
  ProjectRuntimeSlotReportSponsor,
  RootfsQuotaReport,
  RootfsQuotaDenialSummary,
  RootfsQuotaUsageRow,
  ServiceAdmissionDenialReport,
  ServiceAdmissionDenialSummary,
  GlobalConfigPropagationBayState,
  GlobalConfigPropagationStatus,
  ProjectBackupShardAdminStatus,
  SiteSettingsSyncResult,
} from "@cocalc/conat/hub/api/system";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getClusterConfig } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";
import { getConatAdmissionConfig } from "../admission-settings";
import {
  recordServiceAdmissionDenialLocal,
  recordServiceAdmissionNearLimitLocal,
} from "./service-admission-denials";
import type { ServiceAdmissionDenialEvent } from "@cocalc/conat/admission/denials";

const logger = getLogger("server:conat:api:system");
const ACCOUNT_ACTIVITY_TOUCH_MIN_INTERVAL_MS = 120_000;
const ACCOUNT_ACTIVITY_TOUCH_MAX_CACHE_AGE_MS = 10 * 60_000;
const accountActivityTouchedAt = new Map<string, number>();

function shouldTouchAccountActivity(account_id: string): boolean {
  const now = Date.now();
  const last = accountActivityTouchedAt.get(account_id) ?? 0;
  if (now - last < ACCOUNT_ACTIVITY_TOUCH_MIN_INTERVAL_MS) {
    return false;
  }
  accountActivityTouchedAt.set(account_id, now);
  if (accountActivityTouchedAt.size > 10_000) {
    for (const [id, touchedAt] of accountActivityTouchedAt) {
      if (now - touchedAt > ACCOUNT_ACTIVITY_TOUCH_MAX_CACHE_AGE_MS) {
        accountActivityTouchedAt.delete(id);
      }
    }
  }
  return true;
}

async function touchAccountActivity(account_id: string): Promise<void> {
  if (!shouldTouchAccountActivity(account_id)) {
    return;
  }
  try {
    await callback2(db().touch, { account_id, action: "browser-session" });
  } catch (err) {
    accountActivityTouchedAt.delete(account_id);
    throw err;
  }
  touchClusterAccountDirectoryEntry({ account_id }).catch((err) => {
    logger.debug("failed to touch cluster account directory", {
      account_id,
      err: `${err}`,
    });
  });
}

// Non-serializable capability used only by trusted in-process inter-bay handlers.
// Public Conat API callers cannot supply this value over JSON.
export const BAY_OPS_INTERNAL_AUTH = Symbol("bay-ops-internal-auth");
const ROOTFS_PUBLISH_LRO_KIND = "project-rootfs-publish";
const DEFAULT_BROWSER_SIGN_IN_COOKIE_MAX_AGE_MS = 12 * 3600 * 1000;

export function ping() {
  return { now: Date.now() };
}

export async function listNews(): Promise<NewsItemWebapp[]> {
  const rows = await listAppNews0();
  return rows
    .filter((row): row is typeof row & { id: string | number } => !!row?.id)
    .map((row) => ({
      id: `${row.id}`,
      title: row.title,
      channel: row.channel,
      tags: row.tags,
      text: row.text,
      url: row.url,
      hide: row.hide,
      date: row.date instanceof Date ? row.date : new Date(row.date * 1000),
      until:
        row.until == null
          ? undefined
          : row.until instanceof Date
            ? row.until
            : new Date(row.until * 1000),
    }));
}

export async function listBays() {
  return await listConfiguredBays();
}

function zeroRehomeDirectionCounts(): BayOpsRehomeDirectionCounts {
  return {
    running: 0,
    failed: 0,
    recent_success: 0,
  };
}

function zeroRehomeCounts(): BayOpsRehomeCounts {
  return {
    outbound: zeroRehomeDirectionCounts(),
    inbound: zeroRehomeDirectionCounts(),
  };
}

function zeroRehomeStatus(): BayOpsRehomeStatus {
  return {
    account: zeroRehomeCounts(),
    project: zeroRehomeCounts(),
    project_host: zeroRehomeCounts(),
  };
}

function addCount(
  rowsByBay: Map<string, number>,
  bay_id: string,
  count: unknown,
): void {
  const n = Number(count);
  rowsByBay.set(bay_id, Math.max(0, Number.isFinite(n) ? n : 0));
}

async function getOwnershipCountMaps(defaultBayId: string): Promise<{
  accounts: Map<string, number>;
  projects: Map<string, number>;
  project_hosts: Map<string, number>;
}> {
  const [accountsResult, projectsResult, hostsResult] = await Promise.all([
    getPool().query<{ bay_id: string; count: string }>(
      `SELECT COALESCE(NULLIF(BTRIM(home_bay_id), ''), $1::TEXT) AS bay_id,
              COUNT(*)::TEXT AS count
         FROM accounts
        WHERE deleted IS NOT TRUE
        GROUP BY 1`,
      [defaultBayId],
    ),
    getPool().query<{ bay_id: string; count: string }>(
      `SELECT COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1::TEXT) AS bay_id,
              COUNT(*)::TEXT AS count
         FROM projects
        WHERE deleted IS NOT TRUE
        GROUP BY 1`,
      [defaultBayId],
    ),
    getPool().query<{ bay_id: string; count: string }>(
      `SELECT COALESCE(NULLIF(BTRIM(bay_id), ''), $1::TEXT) AS bay_id,
              COUNT(*)::TEXT AS count
         FROM project_hosts
        WHERE deleted IS NULL
        GROUP BY 1`,
      [defaultBayId],
    ),
  ]);

  const accounts = new Map<string, number>();
  const projects = new Map<string, number>();
  const project_hosts = new Map<string, number>();
  for (const row of accountsResult.rows)
    addCount(accounts, row.bay_id, row.count);
  for (const row of projectsResult.rows)
    addCount(projects, row.bay_id, row.count);
  for (const row of hostsResult.rows)
    addCount(project_hosts, row.bay_id, row.count);
  return { accounts, projects, project_hosts };
}

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${table}`],
  );
  return rows[0]?.exists === true;
}

type RehomeKind = keyof BayOpsRehomeStatus;

async function addRehomeCounts({
  rows,
  kind,
  table,
}: {
  rows: Map<string, BayOpsOverviewBay>;
  kind: RehomeKind;
  table: string;
}): Promise<void> {
  if (!(await tableExists(table))) return;
  const { rows: resultRows } = await getPool().query<{
    source_bay_id: string;
    dest_bay_id: string;
    running: string;
    failed: string;
    recent_success: string;
  }>(
    `SELECT source_bay_id,
            dest_bay_id,
            COUNT(*) FILTER (WHERE status IN ('running', 'requested'))::TEXT AS running,
            COUNT(*) FILTER (WHERE status = 'failed')::TEXT AS failed,
            COUNT(*) FILTER (
              WHERE status = 'succeeded'
                AND finished_at >= NOW() - INTERVAL '24 hours'
            )::TEXT AS recent_success
       FROM ${table}
      WHERE status IN ('running', 'requested', 'failed')
         OR finished_at >= NOW() - INTERVAL '24 hours'
      GROUP BY source_bay_id, dest_bay_id`,
  );
  for (const row of resultRows) {
    const running = Number(row.running) || 0;
    const failed = Number(row.failed) || 0;
    const recentSuccess = Number(row.recent_success) || 0;
    const outbound = rows.get(row.source_bay_id)?.rehome[kind]?.outbound;
    const inbound = rows.get(row.dest_bay_id)?.rehome[kind]?.inbound;
    if (outbound) {
      outbound.running += running;
      outbound.failed += failed;
      outbound.recent_success += recentSuccess;
    }
    if (inbound) {
      inbound.running += running;
      inbound.failed += failed;
      inbound.recent_success += recentSuccess;
    }
  }
}

export async function getBayOpsOverview({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<BayOpsOverview> {
  await assertAdmin(account_id);
  const defaultBayId = getConfiguredBayId();
  const [configuredBays, registryRows, counts] = await Promise.all([
    listConfiguredBays(),
    listClusterBayRegistry(),
    getOwnershipCountMaps(defaultBayId),
  ]);
  const registryByBay = new Map(registryRows.map((row) => [row.bay_id, row]));
  const rowsByBay = new Map<string, BayOpsOverviewBay>();

  for (const bay of configuredBays) {
    const registry = registryByBay.get(bay.bay_id);
    rowsByBay.set(bay.bay_id, {
      ...bay,
      public_origin: registry?.public_origin ?? null,
      public_target: registry?.public_target ?? null,
      public_target_kind: registry?.public_target_kind ?? null,
      dns_hostname: registry?.dns_hostname ?? null,
      last_seen: registry?.last_seen ?? null,
      ownership: {
        accounts: counts.accounts.get(bay.bay_id) ?? 0,
        projects: counts.projects.get(bay.bay_id) ?? 0,
        project_hosts: counts.project_hosts.get(bay.bay_id) ?? 0,
      },
      rehome: zeroRehomeStatus(),
    });
  }

  for (const registry of registryRows) {
    if (rowsByBay.has(registry.bay_id)) continue;
    rowsByBay.set(registry.bay_id, {
      bay_id: registry.bay_id,
      label: registry.label || registry.bay_id,
      region: registry.region ?? null,
      deployment_mode: "multi-bay",
      role:
        registry.role === "seed" || registry.role === "attached"
          ? registry.role
          : "combined",
      is_default: registry.bay_id === defaultBayId,
      accepts_project_ownership: registry.accepts_project_ownership !== false,
      project_ownership_note: registry.project_ownership_note ?? null,
      public_origin: registry.public_origin ?? null,
      public_target: registry.public_target ?? null,
      public_target_kind: registry.public_target_kind ?? null,
      dns_hostname: registry.dns_hostname ?? null,
      last_seen: registry.last_seen ?? null,
      ownership: {
        accounts: counts.accounts.get(registry.bay_id) ?? 0,
        projects: counts.projects.get(registry.bay_id) ?? 0,
        project_hosts: counts.project_hosts.get(registry.bay_id) ?? 0,
      },
      rehome: zeroRehomeStatus(),
    });
  }

  await Promise.all([
    addRehomeCounts({
      rows: rowsByBay,
      kind: "account",
      table: "account_rehome_operations",
    }),
    addRehomeCounts({
      rows: rowsByBay,
      kind: "project",
      table: "project_rehome_operations",
    }),
    addRehomeCounts({
      rows: rowsByBay,
      kind: "project_host",
      table: "project_host_rehome_operations",
    }),
  ]);

  return {
    checked_at: new Date().toISOString(),
    current_bay_id: defaultBayId,
    bays: [...rowsByBay.values()].sort((a, b) =>
      a.bay_id.localeCompare(b.bay_id),
    ),
  };
}

function settledError(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? `${result.reason}` : null;
}

export async function getBayOpsDetail({
  account_id,
  bay_id,
}: {
  account_id?: string;
  bay_id: string;
}): Promise<BayOpsDetail> {
  await assertAdmin(account_id);
  const requestedBayId = `${bay_id ?? ""}`.trim();
  if (!requestedBayId) {
    throw Error("bay_id is required");
  }
  const currentBayId = getConfiguredBayId();
  const api =
    requestedBayId === currentBayId
      ? {
          getLoad: async (_opts: { account_id?: string }) =>
            await getBayLoad({ account_id, bay_id: currentBayId }),
          getBackups: async (_opts: { account_id?: string }) =>
            await getBayBackups({ account_id, bay_id: currentBayId }),
          getDrainPreflight: async (_opts: {
            account_id?: string;
            unsafe_rehome?: boolean;
          }) =>
            await runBayDrainPreflight({
              source_bay_id: currentBayId,
              seed_bay_id: getConfiguredClusterSeedBayId(),
              unsafe_rehome: _opts.unsafe_rehome,
            }),
        }
      : getInterBayBridge().bayOps(requestedBayId, { timeout_ms: 15_000 });
  const [loadResult, backupsResult, drainPreflightResult] =
    await Promise.allSettled([
      api.getLoad({ account_id }),
      api.getBackups({ account_id }),
      api.getDrainPreflight({ account_id }),
    ]);

  return {
    bay_id: requestedBayId,
    checked_at: new Date().toISOString(),
    routed: requestedBayId !== currentBayId,
    load: loadResult.status === "fulfilled" ? loadResult.value : undefined,
    backups:
      backupsResult.status === "fulfilled" ? backupsResult.value : undefined,
    drain_preflight:
      drainPreflightResult.status === "fulfilled"
        ? drainPreflightResult.value
        : undefined,
    load_error: settledError(loadResult),
    backups_error: settledError(backupsResult),
    drain_preflight_error: settledError(drainPreflightResult),
  };
}

export async function getBayDrainPreflight({
  account_id,
  bay_id,
  unsafe_rehome,
}: {
  account_id?: string;
  bay_id?: string;
  unsafe_rehome?: boolean;
}) {
  await assertAdmin(account_id);
  const currentBayId = getConfiguredBayId();
  const requestedBayId = `${bay_id ?? currentBayId}`.trim();
  if (!requestedBayId) {
    throw Error("bay_id is required");
  }
  if (requestedBayId === currentBayId) {
    return await runBayDrainPreflight({
      source_bay_id: currentBayId,
      seed_bay_id: getConfiguredClusterSeedBayId(),
      unsafe_rehome,
    });
  }
  return await getInterBayBridge()
    .bayOps(requestedBayId, { timeout_ms: 15_000 })
    .getDrainPreflight({ account_id, unsafe_rehome });
}

type SiteSettingUpdate = { name: string; value: string };
export const SERVER_SETTINGS_CONFIG_SCOPE = "server_settings";

const SITE_SETTING_NAMES = new Set<string>([
  ...Object.keys(site_settings_conf),
  ...Object.keys(SITE_SETTINGS_EXTRAS),
]);

function normalizeSiteSettingUpdate({
  name,
  value,
}: SiteSettingUpdate): SiteSettingUpdate {
  const normalizedName = `${name ?? ""}`.trim();
  if (!SITE_SETTING_NAMES.has(normalizedName)) {
    throw Error(`setting name='${normalizedName}' not allowed`);
  }
  return { name: normalizedName, value: `${value ?? ""}` };
}

async function assertSiteSettingWritable(name: string): Promise<void> {
  const { rows } = await getPool().query(
    "SELECT readonly FROM server_settings WHERE name=$1 LIMIT 1",
    [name],
  );
  if (rows[0]?.readonly === true) {
    throw Error(`setting name='${name}' is readonly`);
  }
}

async function setSiteSettingLocal(update: SiteSettingUpdate): Promise<void> {
  const normalized = normalizeSiteSettingUpdate(update);
  await assertSiteSettingWritable(normalized.name);
  await callback2(db().set_server_setting, normalized);
}

function isSignupEmailDomainPolicySetting(name: string): boolean {
  return SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS.has(name);
}

function auditDomainRule(rule: DomainRule): string {
  return `${rule.includeSubdomains ? "*." : ""}${rule.domain}`;
}

function auditSignupEmailDomainPolicy(policy: SignupEmailDomainPolicy) {
  return {
    mode: policy.mode,
    allow_domains: policy.allowRules.map(auditDomainRule),
    deny_domains: policy.denyRules.map(auditDomainRule),
    public_message: policy.publicMessage,
    show_allowed_domains: policy.showAllowedDomains,
  };
}

async function getSignupEmailDomainPolicySettings(): Promise<SignupEmailDomainPolicySettings> {
  const settings: SignupEmailDomainPolicySettings = {};
  for (const name of SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS) {
    settings[name] = await callback2(db().get_server_setting, { name });
  }
  return settings;
}

async function logSignupEmailDomainPolicyChange({
  account_id,
  updates,
  oldSettings,
  source_bay_id,
}: {
  account_id?: string;
  updates: SiteSettingUpdate[];
  oldSettings: SignupEmailDomainPolicySettings;
  source_bay_id?: string | null;
}): Promise<void> {
  const changed_setting_names = updates
    .map(({ name }) => name)
    .filter(isSignupEmailDomainPolicySetting)
    .sort();
  if (changed_setting_names.length === 0) {
    return;
  }
  const newSettings: SignupEmailDomainPolicySettings = { ...oldSettings };
  for (const { name, value } of updates) {
    if (isSignupEmailDomainPolicySetting(name)) {
      newSettings[name] = value;
    }
  }
  await centralLog({
    event: "signup_email_domain_policy_changed",
    value: {
      account_id,
      bay_id: getConfiguredBayId(),
      source_bay_id: source_bay_id ?? getConfiguredBayId(),
      changed_setting_names,
      old_policy: auditSignupEmailDomainPolicy(
        normalizeSignupEmailDomainPolicy(oldSettings),
      ),
      new_policy: auditSignupEmailDomainPolicy(
        normalizeSignupEmailDomainPolicy(newSettings),
      ),
    },
  });
}

async function getConfiguredSiteSettingUpdates(): Promise<SiteSettingUpdate[]> {
  const settings: SiteSettingUpdate[] = [];
  for (const name of [...SITE_SETTING_NAMES].sort()) {
    const value = await callback2(db().get_server_setting, { name });
    if (value != null) {
      settings.push({ name, value });
    }
  }
  return settings;
}

function parseConfigVersion(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

async function getGlobalConfigVersion(
  scope: string,
): Promise<number | undefined> {
  const { rows } = await getPool().query(
    "SELECT version FROM global_config_versions WHERE scope=$1",
    [scope],
  );
  const version = parseConfigVersion(rows[0]?.version);
  return version > 0 ? version : undefined;
}

async function recordGlobalConfigEventOnSeed({
  scope,
  account_id,
  source_bay_id,
  changes,
}: {
  scope: string;
  account_id?: string;
  source_bay_id?: string | null;
  changes: unknown;
}): Promise<number> {
  const bayId = getConfiguredBayId();
  const metadata = {
    source_bay_id: source_bay_id ?? bayId,
  };
  const { rows } = await getPool().query(
    `
    INSERT INTO global_config_versions (scope, version, updated_at, updated_by, metadata)
    VALUES ($1, 1, NOW(), $2, $3::jsonb)
    ON CONFLICT (scope) DO UPDATE SET
      version = global_config_versions.version + 1,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by,
      metadata = EXCLUDED.metadata
    RETURNING version
    `,
    [scope, account_id ?? null, JSON.stringify(metadata)],
  );
  const version = parseConfigVersion(rows[0]?.version);
  await getPool().query(
    `
    INSERT INTO global_config_events
      (id, scope, version, changes, created_at, created_by, source_bay_id)
    VALUES
      ($1, $2, $3, $4::jsonb, NOW(), $5, $6)
    `,
    [
      uuid(),
      scope,
      version,
      JSON.stringify(changes),
      account_id ?? null,
      source_bay_id ?? bayId,
    ],
  );
  return version;
}

async function recordGlobalConfigBayState({
  scope,
  bay_id,
  version,
  error,
}: {
  scope: string;
  bay_id: string;
  version: number;
  error?: string;
}): Promise<void> {
  const appliedVersion = error == null ? version : null;
  await getPool().query(
    `
    INSERT INTO global_config_bay_state
      (bay_id, scope, applied_version, applied_at, last_error)
    VALUES
      ($1, $2, $3, CASE WHEN $4::text IS NULL THEN NOW() ELSE NULL END, $4)
    ON CONFLICT (bay_id, scope) DO UPDATE SET
      applied_version = CASE
        WHEN EXCLUDED.last_error IS NULL THEN EXCLUDED.applied_version
        ELSE global_config_bay_state.applied_version
      END,
      applied_at = CASE
        WHEN EXCLUDED.last_error IS NULL THEN NOW()
        ELSE global_config_bay_state.applied_at
      END,
      last_error = EXCLUDED.last_error
    `,
    [bay_id, scope, appliedVersion, error ?? null],
  );
}

async function propagateSiteSettingsToBays(
  settings: SiteSettingUpdate[],
  opts: { scope?: string; version?: number } = {},
): Promise<SiteSettingsSyncResult> {
  const local_bay_id = getConfiguredBayId();
  const scope = opts.scope ?? SERVER_SETTINGS_CONFIG_SCOPE;
  const version = opts.version;
  const registry = await listClusterBayRegistry();
  const remoteBayIds = [
    ...new Set(registry.map(({ bay_id }) => bay_id).filter(Boolean)),
  ]
    .filter((bay_id) => bay_id !== local_bay_id)
    .sort();
  const bays: SiteSettingsSyncResult["bays"] = [
    { bay_id: local_bay_id, status: "local", count: settings.length, version },
  ];
  if (version != null) {
    await recordGlobalConfigBayState({
      scope,
      bay_id: local_bay_id,
      version,
    });
  }
  if (!remoteBayIds.length) {
    return { local_bay_id, count: settings.length, scope, version, bays };
  }

  const results = await Promise.allSettled(
    remoteBayIds.map(async (bay_id) => {
      const api = getInterBayBridge().bayOps(bay_id, { timeout_ms: 15_000 });
      for (const setting of settings) {
        await api.setServerSetting(setting);
      }
      return bay_id;
    }),
  );
  for (let i = 0; i < remoteBayIds.length; i += 1) {
    const bay_id = remoteBayIds[i];
    const result = results[i];
    const error =
      result.status === "fulfilled" ? undefined : `${result.reason}`;
    if (version != null) {
      await recordGlobalConfigBayState({
        scope,
        bay_id,
        version,
        error,
      });
    }
    bays.push(
      result.status === "fulfilled"
        ? { bay_id, status: "applied", count: settings.length, version }
        : {
            bay_id,
            status: "failed",
            count: settings.length,
            version,
            error,
          },
    );
  }
  return { local_bay_id, count: settings.length, scope, version, bays };
}

export async function setSiteSettingsOnSeed({
  account_id,
  settings,
  source_bay_id,
}: {
  account_id?: string;
  settings: SiteSettingUpdate[];
  source_bay_id?: string | null;
}): Promise<SiteSettingsSyncResult> {
  const localBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  if (localBayId !== seedBayId) {
    throw Error(
      `setSiteSettingsOnSeed must run on seed bay '${seedBayId}', not '${localBayId}'`,
    );
  }
  const updates = settings.map(normalizeSiteSettingUpdate);
  const signupEmailDomainPolicyOldSettings = updates.some(({ name }) =>
    isSignupEmailDomainPolicySetting(name),
  )
    ? await getSignupEmailDomainPolicySettings()
    : undefined;
  for (const update of updates) {
    await setSiteSettingLocal(update);
  }
  if (signupEmailDomainPolicyOldSettings != null) {
    await logSignupEmailDomainPolicyChange({
      account_id,
      updates,
      oldSettings: signupEmailDomainPolicyOldSettings,
      source_bay_id,
    });
  }
  const version = await recordGlobalConfigEventOnSeed({
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    account_id,
    source_bay_id,
    changes: { settings: updates.map(({ name }) => name).sort() },
  });
  return await propagateSiteSettingsToBays(updates, {
    scope: SERVER_SETTINGS_CONFIG_SCOPE,
    version,
  });
}

export async function syncSiteSettingsToBaysOnSeed(): Promise<SiteSettingsSyncResult> {
  const localBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  if (localBayId !== seedBayId) {
    throw Error(
      `syncSiteSettingsToBaysOnSeed must run on seed bay '${seedBayId}', not '${localBayId}'`,
    );
  }
  return await propagateSiteSettingsToBays(
    await getConfiguredSiteSettingUpdates(),
    {
      scope: SERVER_SETTINGS_CONFIG_SCOPE,
      version: await getGlobalConfigVersion(SERVER_SETTINGS_CONFIG_SCOPE),
    },
  );
}

function toIsoString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return `${value}`;
}

function classifyGlobalConfigBayState({
  seedVersion,
  appliedVersion,
  lastError,
}: {
  seedVersion?: number;
  appliedVersion?: number;
  lastError?: string | null;
}): GlobalConfigPropagationBayState {
  if (lastError) {
    return "error";
  }
  if (seedVersion == null || appliedVersion == null) {
    return "missing";
  }
  return appliedVersion >= seedVersion ? "current" : "stale";
}

export async function getGlobalConfigPropagationStatusOnSeed({
  scope,
}: {
  scope?: string;
} = {}): Promise<GlobalConfigPropagationStatus> {
  const currentBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  const normalizedScope = `${scope ?? ""}`.trim();
  if (currentBayId !== seedBayId) {
    throw Error(
      `getGlobalConfigPropagationStatusOnSeed must run on seed bay '${seedBayId}', not '${currentBayId}'`,
    );
  }

  const [versionResult, registry] = await Promise.all([
    normalizedScope
      ? getPool().query(
          `
          SELECT scope, version, updated_at, updated_by, metadata
          FROM global_config_versions
          WHERE scope=$1
          `,
          [normalizedScope],
        )
      : getPool().query(
          `
          SELECT scope, version, updated_at, updated_by, metadata
          FROM global_config_versions
          ORDER BY scope
          `,
        ),
    listClusterBayRegistry(),
  ]);
  const versionRows = [...versionResult.rows];
  if (
    normalizedScope &&
    !versionRows.some((row) => row.scope === normalizedScope)
  ) {
    versionRows.push({
      scope: normalizedScope,
      version: null,
      updated_at: null,
      updated_by: null,
      metadata: null,
    });
  }
  const scopes = versionRows.map((row) => `${row.scope}`);
  const stateResult = scopes.length
    ? await getPool().query(
        `
        SELECT bay_id, scope, applied_version, applied_at, last_error
        FROM global_config_bay_state
        WHERE scope=ANY($1)
        `,
        [scopes],
      )
    : { rows: [] };
  const states = new Map<string, any>();
  for (const row of stateResult.rows) {
    states.set(`${row.scope}\0${row.bay_id}`, row);
  }
  const bayIds = [
    ...new Set([
      seedBayId,
      currentBayId,
      ...registry.map(({ bay_id }) => bay_id).filter(Boolean),
    ]),
  ].sort();

  return {
    current_bay_id: currentBayId,
    seed_bay_id: seedBayId,
    checked_at: new Date().toISOString(),
    scopes: versionRows
      .sort((a, b) => `${a.scope}`.localeCompare(`${b.scope}`))
      .map((row) => {
        const seedVersion = parseConfigVersion(row.version);
        const version = seedVersion > 0 ? seedVersion : undefined;
        return {
          scope: `${row.scope}`,
          seed_version: version,
          updated_at: toIsoString(row.updated_at),
          updated_by: row.updated_by ?? null,
          metadata: row.metadata ?? null,
          bays: bayIds.map((bay_id) => {
            const state = states.get(`${row.scope}\0${bay_id}`);
            const appliedVersion = parseConfigVersion(state?.applied_version);
            const applied_version =
              appliedVersion > 0 ? appliedVersion : undefined;
            const last_error = state?.last_error ?? null;
            return {
              bay_id,
              status: classifyGlobalConfigBayState({
                seedVersion: version,
                appliedVersion: applied_version,
                lastError: last_error,
              }),
              applied_version,
              applied_at: toIsoString(state?.applied_at),
              last_error,
            };
          }),
        };
      }),
  };
}

export async function getGlobalConfigPropagationStatus({
  account_id,
  scope,
}: {
  account_id?: string;
  scope?: string;
} = {}): Promise<GlobalConfigPropagationStatus> {
  await assertAdmin(account_id);
  const currentBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  const normalizedScope = `${scope ?? ""}`.trim();
  if (currentBayId !== seedBayId) {
    return await getInterBayBridge()
      .bayOps(seedBayId, { timeout_ms: 15_000 })
      .getGlobalConfigPropagationStatus({
        account_id,
        scope: normalizedScope || undefined,
        source_bay_id: currentBayId,
      });
  }
  return await getGlobalConfigPropagationStatusOnSeed({
    scope: normalizedScope || undefined,
  });
}

export async function setSiteSettings({
  account_id,
  browser_id,
  session_hash,
  settings,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  settings: SiteSettingUpdate[];
}): Promise<SiteSettingsSyncResult> {
  await assertAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const updates = settings.map(normalizeSiteSettingUpdate);
  const localBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  if (localBayId !== seedBayId) {
    return await getInterBayBridge()
      .bayOps(seedBayId, { timeout_ms: 15_000 })
      .setSiteSettings({
        account_id,
        settings: updates,
        source_bay_id: localBayId,
      });
  }
  return await setSiteSettingsOnSeed({
    account_id,
    settings: updates,
  });
}

export async function manageApiKeys({
  account_id,
  browser_id,
  session_hash,
  action,
  name,
  expire,
  capabilities,
  allowed_project_ids,
  id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  action: ApiKeyAction;
  name?: string;
  expire?: Date;
  capabilities?: ApiKeyCapability[];
  allowed_project_ids?: string[];
  id?: number;
}): Promise<ApiKey[] | undefined> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (action !== "get") {
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor: true,
    });
  }
  return await manageApiKeys0({
    account_id,
    action,
    name,
    expire,
    capabilities,
    allowed_project_ids,
    id,
  });
}

export async function syncSiteSettingsToBays({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<SiteSettingsSyncResult> {
  await assertAdmin(account_id);
  const localBayId = getConfiguredBayId();
  const seedBayId = getConfiguredClusterSeedBayId();
  if (localBayId !== seedBayId) {
    return await getInterBayBridge()
      .bayOps(seedBayId, { timeout_ms: 15_000 })
      .syncSiteSettings({
        account_id,
        source_bay_id: localBayId,
      });
  }
  return await syncSiteSettingsToBaysOnSeed();
}

export async function setBayProjectOwnershipAdmission({
  account_id,
  bay_id,
  accepts_project_ownership,
  note,
}: {
  account_id?: string;
  bay_id: string;
  accepts_project_ownership: boolean;
  note?: string | null;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const entry = await setBayProjectOwnershipAdmissionLocal({
    bay_id,
    accepts_project_ownership,
    note,
  });
  const role: BayInfo["role"] =
    entry.role === "seed" || entry.role === "attached"
      ? entry.role
      : "combined";
  return {
    bay_id: entry.bay_id,
    label: entry.label,
    region: entry.region ?? null,
    deployment_mode: "multi-bay" as const,
    role,
    is_default: entry.bay_id === getConfiguredBayId(),
    accepts_project_ownership: entry.accepts_project_ownership !== false,
    project_ownership_note: entry.project_ownership_note ?? null,
  };
}

function summarizeProjectionLoad({
  backlog,
  maintenance,
}: {
  backlog: {
    unpublished_events: number;
    oldest_unpublished_event_age_ms: number | null;
  };
  maintenance: {
    running: boolean;
    last_success_at: string | null;
  };
}): BayLoadProjectionStatus {
  return {
    unpublished_events: backlog.unpublished_events ?? 0,
    oldest_unpublished_event_age_ms:
      backlog.oldest_unpublished_event_age_ms ?? null,
    maintenance_running: maintenance.running === true,
    last_success_at: maintenance.last_success_at ?? null,
  };
}

function summarizeParallelOpsLoad(
  workers: Awaited<ReturnType<typeof getParallelOpsStatus0>>,
): BayLoadParallelOpsStatus {
  const hotspots = [...(workers ?? [])]
    .filter(
      (worker) =>
        (worker.queued_count ?? 0) > 0 ||
        (worker.running_count ?? 0) > 0 ||
        (worker.stale_running_count ?? 0) > 0,
    )
    .sort((a, b) => {
      const aLoad =
        (a.queued_count ?? 0) +
        (a.running_count ?? 0) +
        (a.stale_running_count ?? 0);
      const bLoad =
        (b.queued_count ?? 0) +
        (b.running_count ?? 0) +
        (b.stale_running_count ?? 0);
      if (bLoad !== aLoad) return bLoad - aLoad;
      return a.worker_kind.localeCompare(b.worker_kind);
    })
    .slice(0, 10)
    .map((worker) => ({
      worker_kind: worker.worker_kind,
      category: worker.category,
      queued_count: worker.queued_count ?? 0,
      running_count: worker.running_count ?? 0,
      stale_running_count: worker.stale_running_count ?? null,
      worker_instances: worker.worker_instances ?? 0,
    }));

  return {
    worker_count: workers.length,
    queued_total: workers.reduce(
      (sum, worker) => sum + (worker.queued_count ?? 0),
      0,
    ),
    running_total: workers.reduce(
      (sum, worker) => sum + (worker.running_count ?? 0),
      0,
    ),
    stale_running_total: workers.reduce(
      (sum, worker) => sum + (worker.stale_running_count ?? 0),
      0,
    ),
    hotspots,
  };
}

async function getLiveBrowserControlStatus(): Promise<BayLoadBrowserControlStatus> {
  const accountIds = new Set<string>();
  const browserKeys = new Set<string>();
  let active_connections = 0;
  try {
    const client = conat();
    await client.waitUntilSignedIn({ timeout: 3_000 });
    const statsByNode = await sysApiMany(client, { maxWait: 2_000 }).stats();
    for await (const node of statsByNode ?? []) {
      for (const sockets of Object.values(node ?? {})) {
        for (const stat of Object.values(sockets ?? {})) {
          const s = stat as ConnectionStats | undefined;
          const account_id = `${s?.user?.account_id ?? ""}`.trim();
          const browser_id = `${s?.browser_id ?? ""}`.trim();
          if (!account_id || !browser_id) continue;
          accountIds.add(account_id);
          browserKeys.add(`${account_id}:${browser_id}`);
          active_connections += 1;
        }
      }
    }
  } catch (err) {
    logger.debug(
      "getBayLoad: failed to read live conat browser stats",
      `${err}`,
    );
  }
  return {
    active_accounts: accountIds.size,
    active_browsers: browserKeys.size,
    active_connections,
  };
}

export async function getBayLoad({
  account_id,
  bay_id,
  internalAuth,
}: {
  account_id?: string;
  bay_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
}): Promise<BayLoadInfo> {
  if (internalAuth !== BAY_OPS_INTERNAL_AUTH) {
    await assertAdmin(account_id);
  }
  const currentBay = getSingleBayInfo();
  const requestedBayId = `${bay_id ?? ""}`.trim();
  if (requestedBayId && requestedBayId !== currentBay.bay_id) {
    throw Error(`bay '${requestedBayId}' not found`);
  }
  const [
    browser_control,
    parallel_ops_workers,
    accountProjectBacklog,
    accountCollaboratorBacklog,
    accountNotificationBacklog,
    hostCountResult,
  ] = await Promise.all([
    getLiveBrowserControlStatus(),
    getParallelOpsStatus0(),
    getAccountProjectIndexProjectionBacklogStatus({
      bay_id: currentBay.bay_id,
    }),
    getAccountCollaboratorIndexProjectionBacklogStatus({
      bay_id: currentBay.bay_id,
    }),
    getAccountNotificationIndexProjectionBacklogStatus({
      bay_id: currentBay.bay_id,
    }),
    getPool().query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM project_hosts
        WHERE deleted IS NULL
          AND COALESCE(bay_id, $1) = $1`,
      [currentBay.bay_id],
    ),
  ]);
  return {
    ...currentBay,
    checked_at: new Date().toISOString(),
    browser_control,
    hosts: {
      total_hosts: Math.max(
        0,
        Number(hostCountResult.rows[0]?.count ?? 0) || 0,
      ),
    },
    parallel_ops: summarizeParallelOpsLoad(parallel_ops_workers),
    projections: {
      account_project_index: summarizeProjectionLoad({
        backlog: accountProjectBacklog,
        maintenance: getAccountProjectIndexProjectionMaintenanceStatus(),
      }),
      account_collaborator_index: summarizeProjectionLoad({
        backlog: accountCollaboratorBacklog,
        maintenance: getAccountCollaboratorIndexProjectionMaintenanceStatus(),
      }),
      account_notification_index: summarizeProjectionLoad({
        backlog: accountNotificationBacklog,
        maintenance: getAccountNotificationIndexProjectionMaintenanceStatus(),
      }),
    },
  };
}

export async function recordUxLatencyEvent({
  account_id,
  event,
}: {
  account_id?: string;
  event: UxLatencyEventInput;
}): Promise<void> {
  await recordUxLatencyEvent0({ account_id, event });
}

export async function getUxLatencySummary({
  account_id,
  window_minutes,
}: {
  account_id?: string;
  window_minutes?: number;
} = {}): Promise<UxLatencySummary> {
  await assertAdmin(account_id);
  return await getUxLatencySummary0({ window_minutes });
}

export async function getBayBackups({
  account_id,
  bay_id,
  internalAuth,
}: {
  account_id?: string;
  bay_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
}): Promise<BayBackupsInfo> {
  if (internalAuth !== BAY_OPS_INTERNAL_AUTH) {
    await assertAdmin(account_id);
  }
  const currentBay = getSingleBayInfo();
  const requestedBayId = `${bay_id ?? ""}`.trim();
  if (requestedBayId && requestedBayId !== currentBay.bay_id) {
    throw Error(`bay '${requestedBayId}' not found`);
  }
  const [bayBackup, infra, parallelOpsWorkers] = await Promise.all([
    getBayBackupStatus0({ bay_id: currentBay.bay_id }),
    getProjectBackupInfrastructureStatus({ bay_id: currentBay.bay_id }),
    getParallelOpsStatus0(),
  ]);
  const backupAdmission =
    parallelOpsWorkers.find(
      (worker) => worker.worker_kind === "project-backup",
    ) ?? null;
  const backupExecution =
    parallelOpsWorkers.find(
      (worker) => worker.worker_kind === "project-host-backup-execution",
    ) ?? null;
  return {
    ...currentBay,
    checked_at: new Date().toISOString(),
    postgres: bayBackup.postgres,
    bay_backup: bayBackup.bay_backup,
    restore_readiness: bayBackup.restore_readiness,
    r2: infra.r2,
    repos: infra.repos,
    projects: infra.projects,
    backup_admission: backupAdmission,
    backup_execution: backupExecution,
  };
}

export async function getProjectBackupShards({
  account_id,
  region,
}: {
  account_id?: string;
  region?: string | null;
}): Promise<ProjectBackupShardAdminStatus> {
  await assertAdmin(account_id);
  const cluster = getClusterConfig();
  if (
    cluster.role === "attached" &&
    cluster.seed_bay_id &&
    cluster.seed_bay_id !== getConfiguredBayId()
  ) {
    return await getInterBayBridge()
      .hostConnection(cluster.seed_bay_id, { timeout_ms: 30_000 })
      .getSeedProjectBackupShards({
        region: region ?? null,
      });
  }
  return await getProjectBackupShardAdminStatus({
    region,
  });
}

function boundedPositiveInteger({
  value,
  fallback,
  max,
}: {
  value: unknown;
  fallback: number;
  max: number;
}): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function optionalFilter(value: unknown): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

async function getClusterReportBayIds(): Promise<string[]> {
  const currentBayId = getConfiguredBayId();
  return [
    ...new Set(
      ((await listConfiguredBays()) ?? [])
        .map((bay) => `${bay.bay_id ?? ""}`.trim())
        .filter(Boolean)
        .concat(currentBayId),
    ),
  ].sort();
}

type ClusterReportBayStatus = {
  bay_id: string;
  ok: boolean;
  error?: string;
};

function reportBayStatuses<T>(
  bayIds: string[],
  settled: PromiseSettledResult<T>[],
  successfulReports: T[],
): ClusterReportBayStatus[] {
  return bayIds.map((bay_id, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      successfulReports.push(result.value);
      return { bay_id, ok: true };
    }
    return {
      bay_id,
      ok: false,
      error: `${result.reason}`,
    };
  });
}

function parseDenialSummaryRow(row: Record<string, any>) {
  const summary: AcpAdmissionDenialSummary = {
    account_id: row.account_id || null,
    project_id: row.project_id || null,
    limit: row.denial_limit || "unknown",
    source: row.source || "unknown",
    count: Number(row.count) || 0,
    first_time:
      row.first_time instanceof Date
        ? row.first_time.toISOString()
        : `${row.first_time}`,
    last_time:
      row.last_time instanceof Date
        ? row.last_time.toISOString()
        : `${row.last_time}`,
    max_current: Number(row.max_current) || 0,
    max_maximum: Number(row.max_maximum) || 0,
    sample_path: row.sample_path || null,
    sample_thread_id: row.sample_thread_id || null,
  };
  return summary;
}

function withAcpAdmissionDenialReportBayId(
  report: AcpAdmissionDenialReport,
  bay_id: string,
): AcpAdmissionDenialReport {
  return {
    ...report,
    bay_id: report.bay_id || bay_id,
    groups: (report.groups ?? []).map((group) => ({
      ...group,
      bay_id: group.bay_id || report.bay_id || bay_id,
    })),
  };
}

export async function getAcpAdmissionDenialReport({
  account_id,
  internalAuth,
  window_minutes,
  min_count,
  limit,
  user_account_id,
  project_id,
  denial_limit,
  source,
}: {
  account_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
  window_minutes?: number;
  min_count?: number;
  limit?: number;
  user_account_id?: string | null;
  project_id?: string | null;
  denial_limit?: string | null;
  source?: string | null;
} = {}): Promise<AcpAdmissionDenialReport> {
  const windowMinutes = boundedPositiveInteger({
    value: window_minutes,
    fallback: 60,
    max: 7 * 24 * 60,
  });
  const minCount = boundedPositiveInteger({
    value: min_count,
    fallback: 1,
    max: 1_000_000,
  });
  const rowLimit = boundedPositiveInteger({
    value: limit,
    fallback: 50,
    max: 500,
  });
  const request = {
    window_minutes: windowMinutes,
    min_count: minCount,
    limit: rowLimit,
    user_account_id,
    project_id,
    denial_limit,
    source,
  };

  if (internalAuth === BAY_OPS_INTERNAL_AUTH) {
    return await getAcpAdmissionDenialReport0({
      bay_id: getConfiguredBayId(),
      ...request,
    });
  }

  await assertAdmin(account_id);
  const currentBayId = getConfiguredBayId();
  const bayIds = await getClusterReportBayIds();
  const settled = await Promise.allSettled(
    bayIds.map(async (bay_id) => {
      const report =
        bay_id === currentBayId
          ? await getAcpAdmissionDenialReport0({ bay_id, ...request })
          : await getInterBayBridge()
              .bayOps(bay_id, { timeout_ms: 15_000 })
              .getAcpAdmissionDenialReport({ account_id, ...request });
      return withAcpAdmissionDenialReportBayId(report, bay_id);
    }),
  );
  const successfulReports: AcpAdmissionDenialReport[] = [];
  const bays = reportBayStatuses(bayIds, settled, successfulReports);
  const checkedAt = new Date();
  return {
    current_bay_id: currentBayId,
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    min_count: minCount,
    groups: successfulReports
      .flatMap((report) => report.groups ?? [])
      .sort(
        (a, b) =>
          b.count - a.count ||
          new Date(b.last_time).getTime() - new Date(a.last_time).getTime(),
      )
      .slice(0, rowLimit),
    bays,
  };
}

async function getAcpAdmissionDenialReport0({
  bay_id,
  window_minutes: windowMinutes,
  min_count: minCount,
  limit: rowLimit,
  user_account_id,
  project_id,
  denial_limit,
  source,
}: {
  bay_id: string;
  window_minutes: number;
  min_count: number;
  limit: number;
  user_account_id?: string | null;
  project_id?: string | null;
  denial_limit?: string | null;
  source?: string | null;
}): Promise<AcpAdmissionDenialReport> {
  const params: any[] = [windowMinutes];
  const conditions = [
    "event = 'acp_admission_denied'",
    `"time" >= NOW() - ($1::int * INTERVAL '1 minute')`,
  ];
  const addFilter = (jsonKey: string, value: unknown) => {
    const filter = optionalFilter(value);
    if (!filter) return;
    params.push(filter);
    conditions.push(`value->>'${jsonKey}' = $${params.length}`);
  };
  addFilter("account_id", user_account_id);
  addFilter("project_id", project_id);
  addFilter("limit", denial_limit);
  addFilter("source", source);
  params.push(minCount, rowLimit);
  const minCountParam = params.length - 1;
  const limitParam = params.length;

  const { rows } = await getPool().query(
    `
      WITH filtered AS (
        SELECT "time", value
        FROM central_log
        WHERE ${conditions.join(" AND ")}
      )
      SELECT
        NULLIF(value->>'account_id', '') AS account_id,
        NULLIF(value->>'project_id', '') AS project_id,
        COALESCE(NULLIF(value->>'limit', ''), 'unknown') AS denial_limit,
        COALESCE(NULLIF(value->>'source', ''), 'unknown') AS source,
        COUNT(*)::int AS count,
        MIN("time") AS first_time,
        MAX("time") AS last_time,
        MAX(
          CASE
            WHEN (value->>'current') ~ '^[0-9]+$'
            THEN (value->>'current')::int
            ELSE 0
          END
        )::int AS max_current,
        MAX(
          CASE
            WHEN (value->>'maximum') ~ '^[0-9]+$'
            THEN (value->>'maximum')::int
            ELSE 0
          END
        )::int AS max_maximum,
        MAX(NULLIF(value->>'path', '')) AS sample_path,
        MAX(NULLIF(value->>'thread_id', '')) AS sample_thread_id
      FROM filtered
      GROUP BY account_id, project_id, denial_limit, source
      HAVING COUNT(*) >= $${minCountParam}
      ORDER BY count DESC, last_time DESC
      LIMIT $${limitParam}
    `,
    params,
  );

  const checkedAt = new Date();
  return {
    bay_id,
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    min_count: minCount,
    groups: rows.map((row) => ({
      ...parseDenialSummaryRow(row),
      bay_id,
    })),
  };
}

function parseServiceDenialSummaryRow(
  row: Record<string, any>,
): ServiceAdmissionDenialSummary {
  return {
    host_id: row.host_id || null,
    account_id: row.account_id || null,
    project_id: row.project_id || null,
    surface: row.surface || "unknown",
    limit: row.denial_limit || "unknown",
    source: row.source || "unknown",
    count: Number(row.count) || 0,
    first_time:
      row.first_time instanceof Date
        ? row.first_time.toISOString()
        : `${row.first_time}`,
    last_time:
      row.last_time instanceof Date
        ? row.last_time.toISOString()
        : `${row.last_time}`,
    max_current: Number(row.max_current) || 0,
    max_maximum: Number(row.max_maximum) || 0,
    sample_subject: row.sample_subject || null,
    sample_path: row.sample_path || null,
    sample_key: row.sample_key || null,
    sample_reason: row.sample_reason || null,
  };
}

function withServiceAdmissionDenialReportBayId(
  report: ServiceAdmissionDenialReport,
  bay_id: string,
): ServiceAdmissionDenialReport {
  return {
    ...report,
    bay_id: report.bay_id || bay_id,
    groups: (report.groups ?? []).map((group) => ({
      ...group,
      bay_id: group.bay_id || report.bay_id || bay_id,
    })),
  };
}

export async function getServiceAdmissionDenialReport({
  account_id,
  internalAuth,
  window_minutes,
  min_count,
  limit,
  user_account_id,
  project_id,
  surface,
  denial_limit,
  source,
}: {
  account_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
  window_minutes?: number;
  min_count?: number;
  limit?: number;
  user_account_id?: string | null;
  project_id?: string | null;
  surface?: string | null;
  denial_limit?: string | null;
  source?: string | null;
} = {}): Promise<ServiceAdmissionDenialReport> {
  const windowMinutes = boundedPositiveInteger({
    value: window_minutes,
    fallback: 60,
    max: 7 * 24 * 60,
  });
  const minCount = boundedPositiveInteger({
    value: min_count,
    fallback: 1,
    max: 1_000_000,
  });
  const rowLimit = boundedPositiveInteger({
    value: limit,
    fallback: 50,
    max: 500,
  });
  const request = {
    window_minutes: windowMinutes,
    min_count: minCount,
    limit: rowLimit,
    user_account_id,
    project_id,
    surface,
    denial_limit,
    source,
  };

  if (internalAuth === BAY_OPS_INTERNAL_AUTH) {
    return await getServiceAdmissionDenialReport0({
      bay_id: getConfiguredBayId(),
      ...request,
    });
  }

  await assertAdmin(account_id);
  const currentBayId = getConfiguredBayId();
  const bayIds = await getClusterReportBayIds();
  const settled = await Promise.allSettled(
    bayIds.map(async (bay_id) => {
      const report =
        bay_id === currentBayId
          ? await getServiceAdmissionDenialReport0({ bay_id, ...request })
          : await getInterBayBridge()
              .bayOps(bay_id, { timeout_ms: 15_000 })
              .getServiceAdmissionDenialReport({ account_id, ...request });
      return withServiceAdmissionDenialReportBayId(report, bay_id);
    }),
  );
  const successfulReports: ServiceAdmissionDenialReport[] = [];
  const bays = reportBayStatuses(bayIds, settled, successfulReports);
  const checkedAt = new Date();
  return {
    current_bay_id: currentBayId,
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    min_count: minCount,
    groups: successfulReports
      .flatMap((report) => report.groups ?? [])
      .sort(
        (a, b) =>
          b.count - a.count ||
          new Date(b.last_time).getTime() - new Date(a.last_time).getTime(),
      )
      .slice(0, rowLimit),
    bays,
  };
}

async function getServiceAdmissionDenialReport0({
  bay_id,
  window_minutes: windowMinutes,
  min_count: minCount,
  limit: rowLimit,
  user_account_id,
  project_id,
  surface,
  denial_limit,
  source,
}: {
  bay_id: string;
  window_minutes: number;
  min_count: number;
  limit: number;
  user_account_id?: string | null;
  project_id?: string | null;
  surface?: string | null;
  denial_limit?: string | null;
  source?: string | null;
}): Promise<ServiceAdmissionDenialReport> {
  const params: any[] = [windowMinutes];
  const conditions = [
    "event = 'service_admission_denied'",
    `"time" >= NOW() - ($1::int * INTERVAL '1 minute')`,
  ];
  const addFilter = (jsonKey: string, value: unknown) => {
    const filter = optionalFilter(value);
    if (!filter) return;
    params.push(filter);
    conditions.push(`value->>'${jsonKey}' = $${params.length}`);
  };
  addFilter("account_id", user_account_id);
  addFilter("project_id", project_id);
  addFilter("surface", surface);
  addFilter("limit", denial_limit);
  addFilter("source", source);
  params.push(minCount, rowLimit);
  const minCountParam = params.length - 1;
  const limitParam = params.length;

  const { rows } = await getPool().query(
    `
      WITH filtered AS (
        SELECT "time", value
        FROM central_log
        WHERE ${conditions.join(" AND ")}
      )
      SELECT
        NULLIF(value->>'host_id', '') AS host_id,
        NULLIF(value->>'account_id', '') AS account_id,
        NULLIF(value->>'project_id', '') AS project_id,
        COALESCE(NULLIF(value->>'surface', ''), 'unknown') AS surface,
        COALESCE(NULLIF(value->>'limit', ''), 'unknown') AS denial_limit,
        COALESCE(NULLIF(value->>'source', ''), 'unknown') AS source,
        COUNT(*)::int AS count,
        MIN("time") AS first_time,
        MAX("time") AS last_time,
        MAX(
          CASE
            WHEN (value->>'current') ~ '^[0-9]+$'
            THEN (value->>'current')::int
            ELSE 0
          END
        )::int AS max_current,
        MAX(
          CASE
            WHEN (value->>'maximum') ~ '^[0-9]+$'
            THEN (value->>'maximum')::int
            ELSE 0
          END
        )::int AS max_maximum,
        MAX(NULLIF(value->>'subject', '')) AS sample_subject,
        MAX(NULLIF(value->>'path', '')) AS sample_path,
        MAX(NULLIF(value->>'key', '')) AS sample_key,
        MAX(NULLIF(value->>'reason', '')) AS sample_reason
      FROM filtered
      GROUP BY host_id, account_id, project_id, surface, denial_limit, source
      HAVING COUNT(*) >= $${minCountParam}
      ORDER BY count DESC, last_time DESC
      LIMIT $${limitParam}
    `,
    params,
  );

  const checkedAt = new Date();
  return {
    bay_id,
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    min_count: minCount,
    groups: rows.map((row) => ({
      ...parseServiceDenialSummaryRow(row),
      bay_id,
    })),
  };
}

function boundedRootfsPositiveInteger({
  value,
  fallback,
  max,
}: {
  value?: number;
  fallback: number;
  max: number;
}): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function boundedRootfsReportLimit(value: number | undefined): number {
  return boundedRootfsPositiveInteger({ value, fallback: 50, max: 500 });
}

function boundedRootfsWindowMinutes(value: number | undefined): number {
  return boundedRootfsPositiveInteger({
    value,
    fallback: 60,
    max: 7 * 24 * 60,
  });
}

function boundedRootfsMinCount(value: number | undefined): number {
  return boundedRootfsPositiveInteger({
    value,
    fallback: 1,
    max: 1_000_000,
  });
}

function boundedRootfsNearPercent(value: number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 80;
  return Math.min(Math.max(parsed, 1), 100);
}

function withRootfsReportBayId(
  report: RootfsQuotaReport,
  bay_id: string,
): RootfsQuotaReport {
  const withUsageBay = (row: RootfsQuotaUsageRow) => ({
    ...row,
    bay_id: row.bay_id || report.bay_id || bay_id,
  });
  const withDenialBay = (row: RootfsQuotaDenialSummary) => ({
    ...row,
    bay_id: row.bay_id || report.bay_id || bay_id,
  });
  return {
    ...report,
    bay_id: report.bay_id || bay_id,
    top_users: (report.top_users ?? []).map(withUsageBay),
    near_limit_users: (report.near_limit_users ?? []).map(withUsageBay),
    denials: (report.denials ?? []).map(withDenialBay),
  };
}

export async function getRootfsQuotaReport({
  account_id,
  internalAuth,
  window_minutes,
  min_count,
  limit,
  near_percent,
  user_account_id,
  denial_limit,
  operation,
}: {
  account_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
  window_minutes?: number;
  min_count?: number;
  limit?: number;
  near_percent?: number;
  user_account_id?: string | null;
  denial_limit?: string | null;
  operation?: string | null;
} = {}) {
  const currentBayId = getConfiguredBayId();
  const request = {
    window_minutes,
    min_count,
    limit,
    near_percent,
    user_account_id,
    denial_limit,
    operation,
  };
  if (internalAuth === BAY_OPS_INTERNAL_AUTH) {
    return await getRootfsQuotaReport0({
      bay_id: currentBayId,
      ...request,
    });
  }
  await assertAdmin(account_id);
  const bayIds = [
    ...new Set(
      (await listConfiguredBays())
        .map((bay) => `${bay.bay_id ?? ""}`.trim())
        .filter(Boolean)
        .concat(currentBayId),
    ),
  ].sort();
  const settled = await Promise.allSettled(
    bayIds.map(async (bay_id) => {
      const report =
        bay_id === currentBayId
          ? await getRootfsQuotaReport0({ bay_id, ...request })
          : await getInterBayBridge()
              .bayOps(bay_id, { timeout_ms: 15_000 })
              .getRootfsQuotaReport({ account_id, ...request });
      return {
        bay_id,
        report: withRootfsReportBayId(report, bay_id),
      };
    }),
  );
  const checkedAt = new Date();
  const rowLimit = boundedRootfsReportLimit(limit);
  const successfulReports: RootfsQuotaReport[] = [];
  const bays = bayIds.map((bay_id, i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      successfulReports.push(result.value.report);
      return { bay_id, ok: true };
    }
    return {
      bay_id,
      ok: false,
      error: `${result.reason}`,
    };
  });
  return {
    current_bay_id: currentBayId,
    checked_at: checkedAt.toISOString(),
    since: new Date(
      checkedAt.valueOf() - boundedRootfsWindowMinutes(window_minutes) * 60_000,
    ).toISOString(),
    window_minutes: boundedRootfsWindowMinutes(window_minutes),
    min_count: boundedRootfsMinCount(min_count),
    near_percent: boundedRootfsNearPercent(near_percent),
    top_users: successfulReports
      .flatMap((report) => report.top_users ?? [])
      .sort(
        (a, b) =>
          b.total_storage_bytes - a.total_storage_bytes || b.count - a.count,
      )
      .slice(0, rowLimit),
    near_limit_users: successfulReports
      .flatMap((report) => report.near_limit_users ?? [])
      .sort((a, b) => {
        const aRatio = Math.max(
          a.count_ratio ?? 0,
          a.total_storage_ratio ?? 0,
          a.max_rootfs_ratio ?? 0,
        );
        const bRatio = Math.max(
          b.count_ratio ?? 0,
          b.total_storage_ratio ?? 0,
          b.max_rootfs_ratio ?? 0,
        );
        return bRatio - aRatio || b.total_storage_bytes - a.total_storage_bytes;
      })
      .slice(0, rowLimit),
    denials: successfulReports
      .flatMap((report) => report.denials ?? [])
      .sort(
        (a, b) =>
          b.count - a.count ||
          new Date(b.last_time).getTime() - new Date(a.last_time).getTime(),
      )
      .slice(0, rowLimit),
    bays,
  };
}

export async function getServiceAdmissionConfig(): Promise<{
  limits: Record<string, number>;
  near_limit: { thresholdPercent: number; logIntervalMs: number };
}> {
  return await getConatAdmissionConfig();
}

export async function recordServiceAdmissionDenial({
  project_id,
  ...event
}: ServiceAdmissionDenialEvent): Promise<void> {
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  await recordServiceAdmissionDenialLocal({ ...event, project_id });
}

export async function recordServiceAdmissionNearLimit({
  project_id,
  ...event
}: ServiceAdmissionDenialEvent): Promise<void> {
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  await recordServiceAdmissionNearLimitLocal({ ...event, project_id });
}

function dateToIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : `${value}`;
}

async function runtimeSponsorLimit(
  sponsor_account_id: string,
): Promise<number | null> {
  try {
    const membership = await resolveMembershipForAccount(sponsor_account_id);
    const limit =
      getEffectiveMembershipUsageLimits(
        membership,
      ).max_sponsored_running_projects;
    return typeof limit === "number" && Number.isFinite(limit) ? limit : null;
  } catch (err) {
    logger.warn("failed to resolve runtime sponsor limit", {
      sponsor_account_id,
      err: `${err}`,
    });
    return null;
  }
}

function withProjectRuntimeSlotReportBayId(
  report: ProjectRuntimeSlotReport,
  bay_id: string,
): ProjectRuntimeSlotReport {
  return {
    ...report,
    bay_id: report.bay_id || bay_id,
    slots: (report.slots ?? []).map((slot) => ({
      ...slot,
      bay_id: slot.bay_id || report.bay_id || bay_id,
    })),
    top_sponsors: (report.top_sponsors ?? []).map((sponsor) => ({
      ...sponsor,
      bay_id: sponsor.bay_id || report.bay_id || bay_id,
    })),
    recent_events: (report.recent_events ?? []).map((event) => ({
      ...event,
      bay_id: event.bay_id || report.bay_id || bay_id,
    })),
  };
}

async function aggregateRuntimeSlotSponsors(
  reports: ProjectRuntimeSlotReport[],
  rowLimit: number,
): Promise<ProjectRuntimeSlotReportSponsor[]> {
  const sponsors = new Map<string, ProjectRuntimeSlotReportSponsor>();
  for (const sponsor of reports.flatMap(
    (report) => report.top_sponsors ?? [],
  )) {
    const existing = sponsors.get(sponsor.sponsor_account_id) ?? {
      sponsor_account_id: sponsor.sponsor_account_id,
      sponsor_display_name: sponsor.sponsor_display_name ?? null,
      current: 0,
      limit: sponsor.limit ?? null,
      active_projects: 0,
      starting: 0,
      running: 0,
      oldest_heartbeat_at: null,
      newest_heartbeat_at: null,
    };
    existing.current += Number(sponsor.current) || 0;
    existing.active_projects += Number(sponsor.active_projects) || 0;
    existing.starting += Number(sponsor.starting) || 0;
    existing.running += Number(sponsor.running) || 0;
    existing.sponsor_display_name =
      existing.sponsor_display_name ?? sponsor.sponsor_display_name ?? null;
    existing.limit = existing.limit ?? sponsor.limit ?? null;
    if (
      sponsor.oldest_heartbeat_at &&
      (existing.oldest_heartbeat_at == null ||
        sponsor.oldest_heartbeat_at < existing.oldest_heartbeat_at)
    ) {
      existing.oldest_heartbeat_at = sponsor.oldest_heartbeat_at;
    }
    if (
      sponsor.newest_heartbeat_at &&
      (existing.newest_heartbeat_at == null ||
        sponsor.newest_heartbeat_at > existing.newest_heartbeat_at)
    ) {
      existing.newest_heartbeat_at = sponsor.newest_heartbeat_at;
    }
    sponsors.set(sponsor.sponsor_account_id, existing);
  }
  return await Promise.all(
    [...sponsors.values()]
      .sort((a, b) => b.current - a.current)
      .slice(0, rowLimit)
      .map(async (sponsor) => ({
        ...sponsor,
        sponsor_display_name:
          sponsor.sponsor_display_name ??
          (await getName(sponsor.sponsor_account_id).catch(() => null)),
        limit:
          sponsor.limit ??
          (await runtimeSponsorLimit(sponsor.sponsor_account_id)),
      })),
  );
}

function aggregateRuntimeSlotEvents(
  reports: ProjectRuntimeSlotReport[],
): ProjectRuntimeSlotReport["recent_events"] {
  const events = new Map<
    string,
    ProjectRuntimeSlotReport["recent_events"][0]
  >();
  for (const event of reports.flatMap((report) => report.recent_events ?? [])) {
    const existing = events.get(event.event) ?? {
      event: event.event,
      count: 0,
      first_time: event.first_time,
      last_time: event.last_time,
    };
    existing.count += Number(event.count) || 0;
    if (event.first_time < existing.first_time) {
      existing.first_time = event.first_time;
    }
    if (event.last_time > existing.last_time) {
      existing.last_time = event.last_time;
    }
    events.set(event.event, existing);
  }
  return [...events.values()].sort((a, b) => a.event.localeCompare(b.event));
}

export async function getProjectRuntimeSlotReport({
  account_id,
  internalAuth,
  sponsor_account_id,
  active_only = true,
  window_minutes,
  limit,
}: {
  account_id?: string;
  internalAuth?: typeof BAY_OPS_INTERNAL_AUTH;
  sponsor_account_id?: string | null;
  active_only?: boolean;
  window_minutes?: number;
  limit?: number;
} = {}): Promise<ProjectRuntimeSlotReport> {
  const rowLimit = boundedPositiveInteger({
    value: limit,
    fallback: 100,
    max: 1000,
  });
  const windowMinutes = boundedPositiveInteger({
    value: window_minutes,
    fallback: 24 * 60,
    max: 30 * 24 * 60,
  });
  const request = {
    sponsor_account_id,
    active_only,
    window_minutes: windowMinutes,
    limit: rowLimit,
  };
  if (internalAuth === BAY_OPS_INTERNAL_AUTH) {
    return await getProjectRuntimeSlotReport0({
      bay_id: getConfiguredBayId(),
      ...request,
    });
  }

  await assertAdmin(account_id);
  const currentBayId = getConfiguredBayId();
  const bayIds = await getClusterReportBayIds();
  const settled = await Promise.allSettled(
    bayIds.map(async (bay_id) => {
      const report =
        bay_id === currentBayId
          ? await getProjectRuntimeSlotReport0({ bay_id, ...request })
          : await getInterBayBridge()
              .bayOps(bay_id, { timeout_ms: 15_000 })
              .getProjectRuntimeSlotReport({ account_id, ...request });
      return withProjectRuntimeSlotReportBayId(report, bay_id);
    }),
  );
  const successfulReports: ProjectRuntimeSlotReport[] = [];
  const bays = reportBayStatuses(bayIds, settled, successfulReports);
  const checkedAt = new Date();
  return {
    current_bay_id: currentBayId,
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    active_only,
    slots: successfulReports
      .flatMap((report) => report.slots ?? [])
      .sort(
        (a, b) =>
          new Date(b.heartbeat_at).getTime() -
            new Date(a.heartbeat_at).getTime() ||
          new Date(b.acquired_at).getTime() - new Date(a.acquired_at).getTime(),
      )
      .slice(0, rowLimit),
    top_sponsors: await aggregateRuntimeSlotSponsors(
      successfulReports,
      rowLimit,
    ),
    recent_events: aggregateRuntimeSlotEvents(successfulReports),
    bays,
  };
}

async function getProjectRuntimeSlotReport0({
  bay_id,
  sponsor_account_id,
  active_only,
  window_minutes: windowMinutes,
  limit: rowLimit,
}: {
  bay_id: string;
  sponsor_account_id?: string | null;
  active_only: boolean;
  window_minutes: number;
  limit: number;
}): Promise<ProjectRuntimeSlotReport> {
  const sponsorFilter = optionalFilter(sponsor_account_id);
  const params: any[] = [rowLimit];
  const conditions: string[] = [];
  if (active_only) {
    conditions.push("s.state = ANY($2)");
    params.push(["starting", "running"]);
  }
  if (sponsorFilter) {
    params.push(sponsorFilter);
    conditions.push(`s.sponsor_account_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows: slotRows } =
    await getPool().query<ProjectRuntimeSlotReportSlot>(
      `
      SELECT s.sponsor_account_id, s.project_id, p.title, s.owning_bay_id,
             s.host_id, s.state, s.actor_account_id, s.reason,
             s.acquired_at, s.heartbeat_at, s.expires_at, s.op_id
        FROM project_runtime_slots s
        LEFT JOIN projects p ON p.project_id = s.project_id
        ${where}
       ORDER BY s.heartbeat_at DESC, s.acquired_at DESC
       LIMIT $1
    `,
      params,
    );

  const sponsorRows = new Map<string, ProjectRuntimeSlotReportSponsor>();
  for (const row of slotRows) {
    const sponsor = sponsorRows.get(row.sponsor_account_id) ?? {
      sponsor_account_id: row.sponsor_account_id,
      current: 0,
      active_projects: 0,
      starting: 0,
      running: 0,
      oldest_heartbeat_at: null,
      newest_heartbeat_at: null,
    };
    if (row.state === "starting" || row.state === "running") {
      sponsor.current += 1;
      sponsor.active_projects += 1;
      if (row.state === "starting") sponsor.starting += 1;
      if (row.state === "running") sponsor.running += 1;
    }
    const heartbeat = dateToIso(row.heartbeat_at);
    if (
      sponsor.oldest_heartbeat_at == null ||
      heartbeat < sponsor.oldest_heartbeat_at
    ) {
      sponsor.oldest_heartbeat_at = heartbeat;
    }
    if (
      sponsor.newest_heartbeat_at == null ||
      heartbeat > sponsor.newest_heartbeat_at
    ) {
      sponsor.newest_heartbeat_at = heartbeat;
    }
    sponsorRows.set(row.sponsor_account_id, sponsor);
  }

  const top_sponsors = await Promise.all(
    [...sponsorRows.values()]
      .sort((a, b) => b.current - a.current)
      .slice(0, rowLimit)
      .map(async (sponsor) => ({
        ...sponsor,
        sponsor_display_name: await getName(sponsor.sponsor_account_id).catch(
          () => null,
        ),
        limit: await runtimeSponsorLimit(sponsor.sponsor_account_id),
        bay_id,
      })),
  );

  const eventParams: any[] = [windowMinutes];
  const eventConditions = [
    "event = ANY($2)",
    `"time" >= NOW() - ($1::int * INTERVAL '1 minute')`,
  ];
  eventParams.push([
    "project_runtime_slot_reserved",
    "project_runtime_slot_denied",
    "project_runtime_slot_released",
    "project_runtime_slot_expired",
  ]);
  if (sponsorFilter) {
    eventParams.push(sponsorFilter);
    eventConditions.push(
      `value->>'sponsor_account_id' = $${eventParams.length}`,
    );
  }
  const { rows: eventRows } = await getPool().query<{
    event: string;
    count: number;
    first_time: Date;
    last_time: Date;
  }>(
    `
      SELECT event, COUNT(*)::int AS count, MIN("time") AS first_time,
             MAX("time") AS last_time
        FROM central_log
       WHERE ${eventConditions.join(" AND ")}
       GROUP BY event
       ORDER BY event
    `,
    eventParams,
  );

  const checkedAt = new Date();
  return {
    checked_at: checkedAt.toISOString(),
    bay_id,
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    active_only,
    slots: slotRows.map((row) => ({
      ...row,
      bay_id,
      acquired_at: dateToIso(row.acquired_at),
      heartbeat_at: dateToIso(row.heartbeat_at),
      expires_at: dateToIso(row.expires_at),
    })),
    top_sponsors,
    recent_events: eventRows.map((row) => ({
      event: row.event,
      bay_id,
      count: Number(row.count) || 0,
      first_time: dateToIso(row.first_time),
      last_time: dateToIso(row.last_time),
    })),
  };
}

export async function runBayBackup({
  account_id,
  bay_id,
}: {
  account_id?: string;
  bay_id?: string;
}): Promise<BayBackupRunResult> {
  await assertAdmin(account_id);
  return await runBayBackup0({ bay_id });
}

export async function runBayRestore({
  account_id,
  browser_id,
  session_hash,
  bay_id,
  backup_set_id,
  target_dir,
  dry_run = true,
  remote_only = false,
  target_time,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  bay_id?: string;
  backup_set_id?: string;
  target_dir?: string;
  dry_run?: boolean;
  remote_only?: boolean;
  target_time?: string;
}): Promise<BayRestoreRunResult> {
  await assertAdmin(account_id);
  if (dry_run !== true) {
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor: true,
    });
  }
  // This RPC is an admin convenience wrapper around bay restore while the hub
  // is already running. Each backup set also carries its own offline restore
  // helper so disaster recovery does not depend on the hub being alive first.
  return await runBayRestore0({
    bay_id,
    backup_set_id,
    target_dir,
    dry_run,
    remote_only,
    target_time,
  });
}

export async function runBayRestoreTest({
  account_id,
  browser_id,
  session_hash,
  bay_id,
  backup_set_id,
  target_dir,
  keep = false,
  remote_only = false,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  bay_id?: string;
  backup_set_id?: string;
  target_dir?: string;
  keep?: boolean;
  remote_only?: boolean;
}): Promise<BayRestoreTestRunResult> {
  await assertAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await runBayRestoreTest0({
    bay_id,
    backup_set_id,
    target_dir,
    keep,
    remote_only,
  });
}

export async function getAccountBay({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id?: string;
}) {
  return await resolveAccountHomeBay({ account_id, user_account_id });
}

export async function getProjectBay({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  return await resolveProjectOwningBay({ account_id, project_id });
}

export async function getHostBay({
  account_id,
  host_id,
  include_deleted,
}: {
  account_id?: string;
  host_id: string;
  include_deleted?: boolean;
}) {
  return await resolveHostBay({ account_id, host_id, include_deleted });
}

export async function getRoutingContext({
  account_id,
  user_account_id,
  project_id,
  host_id,
}: {
  account_id?: string;
  user_account_id?: string;
  project_id: string;
  host_id?: string | null;
}) {
  return await resolveRoutingContext({
    account_id,
    user_account_id,
    project_id,
    host_id,
  });
}

export async function backfillBayOwnership({
  account_id,
  bay_id,
  dry_run = true,
  limit_per_table,
}: {
  account_id?: string;
  bay_id?: string;
  dry_run?: boolean;
  limit_per_table?: number;
}) {
  await assertAdmin(account_id);
  return await backfillBayOwnership0({
    bay_id,
    dry_run,
    limit_per_table,
  });
}

export async function rebuildAccountProjectIndex({
  account_id,
  target_account_id,
  dry_run = true,
}: {
  account_id?: string;
  target_account_id: string;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await rebuildAccountProjectIndex0({
    account_id: target_account_id,
    bay_id: getConfiguredBayId(),
    dry_run,
  });
}

export async function drainAccountProjectIndexProjection({
  account_id,
  bay_id,
  limit,
  dry_run = true,
}: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await drainAccountProjectIndexProjection0({
    bay_id: bay_id?.trim() || getConfiguredBayId(),
    limit,
    dry_run,
  });
}

export async function getAccountProjectIndexProjectionStatus({
  account_id,
}: {
  account_id?: string;
}) {
  await assertAdmin(account_id);
  const bay_id = getConfiguredBayId();
  return {
    bay_id,
    backlog: await getAccountProjectIndexProjectionBacklogStatus({
      bay_id,
    }),
    maintenance: getAccountProjectIndexProjectionMaintenanceStatus(),
  };
}

export async function rebuildAccountCollaboratorIndex({
  account_id,
  target_account_id,
  dry_run = true,
}: {
  account_id?: string;
  target_account_id: string;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await rebuildAccountCollaboratorIndex0({
    account_id: target_account_id,
    bay_id: getConfiguredBayId(),
    dry_run,
  });
}

export async function drainAccountCollaboratorIndexProjection({
  account_id,
  bay_id,
  limit,
  dry_run = true,
}: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await drainAccountCollaboratorIndexProjection0({
    bay_id: bay_id?.trim() || getConfiguredBayId(),
    limit,
    dry_run,
  });
}

export async function getAccountCollaboratorIndexProjectionStatus({
  account_id,
}: {
  account_id?: string;
}) {
  await assertAdmin(account_id);
  const bay_id = getConfiguredBayId();
  return {
    bay_id,
    backlog: await getAccountCollaboratorIndexProjectionBacklogStatus({
      bay_id,
    }),
    maintenance: getAccountCollaboratorIndexProjectionMaintenanceStatus(),
  };
}

export async function rebuildAccountNotificationIndex({
  account_id,
  target_account_id,
  dry_run = true,
}: {
  account_id?: string;
  target_account_id: string;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await rebuildAccountNotificationIndex0({
    account_id: target_account_id,
    bay_id: getConfiguredBayId(),
    dry_run,
  });
}

export async function drainAccountNotificationIndexProjection({
  account_id,
  bay_id,
  limit,
  dry_run = true,
}: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}) {
  await assertAdmin(account_id);
  return await drainAccountNotificationIndexProjection0({
    bay_id: bay_id?.trim() || getConfiguredBayId(),
    limit,
    dry_run,
  });
}

export async function getAccountNotificationIndexProjectionStatus({
  account_id,
}: {
  account_id?: string;
}) {
  await assertAdmin(account_id);
  const bay_id = getConfiguredBayId();
  return {
    bay_id,
    backlog: await getAccountNotificationIndexProjectionBacklogStatus({
      bay_id,
    }),
    maintenance: getAccountNotificationIndexProjectionMaintenanceStatus(),
  };
}

export async function getParallelOpsStatus({
  account_id,
}: {
  account_id?: string;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getParallelOpsStatus0();
}

export async function getProjectHostParallelOpsLimit({
  account_id,
  host_id,
  worker_kind,
}: {
  account_id?: string;
  host_id?: string;
  worker_kind: string;
}) {
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  if (worker.scope_model !== "per-project-host") {
    throw Error(
      `worker '${worker_kind}' does not use per-project-host limit resolution`,
    );
  }
  const effectiveHostId = `${host_id ?? ""}`.trim();
  if (!effectiveHostId) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("must be a host or an admin");
    }
    throw Error("host_id is required");
  }
  const base = worker.getLimitSnapshot();
  let default_limit = base.default_limit ?? base.effective_limit;
  if (
    effectiveHostId &&
    (worker_kind === "project-rootfs-publish-host" ||
      worker_kind === "project-host-backup-execution")
  ) {
    default_limit = await getProjectHostDefaultParallelLimit({
      host_id: effectiveHostId,
    });
  }
  if (default_limit == null) {
    throw Error(`worker '${worker_kind}' does not define a default limit`);
  }
  const { value, source } = await getEffectiveParallelOpsLimit({
    worker_kind,
    default_limit,
    scope_type: "project_host",
    scope_id: effectiveHostId,
  });
  return {
    worker_kind,
    scope_type: "project_host" as const,
    scope_id: effectiveHostId,
    default_limit,
    configured_limit: source === "db-override" ? value : null,
    effective_limit: value,
    config_source:
      source === "db-override"
        ? "db-override"
        : source === "env-debug-cap"
          ? "env-debug-cap"
          : base.config_source,
  };
}

function validateParallelOpsScopeType(
  scope_type: string | undefined,
): ParallelOpsLimitScopeType {
  const normalized = `${scope_type ?? "global"}`.trim();
  if (
    normalized === "global" ||
    normalized === "provider" ||
    normalized === "project_host"
  ) {
    return normalized;
  }
  throw Error(`invalid scope_type '${scope_type}'`);
}

async function assertAdmin(account_id?: string): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
}

export async function setParallelOpsLimit({
  account_id,
  browser_id,
  session_hash,
  worker_kind,
  scope_type,
  scope_id,
  limit_value,
  note,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  worker_kind: string;
  scope_type?: string;
  scope_id?: string;
  limit_value: number;
  note?: string;
}) {
  await assertAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  const normalizedScopeType = validateParallelOpsScopeType(scope_type);
  if (!worker.dynamic_limit_supported) {
    throw Error(`dynamic limits are not supported for '${worker_kind}'`);
  }
  if (worker.scope_model === "global") {
    if (normalizedScopeType !== "global") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
  } else if (worker.scope_model === "per-project-host") {
    if (normalizedScopeType !== "project_host") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (!`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else if (worker.scope_model === "per-provider") {
    if (
      normalizedScopeType !== "global" &&
      normalizedScopeType !== "provider"
    ) {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (normalizedScopeType === "provider" && !`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else {
    throw Error(
      `non-global limit overrides are not implemented for '${worker_kind}'`,
    );
  }
  if (!Number.isInteger(limit_value) || limit_value < 1) {
    throw Error("limit_value must be a positive integer");
  }
  return await setParallelOpsLimitOverride({
    worker_kind,
    scope_type: normalizedScopeType,
    scope_id,
    limit_value,
    updated_by: account_id,
    note,
  });
}

export async function clearParallelOpsLimit({
  account_id,
  browser_id,
  session_hash,
  worker_kind,
  scope_type,
  scope_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  worker_kind: string;
  scope_type?: string;
  scope_id?: string;
}) {
  await assertAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const worker = getParallelOpsWorkerRegistration(worker_kind);
  if (!worker) {
    throw Error(`unknown worker_kind '${worker_kind}'`);
  }
  const normalizedScopeType = validateParallelOpsScopeType(scope_type);
  if (!worker.dynamic_limit_supported) {
    throw Error(`dynamic limits are not supported for '${worker_kind}'`);
  }
  if (worker.scope_model === "global") {
    if (normalizedScopeType !== "global") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
  } else if (worker.scope_model === "per-project-host") {
    if (normalizedScopeType !== "project_host") {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (!`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else if (worker.scope_model === "per-provider") {
    if (
      normalizedScopeType !== "global" &&
      normalizedScopeType !== "provider"
    ) {
      throw Error(
        `scope_type '${normalizedScopeType}' is not implemented for '${worker_kind}'`,
      );
    }
    if (normalizedScopeType === "provider" && !`${scope_id ?? ""}`.trim()) {
      throw Error(`scope_id is required for '${worker_kind}'`);
    }
  } else {
    throw Error(
      `non-global limit overrides are not implemented for '${worker_kind}'`,
    );
  }
  await clearParallelOpsLimitOverride({
    worker_kind,
    scope_type: normalizedScopeType,
    scope_id,
  });
}

export async function recordBrowserAutomationAudit({
  event,
  value,
  account_id,
}: {
  event: Parameters<typeof recordBrowserAutomationAuditEvent>[0]["event"];
  value: Parameters<typeof recordBrowserAutomationAuditEvent>[0]["value"];
  account_id?: string;
}): Promise<void> {
  await recordBrowserAutomationAuditEvent({
    event,
    value: {
      ...value,
      account_id,
    },
  });
}

export async function logClientError({
  account_id,
  event,
  error,
}: {
  account_id?: string;
  event: string;
  error: string;
}): Promise<void> {
  await callback2(db().log_client_error, {
    event,
    error,
    account_id,
  });
}

export async function webappError(opts: object): Promise<void> {
  await callback2(db().webapp_error, opts);
}

export async function getFrontendSourceFingerprint() {
  return await getFrontendSourceFingerprint0();
}

function setupStep(opts: {
  id: string;
  title: string;
  state: SiteSetupStepState;
  hard_gate?: boolean;
  summary: string;
  details?: string[];
  admin_section?: string;
}): SiteSetupStep {
  return {
    hard_gate: true,
    ...opts,
  };
}

function siteSetupProfile(): SiteSetupStatus["profile"] {
  const profile = `${process.env.COCALC_SETUP_PROFILE ?? ""}`
    .trim()
    .toLowerCase();
  if (profile === "star") return "star";
  return "launchpad-cloud";
}

const STAR_INSTALL_ROOT = "/opt/cocalc-star";

async function readJsonFile(path: string): Promise<Record<string, any>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function parseStarChannelEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    if (/^COCALC_STAR_[A-Z0-9_]+$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

async function readlinkBestEffort(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export async function getStarServerInfo({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<StarServerInfo> {
  await assertAdmin(account_id);
  const installMetadata = await readJsonFile(
    `${STAR_INSTALL_ROOT}/current/release.json`,
  );
  const buildMetadata = {
    ...(await readJsonFile(`${STAR_INSTALL_ROOT}/current/source/release.json`)),
    ...(await readJsonFile(`${STAR_INSTALL_ROOT}/current/build-release.json`)),
  };
  const channelEnv = parseStarChannelEnv(
    await readTextFile(`${STAR_INSTALL_ROOT}/channel.env`),
  );
  const releaseId =
    optionalString(installMetadata.release_id) ??
    optionalString(buildMetadata.release_id);

  return {
    detected: !!releaseId || !!optionalString(buildMetadata.product),
    checked_at: new Date().toISOString(),
    product: optionalString(buildMetadata.product) ?? "cocalc-star",
    channel: optionalString(channelEnv.COCALC_STAR_CHANNEL),
    release_id: releaseId,
    release_base_url: optionalString(channelEnv.COCALC_STAR_RELEASE_BASE_URL),
    promoted_at: optionalString(channelEnv.COCALC_STAR_PROMOTED_AT),
    git_revision:
      optionalString(channelEnv.COCALC_STAR_GIT_REVISION) ??
      optionalString(buildMetadata.git_revision),
    git_dirty: optionalBoolean(buildMetadata.git_dirty),
    artifact_mode: optionalString(buildMetadata.artifact_mode),
    payload_kind: optionalString(buildMetadata.payload_kind),
    payload_sha256: optionalString(buildMetadata.payload_sha256),
    built_at: optionalString(buildMetadata.built_at),
    installed_at: optionalString(installMetadata.installed_at),
    tarball_sha256: optionalString(installMetadata.tarball_sha256),
    install_root: STAR_INSTALL_ROOT,
    current_release_path: await readlinkBestEffort(
      `${STAR_INSTALL_ROOT}/current`,
    ),
    source_path:
      optionalString(installMetadata.source_path) ??
      (await readlinkBestEffort(`${STAR_INSTALL_ROOT}/source`)),
    hostname: hostname(),
    architecture: arch(),
    platform: platform(),
    os_release: osRelease(),
  };
}

function boolSetting(value: unknown): boolean {
  return to_bool(value) === true;
}

async function getProjectHostSetupCount(): Promise<number> {
  const { rows } = await getPool("medium").query<{ count: number }>(
    `
      SELECT COUNT(*)::INTEGER AS count
        FROM project_hosts
       WHERE deleted IS NULL
         AND status IN ('active', 'running')
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

async function getProviderCatalogSetupCount(
  providers: string[],
): Promise<number> {
  if (!providers.length) return 0;
  const { rows } = await getPool("medium").query<{ count: number }>(
    `
      SELECT COUNT(DISTINCT provider)::INTEGER AS count
        FROM cloud_catalog_cache
       WHERE provider = ANY($1::TEXT[])
    `,
    [providers],
  );
  return Number(rows[0]?.count ?? 0);
}

async function getRootfsSetupCounts(): Promise<{
  official: number;
  prepull: number;
}> {
  const { rows } = await getPool("medium").query<{
    official: number;
    prepull: number;
  }>(
    `
      SELECT COUNT(*) FILTER (WHERE COALESCE(official, false))::INTEGER AS official,
             COUNT(*) FILTER (WHERE COALESCE(prepull, false))::INTEGER AS prepull
        FROM rootfs_images
       WHERE COALESCE(deleted, false) = false
         AND COALESCE(hidden, false) = false
         AND COALESCE(blocked, false) = false
    `,
  );
  return {
    official: Number(rows[0]?.official ?? 0),
    prepull: Number(rows[0]?.prepull ?? 0),
  };
}

function configuredProvidersFromSettings(settings: any): {
  providers: string[];
  details: string[];
} {
  const providers: string[] = [];
  const details: string[] = [];

  if (boolSetting(settings["project_hosts_google-cloud_enabled"])) {
    if (clean(settings.google_cloud_service_account_json)) {
      providers.push("gcp");
      details.push("GCP is enabled and has a service account JSON.");
    } else {
      details.push("GCP is enabled but service account JSON is missing.");
    }
  }

  if (boolSetting(settings.project_hosts_nebius_enabled)) {
    try {
      const regionConfig = getNebiusRegionConfigFromSettings(settings);
      const regions = regionConfig ? Object.keys(regionConfig).sort() : [];
      if (regions.length) {
        providers.push("nebius");
        details.push(`Nebius is enabled for ${regions.join(", ")}.`);
      } else {
        details.push("Nebius is enabled but has no region configuration.");
      }
    } catch (err) {
      details.push(`Nebius configuration is invalid: ${err}`);
    }
  }

  return { providers, details };
}

function emailSetupState(settings: any): SiteSetupStep {
  if (!boolSetting(settings.email_enabled)) {
    return setupStep({
      id: "email",
      title: "Email Provider",
      state: "optional",
      hard_gate: false,
      admin_section: "site-settings",
      summary:
        "Email is skipped. This is acceptable for small sites where users can coordinate out of band.",
      details: [
        "Email verification UI stays hidden when email is disabled.",
        "Admins can still generate password reset links for users.",
      ],
    });
  }

  const backend = `${settings.email_backend ?? ""}`.trim();
  const configured =
    backend === "sendgrid"
      ? !!clean(settings.sendgrid_key)
      : backend === "smtp"
        ? !!(
            clean(settings.email_smtp_server) &&
            clean(settings.email_smtp_from) &&
            clean(settings.email_smtp_login) &&
            clean(settings.email_smtp_password)
          )
        : false;

  return setupStep({
    id: "email",
    title: "Email Provider",
    state: configured ? "done" : "warning",
    hard_gate: false,
    admin_section: "site-settings",
    summary: configured
      ? `Email is enabled with the ${backend} backend.`
      : "Email is enabled but the selected backend is not fully configured.",
    details: configured
      ? []
      : [
          "Either finish the email backend configuration or disable email until the site needs multi-user coordination.",
        ],
  });
}

function buildSiteSetupStatus({
  counts,
  inviteUrl,
  profile,
  steps,
}: {
  counts: SiteSetupStatus["counts"];
  inviteUrl?: string;
  profile: SiteSetupStatus["profile"];
  steps: SiteSetupStep[];
}): SiteSetupStatus {
  const hardGates = steps.filter((step) => step.hard_gate);
  const hardGatesDone = hardGates.filter(
    (step) => step.state === "done",
  ).length;
  return {
    profile,
    checked_at: new Date().toISOString(),
    ready: hardGatesDone === hardGates.length,
    invite_url: inviteUrl,
    hard_gates_total: hardGates.length,
    hard_gates_done: hardGatesDone,
    steps,
    counts,
  };
}

export async function getSiteSetupStatus({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<SiteSetupStatus> {
  await assertAdmin(account_id);
  const settings = await getServerSettings();
  const profile = siteSetupProfile();
  const siteDns = clean(settings.dns);
  const cloudflareConfigured =
    !!siteDns &&
    boolSetting((settings as any).project_hosts_cloudflare_tunnel_enabled) &&
    !!clean((settings as any).project_hosts_cloudflare_tunnel_account_id) &&
    !!clean((settings as any).project_hosts_cloudflare_tunnel_api_token);
  const { providers, details: providerDetails } =
    configuredProvidersFromSettings(settings);
  const [has2fa, cachedProviderCatalogs, healthyProjectHosts, rootfs] =
    await Promise.all([
      hasActiveSecondFactor(account_id!),
      getProviderCatalogSetupCount(providers),
      getProjectHostSetupCount(),
      getRootfsSetupCounts(),
    ]);
  const counts = {
    configured_providers: providers.length,
    cached_provider_catalogs: cachedProviderCatalogs,
    healthy_project_hosts: healthyProjectHosts,
    official_rootfs_images: rootfs.official,
    prepull_rootfs_images: rootfs.prepull,
  };

  if (profile === "star") {
    const inviteUrl = await ensureStarInviteRegistrationToken();
    const totalMemoryGiB = totalmem() / 1024 ** 3;
    const totalMemoryLabel = `${totalMemoryGiB.toFixed(1)} GiB`;
    const defaultRootfsImage = clean(
      (settings as any).project_rootfs_default_image,
    );
    const prepullImages = clean(
      (settings as any).project_rootfs_prepull_images,
    );
    const rootfsReady =
      !!defaultRootfsImage &&
      (!prepullImages || prepullImages.includes(defaultRootfsImage));
    const smokeReady = healthyProjectHosts > 0 && rootfsReady;
    const steps: SiteSetupStep[] = [
      setupStep({
        id: "admin-account",
        title: "Admin Account",
        state: "done",
        summary:
          "The first administrator account exists and can manage this Star appliance.",
        details: [
          "This is the only account requirement for a usable zero-conf Star install.",
          "Keep normal signups closed until the local smoke path has been checked.",
        ],
      }),
      setupStep({
        id: "smoke-test",
        title: "Smoke Test",
        state: smokeReady ? "done" : "blocked",
        summary: smokeReady
          ? "The local host and default project image are ready for the required smoke test."
          : "Smoke testing is blocked until the local project host and default project image are ready.",
        details: [
          "Required operator check: create a project, start it, open a terminal, and open Jupyter.",
          "The installer-level smoke test covers project creation, file listing, exec, SSH info, Jupyter executable, and LaTeX executable.",
          "A follow-up should persist the most recent browser smoke-test result instead of deriving this from prerequisites.",
        ],
      }),
      setupStep({
        id: "admin-2fa",
        title: "Admin Two-Factor Authentication",
        state: has2fa ? "done" : "warning",
        hard_gate: false,
        summary: has2fa
          ? "Your admin account has an active second factor."
          : "2FA is recommended before inviting users, but it is not required for initial Star setup.",
        details: [
          "Star should be useful immediately after bootstrap; 2FA belongs in the recommended-before-users checklist.",
          "Some high-risk admin operations may still require fresh authentication.",
        ],
      }),
      setupStep({
        id: "project-host",
        title: "Local Project Host",
        state: healthyProjectHosts > 0 ? "done" : "warning",
        hard_gate: false,
        summary:
          healthyProjectHosts > 0
            ? `${healthyProjectHosts} local project host${healthyProjectHosts === 1 ? "" : "s"} healthy.`
            : "The local Star project host is not healthy.",
        details: [
          "Star should have one local project host created by the installer.",
          "No Cloudflare, GCP, Nebius, AWS, or Azure setup is needed for this profile.",
          healthyProjectHosts > 0
            ? "This supports the required smoke test."
            : "A broken local host means projects will not start, but the fix is appliance repair rather than cloud-provider setup.",
        ],
      }),
      setupStep({
        id: "resource-budget",
        title: "Resource Budget",
        state: totalMemoryGiB >= 16 ? "done" : "warning",
        hard_gate: false,
        summary:
          totalMemoryGiB >= 16
            ? `This VM reports ${totalMemoryLabel} RAM, which is within the Star V1 envelope.`
            : `This VM reports ${totalMemoryLabel} RAM, below the recommended Star V1 minimum.`,
        details: [
          "Star shares one VM between the hub, local Postgres, project-host daemons, rootfs cache, and user project containers.",
          "Recommended V1 minimum is 16 GiB RAM; 32 GiB RAM is a better default for small groups.",
        ],
      }),
      setupStep({
        id: "rootfs",
        title: "Default Project Image",
        state: rootfsReady ? "done" : "warning",
        hard_gate: false,
        admin_section: "rootfs",
        summary: rootfsReady
          ? `Default project image is ${defaultRootfsImage}.`
          : "Configure a usable default RootFS image for projects.",
        details: [
          rootfsReady
            ? "The Star installer should provide a default image with Jupyter and LaTeX."
            : "A fresh Star install should build or configure a default image before users create projects.",
          "The image should be prepulled or locally cached so first project startup is predictable.",
        ],
      }),
      setupStep({
        id: "license",
        title: "License Code",
        state: "optional",
        hard_gate: false,
        summary:
          "License entry is deferred; the free appliance should remain useful without a code.",
        details: [
          "Later, a license should unlock higher limits, supported upgrades, or paid support.",
          "It should not block first successful install, project start, or local Jupyter usage.",
        ],
      }),
      emailSetupState(settings),
      setupStep({
        id: "tls-public-url",
        title: "TLS And Public URL",
        state: siteDns ? "manual" : "optional",
        hard_gate: false,
        admin_section: "site-settings",
        summary: siteDns
          ? `Public URL/DNS setting is ${siteDns}; configure Caddy/Let's Encrypt when exposing this VM.`
          : "TLS and DNS are optional. Star can be tested over localhost, LAN, VPN, or SSH tunnel.",
        details: [
          "Supported path: Caddy with Let's Encrypt after DNS points at the VM.",
          "Do not require DNS or TLS for the first useful appliance experience.",
        ],
      }),
      setupStep({
        id: "custom-rootfs",
        title: "Custom RootFS",
        state: "optional",
        hard_gate: false,
        admin_section: "rootfs",
        summary:
          "Custom project images are supported after the default image works.",
        details: [
          "The default image should be enough for terminal, Jupyter, and LaTeX smoke testing.",
          "GPU-specific images should be tested on GPU VMs during manual provider validation.",
        ],
      }),
      setupStep({
        id: "backups",
        title: "Backups And VM Snapshots",
        state: "manual",
        hard_gate: false,
        summary:
          "Decide how this VM will be backed up before relying on it for real users.",
        details: [
          "V1 recommendation: provider VM/disk snapshots plus a documented copy of the Star recovery material.",
          "External/off-machine rustic backup targets are a follow-up, not a first-run hard gate.",
        ],
      }),
    ];
    return buildSiteSetupStatus({ counts, inviteUrl, profile, steps });
  }

  const steps: SiteSetupStep[] = [
    setupStep({
      id: "admin-2fa",
      title: "Admin Account Security",
      state: has2fa ? "done" : "blocked",
      summary: has2fa
        ? "Your admin account has an active second factor."
        : "Enable 2FA before continuing; many admin operations require it.",
      details: [
        "The first account is the site admin. Do not open normal signups before setup is complete.",
      ],
    }),
    setupStep({
      id: "domain-cloudflare",
      title: "Domain And Cloudflare",
      state: cloudflareConfigured ? "done" : "blocked",
      admin_section: "site-settings",
      summary: cloudflareConfigured
        ? `Cloudflare tunnel settings are configured for ${siteDns}.`
        : "Configure a domain on Cloudflare and save the tunnel settings.",
      details: [
        "You need a domain before project-host providers are useful.",
        "Cloudflare can host existing domains, and can also be used as a registrar.",
        "Free Cloudflare domains should work for the required DNS/tunnel flow, but the setup wizard should still make tier limitations explicit.",
      ],
    }),
    setupStep({
      id: "cloud-provider",
      title: "Cloud Provider",
      state: providers.length ? "done" : "blocked",
      admin_section: "site-settings",
      summary: providers.length
        ? `Configured provider${providers.length === 1 ? "" : "s"}: ${providers.join(", ")}.`
        : "Configure GCP or Nebius using direct upload.",
      details: providerDetails.length
        ? providerDetails
        : [
            "Direct upload should be the normal path; manual paste should stay hidden unless explicitly enabled for support.",
          ],
    }),
    setupStep({
      id: "provider-catalog",
      title: "Provider Catalog",
      state:
        cachedProviderCatalogs > 0
          ? "done"
          : providers.length
            ? "blocked"
            : "manual",
      admin_section: "site-settings",
      summary:
        cachedProviderCatalogs > 0
          ? `${cachedProviderCatalogs} configured provider catalog${cachedProviderCatalogs === 1 ? "" : "s"} cached.`
          : "Refresh the provider catalog after credentials are configured.",
      details: [
        "Catalog refresh can take long enough that the UI must wait on the backend result instead of prompting repeated clicks.",
      ],
    }),
    setupStep({
      id: "email",
      title: "Email Provider",
      state: "optional",
      hard_gate: false,
      summary: "Email is optional for small sites.",
    }),
    setupStep({
      id: "project-host",
      title: "First Project Host",
      state: healthyProjectHosts > 0 ? "done" : "blocked",
      summary:
        healthyProjectHosts > 0
          ? `${healthyProjectHosts} project host${healthyProjectHosts === 1 ? "" : "s"} healthy.`
          : "Create at least one healthy project host.",
      details: [
        "A project host proves provider credentials, bootstrap, DNS, and host heartbeat are working.",
      ],
    }),
    // TODO: restore these before treating Site Setup as a complete launch gate.
    // Official RootFS detection is not reliable enough yet, and the smoke-test
    // step needs a persisted browser/project result instead of a manual prompt.
    // setupStep({
    //   id: "rootfs",
    //   title: "Official RootFS",
    //   state: rootfs.official > 0 && rootfs.prepull > 0 ? "done" : "blocked",
    //   admin_section: "rootfs",
    //   summary:
    //     rootfs.official > 0 && rootfs.prepull > 0
    //       ? `${rootfs.official} official image${rootfs.official === 1 ? "" : "s"} and ${rootfs.prepull} prepull image${rootfs.prepull === 1 ? "" : "s"} are visible.`
    //       : "Create an official RootFS and mark it for prepull.",
    //   details: [
    //     "The first public recipe can start as Ubuntu with Jupyter and LaTeX packages installed.",
    //   ],
    // }),
    // setupStep({
    //   id: "smoke-test",
    //   title: "Smoke Test",
    //   state:
    //     healthyProjectHosts > 0 && rootfs.official > 0 ? "manual" : "blocked",
    //   summary:
    //     healthyProjectHosts > 0 && rootfs.official > 0
    //       ? "Create a project, start it on the official RootFS, and verify terminal/Jupyter manually."
    //       : "Smoke testing is blocked until a host and official RootFS exist.",
    // }),
  ];
  steps[4] = emailSetupState(settings);
  steps.push(
    setupStep({
      id: "mark-ready",
      title: "Mark Site Ready",
      state: "manual",
      summary:
        "Explicit completion is not persisted yet; this first implementation only derives setup readiness.",
      details: [
        "The follow-up write path should require fresh admin auth and store a small site setup state record.",
      ],
    }),
  );

  return buildSiteSetupStatus({ counts, profile, steps });
}

export async function getRootfsCatalog(opts: { account_id?: string } = {}) {
  return await listVisibleRootfsImages(opts.account_id);
}

export async function getRootfsCatalogPage(
  opts: RootfsCatalogPageRequest & {
    account_id?: string;
  } = {},
): Promise<RootfsImageCatalogPage> {
  return await listVisibleRootfsImagesPage(opts.account_id, opts);
}

export async function getRootfsCatalogAdmin(
  opts: {
    account_id?: string;
  } = {},
) {
  return await listRootfsImagesAdmin(opts.account_id);
}

export async function getRootfsCatalogAdminPage(
  opts: RootfsCatalogPageRequest & {
    account_id?: string;
  } = {},
): Promise<RootfsAdminCatalogPage> {
  return await listRootfsImagesAdminPage(opts);
}

export async function getRootfsRusticReposAdmin(
  opts: {
    account_id?: string;
    region?: string;
    status?: string;
  } = {},
) {
  const { account_id, region, status } = opts;
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await listRootfsRusticReposAdmin({ region, status });
}

const ROOTFS_ADMIN_CATALOG_FIELDS = [
  "official",
  "prepull",
  "hidden",
  "blocked",
  "blocked_reason",
] as const;

function hasRootfsAdminCatalogField(
  body: Partial<Record<(typeof ROOTFS_ADMIN_CATALOG_FIELDS)[number], unknown>>,
): boolean {
  return ROOTFS_ADMIN_CATALOG_FIELDS.some((field) => {
    return (
      Object.prototype.hasOwnProperty.call(body, field) &&
      body[field] !== undefined
    );
  });
}

async function isAdminMutatingNonOwnedRootfsEntry({
  account_id,
  image_id,
}: {
  account_id: string;
  image_id?: string;
}): Promise<boolean> {
  const imageId = `${image_id ?? ""}`.trim();
  if (!imageId || !(await isAdmin(account_id))) {
    return false;
  }
  const { rows } = await getPool().query<{ owner_id: string | null }>(
    "SELECT owner_id FROM rootfs_images WHERE image_id=$1",
    [imageId],
  );
  if (rows.length === 0) {
    return false;
  }
  return rows[0].owner_id !== account_id;
}

export async function saveRootfsCatalogEntry(
  opts: RootfsCatalogSaveBody & {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  },
) {
  const { account_id, browser_id, session_hash, ...body } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const admin = await isAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor:
      (admin && hasRootfsAdminCatalogField(body)) ||
      (await isAdminMutatingNonOwnedRootfsEntry({
        account_id,
        image_id: body.image_id,
      })),
  });
  return await saveRootfsImage({ account_id, body });
}

export async function requestRootfsImageDeletion(opts: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  image_id: string;
  reason?: string;
}) {
  const { account_id, browser_id, session_hash, image_id, reason } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: await isAdminMutatingNonOwnedRootfsEntry({
      account_id,
      image_id,
    }),
  });
  return await requestRootfsImageDeletion0({
    account_id,
    image_id,
    reason,
  });
}

export async function runRootfsReleaseGc(opts: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  limit?: number;
}) {
  const { account_id, browser_id, session_hash, limit } = opts;
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await runPendingRootfsReleaseGc({ limit });
}

export async function scanRootfsRelease(opts: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  release_id: string;
  host_id: string;
  scanner_image?: string;
  trivy_cache_dir?: string;
  timeout_ms?: number;
  max_target_bytes?: number;
  max_report_bytes?: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
}): Promise<RootfsReleaseScanRun> {
  const {
    account_id,
    browser_id,
    session_hash,
    release_id,
    host_id,
    memory_limit,
    cpu_limit,
    tmpfs_size,
  } = opts;
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await runRootfsReleaseScan({
    release_id,
    host_id,
    requested_by: account_id,
    scanner_image: opts.scanner_image,
    trivy_cache_dir: opts.trivy_cache_dir,
    timeout_ms: opts.timeout_ms,
    max_target_bytes: opts.max_target_bytes,
    max_report_bytes: opts.max_report_bytes,
    memory_limit,
    cpu_limit,
    tmpfs_size,
  });
}

export async function scanProjectRootfs(opts: {
  account_id?: string;
  project_id: string;
  scanner_image?: string;
  trivy_cache_dir?: string;
  timeout_ms?: number;
  max_target_bytes?: number;
  max_report_bytes?: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
}): Promise<RootfsProjectPreflightScanResult> {
  const { account_id, project_id, memory_limit, cpu_limit, tmpfs_size } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
  return await runProjectRootfsPreflightScan({
    project_id,
    requested_by: account_id,
    scanner_image: opts.scanner_image,
    trivy_cache_dir: opts.trivy_cache_dir,
    timeout_ms: opts.timeout_ms,
    max_target_bytes: opts.max_target_bytes,
    max_report_bytes: opts.max_report_bytes,
    memory_limit,
    cpu_limit,
    tmpfs_size,
  });
}

export async function getRootfsScanReport(opts: {
  account_id?: string;
  report_id: string;
}): Promise<RootfsReleaseScanReport> {
  const { account_id, report_id } = opts;
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const report = await getRootfsReleaseScanReport({ report_id });
  if (!report) {
    throw new Error(`RootFS scan report ${report_id} not found`);
  }
  return report;
}

async function publishQueuedLroSafe({ op }: { op: LroSummary }) {
  void publishLroSummary({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
  }).catch(() => {
    // best effort only; worker will publish later summaries
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});
}

export async function publishProjectRootfsImage(
  opts: PublishProjectRootfsBody & {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
  },
): Promise<ProjectRootfsPublishLroRef> {
  const { account_id, browser_id, session_hash, project_id, ...body } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const admin = await isAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: admin && hasRootfsAdminCatalogField(body),
  });
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
  await assertCanCreateOrUpdateRootfs({
    account_id,
    operation: "publish",
  });
  const op = await createLro({
    kind: ROOTFS_PUBLISH_LRO_KIND,
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    dedupe_key: `${ROOTFS_PUBLISH_LRO_KIND}:${project_id}`,
    input: {
      project_id,
      ...body,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function getProjectRootfsStates(opts: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const { account_id, project_id } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
  return await getProjectRootfsStates0({ project_id });
}

export async function setProjectRootfsImage(opts: {
  account_id?: string;
  project_id: string;
  image: string;
  image_id?: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const { account_id, project_id, image, image_id } = opts;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
  await assertCanSelectProjectRootfsImage({
    account_id,
    image,
    image_id,
  });
  return await setProjectRootfsImageWithRollback({
    project_id,
    image,
    image_id,
    set_by_account_id: account_id,
  });
}

export async function createImpersonationGrant({
  account_id,
  browser_id,
  session_hash,
  subject_account_id,
  reason,
  lang_temp,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  subject_account_id: string;
  reason?: string | null;
  lang_temp?: string | null;
}): Promise<{
  grant_id: string;
  subject_account_id: string;
  subject_home_bay_id: string;
  home_bay_url?: string;
  url: string;
  expires_at: Date;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const subjectAccountId = `${subject_account_id ?? ""}`.trim();
  if (!subjectAccountId) {
    throw Error("subject_account_id is required");
  }
  const session = await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  const cleanedBrowserId = `${browser_id ?? ""}`.trim();
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: subjectAccountId,
  });
  const subject_home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  const createOpts = {
    actor_account_id: account_id,
    subject_account_id: subjectAccountId,
    actor_session_hash: session.session_hash,
    subject_home_bay_id,
    actor_authenticated_at: session.authenticated_at ?? null,
    actor_password_verified_at: session.password_verified_at ?? null,
    actor_factor_verified_at: session.factor_verified_at ?? null,
    actor_fresh_auth_until: session.fresh_auth_until ?? null,
    actor_factor_level: session.factor_level ?? "none",
    reason,
    metadata: {
      created_via: "admin-ui",
      browser_id: cleanedBrowserId || undefined,
      cli_session_hash: cleanedSessionHash || undefined,
    },
  };
  let grant;
  try {
    grant =
      subject_home_bay_id === getConfiguredBayId()
        ? await (async () => {
            const localGrant = await createImpersonationGrantLocal(createOpts);
            return {
              grant_id: localGrant.id,
              subject_account_id: subjectAccountId,
              subject_home_bay_id,
              expires_at: localGrant.expire,
            };
          })()
        : await createInterBayAccountLocalClient({
            client: getInterBayFabricClient(),
            dest_bay: subject_home_bay_id,
          }).createImpersonationGrant(createOpts);
  } catch (err) {
    const mesg = err instanceof Error ? err.message : `${err}`;
    if (mesg.includes("account") && mesg.includes("not found")) {
      throw new Error(
        `cannot create impersonation grant for account ${subjectAccountId}; account directory resolved home bay '${subject_home_bay_id}', but that bay has no active local account row. The account may be deleted, not fully provisioned, or the account directory may be stale. Original error: ${mesg}`,
      );
    }
    throw err;
  }
  await upsertAccountImpersonationGrantDirectory({
    grant_id: grant.grant_id,
    subject_account_id: subjectAccountId,
    subject_home_bay_id,
    status: "pending",
    expires_at: grant.expires_at,
  });
  const home_bay_url = await getBayPublicOrigin(subject_home_bay_id);
  const seed_bay_url = await getBayPublicOrigin(
    getConfiguredClusterSeedBayId(),
  );
  const target = new URL(
    basePath === "/" ? "/auth/impersonate" : `${basePath}/auth/impersonate`,
    seed_bay_url ?? home_bay_url ?? "http://localhost",
  );
  target.searchParams.set("grant_id", grant.grant_id);
  if (`${lang_temp ?? ""}`.trim()) {
    target.searchParams.set("lang_temp", `${lang_temp}`.trim());
  }
  return {
    grant_id: grant.grant_id,
    subject_account_id: subjectAccountId,
    subject_home_bay_id,
    home_bay_url,
    url: target.toString(),
    expires_at: new Date(grant.expires_at),
  };
}

export async function userSearch({
  account_id,
  query,
  limit,
  admin,
  only_email,
}: {
  account_id?: string;
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}): Promise<UserSearchResult[]> {
  if (!account_id) {
    throw Error("You must be signed in to search for users.");
  }
  const adminSearch = !!admin;
  if (admin) {
    if (!(await isAdmin(account_id))) {
      throw Error("Must be an admin to do admin search.");
    }
  } else {
    if (limit != null && limit > 50) {
      // hard cap at 50... (for non-admin)
      limit = 50;
    }
  }
  if (adminSearch) {
    return await searchClusterAccounts({
      query,
      limit,
      admin: true,
      only_email,
    });
  }
  return await searchRelatedClusterAccounts({
    account_id,
    query,
    limit,
    only_email,
  });
}

import getEmailAddress from "@cocalc/server/accounts/get-email-address";
import { createReset } from "@cocalc/server/auth/password-reset";
export async function adminResetPasswordLink({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
}): Promise<string> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  const email = await getEmailAddress(user_account_id);
  if (!email) {
    throw Error("passwords are only defined for accounts with email");
  }
  const id = await createReset(email, "", 60 * 60 * 24); // 24 hour ttl seems reasonable for this.
  return `/auth/password-reset/${id}`;
}

export async function adminVerifyEmailAddress({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  return await adminVerifyClusterAccountEmailAddress({
    account_id: user_account_id,
  });
}

export async function adminDisableTwoFactor({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  return await adminDisableClusterAccountTwoFactor({
    account_id: user_account_id,
  });
}

export async function adminGrantAdminRole({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  reason,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  reason?: string | null;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const targetAccountId = `${user_account_id ?? ""}`.trim().toLowerCase();
  if (!targetAccountId) {
    throw Error("user_account_id is required");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  return await adminGrantClusterAccountAdminRole({
    account_id: targetAccountId,
    actor_account_id: account_id,
    reason,
    metadata: {
      created_via: "admin-ui",
      browser_id: `${browser_id ?? ""}`.trim() || undefined,
      authenticated_with_session_hash: !!`${session_hash ?? ""}`.trim(),
    },
  });
}

export async function adminRevokeAdminRole({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  reason,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  reason?: string | null;
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const targetAccountId = `${user_account_id ?? ""}`.trim().toLowerCase();
  if (!targetAccountId) {
    throw Error("user_account_id is required");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  return await adminRevokeClusterAccountAdminRole({
    account_id: targetAccountId,
    actor_account_id: account_id,
    reason,
    metadata: {
      created_via: "admin-ui",
      browser_id: `${browser_id ?? ""}`.trim() || undefined,
      authenticated_with_session_hash: !!`${session_hash ?? ""}`.trim(),
    },
  });
}

function defaultUserNameFromEmail(email: string): {
  first_name: string;
  last_name: string;
} {
  const local = (email.split("@")[0] ?? "").trim();
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { first_name: "New", last_name: "User" };
  }
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "User" };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" "),
  };
}

export async function adminCreateUser({
  account_id,
  browser_id,
  session_hash,
  email,
  password,
  first_name,
  last_name,
  tags,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  email: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  tags?: string[];
}): Promise<{
  account_id: string;
  email_address: string;
  first_name: string;
  last_name: string;
  created_by: string;
  password_generated: boolean;
  generated_password?: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });

  const emailAddress = `${email ?? ""}`.trim().toLowerCase();
  if (!is_valid_email_address(emailAddress)) {
    throw Error(`invalid email address '${email}'`);
  }
  const explicitPassword = typeof password === "string" ? password : "";
  const generatedPassword =
    explicitPassword.length > 0 ? undefined : await secureRandomString(24);
  const finalPassword =
    explicitPassword.length > 0 ? explicitPassword : generatedPassword!;
  if (!finalPassword) {
    throw Error("password must be non-empty");
  }

  const defaultName = defaultUserNameFromEmail(emailAddress);
  const firstName = `${first_name ?? ""}`.trim() || defaultName.first_name;
  const lastName = `${last_name ?? ""}`.trim() || defaultName.last_name;
  try {
    const created = await createClusterAccount({
      account_id: uuid(),
      email_address: emailAddress,
      password: finalPassword,
      first_name: firstName,
      last_name: lastName,
      home_bay_id: getConfiguredBayId(),
      owner_id: account_id,
      tags: Array.isArray(tags) && tags.length ? tags : undefined,
      signup_reason: "Admin created account",
    });
    return {
      account_id: created.account_id,
      email_address: emailAddress,
      first_name: firstName,
      last_name: lastName,
      created_by: account_id,
      password_generated: !!generatedPassword,
      generated_password: generatedPassword,
    };
  } catch (err: any) {
    if (err?.code === "23505") {
      throw Error(`an account with email '${emailAddress}' already exists`);
    }
    throw err;
  }
}

export async function deleteAccount({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  only_if_tag,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  only_if_tag?: string;
}): Promise<{
  account_id: string;
  home_bay_id: string;
  status: "deleted";
}> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const targetAccountId = `${user_account_id ?? ""}`.trim();
  if (!targetAccountId) {
    throw Error("user_account_id is required");
  }
  if (targetAccountId !== account_id && !(await isAdmin(account_id))) {
    throw Error("must be an admin to delete another account");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: targetAccountId !== account_id,
    allow_actor_impersonation: false,
  });
  return await deleteClusterAccount({
    account_id: targetAccountId,
    only_if_tag: `${only_if_tag ?? ""}`.trim() || undefined,
  });
}

export async function rehomeAccount({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}) {
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await rehomeAccountInternal({
    account_id,
    target_account_id: user_account_id,
    dest_bay_id,
    reason,
    campaign_id,
  });
}

export async function getAccountRehomeOperation({
  account_id,
  op_id,
  source_bay_id,
}: {
  account_id?: string;
  op_id: string;
  source_bay_id?: string;
}) {
  return (
    (await getAccountRehomeOperationForOperator({
      account_id,
      op_id,
      source_bay_id,
    })) ?? null
  );
}

export async function reconcileAccountRehome({
  account_id,
  browser_id,
  session_hash,
  op_id,
  source_bay_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  op_id: string;
  source_bay_id?: string;
}) {
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await reconcileAccountRehomeInternal({
    account_id,
    op_id,
    source_bay_id,
  });
}

export async function drainAccountRehome({
  account_id,
  browser_id,
  session_hash,
  source_bay_id,
  dest_bay_id,
  limit,
  dry_run,
  campaign_id,
  reason,
  only_if_tag,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  source_bay_id?: string;
  dest_bay_id: string;
  limit?: number;
  dry_run?: boolean;
  campaign_id?: string | null;
  reason?: string | null;
  only_if_tag?: string | null;
}) {
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await drainAccountRehomeInternal({
    account_id,
    source_bay_id,
    dest_bay_id,
    limit,
    dry_run,
    campaign_id,
    reason,
    only_if_tag,
  });
}

export async function repairAccountMembershipPortability({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  dry_run,
  clear_stale,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  dry_run?: boolean;
  clear_stale?: boolean;
}) {
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await repairAccountMembershipPortabilityInternal({
    account_id,
    target_account_id: user_account_id,
    dry_run,
    clear_stale,
  });
}

import sendEmailVerification0 from "@cocalc/server/accounts/send-email-verification";
import {
  sendTestEmail as sendTestEmail0,
  type TestEmailResult,
  type TestEmailMode,
} from "@cocalc/server/email/test-email";
import { getEmailLaneDiagnostic } from "@cocalc/server/email/send-email";
import type { EmailLane } from "@cocalc/util/notification-email";

export async function sendTestEmail({
  account_id,
  lane,
  mode,
}: {
  account_id?: string;
  lane?: EmailLane;
  mode?: TestEmailMode;
}): Promise<TestEmailResult> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await sendTestEmail0({ account_id, lane, mode });
}

export async function sendEmailVerification({
  account_id,
  only_verify,
}: {
  account_id?: string;
  only_verify?: boolean;
}): Promise<void> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const resp = await sendEmailVerification0(account_id, only_verify);
  if (resp) {
    let diagnostic = "";
    try {
      diagnostic = await getEmailLaneDiagnostic("critical");
    } catch (_) {
      // Preserve the original verification error if diagnostic collection fails.
    }
    throw Error(diagnostic ? `${resp} (${diagnostic})` : resp);
  }
}

import { delete_passport } from "@cocalc/server/auth/sso/delete-passport";
export async function deletePassport(opts: {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
  strategy: string;
  id: string;
}): Promise<void> {
  await requireDangerousSessionAuth({
    account_id: opts.account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: true,
  });
  await delete_passport(db(), opts);
}

export async function getAdminAssignedMembership({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id: string;
}): Promise<AdminAssignedMembershipRow | undefined> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const client = await getAdminAssignedMembershipHomeClient({
    account_id,
    user_account_id,
  });
  return client
    ? await client.getAdminAssignedMembership({ account_id: user_account_id })
    : await getAdminAssignedMembershipLocal(user_account_id);
}

export async function setAdminAssignedMembership({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  membership_class,
  expires_at,
  notes,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  membership_class: string;
  expires_at?: Date | null;
  notes?: string | null;
}): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const client = await getAdminAssignedMembershipHomeClient({
    account_id,
    user_account_id,
  });
  if (client) {
    await client.setAdminAssignedMembership({
      account_id: user_account_id,
      actor_account_id: account_id,
      membership_class,
      expires_at,
      notes,
    });
    return;
  }
  await setAdminAssignedMembershipLocal({
    account_id: user_account_id,
    actor_account_id: account_id,
    membership_class,
    expires_at,
    notes,
  });
}

export async function clearAdminAssignedMembership({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
}): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const client = await getAdminAssignedMembershipHomeClient({
    account_id,
    user_account_id,
  });
  if (client) {
    await client.clearAdminAssignedMembership({
      account_id: user_account_id,
      actor_account_id: account_id,
    });
    return;
  }
  await clearAdminAssignedMembershipLocal({
    account_id: user_account_id,
  });
}

async function getAdminAssignedMembershipHomeClient({
  account_id,
  user_account_id,
}: {
  account_id: string;
  user_account_id: string;
}) {
  const location = await resolveAccountHomeBay({ account_id, user_account_id });
  const homeBayId =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (homeBayId === getConfiguredBayId()) {
    return undefined;
  }
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  });
}

async function getAccountEntitlementOverrideHomeClient({
  account_id,
  user_account_id,
}: {
  account_id: string;
  user_account_id: string;
}) {
  const location = await resolveAccountHomeBay({ account_id, user_account_id });
  const homeBayId =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (homeBayId === getConfiguredBayId()) {
    return undefined;
  }
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  });
}

export async function getAccountEntitlementOverride({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id: string;
}): Promise<AccountEntitlementOverride | undefined> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const client = await getAccountEntitlementOverrideHomeClient({
    account_id,
    user_account_id,
  });
  return client
    ? await client.getAccountEntitlementOverride({
        account_id: user_account_id,
      })
    : await getAccountEntitlementOverrideLocal(user_account_id);
}

export async function setAccountEntitlementOverride({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  override,
  reason,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  override: AccountEntitlementOverrideInput;
  reason: string;
}): Promise<AccountEntitlementOverride> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const client = await getAccountEntitlementOverrideHomeClient({
    account_id,
    user_account_id,
  });
  return client
    ? await client.setAccountEntitlementOverride({
        account_id: user_account_id,
        actor_account_id: account_id,
        override,
        reason,
      })
    : await setAccountEntitlementOverrideLocal({
        account_id: user_account_id,
        actor_account_id: account_id,
        override,
        reason,
      });
}

export async function clearAccountEntitlementOverride({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  reason,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  user_account_id: string;
  reason: string;
}): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const client = await getAccountEntitlementOverrideHomeClient({
    account_id,
    user_account_id,
  });
  if (client) {
    await client.clearAccountEntitlementOverride({
      account_id: user_account_id,
      actor_account_id: account_id,
      reason,
    });
    return;
  }
  await clearAccountEntitlementOverrideLocal({
    account_id: user_account_id,
    actor_account_id: account_id,
    reason,
  });
}

import { sync as salesloftSync } from "@cocalc/server/salesloft/sync";
export async function adminSalesloftSync({
  account_id,
  account_ids,
}: {
  account_id?: string;
  account_ids: string[];
}) {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  (async () => {
    // we do not block on this
    try {
      await salesloftSync(account_ids);
    } catch (err) {
      logger.debug(`WARNING: issue syncing with salesloft -- ${err}`, {
        account_ids,
      });
    }
  })();
}

// user can sync themself with salesloft.
export const userSalesloftSync = reuseInFlight(
  async ({ account_id }: { account_id?: string }): Promise<void> => {
    if (account_id) {
      await salesloftSync([account_id]);
    }
  },
);

function parseMap(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const key in parsed) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function resolveSharedHomeMode():
  | "disabled"
  | "fallback"
  | "prefer"
  | "always" {
  const defaultMode =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad"
      ? "disabled"
      : "fallback";
  const mode =
    `${process.env.COCALC_CODEX_AUTH_SHARED_HOME_MODE ?? defaultMode}`
      .trim()
      .toLowerCase();
  if (mode === "disabled") return "disabled";
  if (mode === "prefer" || mode === "always") return mode;
  return "fallback";
}

const CODEX_SUBSCRIPTION_KIND = "codex-subscription-auth-json";
const OPENAI_API_KEY_KIND = "openai-api-key";

function toExternalCredentialInfo(
  credential:
    | Awaited<ReturnType<typeof getExternalCredentialRouted>>
    | undefined,
) {
  if (!credential) return undefined;
  return {
    id: credential.id,
    provider: credential.provider,
    kind: credential.kind,
    scope: credential.scope,
    owner_account_id: credential.owner_account_id,
    project_id: credential.project_id,
    organization_id: credential.organization_id,
    metadata: credential.metadata,
    created: credential.created,
    updated: credential.updated,
    revoked: credential.revoked,
    last_used: credential.last_used,
  };
}

async function assertProjectCollaborator(
  account_id: string,
  project_id: string,
): Promise<void> {
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
}

export async function listExternalCredentials({
  account_id,
  provider,
  kind,
  scope,
  include_revoked,
}: {
  account_id?: string;
  provider?: string;
  kind?: string;
  scope?: string;
  include_revoked?: boolean;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return await listAccountExternalCredentialsRouted({
    owner_account_id: account_id,
    provider,
    kind,
    scope: scope as any,
    includeRevoked: !!include_revoked,
  });
}

export async function revokeExternalCredential({
  account_id,
  browser_id,
  session_hash,
  id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  id: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (!id) {
    throw Error("id must be specified");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: false,
  });
  const revoked = await revokeAccountExternalCredentialRouted({
    id,
    owner_account_id: account_id,
  });
  return { revoked };
}

export async function setOpenAiApiKey({
  account_id,
  browser_id,
  session_hash,
  api_key,
  project_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  api_key: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const key = `${api_key ?? ""}`.trim();
  if (!key) {
    throw Error("api_key must not be empty");
  }

  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor: false,
    });
    const result = await upsertExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id,
      },
      payload: key,
      metadata: {
        source: "account-settings",
        actor_account_id: account_id,
      },
    });
    return { ...result, scope: "project" as const, project_id };
  }

  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: false,
  });
  const result = await upsertExternalCredentialRouted({
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: account_id,
    },
    payload: key,
    metadata: {
      source: "account-settings",
      actor_account_id: account_id,
    },
  });
  return { ...result, scope: "account" as const };
}

export async function deleteOpenAiApiKey({
  account_id,
  browser_id,
  session_hash,
  project_id,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }

  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
    const existing = await getExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id,
      },
      touchLastUsed: false,
    });
    if (!existing) {
      return { revoked: false, scope: "project" as const, project_id };
    }
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor: false,
    });
    const revoked = await revokeExternalCredentialBySelectorRouted({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id,
      },
    });
    return { revoked, scope: "project" as const, project_id };
  }

  const existing = await getExternalCredentialRouted({
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: account_id,
    },
    touchLastUsed: false,
  });
  if (!existing) {
    return { revoked: false, scope: "account" as const };
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: false,
  });
  const revoked = await revokeAccountExternalCredentialRouted({
    id: existing.id,
    owner_account_id: account_id,
  });
  return { revoked, scope: "account" as const };
}

export async function getOpenAiApiKeyStatus({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
  }

  const [accountCredential, projectCredential] = await Promise.all([
    getExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "account",
        owner_account_id: account_id,
      },
      touchLastUsed: false,
    }),
    project_id
      ? getExternalCredentialRouted({
          selector: {
            provider: "openai",
            kind: OPENAI_API_KEY_KIND,
            scope: "project",
            project_id,
          },
          touchLastUsed: false,
        })
      : Promise.resolve(undefined),
  ]);

  return {
    account: toExternalCredentialInfo(accountCredential),
    project: toExternalCredentialInfo(projectCredential),
    project_id,
  };
}

export async function getCodexPaymentSource({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const projectKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEYS_JSON,
  );
  const accountKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON,
  );
  if (project_id) {
    await assertProjectCollaborator(account_id, project_id);
  }

  const settings = await getServerSettings();
  const hasSiteApiKey =
    to_bool(settings.openai_enabled) &&
    !(await isAiLaunchDisabled()) &&
    !!`${settings.openai_api_key ?? ""}`.trim();
  const [hasSubscription, hasProjectApiKeyStored, hasAccountApiKeyStored] =
    await Promise.all([
      hasExternalCredentialRouted({
        selector: {
          provider: "openai",
          kind: CODEX_SUBSCRIPTION_KIND,
          scope: "account",
          owner_account_id: account_id,
        },
      }),
      project_id
        ? hasExternalCredentialRouted({
            selector: {
              provider: "openai",
              kind: OPENAI_API_KEY_KIND,
              scope: "project",
              project_id,
            },
          })
        : Promise.resolve(false),
      hasExternalCredentialRouted({
        selector: {
          provider: "openai",
          kind: OPENAI_API_KEY_KIND,
          scope: "account",
          owner_account_id: account_id,
        },
      }),
    ]);

  const hasProjectApiKey =
    hasProjectApiKeyStored ||
    !!(project_id && projectKeys[project_id]) ||
    !!(project_id && process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY);
  const hasAccountApiKey =
    hasAccountApiKeyStored ||
    !!accountKeys[account_id] ||
    !!process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY;
  const sharedHomeMode = resolveSharedHomeMode();

  let source:
    | "subscription"
    | "project-api-key"
    | "account-api-key"
    | "site-api-key"
    | "shared-home"
    | "none";
  if (hasSubscription) {
    source = "subscription";
  } else if (hasProjectApiKey) {
    source = "project-api-key";
  } else if (hasAccountApiKey) {
    source = "account-api-key";
  } else if (hasSiteApiKey) {
    source = "site-api-key";
  } else if (sharedHomeMode === "always") {
    source = "shared-home";
  } else {
    source = "none";
  }

  return {
    source,
    hasSubscription,
    hasProjectApiKey,
    hasAccountApiKey,
    hasSiteApiKey,
    sharedHomeMode,
    project_id,
  };
}

export async function upsertBrowserSession({
  account_id,
  browser_id,
  session_name,
  url,
  spawn_marker,
  active_project_id,
  open_projects,
}: {
  account_id?: string;
  browser_id: string;
  session_name?: string;
  url?: string;
  spawn_marker?: string;
  active_project_id?: string;
  open_projects?: unknown;
}): Promise<{ browser_id: string; created_at: string; updated_at: string }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  await touchAccountActivity(account_id);
  return upsertBrowserSessionRecord({
    account_id,
    browser_id,
    session_name,
    url,
    spawn_marker,
    active_project_id,
    open_projects,
  });
}

export async function listBrowserSessions({
  account_id,
  max_age_ms,
  include_stale,
}: {
  account_id?: string;
  max_age_ms?: number;
  include_stale?: boolean;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const live_by_browser_id = await getLiveBrowserSessionInfo(account_id);
  return listBrowserSessionsForAccount({
    account_id,
    max_age_ms,
    include_stale,
    live_by_browser_id,
  });
}

export async function removeBrowserSession({
  account_id,
  browser_id,
}: {
  account_id?: string;
  browser_id: string;
}): Promise<{ removed: boolean }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  return {
    removed: removeBrowserSessionRecord({
      account_id,
      browser_id,
    }),
  };
}

export async function issueBrowserSignInCookie({
  account_id,
  browser_id,
  session_hash,
  max_age_ms,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  max_age_ms?: number;
}) {
  if (!account_id) {
    throw Error("must be signed in");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
  });
  const cleanMaxAgeMs = Number(max_age_ms);
  const resolvedMaxAgeMs =
    Number.isFinite(cleanMaxAgeMs) && cleanMaxAgeMs > 0
      ? Math.min(
          DEFAULT_BROWSER_SIGN_IN_COOKIE_MAX_AGE_MS,
          Math.floor(cleanMaxAgeMs),
        )
      : DEFAULT_BROWSER_SIGN_IN_COOKIE_MAX_AGE_MS;
  const { value, hash, expire } = await createRememberMeCookie(
    account_id,
    Math.max(60, Math.floor(resolvedMaxAgeMs / 1000)),
  );
  await recordNewAuthSession({
    account_id,
    session_hash: hash,
    expire,
    authenticated_at: new Date(),
    password_verified_at: new Date(),
    factor_level: "none",
    fresh_auth_until: null,
    metadata: { issued_by: "issueBrowserSignInCookie" },
  });
  return {
    account_id,
    remember_me: value,
    max_age_ms: resolvedMaxAgeMs,
  };
}

async function resolveProjectContext(opts: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
}): Promise<string> {
  const project_id = `${opts.project_id ?? ""}`.trim();
  if (!project_id) {
    throw Error("project_id is required");
  }
  if (opts.account_id) {
    await assertProjectCollaborator(opts.account_id, project_id);
  }
  if (opts.host_id) {
    let assigned = "";
    try {
      assigned = (await getAssignedProjectHostInfo(project_id)).host_id;
    } catch {
      assigned = "";
    }
    if (!assigned || assigned !== opts.host_id) {
      throw Error("project is not assigned to this host");
    }
  }
  return project_id;
}

async function getProjectOwnerAccountIds(
  project_id: string,
): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ account_id: string }>(
    `
      SELECT owner.key AS account_id
      FROM projects,
           jsonb_each(projects.users) AS owner(key, value)
      WHERE projects.project_id=$1
        AND owner.value ->> 'group' = 'owner'
      ORDER BY owner.key
    `,
    [project_id],
  );
  return rows.map((row) => `${row.account_id ?? ""}`.trim()).filter(Boolean);
}

export async function assertProjectPublicSharingAllowed({
  account_id,
  host_id,
  project_id,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
}): Promise<{
  allowed: true;
  project_id: string;
  checked_account_ids: string[];
}> {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  const action = "publicly share project content";
  if (account_id) {
    await assertAccountTrustedForProductAccess(account_id, action);
    return {
      allowed: true,
      project_id: resolvedProjectId,
      checked_account_ids: [account_id],
    };
  }
  const ownerAccountIds = await getProjectOwnerAccountIds(resolvedProjectId);
  if (ownerAccountIds.length === 0) {
    throw new Error("project has no owner account");
  }
  for (const ownerAccountId of ownerAccountIds) {
    await assertAccountTrustedForProductAccess(ownerAccountId, action);
  }
  return {
    allowed: true,
    project_id: resolvedProjectId,
    checked_account_ids: ownerAccountIds,
  };
}

export async function getProjectAppPublicPolicy({
  account_id,
  host_id,
  project_id,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  return await getProjectAppPublicPolicyRaw(resolvedProjectId);
}

export async function tracePublicAppHostname({
  account_id,
  host_id,
  hostname,
}: {
  account_id?: string;
  host_id?: string;
  hostname: string;
}) {
  const normalized = `${hostname ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    throw Error("hostname is required");
  }
  const target = await getPublicAppRouteByHostnameRaw(normalized);
  if (!target) {
    return {
      matched: false,
      hostname: normalized,
    };
  }
  if (!account_id && !host_id) {
    throw Error("must be signed in");
  }
  if (account_id) {
    await assertProjectCollaborator(account_id, target.project_id);
  }
  if (host_id) {
    await resolveProjectContext({ host_id, project_id: target.project_id });
  }
  const policy = await getProjectAppPublicPolicyRaw(target.project_id);
  const dnsTargetHostname = policy.host_hostname;
  const dns_target =
    dnsTargetHostname != null
      ? await resolvePublicAppDnsTarget(dnsTargetHostname)
      : undefined;
  return {
    matched: true,
    hostname: normalized,
    project_id: target.project_id,
    app_id: target.app_id,
    base_path: target.base_path,
    site_hostname: policy.site_hostname,
    host_hostname: policy.host_hostname,
    dns_domain: policy.dns_domain,
    subdomain_suffix: policy.subdomain_suffix,
    dns_target,
    metered_egress: policy.metered_egress,
    warnings: policy.warnings,
  };
}

export async function reserveProjectAppPublicSubdomain({
  account_id,
  host_id,
  project_id,
  app_id,
  base_path,
  ttl_s,
  preferred_label,
  random_subdomain,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  app_id: string;
  base_path: string;
  ttl_s: number;
  preferred_label?: string;
  random_subdomain?: boolean;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  await assertProjectPublicSharingAllowed({
    account_id,
    host_id,
    project_id: resolvedProjectId,
  });
  return await reserveProjectAppPublicSubdomainRaw({
    project_id: resolvedProjectId,
    app_id,
    base_path,
    ttl_s,
    preferred_label,
    random_subdomain,
  });
}

export async function releaseProjectAppPublicSubdomain({
  account_id,
  host_id,
  project_id,
  app_id,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  app_id: string;
}) {
  const resolvedProjectId = await resolveProjectContext({
    account_id,
    host_id,
    project_id,
  });
  return await releaseProjectAppPublicSubdomainRaw({
    project_id: resolvedProjectId,
    app_id,
  });
}

export async function recordManagedProjectEgress({
  account_id,
  host_id,
  project_id,
  category,
  bytes,
  metadata,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  category:
    | "file-download"
    | "http-proxy"
    | "ws-proxy"
    | "ssh"
    | "interactive-conat"
    | "raw-network"
    | "backup-upload";
  bytes: number;
  metadata?: Record<string, unknown>;
}) {
  const resolvedProjectId = `${project_id ?? ""}`.trim()
    ? await resolveProjectContext({
        account_id,
        host_id,
        project_id,
      })
    : undefined;
  if (!resolvedProjectId && !`${account_id ?? ""}`.trim()) {
    throw Error("project_id or account_id is required");
  }
  return await recordManagedProjectEgressRaw({
    account_id,
    project_id: resolvedProjectId,
    category,
    bytes,
    metadata,
  });
}

export async function recordManagedProjectCpuUsage({
  account_id,
  host_id,
  project_id,
  cpu_seconds,
  sample_started_at,
  sample_ended_at,
  source,
  metadata,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  cpu_seconds: number;
  sample_started_at?: Date;
  sample_ended_at?: Date;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const resolvedProjectId = `${project_id ?? ""}`.trim()
    ? await resolveProjectContext({
        account_id,
        host_id,
        project_id,
      })
    : undefined;
  if (!resolvedProjectId && !`${account_id ?? ""}`.trim()) {
    throw Error("project_id or account_id is required");
  }
  return await recordManagedProjectCpuUsageRaw({
    account_id,
    project_id: resolvedProjectId,
    host_id,
    cpu_seconds,
    sample_started_at,
    sample_ended_at,
    source,
    metadata,
  });
}

export async function getManagedProjectEgressPolicy({
  account_id,
  host_id,
  project_id,
  category,
}: {
  account_id?: string;
  host_id?: string;
  project_id?: string;
  category:
    | "file-download"
    | "http-proxy"
    | "ws-proxy"
    | "ssh"
    | "interactive-conat"
    | "raw-network"
    | "backup-upload";
}) {
  const resolvedProjectId = `${project_id ?? ""}`.trim()
    ? await resolveProjectContext({
        account_id,
        host_id,
        project_id,
      })
    : undefined;
  if (!resolvedProjectId && !`${account_id ?? ""}`.trim()) {
    throw Error("project_id or account_id is required");
  }
  return await getManagedProjectEgressPolicyRaw({
    account_id,
    project_id: resolvedProjectId,
    category,
  });
}

export async function resolveManagedProjectSshKeyAccount({
  account_id,
  project_id,
  fingerprint,
}: {
  account_id?: string;
  project_id: string;
  fingerprint: string;
}): Promise<{ account_id?: string }> {
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });
  const keys = await sshKeys(project_id);
  const resolved_account_id = keys[fingerprint]?.account_id;
  return resolved_account_id ? { account_id: resolved_account_id } : {};
}

export async function getPublicSiteUrl({
  account_id,
}: {
  account_id?: string;
}): Promise<{ url: string }> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const { dns } = await getServerSettings();
  let url = `${dns ?? ""}`.trim();
  if (!url) {
    throw Error("public site URL is not configured");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  if (basePath?.length) {
    url = `${url.replace(/\/+$/, "")}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
  }
  return { url: url.replace(/\/+$/, "") };
}

function clean(v?: string): string | undefined {
  const s = `${v ?? ""}`.trim();
  return s.length > 0 ? s : undefined;
}

export async function testR2Credentials({
  account_id,
  overrides,
}: {
  account_id?: string;
  overrides?: {
    r2_account_id?: string;
    r2_api_token?: string;
    r2_access_key_id?: string;
    r2_secret_access_key?: string;
    r2_bucket_prefix?: string;
    r2_endpoint?: string;
  };
}): Promise<R2CredentialsTestResult> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  const settings = await getServerSettings();
  const accountId =
    clean(overrides?.r2_account_id) ??
    clean(settings.r2_account_id) ??
    clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const endpoint =
    clean(overrides?.r2_endpoint) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  return await testR2Credentials0({
    accountId,
    apiToken: clean(overrides?.r2_api_token) ?? clean(settings.r2_api_token),
    accessKey:
      clean(overrides?.r2_access_key_id) ?? clean(settings.r2_access_key_id),
    secretKey:
      clean(overrides?.r2_secret_access_key) ??
      clean(settings.r2_secret_access_key),
    bucketPrefix:
      clean(overrides?.r2_bucket_prefix) ?? clean(settings.r2_bucket_prefix),
    endpoint,
  });
}

export async function bootstrapCloudflareConfiguration({
  account_id,
  browser_id,
  session_hash,
  domain,
  token,
  tunnelPrefix,
  hostSuffix,
  r2BucketPrefix,
  invalidateBootstrapToken,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  domain: string;
  token: string;
  tunnelPrefix?: string;
  hostSuffix?: string;
  r2BucketPrefix?: string;
  invalidateBootstrapToken?: boolean;
}): Promise<CloudflareBootstrapResult> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await bootstrapCloudflareConfiguration0({
    domain,
    token,
    tunnelPrefix,
    hostSuffix,
    r2BucketPrefix,
    invalidateBootstrapToken,
  });
}

export async function applyCloudflareTunnelSettings({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}): Promise<CloudflareTunnelApplyResult> {
  await assertAdmin(account_id);
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  return await applyLaunchpadCloudflareTunnelSettings();
}

export async function createCloudflareTeardownPlan({
  account_id,
  include_r2,
}: {
  account_id?: string;
  include_r2?: boolean;
}): Promise<CloudflareTeardownPlan> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await createCloudflareTeardownPlan0({
    account_id,
    include_r2,
  });
}

export async function getCloudflareTeardownPlan({
  account_id,
  plan_id,
}: {
  account_id?: string;
  plan_id: string;
}): Promise<CloudflareTeardownPlan> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getCloudflareTeardownPlan0({ account_id, plan_id });
}

export async function startCloudflareTeardownApply({
  account_id,
  browser_id,
  session_hash,
  plan_id,
  confirm,
  delete_r2_contents,
  reset_local_settings,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string;
  plan_id: string;
  confirm: string;
  delete_r2_contents?: boolean;
  reset_local_settings?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const op = await createLro({
    kind: CLOUDFLARE_TEARDOWN_APPLY_LRO_KIND,
    scope_type: "account",
    scope_id: account_id,
    created_by: account_id,
    routing: "hub",
    input: {
      plan_id,
      confirm,
      delete_r2_contents: !!delete_r2_contents,
      reset_local_settings: !!reset_local_settings,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  void runCloudflareTeardownApplyLro({
    op_id: op.op_id,
    account_id,
    plan_id,
    confirm,
    delete_r2_contents,
    reset_local_settings,
  }).catch((err) =>
    logger.warn("failed to run Cloudflare teardown apply LRO", {
      op_id: op.op_id,
      err,
    }),
  );
  return {
    op_id: op.op_id,
    scope_type: "account",
    scope_id: account_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function getCloudflareR2Usage({
  account_id,
  all_buckets,
  scan,
  refresh,
  max_age_minutes,
}: {
  account_id?: string;
  all_buckets?: boolean;
  scan?: boolean;
  refresh?: boolean;
  max_age_minutes?: number;
}): Promise<CloudflareR2UsageResult> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getCloudflareR2Usage0({
    all_buckets,
    scan,
    refresh,
    max_age_minutes,
  });
}

export async function auditCloudflareR2Bucket({
  account_id,
  bucket,
  prefix,
  refresh,
  max_age_minutes,
}: {
  account_id?: string;
  bucket: string;
  prefix?: string;
  refresh?: boolean;
  max_age_minutes?: number;
}): Promise<CloudflareR2AuditResult> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await auditCloudflareR2Bucket0({
    bucket,
    prefix,
    refresh,
    max_age_minutes,
  });
}

const CLOUDFLARE_R2_AUDIT_LRO_KIND = "cloudflare-r2-audit";
const CLOUDFLARE_R2_BAY_BACKUP_CLEANUP_LRO_KIND =
  "cloudflare-r2-bay-backup-cleanup";
const CLOUDFLARE_TEARDOWN_APPLY_LRO_KIND = "cloudflare-teardown-apply";

export async function startCloudflareR2Audit({
  account_id,
  browser_id,
  session_hash,
  bucket,
  prefix,
  refresh,
  max_age_minutes,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  bucket: string;
  prefix?: string;
  refresh?: boolean;
  max_age_minutes?: number;
}): Promise<{
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const op = await createLro({
    kind: CLOUDFLARE_R2_AUDIT_LRO_KIND,
    scope_type: "account",
    scope_id: account_id,
    created_by: account_id,
    routing: "hub",
    input: {
      bucket,
      prefix,
      refresh: !!refresh,
      max_age_minutes,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  void runCloudflareR2AuditLro({
    op_id: op.op_id,
    bucket,
    prefix,
    refresh,
    max_age_minutes,
  }).catch((err) =>
    logger.warn("failed to run Cloudflare R2 audit LRO", {
      op_id: op.op_id,
      err,
    }),
  );
  return {
    op_id: op.op_id,
    scope_type: "account",
    scope_id: account_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function getCloudflareR2BayBackupCleanupPlan({
  account_id,
  bucket,
  prefix,
}: {
  account_id?: string;
  bucket: string;
  prefix?: string;
}): Promise<CloudflareR2BayBackupCleanupPlan> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getCloudflareR2BayBackupCleanupPlan0({ bucket, prefix });
}

export async function startCloudflareR2BayBackupCleanup({
  account_id,
  browser_id,
  session_hash,
  bucket,
  prefix,
  confirm,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  bucket: string;
  prefix?: string;
  confirm: string;
}): Promise<{
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await requireDangerousSessionAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor: true,
  });
  const op = await createLro({
    kind: CLOUDFLARE_R2_BAY_BACKUP_CLEANUP_LRO_KIND,
    scope_type: "account",
    scope_id: account_id,
    created_by: account_id,
    routing: "hub",
    input: {
      bucket,
      prefix,
      confirm,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  void runCloudflareR2BayBackupCleanupLro({
    op_id: op.op_id,
    bucket,
    prefix,
    confirm,
  }).catch((err) =>
    logger.warn("failed to run Cloudflare R2 bay backup cleanup LRO", {
      op_id: op.op_id,
      err,
    }),
  );
  return {
    op_id: op.op_id,
    scope_type: "account",
    scope_id: account_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function createProviderSetupChallenge({
  account_id,
  provider,
}: {
  account_id?: string;
  provider: ProviderSetupChallengeProvider;
}): Promise<ProviderSetupChallenge & { token: string }> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await createProviderSetupChallenge0({ account_id, provider });
}

export async function getProviderSetupChallenge({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<ProviderSetupChallenge> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getProviderSetupChallenge0({ account_id, id });
}

export async function clearProviderSetupChallenge({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<{ deleted: boolean }> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await clearProviderSetupChallenge0({ account_id, id });
}
