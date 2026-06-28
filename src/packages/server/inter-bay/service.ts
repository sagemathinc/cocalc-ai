/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAuthTokenHandlers,
  createInterBayAccountProjectFeedHandlers,
  createInterBayAccountNotificationFeedHandlers,
  createInterBayBayOpsHandlers,
  createInterBayBayRegistryHandlers,
  createInterBayAccountDirectoryHandlers,
  createInterBayAccountLocalHandler,
  createInterBayAccountLocalClient,
  createInterBayProjectCollabInviteHandlers,
  createInterBayProjectDetailsHandler,
  createInterBayProjectSecretsHandlers,
  createInterBayExternalCredentialsHandlers,
  createInterBayHostConnectionHandler,
  createInterBayHostControlHandler,
  createInterBayProjectHostAuthTokenHandler,
  createInterBayProjectControlAddressHandler,
  createInterBayProjectControlActiveOpHandler,
  createInterBayProjectControlBackupHandler,
  createInterBayProjectControlCheckStartAdmissionHandler,
  createInterBayBayDirectoryHandlers,
  createInterBayDirectoryHandlers,
  createInterBayProjectControlHandler,
  createInterBayProjectControlAcceptRehomeHandler,
  createInterBayProjectControlSetUsageAccountHandler,
  createInterBayProjectControlAssignHostHandler,
  createInterBayProjectControlMoveHandler,
  createInterBayProjectControlRehomeHandler,
  createInterBayProjectControlRestartHandler,
  createInterBayProjectControlStateHandler,
  createInterBayProjectLroHandler,
  createInterBayProjectReferenceHandler,
  createInterBayProjectControlStopHandler,
  type InterBayAuthTokenApi,
  type InterBayAccountProjectFeedApi,
  type InterBayAccountNotificationFeedApi,
  type InterBayBayOpsApi,
  type InterBayBayRegistryApi,
  type InterBayAccountDirectoryApi,
  type InterBayAccountLocalApi,
  type InterBayDirectoryApi,
  type InterBayProjectCollabInviteApi,
  type InterBayProjectDetailsApi,
  type InterBayProjectSecretsApi,
  type InterBayExternalCredentialsApi,
  type InterBayHostConnectionApi,
  type InterBayHostControlApi,
  type InterBayProjectHostAuthTokenApi,
  type InterBayProjectControlApi,
  type InterBayProjectLroApi,
  type InterBayProjectReferenceApi,
} from "@cocalc/conat/inter-bay/api";
import type { ConatService } from "@cocalc/conat/service/typed";
import type { SiteLicenseAffiliationReverificationSeat } from "@cocalc/conat/hub/api/purchases";
import getLogger from "@cocalc/backend/logger";
import { db } from "@cocalc/database";
import { callback2 } from "@cocalc/util/async-utils";
import { getRequiresTokensDirect } from "@cocalc/server/auth/tokens/get-requires-token";
import {
  deleteRegistrationTokenDirect,
  disableRegistrationTokenDirect,
  redeemRegistrationTokenDirect,
  validateRegistrationTokenDirect,
} from "@cocalc/server/auth/tokens/redeem";
import { verifyLocalSignInPassword } from "@cocalc/server/auth/verify-sign-in-password";
import { redeemVerifyEmailLocal } from "@cocalc/server/auth/redeem-verify-email";
import {
  createResetLocal as createPasswordResetLocal,
  recentAttemptsLocal as recentPasswordResetAttemptsLocal,
  redeemResetLocal as redeemPasswordResetLocal,
} from "@cocalc/server/auth/password-reset";
import adminVerifyEmailAddressLocal from "@cocalc/server/accounts/admin-verify-email-address";
import sendEmailVerificationLocal from "@cocalc/server/accounts/send-email-verification";
import {
  grantAdminRole as grantAdminRoleLocal,
  revokeAdminRole as revokeAdminRoleLocal,
} from "@cocalc/server/accounts/admin-role";
import setPasswordFromResetLocal from "@cocalc/server/accounts/set-password-from-reset";
import { adminDisableTwoFactor as adminDisableTwoFactorLocal } from "@cocalc/server/auth/two-factor";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";
import {
  listBayRegistryLocal,
  registerBayPresenceLocal,
  startBayRegistrationHeartbeat,
} from "@cocalc/server/bay-registry";
import { runBayDrainPreflight } from "@cocalc/server/bay-drain/preflight";
import { startManagedBayCloudflared } from "@cocalc/server/bay-cloudflared";
import {
  applyAccountProjectFeedRemoveOnHomeBay,
  applyAccountProjectFeedUpsertOnHomeBay,
} from "@cocalc/server/account/project-feed";
import {
  createClusterAccount,
  createLocalCliLoginSession,
  deleteClusterAccountApiKeyDirectoryEntry,
  deleteClusterAccount,
  deleteLocalClusterAccount,
  getClusterAccountApiKeyByKeyId,
  getClusterBanEquivalentEmailAccounts,
  getClusterAccountByEmail,
  getClusterAccountById,
  getClusterAccountHomeBayCounts,
  getClusterAccountsByIds,
  provisionLocalClusterAccount,
  searchClusterAccounts,
  setLocalClusterAccountBan,
  quarantineLocalClusterAccountBillingResources,
  touchClusterAccountApiKeyDirectoryEntry,
  touchClusterAccountDirectoryEntry,
  updateClusterAccountBanned,
  updateClusterAccountEmailAddress,
  updateClusterAccountApiKeysHomeBay,
  updateClusterAccountHomeBay,
  upsertClusterAccountApiKeyDirectoryEntry,
} from "@cocalc/server/inter-bay/accounts";
import { updateClusterAccountEmailAddressVerified } from "@cocalc/server/inter-bay/account-directory-updates";
import isAdmin from "@cocalc/server/accounts/is-admin";
import {
  acceptAccountRehome,
  copyAccountRehomeState,
  getMembershipPortableState,
  getAccountRehomeOperation,
  replaceMembershipPortableState,
  reconcileAccountRehomeOnSource,
  rehomeAccountOnHomeBay,
} from "@cocalc/server/accounts/rehome";
import {
  createMembershipGrant,
  revokeMembershipGrantById,
} from "@cocalc/server/membership/grants";
import { getMembershipTiers } from "@cocalc/server/membership/tiers";
import { createImpersonationGrantLocal } from "@cocalc/server/auth/impersonation";
import { verifyFreshAuthCredentials } from "@cocalc/server/auth/two-factor";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import {
  activateMembershipClaimIdentityDirect,
  getMembershipClaimIdentityDirect,
  reserveMembershipClaimIdentityDirect,
  revokeMembershipClaimIdentityDirect,
} from "@cocalc/server/membership/claim-directory";
import {
  claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay,
  claimMembershipPackageSeat as claimMembershipPackageSeatForAccount,
  getMembershipPackage,
  listClaimableMembershipPackagesForAccount,
  listLocalClaimableMembershipPackagesForVerifiedEmails,
  listMembershipPackageDetailsForOwner,
  updateMembershipPackage,
} from "@cocalc/server/membership/packages";
import {
  getTeamLicenseOverviewForOwner,
  resolveTeamLicenseQuote,
} from "@cocalc/server/membership/team-licenses";
import { purchaseTeamLicenseChange } from "@cocalc/server/purchases/team-license";
import createProject, {
  createProjectWithInternalProjectId,
} from "@cocalc/server/projects/create";
import { isValidUUID } from "@cocalc/util/misc";
import {
  addSiteLicensePool,
  adminProvisionSiteLicense,
  archiveSiteLicensePool,
  assignSiteLicensePoolSeat,
  cancelSiteLicensePoolRequest,
  getVerifiedEmailAddressesForAccount,
  getSiteLicenseAffiliationReverificationStatusForAccount,
  getSiteLicenseOverview,
  listSiteLicenseOverviews,
  releaseSiteLicensePoolSeat,
  requestSiteLicensePoolWithVerifiedEmailsOnLocalBay,
  refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay,
  removeSiteLicenseManager,
  reviewSiteLicensePoolRequest,
  revokeSiteLicensePoolSeat,
  setSiteLicenseManager,
  updateSiteLicense,
  updateSiteLicensePool,
} from "@cocalc/server/membership/site-licenses";
import {
  addSiteLicenseExternalClaimKey,
  consumeSiteLicenseExternalClaimToken,
  createSiteLicenseExternalClaimPool,
  disableSiteLicenseExternalClaimPool,
  listSiteLicenseExternalClaimConsumptions,
  listSiteLicenseExternalClaimKeys,
  listSiteLicenseExternalClaimPools,
  revokeSiteLicenseExternalClaimKey,
} from "@cocalc/server/membership/site-license-external-claims";
import {
  createLicenseOnSeed,
  listLicensesOnSeed,
  listLicenseTiersOnSeed,
  listOwnedLicensesOnSeed,
  restoreLicenseOnSeed,
  revokeLicenseOnSeed,
  upsertLicenseTierOnSeed,
} from "@cocalc/server/conat/api/software";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "@cocalc/server/membership/resolve";
import * as legacyMigration from "@cocalc/server/legacy-migration";
import * as publicDirectoryShares from "@cocalc/server/public-directory-shares";
import { getAccountUsageOverviewForAccount } from "@cocalc/server/membership/account-usage-overview";
import {
  clearAccountEntitlementOverrideLocal,
  getAccountEntitlementOverrideLocal,
  setAccountEntitlementOverrideLocal,
} from "@cocalc/server/membership/entitlement-overrides";
import {
  clearAdminAssignedMembershipLocal,
  getAdminAssignedMembershipLocal,
  setAdminAssignedMembershipLocal,
} from "@cocalc/server/membership/admin-assigned";
import {
  getExternalCredential,
  hasExternalCredential,
  listExternalCredentials,
  revokeExternalCredential,
  touchExternalCredential,
  upsertExternalCredential,
} from "@cocalc/server/external-credentials/store";
import { getDedicatedHostPolicySnapshotLocal } from "@cocalc/server/project-host/admission";
import {
  closeDedicatedHostPurchaseSessionLocal,
  reconcileDedicatedHostPurchaseSessionLocal,
} from "@cocalc/server/project-host/spend";
import {
  heartbeatProjectRuntimeSlotLocal,
  heartbeatProjectRuntimeSlotsBatchLocal,
  listProjectRuntimeSlotsLocal,
  releaseProjectRuntimeSlotLocal,
  reserveProjectRuntimeSlotLocal,
  startProjectRuntimeSlotHeartbeat,
} from "@cocalc/server/projects/runtime-slots";
import {
  resolveHostBayAcrossCluster,
  resolveHostBayDirect,
  resolveProjectBayAcrossCluster,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import {
  resolveAccountImpersonationGrantDirectoryDirect,
  upsertAccountImpersonationGrantDirectoryDirect,
} from "@cocalc/server/auth/impersonation-grant-directory";
import {
  resolveProjectCollabInviteDirectoryDirect,
  upsertProjectCollabInviteDirectoryDirect,
} from "@cocalc/server/projects/collab-invite-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { applyRemoteNotificationTargetOnHomeBay } from "@cocalc/server/notifications/remote-feed";
import {
  handleProjectControlAddress,
  handleProjectControlActiveOperation,
  handleProjectControlBackup,
  handleProjectControlCheckStartAdmission,
  handleProjectControlAcceptRehome,
  handleProjectControlSetUsageAccount,
  handleProjectControlAssignHost,
  handleProjectControlMove,
  handleProjectControlRehome,
  handleProjectControlRestart,
  handleProjectControlStart,
  handleProjectControlState,
  handleProjectDetailsGet,
  handleProjectLroPublishProgress,
  handleProjectReferenceGet,
  handleProjectControlStop,
} from "@cocalc/server/inter-bay/project-control";
import {
  handleProjectSecretsCopy,
  handleProjectSecretsDelete,
  handleProjectSecretsExportForCopy,
  handleProjectSecretsGenerateSshKeySecret,
  handleProjectSecretsImportForCopy,
  handleProjectSecretsList,
  handleProjectSecretsSet,
} from "@cocalc/server/inter-bay/project-secrets";
import {
  HOST_DANGEROUS_INTERNAL_AUTH,
  annotateHostAvailabilityEvent,
  deleteHost,
  deleteHostRootfsImage,
  backupHostProjects,
  drainHost,
  forceDeprovisionHost,
  gcDeletedHostRootfsImages,
  getBackupConfigLocal,
  getHostAvailability,
  getHostLog,
  getHostManagedComponentStatus,
  getHostMetricsHistory,
  getHostRuntimeDeploymentStatus,
  getHostRuntimeLog,
  getAccountEffectiveLimitsLocal,
  getProjectOwnerEffectiveLimitsLocal,
  getProjectStartMetadataLocal,
  recordAcpAdmissionDenialLocal,
  recordServiceAdmissionDenialLocal,
  recordServiceAdmissionNearLimitLocal,
  reconcileHostRuntimeDeployments,
  reconcileHostSoftware,
  refreshHostCloudState,
  removeSelfHostConnector,
  restartHost,
  rollbackHostRuntimeDeployments,
  rolloutHostManagedComponents,
  startHost,
  stopHost,
  upgradeHostSoftware,
  listHostRootfsImages,
  listHostSshAuthorizedKeys,
  listHostProjects,
  listHostRuntimeDeployments,
  pullHostRootfsImage,
  addHostSshAuthorizedKey,
  issueProjectHostAuthTokenLocal,
  listHostAccess,
  listHostsLocal,
  markProjectChanged as markProjectChangedLocal,
  recordProjectBackupIndexLocal,
  recordProjectBackupLocal,
  resolveHostConnectionLocal,
  removeHostAccess,
  setHostOwnerSpendLimits,
  setHostAccess,
  setHostDeletionProtection,
  setHostProjectRamLimit,
  setHostPoolAccess,
  setHostRuntimeDeployments,
  getProjectBackupIndexesLocal,
  syncProjectBackupIndexesLocal,
  deleteProjectBackupIndexLocal,
  removeHostSshAuthorizedKey,
} from "@cocalc/server/conat/api/hosts";
import {
  getProjectBackupShardAdminStatus,
  getSeedProjectBackupConfig,
  releaseProjectBackupRepoAssignment,
  resolveProjectBackupRepoAssignment,
} from "@cocalc/server/project-backup";
import { releaseProjectAppPublicSubdomainsForProject } from "@cocalc/server/app-public-subdomains";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  acceptHostRehome,
  ensureHostOwnerSshTrustOnBay,
  prepareHostRehomeOnDestination,
  reconnectHostRehomeOnDestination,
  recordHostRehomeLogOnDestination,
  rehomeHostOnOwningBay,
} from "@cocalc/server/project-host/rehome";
import {
  deleteProjectedCollabInviteDirect,
  toWire as collabInviteToWire,
  upsertProjectedCollabInviteDirect,
} from "@cocalc/server/projects/collab-invite-inbox";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import {
  copyEmailProjectInviteLink,
  createCollabInvite,
  getProjectAccessLandingInfo,
  inviteCollaboratorWithoutAccount,
  listProjectAccessRequestBlocks,
  listProjectAccessRequests,
  listCollabInvites,
  previewEmailProjectInvite,
  redeemEmailProjectInvite,
  removeCollaborator,
  repairAcceptedCourseStudentInviteAccountsLocal,
  requestProjectAccess,
  respondCollabInviteCanonical,
  respondEmailProjectInvite,
  respondProjectAccessRequest,
  setProjectUserRole,
  unblockProjectAccessRequester,
} from "@cocalc/server/projects/collaborators";
import { ensureCourseManagerAccessLocal } from "@cocalc/server/projects/course/ensure-manager-access";
import { getProjectCollaboratorInviteUsage } from "@cocalc/server/membership/project-limits";
import { leaveOrDeleteProjectsForAccount } from "@cocalc/server/projects/ownership";
import {
  BAY_OPS_INTERNAL_AUTH,
  getAcpAdmissionDenialReport,
  getBayBackups,
  getBayLoad,
  getGlobalConfigPropagationStatus,
  getProjectRuntimeSlotReport,
  getRootfsQuotaReport,
  getServiceAdmissionDenialReport,
  getSiteSettingsOnSeed,
  setSiteSettingsOnSeed,
  syncSiteSettingsToBays,
} from "@cocalc/server/conat/api/system";
import {
  setLocalProjectDeletionProtection,
  setLocalProjectManageUsersOwnerOnly,
  setLocalProjectsHidden,
} from "@cocalc/server/conat/api/projects";
import { listVisibleRootfsImages } from "@cocalc/server/rootfs/catalog";

const logger = getLogger("server:inter-bay:service");

function isLegacyProjectIdUnavailableError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err}`;
  return (
    message.includes("project_id already exists") ||
    message.includes("project_id belongs to a permanently deleted workspace") ||
    message.includes("if project_id is given, it must be a valid uuid")
  );
}

function getSeedSiteLicenseBayId(): string {
  return getConfiguredClusterSeedBayId();
}

function isSeedSiteLicenseBay(): boolean {
  return getConfiguredBayId() === getSeedSiteLicenseBayId();
}

function getSeedSiteLicenseClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getSeedSiteLicenseBayId(),
  });
}

let serviceStarted = false;
let services: ConatService[] = [];

function normalizeOptionalDateLike(
  value?: string | number | Date | null,
): string | Date | null | undefined {
  if (typeof value === "number") {
    return new Date(value);
  }
  return value;
}

export async function initInterBayServices(): Promise<void> {
  if (serviceStarted) {
    return;
  }
  serviceStarted = true;
  try {
    await startDirectoryService();
    await startAuthTokenService();
    await startBayRegistryService();
    await startBayOpsService();
    await startAccountDirectoryService();
    await startAccountLocalService();
    await startAccountProjectFeedService();
    await startAccountNotificationFeedService();
    await startProjectControlStartService();
    await startProjectReferenceService();
    await startProjectDetailsService();
    await startProjectSecretsService();
    await startExternalCredentialsService();
    await startHostConnectionService();
    await startHostControlService();
    await startProjectHostAuthTokenService();
    await startProjectLroService();
    await startProjectCollabInviteService();
    startBayRegistrationHeartbeat();
    startProjectRuntimeSlotHeartbeat();
    startManagedBayCloudflared();
  } catch (err) {
    serviceStarted = false;
    throw err;
  }
}

async function startBayRegistryService(): Promise<void> {
  const role = getConfiguredClusterRole();
  if (role === "attached") {
    return;
  }
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayBayRegistryApi = {
    register: async (opts) => await registerBayPresenceLocal(opts),
    list: async (opts) => await listBayRegistryLocal(opts),
  };
  services.push(
    ...createInterBayBayRegistryHandlers({
      client,
      parallel: true,
      impl,
    }),
  );
}

async function startBayOpsService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const bay_id = getConfiguredBayId();
  const impl: InterBayBayOpsApi = {
    getLoad: async ({ account_id }) =>
      await getBayLoad({
        account_id,
        bay_id,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getBackups: async ({ account_id }) =>
      await getBayBackups({
        account_id,
        bay_id,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getDrainPreflight: async ({ unsafe_rehome }) =>
      await runBayDrainPreflight({
        source_bay_id: bay_id,
        seed_bay_id: getConfiguredClusterSeedBayId(),
        unsafe_rehome,
      }),
    getRootfsCatalog: async ({ account_id }) =>
      await listVisibleRootfsImages(account_id, {
        includeSeedCatalog: false,
      }),
    getRootfsQuotaReport: async (opts) =>
      await getRootfsQuotaReport({
        ...opts,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getAcpAdmissionDenialReport: async (opts) =>
      await getAcpAdmissionDenialReport({
        ...opts,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getServiceAdmissionDenialReport: async (opts) =>
      await getServiceAdmissionDenialReport({
        ...opts,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getProjectRuntimeSlotReport: async (opts) =>
      await getProjectRuntimeSlotReport({
        ...opts,
        internalAuth: BAY_OPS_INTERNAL_AUTH,
      }),
    getMembershipTiers: async (opts = {}) =>
      await getMembershipTiers({
        includeDisabled: opts.includeDisabled,
        storeVisibleOnly: opts.storeVisibleOnly,
        courseStoreVisibleOnly: opts.courseStoreVisibleOnly,
      }),
    setServerSetting: async (opts) => {
      await callback2(db().set_server_setting, opts);
    },
    setSiteSettings: async (opts) => await setSiteSettingsOnSeed(opts),
    getSiteSettings: async (opts) =>
      await getSiteSettingsOnSeed({ names: opts.names }),
    syncSiteSettings: async (opts) =>
      await syncSiteSettingsToBays({ account_id: opts.account_id }),
    getGlobalConfigPropagationStatus: async (opts) =>
      await getGlobalConfigPropagationStatus({
        account_id: opts.account_id,
        scope: opts.scope,
      }),
  };
  services.push(
    ...createInterBayBayOpsHandlers({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
  );
}

async function startAuthTokenService(): Promise<void> {
  const role = getConfiguredClusterRole();
  if (role === "attached") {
    return;
  }
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayAuthTokenApi = {
    requiresToken: async () => await getRequiresTokensDirect(),
    validate: async ({ token }) =>
      (await validateRegistrationTokenDirect(token)) ?? null,
    redeem: async ({ token }) =>
      (await redeemRegistrationTokenDirect(token)) ?? null,
    disable: async ({ token }) => {
      await disableRegistrationTokenDirect(token);
    },
    delete: async ({ token }) => {
      await deleteRegistrationTokenDirect(token);
    },
  };
  services.push(
    ...createInterBayAuthTokenHandlers({
      client,
      parallel: true,
      impl,
    }),
  );
}

async function startDirectoryService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayDirectoryApi = {
    resolveProjectBay: async ({ project_id }) =>
      await resolveProjectBayDirect(`${project_id ?? ""}`),
    resolveHostBay: async ({ host_id, include_deleted }) =>
      await resolveHostBayDirect(`${host_id ?? ""}`, {
        include_deleted: !!include_deleted,
      }),
    resolveProjectCollabInvite: async (opts) =>
      await resolveProjectCollabInviteDirectoryDirect(opts),
    upsertProjectCollabInvite: async (opts) =>
      await upsertProjectCollabInviteDirectoryDirect(opts),
    resolveAccountImpersonationGrant: async (opts) =>
      await resolveAccountImpersonationGrantDirectoryDirect(opts),
    upsertAccountImpersonationGrant: async (opts) =>
      await upsertAccountImpersonationGrantDirectoryDirect(opts),
  };
  services.push(
    ...createInterBayBayDirectoryHandlers({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
  const role = getConfiguredClusterRole();
  if (role === "attached") {
    return;
  }
  services.push(
    ...createInterBayDirectoryHandlers({
      client,
      parallel: true,
      impl: {
        resolveProjectBay: async ({ project_id }) =>
          await resolveProjectBayAcrossCluster(`${project_id ?? ""}`),
        resolveHostBay: async ({ host_id, include_deleted }) =>
          await resolveHostBayAcrossCluster(`${host_id ?? ""}`, {
            include_deleted: !!include_deleted,
          }),
        resolveProjectCollabInvite: async (opts) =>
          await resolveProjectCollabInviteDirectoryDirect(opts),
        upsertProjectCollabInvite: async (opts) =>
          await upsertProjectCollabInviteDirectoryDirect(opts),
        resolveAccountImpersonationGrant: async (opts) =>
          await resolveAccountImpersonationGrantDirectoryDirect(opts),
        upsertAccountImpersonationGrant: async (opts) =>
          await upsertAccountImpersonationGrantDirectoryDirect(opts),
      },
    }),
  );
}

async function startAccountDirectoryService(): Promise<void> {
  const role = getConfiguredClusterRole();
  if (role === "attached") {
    return;
  }
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayAccountDirectoryApi = {
    get: async ({ account_id }) =>
      await getClusterAccountById(`${account_id ?? ""}`),
    getByEmail: async ({ email_address }) =>
      await getClusterAccountByEmail(`${email_address ?? ""}`),
    getMany: async ({ account_ids }) =>
      await getClusterAccountsByIds(
        Array.isArray(account_ids) ? account_ids : [],
      ),
    search: async ({ query, limit, admin, only_email }) =>
      await searchClusterAccounts({
        query: `${query ?? ""}`,
        limit,
        admin,
        only_email,
      }),
    getBanEquivalentEmailAccounts: async ({ email_address, limit }) =>
      await getClusterBanEquivalentEmailAccounts({
        email_address,
        limit,
      }),
    getHomeBayCounts: async () => await getClusterAccountHomeBayCounts(),
    updateHomeBay: async (opts) => await updateClusterAccountHomeBay(opts),
    updateEmailAddress: async (opts) =>
      await updateClusterAccountEmailAddress(opts),
    updateEmailAddressVerified: async (opts) =>
      await updateClusterAccountEmailAddressVerified(opts),
    updateBanned: async (opts) => await updateClusterAccountBanned(opts),
    touch: async (opts) => await touchClusterAccountDirectoryEntry(opts),
    create: async (opts) => await createClusterAccount(opts),
    delete: async (opts) => await deleteClusterAccount(opts),
    getApiKey: async ({ key_id }) =>
      await getClusterAccountApiKeyByKeyId(`${key_id ?? ""}`),
    upsertApiKey: async (opts) =>
      await upsertClusterAccountApiKeyDirectoryEntry(opts),
    deleteApiKey: async (opts) =>
      await deleteClusterAccountApiKeyDirectoryEntry(opts),
    updateApiKeysHomeBay: async (opts) =>
      await updateClusterAccountApiKeysHomeBay(opts),
    touchApiKey: async (opts) =>
      await touchClusterAccountApiKeyDirectoryEntry(opts),
    recentPasswordResetAttempts: async ({ email_address, ip_address }) => ({
      count: await recentPasswordResetAttemptsLocal(email_address, ip_address),
    }),
    createPasswordReset: async ({ email_address, ip_address, ttl_s }) => ({
      id: await createPasswordResetLocal(email_address, ip_address, ttl_s),
    }),
    redeemPasswordReset: async ({ password_reset_id }) => {
      const { email_address } =
        await redeemPasswordResetLocal(password_reset_id);
      const account = await getClusterAccountByEmail(email_address);
      const account_id = account?.account_id;
      if (!account_id) {
        throw Error("Password reset no longer valid.");
      }
      return {
        account_id,
        email_address,
        home_bay_id: account.home_bay_id ?? null,
      };
    },
    getMembershipClaimIdentity: async (opts) =>
      await getMembershipClaimIdentityDirect(opts),
    reserveMembershipClaimIdentity: async (opts) =>
      await reserveMembershipClaimIdentityDirect(opts),
    activateMembershipClaimIdentity: async (opts) =>
      await activateMembershipClaimIdentityDirect(opts),
    revokeMembershipClaimIdentity: async (opts) =>
      await revokeMembershipClaimIdentityDirect(opts),
  };
  services.push(
    ...createInterBayAccountDirectoryHandlers({
      client,
      parallel: true,
      impl,
    }),
  );
}

async function startAccountLocalService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayAccountLocalApi = {
    create: async (opts) => await provisionLocalClusterAccount(opts),
    delete: async (opts) => await deleteLocalClusterAccount(opts),
    rehome: async (opts) => await rehomeAccountOnHomeBay(opts),
    acceptRehome: async (opts) => await acceptAccountRehome(opts),
    copyRehomeState: async (opts) => await copyAccountRehomeState(opts),
    getRehomeOperation: async ({ op_id }) =>
      (await getAccountRehomeOperation(op_id)) ?? null,
    reconcileRehome: async (opts) => await reconcileAccountRehomeOnSource(opts),
    createImpersonationGrant: async (opts) => {
      const grant = await createImpersonationGrantLocal({
        actor_account_id: opts.actor_account_id,
        subject_account_id: opts.subject_account_id,
        actor_session_hash: opts.actor_session_hash,
        subject_home_bay_id: opts.subject_home_bay_id,
        actor_authenticated_at: normalizeOptionalDateLike(
          opts.actor_authenticated_at,
        ) as Date | null | undefined,
        actor_password_verified_at: normalizeOptionalDateLike(
          opts.actor_password_verified_at,
        ) as Date | null | undefined,
        actor_factor_verified_at: normalizeOptionalDateLike(
          opts.actor_factor_verified_at,
        ) as Date | null | undefined,
        actor_fresh_auth_until: normalizeOptionalDateLike(
          opts.actor_fresh_auth_until,
        ) as Date | null | undefined,
        actor_factor_level: opts.actor_factor_level ?? "none",
        reason: opts.reason,
        metadata: opts.metadata,
      });
      return {
        grant_id: grant.id,
        subject_account_id: grant.subject_account_id,
        subject_home_bay_id: grant.subject_home_bay_id ?? getConfiguredBayId(),
        expires_at: grant.expire,
      };
    },
    verifyFreshAuthCredentials: async ({
      account_id,
      current_password,
      method,
      code,
    }) => ({
      factor_level: await verifyFreshAuthCredentials({
        account_id,
        current_password,
        method,
        code,
      }),
    }),
    verifySignInPassword: async ({ email_address, password }) =>
      await verifyLocalSignInPassword({ email_address, password }),
    createCliLoginSession: async (opts) =>
      await createLocalCliLoginSession(opts),
    redeemVerifyEmail: async ({ email_address, token }) => {
      await redeemVerifyEmailLocal(email_address, token);
    },
    sendEmailVerification: async ({ account_id, only_verify }) =>
      await sendEmailVerificationLocal(account_id, only_verify),
    adminVerifyEmailAddress: async ({ account_id }) =>
      await adminVerifyEmailAddressLocal({ account_id }),
    adminDisableTwoFactor: async ({ account_id }) =>
      await adminDisableTwoFactorLocal({ account_id }),
    adminGrantAdminRole: async (opts) => await grantAdminRoleLocal(opts),
    adminRevokeAdminRole: async (opts) => await revokeAdminRoleLocal(opts),
    setBan: async (opts) => await setLocalClusterAccountBan(opts),
    quarantineBillingResources: async (opts) =>
      await quarantineLocalClusterAccountBillingResources(opts),
    setPasswordFromReset: async ({ account_id, password }) => {
      await setPasswordFromResetLocal({ account_id, password });
    },
    assertProductAccessTrust: async ({ account_id, action }) => {
      await assertAccountTrustedForProductAccess(account_id, action);
    },
    reconcileDedicatedHostPurchaseSession: async (opts) => {
      await reconcileDedicatedHostPurchaseSessionLocal(opts);
    },
    closeDedicatedHostPurchaseSession: async (opts) => {
      await closeDedicatedHostPurchaseSessionLocal(opts);
    },
    reserveProjectRuntimeSlot: async (opts) =>
      await reserveProjectRuntimeSlotLocal(opts),
    heartbeatProjectRuntimeSlot: async (opts) =>
      await heartbeatProjectRuntimeSlotLocal(opts),
    heartbeatProjectRuntimeSlotsBatch: async (opts) =>
      await heartbeatProjectRuntimeSlotsBatchLocal(opts),
    releaseProjectRuntimeSlot: async (opts) =>
      await releaseProjectRuntimeSlotLocal(opts),
    listProjectRuntimeSlots: async (opts) =>
      await listProjectRuntimeSlotsLocal(opts),
    upsertMembershipGrant: async (opts) => ({
      grant_id: await createMembershipGrant({
        ...opts,
        starts_at: normalizeOptionalDateLike(opts.starts_at),
        expires_at: normalizeOptionalDateLike(opts.expires_at),
      }),
    }),
    revokeMembershipGrant: async ({ account_id, grant_id, revoked_at }) => {
      await revokeMembershipGrantById({
        account_id,
        grant_id,
        revoked_at: normalizeOptionalDateLike(revoked_at),
      });
    },
    getMembership: async ({ account_id }) =>
      await resolveMembershipForAccount(account_id),
    getMembershipDetails: async ({ account_id, refresh_usage_status }) =>
      await resolveMembershipDetailsForAccount(account_id, {
        refresh_usage_status,
      }),
    getAccountUsageOverview: async ({ account_id }) =>
      await getAccountUsageOverviewForAccount({ account_id }),
    getVerifiedEmailAddresses: async ({ account_id }) => ({
      email_addresses: await getVerifiedEmailAddressesForAccount(account_id),
    }),
    createLegacyMigrationProject: async ({
      account_id,
      legacy_project_id,
      title,
      description,
      rootfs_image,
      rootfs_image_id,
      host_id,
      region,
    }) => {
      const opts = {
        account_id,
        title,
        description: description ?? undefined,
        rootfs_image,
        rootfs_image_id,
        host_id,
        region,
        skip_project_count_limit: true,
        start: false,
      };
      if (!isValidUUID(legacy_project_id)) {
        return { project_id: await createProject(opts) };
      }
      try {
        return {
          project_id: await createProjectWithInternalProjectId({
            ...opts,
            project_id: legacy_project_id,
          }),
        };
      } catch (err) {
        if (!isLegacyProjectIdUnavailableError(err)) {
          throw err;
        }
        logger.warn(
          "legacy migration project_id unavailable on account home bay; falling back to fresh project_id",
          { legacy_project_id, err: `${err}` },
        );
        return { project_id: await createProject(opts) };
      }
    },
    getAdminAssignedMembership: async ({ account_id }) =>
      await getAdminAssignedMembershipLocal(account_id),
    setAdminAssignedMembership: async ({
      account_id,
      actor_account_id,
      membership_class,
      expires_at,
      notes,
    }) =>
      await setAdminAssignedMembershipLocal({
        account_id,
        actor_account_id,
        membership_class,
        expires_at: normalizeOptionalDateLike(expires_at),
        notes,
      }),
    clearAdminAssignedMembership: async ({ account_id }) =>
      await clearAdminAssignedMembershipLocal({ account_id }),
    getAccountEntitlementOverride: async ({ account_id }) =>
      await getAccountEntitlementOverrideLocal(account_id),
    setAccountEntitlementOverride: async ({
      account_id,
      actor_account_id,
      override,
      reason,
    }) =>
      await setAccountEntitlementOverrideLocal({
        account_id,
        actor_account_id,
        override,
        reason,
      }),
    clearAccountEntitlementOverride: async ({
      account_id,
      actor_account_id,
      reason,
    }) =>
      await clearAccountEntitlementOverrideLocal({
        account_id,
        actor_account_id,
        reason,
      }),
    getDedicatedHostPolicySnapshot: async ({
      account_id,
      funding_mode_override,
    }) =>
      await getDedicatedHostPolicySnapshotLocal(account_id, {
        funding_mode_override,
      }),
    getMembershipPackages: async ({ owner_account_id }) =>
      await listMembershipPackageDetailsForOwner({
        owner_account_id,
      }),
    getTeamLicense: async ({ account_id }) =>
      await getTeamLicenseOverviewForOwner({
        owner_account_id: account_id,
      }),
    getTeamLicenseQuote: async ({ account_id, target_seats }) =>
      await resolveTeamLicenseQuote({
        owner_account_id: account_id,
        target_seats,
      }),
    purchaseTeamLicenseChange: async ({ account_id, target_seats }) =>
      await purchaseTeamLicenseChange({
        account_id,
        target_seats: target_seats ?? {},
      }),
    adminProvisionSiteLicense: async (opts) =>
      isSeedSiteLicenseBay()
        ? await adminProvisionSiteLicense({ ...opts, trusted_admin: true })
        : await getSeedSiteLicenseClient().adminProvisionSiteLicense(opts),
    listSiteLicenseOverviews: async ({
      actor_account_id,
      admin,
      trusted_admin,
    }) =>
      isSeedSiteLicenseBay()
        ? await listSiteLicenseOverviews({
            account_id: actor_account_id,
            admin,
            trusted_admin,
          })
        : await getSeedSiteLicenseClient().listSiteLicenseOverviews({
            actor_account_id,
            admin,
            trusted_admin,
          }),
    revokeSiteLicensePoolSeat: async (opts) =>
      isSeedSiteLicenseBay()
        ? {
            revoked: await revokeSiteLicensePoolSeat(opts),
          }
        : await getSeedSiteLicenseClient().revokeSiteLicensePoolSeat(opts),
    assignSiteLicensePoolSeat: async (opts) =>
      isSeedSiteLicenseBay()
        ? await assignSiteLicensePoolSeat(opts)
        : await getSeedSiteLicenseClient().assignSiteLicensePoolSeat(opts),
    releaseSiteLicensePoolSeat: async (opts) =>
      isSeedSiteLicenseBay()
        ? {
            revoked: await releaseSiteLicensePoolSeat(opts),
          }
        : await getSeedSiteLicenseClient().releaseSiteLicensePoolSeat(opts),
    listSoftwareLicenseTiers: async ({ actor_account_id, include_disabled }) =>
      isSeedSiteLicenseBay()
        ? await listLicenseTiersOnSeed({ include_disabled })
        : await getSeedSiteLicenseClient().listSoftwareLicenseTiers({
            actor_account_id,
            include_disabled,
          }),
    upsertSoftwareLicenseTier: async ({ actor_account_id, tier }) =>
      isSeedSiteLicenseBay()
        ? await upsertLicenseTierOnSeed({ actor_account_id, tier })
        : await getSeedSiteLicenseClient().upsertSoftwareLicenseTier({
            actor_account_id,
            tier,
          }),
    listSoftwareLicenses: async ({ actor_account_id, search, limit }) =>
      isSeedSiteLicenseBay()
        ? await listLicensesOnSeed({ search, limit })
        : await getSeedSiteLicenseClient().listSoftwareLicenses({
            actor_account_id,
            search,
            limit,
          }),
    createSoftwareLicense: async (opts) =>
      isSeedSiteLicenseBay()
        ? await createLicenseOnSeed(opts)
        : await getSeedSiteLicenseClient().createSoftwareLicense(opts),
    revokeSoftwareLicense: async (opts) =>
      isSeedSiteLicenseBay()
        ? await revokeLicenseOnSeed(opts)
        : await getSeedSiteLicenseClient().revokeSoftwareLicense(opts),
    restoreSoftwareLicense: async (opts) =>
      isSeedSiteLicenseBay()
        ? await restoreLicenseOnSeed(opts)
        : await getSeedSiteLicenseClient().restoreSoftwareLicense(opts),
    listOwnedSoftwareLicenses: async (opts) =>
      isSeedSiteLicenseBay()
        ? await listOwnedLicensesOnSeed(opts)
        : await getSeedSiteLicenseClient().listOwnedSoftwareLicenses(opts),
    updateMembershipPackage: async ({
      package_id,
      actor_account_id,
      pool_name,
      seat_count,
      pool_description,
      requires_approval,
      affiliation_reverification_days,
      affiliation_reverification_grace_days,
      expires_at,
      allowed_domains,
    }) => {
      const pkg = await getMembershipPackage({ package_id });
      if (isSeedSiteLicenseBay() && pkg?.kind === "site") {
        return await updateSiteLicensePool({
          actor_account_id,
          package_id,
          pool_name,
          seat_count,
          pool_description,
          requires_approval,
          affiliation_reverification_days,
          affiliation_reverification_grace_days,
          expires_at,
          allowed_domains,
        });
      }
      return await updateMembershipPackage({
        package_id,
        seat_count,
        expires_at,
        allowed_domains,
      });
    },
    updateSiteLicense: async (opts) =>
      isSeedSiteLicenseBay()
        ? await updateSiteLicense(opts)
        : await getSeedSiteLicenseClient().updateSiteLicense(opts),
    addSiteLicensePool: async (opts) =>
      isSeedSiteLicenseBay()
        ? await addSiteLicensePool(opts)
        : await getSeedSiteLicenseClient().addSiteLicensePool(opts),
    createSiteLicenseExternalClaimPool: async ({
      actor_account_id,
      ...opts
    }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().createSiteLicenseExternalClaimPool(
          {
            actor_account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(actor_account_id))) {
        throw Error("must be an admin");
      }
      return await createSiteLicenseExternalClaimPool({
        ...opts,
        created_by_account_id: actor_account_id,
      });
    },
    addSiteLicenseExternalClaimKey: async ({ actor_account_id, ...opts }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().addSiteLicenseExternalClaimKey({
          actor_account_id,
          ...opts,
        });
      }
      if (!(await isAdmin(actor_account_id))) {
        throw Error("must be an admin");
      }
      return await addSiteLicenseExternalClaimKey({
        ...opts,
        created_by_account_id: actor_account_id,
      });
    },
    listSiteLicenseExternalClaimPools: async ({ account_id, ...opts }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimPools(
          {
            account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(account_id))) {
        throw Error("must be an admin");
      }
      return await listSiteLicenseExternalClaimPools(opts);
    },
    disableSiteLicenseExternalClaimPool: async ({
      actor_account_id,
      ...opts
    }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().disableSiteLicenseExternalClaimPool(
          {
            actor_account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(actor_account_id))) {
        throw Error("must be an admin");
      }
      return await disableSiteLicenseExternalClaimPool(opts);
    },
    listSiteLicenseExternalClaimKeys: async ({ account_id, ...opts }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimKeys(
          {
            account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(account_id))) {
        throw Error("must be an admin");
      }
      return await listSiteLicenseExternalClaimKeys(opts);
    },
    revokeSiteLicenseExternalClaimKey: async ({
      actor_account_id,
      ...opts
    }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().revokeSiteLicenseExternalClaimKey(
          {
            actor_account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(actor_account_id))) {
        throw Error("must be an admin");
      }
      return await revokeSiteLicenseExternalClaimKey(opts);
    },
    listSiteLicenseExternalClaimConsumptions: async ({
      account_id,
      ...opts
    }) => {
      if (!isSeedSiteLicenseBay()) {
        return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimConsumptions(
          {
            account_id,
            ...opts,
          },
        );
      }
      if (!(await isAdmin(account_id))) {
        throw Error("must be an admin");
      }
      return await listSiteLicenseExternalClaimConsumptions({
        ...opts,
        account_id: opts.target_account_id,
      });
    },
    consumeSiteLicenseExternalClaimToken: async ({ account_id, token }) => {
      await assertAccountTrustedForProductAccess(
        account_id,
        "claim site-license external token",
      );
      return isSeedSiteLicenseBay()
        ? await consumeSiteLicenseExternalClaimToken({ token, account_id })
        : await getSeedSiteLicenseClient().consumeSiteLicenseExternalClaimToken(
            {
              account_id,
              token,
            },
          );
    },
    archiveSiteLicensePool: async (opts) =>
      isSeedSiteLicenseBay()
        ? await archiveSiteLicensePool(opts)
        : await getSeedSiteLicenseClient().archiveSiteLicensePool(opts),
    setSiteLicenseManager: async (opts) =>
      isSeedSiteLicenseBay()
        ? await setSiteLicenseManager(opts)
        : await getSeedSiteLicenseClient().setSiteLicenseManager(opts),
    removeSiteLicenseManager: async (opts) =>
      isSeedSiteLicenseBay()
        ? await removeSiteLicenseManager(opts)
        : await getSeedSiteLicenseClient().removeSiteLicenseManager(opts),
    getClaimableMembershipPackages: async ({
      account_id,
      include_claimed_site_license_pools,
      verified_email_addresses,
    }) => {
      const rows = await listLocalClaimableMembershipPackagesForVerifiedEmails({
        account_id,
        include_claimed_site_license_pools,
        verified_email_addresses,
      });
      return isSeedSiteLicenseBay()
        ? rows
        : rows.filter((row) => row.kind !== "site");
    },
    getClaimableMembershipPackagesForAccount: async ({
      account_id,
      include_claimed_site_license_pools,
    }) =>
      await listClaimableMembershipPackagesForAccount({
        account_id,
        include_claimed_site_license_pools,
      }),
    claimMembershipPackageSeat: async ({
      package_id,
      account_id,
      verified_email_addresses,
      accepted_terms,
    }) =>
      await claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay({
        package_id,
        account_id,
        verified_email_addresses,
        accepted_terms,
      }),
    claimMembershipPackageSeatForAccount: async ({
      package_id,
      account_id,
      accepted_terms,
    }) => {
      await assertAccountTrustedForProductAccess(
        account_id,
        "claim membership seats",
      );
      return await claimMembershipPackageSeatForAccount({
        package_id,
        account_id,
        accepted_terms,
      });
    },
    getSiteLicenseOverview: async ({ account_id, site_license_id }) =>
      isSeedSiteLicenseBay()
        ? await getSiteLicenseOverview({ account_id, site_license_id })
        : await getSeedSiteLicenseClient().getSiteLicenseOverview({
            account_id,
            site_license_id,
          }),
    requestSiteLicensePool: async ({
      account_id,
      package_id,
      verified_email_addresses,
      requester_note,
      accepted_terms,
    }) =>
      isSeedSiteLicenseBay()
        ? await requestSiteLicensePoolWithVerifiedEmailsOnLocalBay({
            account_id,
            package_id,
            verified_email_addresses,
            requester_note,
            accepted_terms,
          })
        : await getSeedSiteLicenseClient().requestSiteLicensePool({
            account_id,
            package_id,
            verified_email_addresses,
            requester_note,
            accepted_terms,
          }),
    cancelSiteLicensePoolRequest: async (opts) =>
      isSeedSiteLicenseBay()
        ? await cancelSiteLicensePoolRequest(opts)
        : await getSeedSiteLicenseClient().cancelSiteLicensePoolRequest(opts),
    requestSiteLicensePoolForAccount: async ({
      account_id,
      package_id,
      requester_note,
      accepted_terms,
    }) => {
      await assertAccountTrustedForProductAccess(
        account_id,
        "request site-license pool",
      );
      const verified_email_addresses =
        await getVerifiedEmailAddressesForAccount(account_id);
      return isSeedSiteLicenseBay()
        ? await requestSiteLicensePoolWithVerifiedEmailsOnLocalBay({
            account_id,
            package_id,
            verified_email_addresses,
            requester_note,
            accepted_terms,
          })
        : await getSeedSiteLicenseClient().requestSiteLicensePool({
            account_id,
            package_id,
            verified_email_addresses,
            requester_note,
            accepted_terms,
          });
    },
    reviewSiteLicensePoolRequest: async (opts) =>
      isSeedSiteLicenseBay()
        ? await reviewSiteLicensePoolRequest(opts)
        : await getSeedSiteLicenseClient().reviewSiteLicensePoolRequest(opts),
    refreshSiteLicenseAffiliationVerification: async ({
      account_id,
      site_license_id,
      verified_email_addresses,
    }) =>
      isSeedSiteLicenseBay()
        ? await refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay(
            {
              account_id,
              site_license_id,
              verified_email_addresses,
            },
          )
        : await getSeedSiteLicenseClient().refreshSiteLicenseAffiliationVerification(
            {
              account_id,
              site_license_id,
              verified_email_addresses,
            },
          ),
    refreshSiteLicenseAffiliationVerificationForAccount: async ({
      account_id,
      site_license_id,
    }) => {
      await assertAccountTrustedForProductAccess(
        account_id,
        "refresh site-license affiliation verification",
      );
      const verified_email_addresses =
        await getVerifiedEmailAddressesForAccount(account_id);
      const status =
        await getSiteLicenseAffiliationReverificationStatusForAccount({
          account_id,
        });
      const refreshed: SiteLicenseAffiliationReverificationSeat[] = [];
      for (const seat of status.seats.filter(
        (seat) =>
          seat.can_refresh_with_verified_email &&
          (site_license_id
            ? seat.site_license_id === site_license_id
            : seat.state === "pending_reverification" ||
              seat.state === "grace_expired"),
      )) {
        if (!isSeedSiteLicenseBay()) {
          refreshed.push(
            ...(await getSeedSiteLicenseClient().refreshSiteLicenseAffiliationVerification(
              {
                account_id,
                site_license_id: seat.site_license_id,
                verified_email_addresses,
              },
            )),
          );
          continue;
        }
        refreshed.push(
          ...(await refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay(
            {
              account_id,
              site_license_id: seat.site_license_id,
              verified_email_addresses,
            },
          )),
        );
      }
      return refreshed;
    },
    getSiteLicenseAffiliationReverificationStatusForAccount: async ({
      account_id,
    }) =>
      await getSiteLicenseAffiliationReverificationStatusForAccount({
        account_id,
      }),
    getMembershipPortableState: async ({ account_id }) =>
      await getMembershipPortableState(account_id),
    replaceMembershipPortableState: async ({
      account_id,
      membership_grants,
      membership_packages,
      membership_package_assignments,
      membership_side_effects_outbox,
    }) =>
      await replaceMembershipPortableState({
        account_id,
        membership_grants,
        membership_packages,
        membership_package_assignments,
        membership_side_effects_outbox,
      }),
    legacyMigrationListProjects: async (opts) =>
      await legacyMigration.listProjects(opts ?? {}),
    legacyMigrationImportProjects: async (opts) =>
      await legacyMigration.importProjects(opts),
    legacyMigrationPrepareArchiveSelection: async (opts) =>
      await legacyMigration.prepareArchiveSelection(opts),
    legacyMigrationRestoreArchiveSelection: async (opts) =>
      await legacyMigration.restoreArchiveSelection(opts),
    legacyMigrationRetryProjectRestore: async (opts) =>
      await legacyMigration.retryProjectRestore(opts),
    legacyMigrationPreviewFinancialMigration: async (opts) =>
      await legacyMigration.previewFinancialMigration(opts ?? {}),
    legacyMigrationApplyFinancialMigration: async (opts) =>
      await legacyMigration.applyFinancialMigration(opts ?? {}),
    legacyMigrationApplyFinancialHomeBay: async (opts) =>
      await legacyMigration.applyFinancialMigrationHomeBay(opts),
    legacyMigrationGetFinancialMembershipGrantHomeBay: async (opts) =>
      await legacyMigration.getFinancialMembershipGrantHomeBay(opts),
    legacyMigrationConfigureFinancialRenewalHomeBay: async (opts) =>
      await legacyMigration.configureFinancialMembershipRenewalHomeBay(opts),
    publicDirectoryShareResolve: async (opts) =>
      await publicDirectoryShares.resolve(opts),
    publicDirectoryShareAuthorizeRead: async (opts) =>
      await publicDirectoryShares.authorizeRead(opts),
    publicDirectoryShareListDirectory: async (opts) =>
      await publicDirectoryShares.listDirectory(opts),
    publicDirectoryShareCopyToProject: async (opts) =>
      await publicDirectoryShares.copyToProject(opts),
    publicDirectoryShareCopyToNewProject: async (opts) =>
      await publicDirectoryShares.copyToNewProject(opts),
    publicDirectoryShareGrantTemporaryViewerAccess: async (opts) =>
      await publicDirectoryShares.grantTemporaryViewerAccess(opts),
    publicDirectoryShareGetTemporaryViewerReadPolicy: async (opts) =>
      await publicDirectoryShares.getTemporaryViewerReadPolicy(opts),
  };
  services.push(
    ...createInterBayAccountLocalHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startAccountProjectFeedService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayAccountProjectFeedApi = {
    upsert: async (event) =>
      await applyAccountProjectFeedUpsertOnHomeBay(event),
    remove: async (event) =>
      await applyAccountProjectFeedRemoveOnHomeBay(event),
  };
  services.push(
    ...createInterBayAccountProjectFeedHandlers({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startAccountNotificationFeedService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const bay_id = getConfiguredBayId();
  const impl: InterBayAccountNotificationFeedApi = {
    upsert: async (opts) =>
      await applyRemoteNotificationTargetOnHomeBay({
        ...opts,
        bay_id,
      }),
  };
  services.push(
    ...createInterBayAccountNotificationFeedHandlers({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
  );
}

async function startProjectControlStartService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectControlApi = {
    checkStartAdmission: async (opts) => {
      await handleProjectControlCheckStartAdmission(opts);
    },
    start: async (opts) => {
      await handleProjectControlStart(opts);
    },
    stop: async (opts) => {
      await handleProjectControlStop(opts);
    },
    restart: async (opts) => {
      await handleProjectControlRestart(opts);
    },
    backup: async (opts) => await handleProjectControlBackup(opts),
    state: async (opts) => await handleProjectControlState(opts),
    setUsageAccount: async (opts) =>
      await handleProjectControlSetUsageAccount(opts),
    assignHost: async (opts) => await handleProjectControlAssignHost(opts),
    address: async (opts) => await handleProjectControlAddress(opts),
    move: async (opts) => await handleProjectControlMove(opts),
    rehome: async (opts) => await handleProjectControlRehome(opts),
    acceptRehome: async (opts) => await handleProjectControlAcceptRehome(opts),
    activeOp: async (opts) => await handleProjectControlActiveOperation(opts),
  };
  const bay_id = getConfiguredBayId();
  logger.debug("starting inter-bay listener", {
    bay_id,
    service: "project-control.start",
  });
  services.push(
    createInterBayProjectControlHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlCheckStartAdmissionHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlStopHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlRestartHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlBackupHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlStateHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlSetUsageAccountHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlAssignHostHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlMoveHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlRehomeHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlAcceptRehomeHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlAddressHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
    createInterBayProjectControlActiveOpHandler({
      client,
      bay_id,
      parallel: true,
      impl,
    }),
  );
}

async function startProjectReferenceService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectReferenceApi = {
    get: async (opts) => await handleProjectReferenceGet(opts),
  };
  services.push(
    createInterBayProjectReferenceHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startProjectDetailsService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectDetailsApi = {
    get: async (opts) => await handleProjectDetailsGet(opts),
  };
  services.push(
    createInterBayProjectDetailsHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startProjectSecretsService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectSecretsApi = {
    list: async (opts) => await handleProjectSecretsList(opts),
    set: async (opts) => await handleProjectSecretsSet(opts),
    delete: async (opts) => await handleProjectSecretsDelete(opts),
    copy: async (opts) => await handleProjectSecretsCopy(opts),
    exportForCopy: async (opts) =>
      await handleProjectSecretsExportForCopy(opts),
    importForCopy: async (opts) =>
      await handleProjectSecretsImportForCopy(opts),
    generateSshKeySecret: async (opts) =>
      await handleProjectSecretsGenerateSshKeySecret(opts),
  };
  services.push(
    ...createInterBayProjectSecretsHandlers({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startExternalCredentialsService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayExternalCredentialsApi = {
    upsert: async ({ selector, payload, metadata }) =>
      await upsertExternalCredential({ selector, payload, metadata }),
    get: async ({ selector, touch_last_used }) =>
      await getExternalCredential({
        selector,
        touchLastUsed: touch_last_used,
      }),
    has: async ({ selector }) => await hasExternalCredential({ selector }),
    touch: async ({ selector }) => await touchExternalCredential({ selector }),
    list: async ({
      owner_account_id,
      include_revoked,
      provider,
      kind,
      scope,
    }) =>
      await listExternalCredentials({
        owner_account_id,
        includeRevoked: include_revoked,
        provider,
        kind,
        scope,
      }),
    revoke: async ({ id, owner_account_id }) =>
      await revokeExternalCredential({ id, owner_account_id }),
  };
  services.push(
    ...createInterBayExternalCredentialsHandlers({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startProjectLroService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectLroApi = {
    publishProgress: async (opts) =>
      await handleProjectLroPublishProgress(opts),
  };
  services.push(
    createInterBayProjectLroHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startProjectCollabInviteService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectCollabInviteApi = {
    upsertInbox: async ({ source_bay_id, invite }) => {
      await upsertProjectedCollabInviteDirect({ source_bay_id, invite });
    },
    deleteInbox: async ({ invite_id }) => {
      await deleteProjectedCollabInviteDirect(invite_id);
    },
    create: async (opts) => {
      const result = await createCollabInvite(opts);
      return {
        created: result.created,
        invite: collabInviteToWire(result.invite),
      };
    },
    inviteWithoutAccount: async (opts) => {
      const result = await inviteCollaboratorWithoutAccount(opts);
      return {
        email_sent: result.email_sent,
        email_available: result.email_available,
        manual_delivery_required: result.manual_delivery_required,
        email_blocked_reason: result.email_blocked_reason,
        invites: result.invites.map((invite) => collabInviteToWire(invite)),
      };
    },
    copyEmailLink: async (opts) => {
      const result = await copyEmailProjectInviteLink(opts);
      return {
        invite_id: result.invite_id,
        invite_url: result.invite_url,
        expires: result.expires ? new Date(result.expires).toISOString() : null,
      };
    },
    redeemEmail: async ({ trusted_product_access_checked, ...opts }) =>
      collabInviteToWire(
        await redeemEmailProjectInvite({
          ...opts,
          trustedProductAccessChecked: !!trusted_product_access_checked,
        }),
      ),
    previewEmail: async (opts) =>
      collabInviteToWire(await previewEmailProjectInvite(opts)),
    respondEmail: async ({ trusted_product_access_checked, ...opts }) =>
      collabInviteToWire(
        await respondEmailProjectInvite({
          ...opts,
          trustedProductAccessChecked: !!trusted_product_access_checked,
        }),
      ),
    list: async (opts) =>
      (await listCollabInvites(opts)).map((invite) =>
        collabInviteToWire(invite),
      ),
    repairAcceptedCourseStudentInviteAccounts: async (opts) =>
      await repairAcceptedCourseStudentInviteAccountsLocal({
        ...opts,
        trustedCourseAccess: true,
      }),
    ensureCourseManagerAccess: async (opts) =>
      await ensureCourseManagerAccessLocal({
        ...opts,
        trustedCourseAccess: true,
      }),
    getProjectAccessLandingInfo: async (opts) =>
      await getProjectAccessLandingInfo(opts),
    requestProjectAccess: async (opts) => await requestProjectAccess(opts),
    listProjectAccessRequests: async (opts) =>
      await listProjectAccessRequests(opts),
    respondProjectAccessRequest: async (opts) =>
      await respondProjectAccessRequest(opts),
    listProjectAccessRequestBlocks: async (opts) =>
      await listProjectAccessRequestBlocks(opts),
    unblockProjectAccessRequester: async (opts) =>
      await unblockProjectAccessRequester(opts),
    removeCollaborator: async (opts) => {
      await removeCollaborator(opts);
    },
    setProjectUserRole: async (opts) => {
      await setProjectUserRole(opts);
    },
    getUsage: async (opts) => {
      await assertLocalProjectCollaborator(opts);
      return await getProjectCollaboratorInviteUsage(opts.project_id);
    },
    leaveOrDeleteProjects: async ({ account_id, project_ids }) =>
      await leaveOrDeleteProjectsForAccount({
        account_id,
        project_ids,
      }),
    setProjectsHidden: async ({ account_id, project_ids, hide }) =>
      await setLocalProjectsHidden({
        account_id,
        project_ids,
        hide,
      }),
    setManageUsersOwnerOnly: async (opts) =>
      await setLocalProjectManageUsersOwnerOnly(opts),
    setDeletionProtection: async (opts) =>
      await setLocalProjectDeletionProtection(opts),
    respond: async ({
      account_id,
      invite_id,
      action,
      include_email,
      trusted_product_access_checked,
    }) =>
      collabInviteToWire(
        await respondCollabInviteCanonical({
          account_id,
          invite_id,
          action,
          includeEmail: !!include_email,
          trustedProductAccessChecked: !!trusted_product_access_checked,
        }),
      ),
  };
  services.push(
    ...createInterBayProjectCollabInviteHandlers({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startHostConnectionService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayHostConnectionApi = {
    get: async ({ account_id, host_id }) => {
      const connection = await resolveHostConnectionLocal({
        account_id,
        host_id,
      });
      if (!connection) {
        throw new Error("host not found");
      }
      return connection;
    },
    list: async (opts) =>
      await listHostsLocal({
        ...opts,
        // The source bay has already authenticated and authorized the user
        // before issuing this cluster-internal request.
        trusted_admin_view: true,
      }),
    listHostAccess: async (opts) => await listHostAccess(opts),
    setHostAccess: async (opts) => await setHostAccess(opts),
    removeHostAccess: async (opts) => await removeHostAccess(opts),
    setHostProjectRamLimit: async (opts) => await setHostProjectRamLimit(opts),
    setHostOwnerSpendLimits: async (opts) =>
      await setHostOwnerSpendLimits(opts),
    setHostPoolAccess: async (opts) => await setHostPoolAccess(opts),
    setHostDeletionProtection: async (opts) =>
      await setHostDeletionProtection(opts),
    getHostLog: async ({ account_id, id, limit }) =>
      await getHostLog({
        account_id,
        id,
        limit,
      }),
    getHostAvailability: async ({ account_id, id, days }) =>
      await getHostAvailability({
        account_id,
        id,
        days,
      }),
    annotateHostAvailabilityEvent: async (opts) =>
      await annotateHostAvailabilityEvent(opts),
    getHostRuntimeLog: async ({ account_id, id, lines, source }) =>
      await getHostRuntimeLog({
        account_id,
        id,
        lines,
        source,
      }),
    getHostMetricsHistory: async ({
      account_id,
      id,
      window_minutes,
      max_points,
    }) =>
      await getHostMetricsHistory({
        account_id,
        id,
        window_minutes,
        max_points,
      }),
    getHostRuntimeDeploymentStatus: async ({ account_id, id }) =>
      await getHostRuntimeDeploymentStatus({
        account_id,
        id,
      }),
    startHost: async ({ account_id, browser_id, session_hash, id }) =>
      await startHost({
        account_id,
        browser_id,
        session_hash,
        id,
      }),
    stopHost: async ({
      account_id,
      browser_id,
      session_hash,
      id,
      skip_backups,
    }) =>
      await stopHost({
        account_id,
        browser_id,
        session_hash,
        id,
        skip_backups,
      }),
    restartHost: async ({ account_id, browser_id, session_hash, id, mode }) =>
      await restartHost({
        account_id,
        browser_id,
        session_hash,
        id,
        mode,
      }),
    backupHostProjects: async ({ account_id, id, parallel }) =>
      await backupHostProjects({
        account_id,
        id,
        parallel,
      }),
    drainHost: async ({
      account_id,
      id,
      dest_host_id,
      force,
      allow_offline,
      parallel,
    }) =>
      await drainHost({
        account_id,
        id,
        dest_host_id,
        force,
        allow_offline,
        parallel,
      }),
    refreshHostCloudState: async ({ account_id, id }) =>
      await refreshHostCloudState({
        account_id,
        id,
      }),
    upgradeHostSoftware: async ({
      account_id,
      id,
      targets,
      base_url,
      align_runtime_stack,
    }) =>
      await upgradeHostSoftware({
        account_id,
        id,
        targets,
        base_url,
        align_runtime_stack,
      }),
    reconcileHostSoftware: async ({ account_id, id }) =>
      await reconcileHostSoftware({
        account_id,
        id,
      }),
    reconcileHostRuntimeDeployments: async ({
      account_id,
      id,
      components,
      reason,
    }) =>
      await reconcileHostRuntimeDeployments({
        account_id,
        id,
        components,
        reason,
      }),
    rollbackHostRuntimeDeployments: async ({
      account_id,
      id,
      target_type,
      target,
      version,
      last_known_good,
      reason,
    }) =>
      await rollbackHostRuntimeDeployments({
        account_id,
        id,
        target_type,
        target,
        version,
        last_known_good,
        reason,
      }),
    rolloutHostManagedComponents: async ({
      account_id,
      id,
      components,
      base_url,
      reason,
    }) =>
      await rolloutHostManagedComponents({
        account_id,
        id,
        components,
        base_url,
        reason,
      }),
    deleteHost: async ({
      account_id,
      browser_id,
      session_hash,
      id,
      skip_backups,
    }) =>
      await deleteHost({
        account_id,
        browser_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
        skip_backups,
      }),
    forceDeprovisionHost: async ({
      account_id,
      browser_id,
      session_hash,
      id,
    }) =>
      await forceDeprovisionHost({
        account_id,
        browser_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
      }),
    removeSelfHostConnector: async ({
      account_id,
      browser_id,
      session_hash,
      id,
    }) =>
      await removeSelfHostConnector({
        account_id,
        browser_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
      }),
    listHostRootfsImages: async ({ account_id, id }) =>
      await listHostRootfsImages({
        account_id,
        id,
      }),
    pullHostRootfsImage: async ({ account_id, session_hash, id, image }) =>
      await pullHostRootfsImage({
        account_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
        image,
      }),
    deleteHostRootfsImage: async ({ account_id, session_hash, id, image }) =>
      await deleteHostRootfsImage({
        account_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
        image,
      }),
    gcDeletedHostRootfsImages: async ({ account_id, session_hash, id }) =>
      await gcDeletedHostRootfsImages({
        account_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
      }),
    listHostSshAuthorizedKeys: async ({ account_id, id }) =>
      await listHostSshAuthorizedKeys({
        account_id,
        id,
      }),
    addHostSshAuthorizedKey: async ({
      account_id,
      session_hash,
      id,
      public_key,
      user,
    }) =>
      await addHostSshAuthorizedKey({
        account_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
        public_key,
        user,
      }),
    removeHostSshAuthorizedKey: async ({
      account_id,
      session_hash,
      id,
      public_key,
    }) =>
      await removeHostSshAuthorizedKey({
        account_id,
        session_hash,
        internalAuth: HOST_DANGEROUS_INTERNAL_AUTH,
        id,
        public_key,
      }),
    listHostRuntimeDeployments: async ({ account_id, scope_type, id }) =>
      await listHostRuntimeDeployments({
        account_id,
        scope_type,
        id,
      }),
    setHostRuntimeDeployments: async ({
      account_id,
      scope_type,
      id,
      deployments,
      replace,
    }) =>
      await setHostRuntimeDeployments({
        account_id,
        scope_type,
        id,
        deployments,
        replace,
      }),
    getHostManagedComponentStatus: async ({ account_id, id }) =>
      await getHostManagedComponentStatus({
        account_id,
        id,
      }),
    getProjectStartMetadata: async ({ host_id, project_id }) => {
      const metadata = await getProjectStartMetadataLocal({
        host_id,
        project_id,
      });
      if (!metadata) {
        throw new Error(
          `project ${project_id} is not assigned to host ${host_id} or is unavailable`,
        );
      }
      return metadata;
    },
    getBackupConfig: async ({
      host_id,
      project_id,
      host_region,
      host_machine,
    }) =>
      await getBackupConfigLocal({
        host_id,
        project_id,
        host_region,
        host_machine,
      }),
    getSeedBackupConfig: async ({
      project_id,
      project_region,
      backup_repo_id,
      preferred_backup_repo_id,
    }) =>
      await getSeedProjectBackupConfig({
        project_id,
        project_region,
        backup_repo_id,
        preferred_backup_repo_id,
      }),
    resolveSeedBackupRepoAssignment: async ({
      project_id,
      project_region,
      backup_repo_id,
      preferred_backup_repo_id,
    }) =>
      await resolveProjectBackupRepoAssignment({
        project_id,
        project_region,
        backup_repo_id,
        preferred_backup_repo_id,
      }),
    releaseSeedBackupRepoAssignment: async ({ project_id }) =>
      await releaseProjectBackupRepoAssignment({
        project_id,
      }),
    releaseSeedProjectAppPublicSubdomains: async ({ project_id }) =>
      await releaseProjectAppPublicSubdomainsForProject({ project_id }),
    getSeedProjectBackupShards: async (opts = {}) =>
      await getProjectBackupShardAdminStatus({
        region: opts.region,
      }),
    getProjectOwnerEffectiveLimits: async ({ host_id, project_id }) =>
      await getProjectOwnerEffectiveLimitsLocal({
        host_id,
        project_id,
      }),
    getAccountEffectiveLimits: async ({ host_id, account_id }) =>
      await getAccountEffectiveLimitsLocal({
        host_id,
        account_id,
      }),
    recordAcpAdmissionDenial: async (opts) =>
      await recordAcpAdmissionDenialLocal(opts),
    recordServiceAdmissionDenial: async (opts) =>
      await recordServiceAdmissionDenialLocal(opts),
    recordServiceAdmissionNearLimit: async (opts) =>
      await recordServiceAdmissionNearLimitLocal(opts),
    recordProjectBackup: async ({ host_id, project_id, time, generation }) =>
      await recordProjectBackupLocal({
        host_id,
        project_id,
        time,
        generation,
      }),
    markProjectChanged: async ({
      host_id,
      project_id,
      changed_at,
      generation,
    }) =>
      await markProjectChangedLocal({
        host_id,
        project_id,
        changed_at,
        generation,
      }),
    recordProjectBackupIndex: async ({
      host_id,
      project_id,
      backup_id,
      backup_time,
      status,
      storage_backend,
      object_key,
      compression,
      sqlite_bytes,
      object_bytes,
      sha256,
      error,
    }) =>
      await recordProjectBackupIndexLocal({
        host_id,
        project_id,
        backup_id,
        backup_time,
        status,
        storage_backend,
        object_key,
        compression,
        sqlite_bytes,
        object_bytes,
        sha256,
        error,
      }),
    getProjectBackupIndexes: async ({ host_id, project_id }) =>
      await getProjectBackupIndexesLocal({ host_id, project_id }),
    syncProjectBackupIndexes: async ({ host_id, project_id, backup_ids }) =>
      await syncProjectBackupIndexesLocal({ host_id, project_id, backup_ids }),
    deleteProjectBackupIndex: async ({ host_id, project_id, backup_id }) =>
      await deleteProjectBackupIndexLocal({ host_id, project_id, backup_id }),
    listHostProjects: async ({
      account_id,
      id,
      limit,
      cursor,
      risk_only,
      state_filter,
      project_state,
    }) =>
      await listHostProjects({
        account_id,
        id,
        limit,
        cursor,
        risk_only,
        state_filter,
        project_state,
      }),
    ensureHostOwnerSshTrust: async ({ account_id, host_id, host }) =>
      await ensureHostOwnerSshTrustOnBay({
        account_id,
        host_id,
        host,
      }),
    rehomeHost: async ({
      account_id,
      host_id,
      dest_bay_id,
      reason,
      campaign_id,
    }) =>
      await rehomeHostOnOwningBay({
        account_id,
        host_id,
        dest_bay_id,
        reason,
        campaign_id,
      }),
    prepareHostRehome: async (opts) =>
      await prepareHostRehomeOnDestination(opts),
    acceptHostRehome: async (opts) => await acceptHostRehome(opts),
    reconnectHostRehome: async (opts) =>
      await reconnectHostRehomeOnDestination(opts),
    recordHostRehomeLog: async (opts) =>
      await recordHostRehomeLogOnDestination(opts),
  };
  services.push(
    ...createInterBayHostConnectionHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startHostControlService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const getHostClient = async (host_id: string, timeout: number) =>
    await getRoutedHostControlClient({
      host_id,
      timeout,
    });
  const impl: InterBayHostControlApi = {
    createProject: async ({ account_id, host_id, create }) => {
      const connection = await resolveHostConnectionLocal({
        account_id,
        host_id,
      });
      if (!connection?.can_place) {
        throw new Error("not allowed to place a project on that host");
      }
      const hostClient = await getHostClient(host_id, 15_000);
      return await hostClient.createProject(create);
    },
    startProject: async ({ host_id, start }) =>
      await (await getHostClient(host_id, 60 * 60 * 1000)).startProject(start),
    stopProject: async ({ host_id, stop }) =>
      await (await getHostClient(host_id, 30_000)).stopProject(stop),
    getProjectStatus: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getProjectStatus(get),
    updateAuthorizedKeys: async ({ host_id, update }) =>
      await (await getHostClient(host_id, 30_000)).updateAuthorizedKeys(update),
    updateProjectUsers: async ({ host_id, update }) =>
      await (await getHostClient(host_id, 30_000)).updateProjectUsers(update),
    syncProjectSecretsCache: async ({ host_id, sync }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).syncProjectSecretsCache(sync),
    setupProjectSecretSshKey: async ({ host_id, setup }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).setupProjectSecretSshKey(setup),
    applyPendingCopies: async ({ host_id, apply }) =>
      await (await getHostClient(host_id, 30_000)).applyPendingCopies(apply),
    deleteProjectData: async ({ host_id, del }) =>
      await (await getHostClient(host_id, 30_000)).deleteProjectData(del),
    upgradeSoftware: async ({ host_id, upgrade }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).upgradeSoftware(upgrade),
    rolloutManagedComponents: async ({ host_id, rollout }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).rolloutManagedComponents(rollout),
    growBtrfs: async ({ host_id, grow }) =>
      await (await getHostClient(host_id, 10 * 60 * 1000)).growBtrfs(grow),
    growSharedScratch: async ({ host_id, grow }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).growSharedScratch(grow),
    unmountSharedScratch: async ({ host_id, unmount }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).unmountSharedScratch(unmount),
    getRuntimeLog: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getRuntimeLog(get),
    getProjectRuntimeLog: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getProjectRuntimeLog(get),
    startRootfsBuild: async ({ host_id, start }) =>
      await (await getHostClient(host_id, 30_000)).startRootfsBuild(start),
    getRootfsBuildStatus: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getRootfsBuildStatus(get),
    getRootfsBuildLog: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getRootfsBuildLog(get),
    cancelRootfsBuild: async ({ host_id, cancel }) =>
      await (await getHostClient(host_id, 30_000)).cancelRootfsBuild(cancel),
    listRootfsImages: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).listRootfsImages(),
    pullRootfsImage: async ({ host_id, pull }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).pullRootfsImage(pull),
    deleteRootfsImage: async ({ host_id, del }) =>
      await (await getHostClient(host_id, 30_000)).deleteRootfsImage(del),
    scanRootfsRelease: async ({ host_id, scan }) =>
      await (
        await getHostClient(host_id, scan.timeout_ms ?? 30 * 60 * 1000)
      ).scanRootfsRelease(scan),
    scanProjectRootfs: async ({ host_id, scan }) =>
      await (
        await getHostClient(host_id, scan.timeout_ms ?? 30 * 60 * 1000)
      ).scanProjectRootfs(scan),
    listHostSshAuthorizedKeys: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).listHostSshAuthorizedKeys(),
    addHostSshAuthorizedKey: async ({ host_id, add }) =>
      await (await getHostClient(host_id, 30_000)).addHostSshAuthorizedKey(add),
    removeHostSshAuthorizedKey: async ({ host_id, remove }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).removeHostSshAuthorizedKey(remove),
    getBackupExecutionStatus: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).getBackupExecutionStatus(),
    invalidateBackupConfig: async ({ host_id, invalidate }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).invalidateBackupConfig(invalidate),
    getManagedComponentStatus: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).getManagedComponentStatus(),
    getInstalledRuntimeArtifacts: async ({ host_id, get }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).getInstalledRuntimeArtifacts(get),
    getHostAgentStatus: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).getHostAgentStatus(),
    inspectStaticAppPath: async ({ host_id, inspect }) =>
      await (
        await getHostClient(host_id, 30_000)
      ).inspectStaticAppPath(inspect),
    buildRootfsImageManifest: async ({ host_id, build }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).buildRootfsImageManifest(build),
    buildProjectRootfsManifest: async ({ host_id, build }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).buildProjectRootfsManifest(build),
  };
  services.push(
    ...createInterBayHostControlHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}

async function startProjectHostAuthTokenService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectHostAuthTokenApi = {
    issue: async ({
      account_id,
      actor,
      host_id,
      project_id,
      public_directory_share_id,
      ttl_seconds,
    }) =>
      await issueProjectHostAuthTokenLocal({
        account_id,
        actor,
        host_id,
        project_id,
        public_directory_share_id,
        ttl_seconds,
      }),
  };
  services.push(
    createInterBayProjectHostAuthTokenHandler({
      client,
      bay_id: getConfiguredBayId(),
      parallel: true,
      impl,
    }),
  );
}
