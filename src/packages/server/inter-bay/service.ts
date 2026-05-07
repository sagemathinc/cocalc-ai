/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAuthTokenHandlers,
  createInterBayAccountProjectFeedHandlers,
  createInterBayBayOpsHandlers,
  createInterBayBayRegistryHandlers,
  createInterBayAccountDirectoryHandlers,
  createInterBayAccountLocalHandler,
  createInterBayProjectCollabInviteHandlers,
  createInterBayProjectDetailsHandler,
  createInterBayHostConnectionHandler,
  createInterBayHostControlHandler,
  createInterBayProjectHostAuthTokenHandler,
  createInterBayProjectControlAddressHandler,
  createInterBayProjectControlActiveOpHandler,
  createInterBayProjectControlBackupHandler,
  createInterBayBayDirectoryHandlers,
  createInterBayDirectoryHandlers,
  createInterBayProjectControlHandler,
  createInterBayProjectControlAcceptRehomeHandler,
  createInterBayProjectControlSetUsageAccountHandler,
  createInterBayProjectControlMoveHandler,
  createInterBayProjectControlRehomeHandler,
  createInterBayProjectControlRestartHandler,
  createInterBayProjectControlStateHandler,
  createInterBayProjectLroHandler,
  createInterBayProjectReferenceHandler,
  createInterBayProjectControlStopHandler,
  type InterBayAuthTokenApi,
  type InterBayAccountProjectFeedApi,
  type InterBayBayOpsApi,
  type InterBayBayRegistryApi,
  type InterBayAccountDirectoryApi,
  type InterBayAccountLocalApi,
  type InterBayDirectoryApi,
  type InterBayProjectCollabInviteApi,
  type InterBayProjectDetailsApi,
  type InterBayHostConnectionApi,
  type InterBayHostControlApi,
  type InterBayProjectHostAuthTokenApi,
  type InterBayProjectControlApi,
  type InterBayProjectLroApi,
  type InterBayProjectReferenceApi,
} from "@cocalc/conat/inter-bay/api";
import type { ConatService } from "@cocalc/conat/service/typed";
import getLogger from "@cocalc/backend/logger";
import { getRequiresTokensDirect } from "@cocalc/server/auth/tokens/get-requires-token";
import {
  disableRegistrationTokenDirect,
  redeemRegistrationTokenDirect,
} from "@cocalc/server/auth/tokens/redeem";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import {
  listBayRegistryLocal,
  registerBayPresenceLocal,
  startBayRegistrationHeartbeat,
} from "@cocalc/server/bay-registry";
import { startManagedBayCloudflared } from "@cocalc/server/bay-cloudflared";
import {
  applyAccountProjectFeedRemoveOnHomeBay,
  applyAccountProjectFeedUpsertOnHomeBay,
} from "@cocalc/server/account/project-feed";
import {
  createClusterAccount,
  deleteClusterAccountApiKeyDirectoryEntry,
  deleteClusterAccount,
  deleteLocalClusterAccount,
  getClusterAccountApiKeyByKeyId,
  getClusterAccountByEmail,
  getClusterAccountById,
  getClusterAccountHomeBayCounts,
  getClusterAccountsByIds,
  provisionLocalClusterAccount,
  searchClusterAccounts,
  touchClusterAccountApiKeyDirectoryEntry,
  updateClusterAccountApiKeysHomeBay,
  updateClusterAccountHomeBay,
  upsertClusterAccountApiKeyDirectoryEntry,
} from "@cocalc/server/inter-bay/accounts";
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
import {
  activateMembershipClaimIdentityDirect,
  getMembershipClaimIdentityDirect,
  reserveMembershipClaimIdentityDirect,
  revokeMembershipClaimIdentityDirect,
} from "@cocalc/server/membership/claim-directory";
import {
  claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay,
  listLocalClaimableMembershipPackagesForVerifiedEmails,
  listMembershipPackageDetailsForOwner,
} from "@cocalc/server/membership/packages";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "@cocalc/server/membership/resolve";
import { getDedicatedHostPolicySnapshotLocal } from "@cocalc/server/project-host/admission";
import {
  resolveHostBayAcrossCluster,
  resolveHostBayDirect,
  resolveProjectBayAcrossCluster,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  handleProjectControlAddress,
  handleProjectControlActiveOperation,
  handleProjectControlBackup,
  handleProjectControlAcceptRehome,
  handleProjectControlSetUsageAccount,
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
  deleteHost,
  deleteHostRootfsImage,
  drainHost,
  forceDeprovisionHost,
  gcDeletedHostRootfsImages,
  getBackupConfigLocal,
  getHostLog,
  getHostManagedComponentStatus,
  getHostMetricsHistory,
  getHostRuntimeDeploymentStatus,
  getHostRuntimeLog,
  getProjectOwnerEffectiveLimitsLocal,
  getProjectStartMetadataLocal,
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
  listHostProjects,
  listHostRuntimeDeployments,
  pullHostRootfsImage,
  issueProjectHostAuthTokenLocal,
  listHostsLocal,
  recordProjectBackupIndexLocal,
  recordProjectBackupLocal,
  resolveHostConnectionLocal,
  setHostRuntimeDeployments,
  getProjectBackupIndexesLocal,
  syncProjectBackupIndexesLocal,
  deleteProjectBackupIndexLocal,
} from "@cocalc/server/conat/api/hosts";
import {
  getProjectBackupShardAdminStatus,
  getSeedProjectBackupConfig,
  releaseProjectBackupRepoAssignment,
  resolveProjectBackupRepoAssignment,
} from "@cocalc/server/project-backup";
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
import {
  createCollabInvite,
  listCollabInvites,
  removeCollaborator,
  respondCollabInviteCanonical,
} from "@cocalc/server/projects/collaborators";
import {
  BAY_OPS_INTERNAL_AUTH,
  getBayBackups,
  getBayLoad,
} from "@cocalc/server/conat/api/system";

const logger = getLogger("server:inter-bay:service");

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
    await startProjectControlStartService();
    await startProjectReferenceService();
    await startProjectDetailsService();
    await startHostConnectionService();
    await startHostControlService();
    await startProjectHostAuthTokenService();
    await startProjectLroService();
    await startProjectCollabInviteService();
    startBayRegistrationHeartbeat();
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
    redeem: async ({ token }) =>
      (await redeemRegistrationTokenDirect(token)) ?? null,
    disable: async ({ token }) => {
      await disableRegistrationTokenDirect(token);
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
    getHomeBayCounts: async () => await getClusterAccountHomeBayCounts(),
    updateHomeBay: async (opts) => await updateClusterAccountHomeBay(opts),
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
    getDedicatedHostPolicySnapshot: async ({ account_id }) =>
      await getDedicatedHostPolicySnapshotLocal(account_id),
    getMembershipPackages: async ({ owner_account_id }) =>
      await listMembershipPackageDetailsForOwner({
        owner_account_id,
      }),
    getClaimableMembershipPackages: async ({
      account_id,
      verified_email_addresses,
    }) =>
      await listLocalClaimableMembershipPackagesForVerifiedEmails({
        account_id,
        verified_email_addresses,
      }),
    claimMembershipPackageSeat: async ({
      package_id,
      account_id,
      verified_email_addresses,
    }) =>
      await claimMembershipPackageSeatWithVerifiedEmailsOnLocalBay({
        package_id,
        account_id,
        verified_email_addresses,
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

async function startProjectControlStartService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectControlApi = {
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
    list: async (opts) =>
      (await listCollabInvites(opts)).map((invite) =>
        collabInviteToWire(invite),
      ),
    removeCollaborator: async (opts) => {
      await removeCollaborator(opts);
    },
    respond: async ({ account_id, invite_id, action, include_email }) =>
      collabInviteToWire(
        await respondCollabInviteCanonical({
          account_id,
          invite_id,
          action,
          includeEmail: !!include_email,
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
    getHostLog: async ({ account_id, id, limit }) =>
      await getHostLog({
        account_id,
        id,
        limit,
      }),
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
    startHost: async ({ account_id, id }) =>
      await startHost({
        account_id,
        id,
      }),
    stopHost: async ({ account_id, id, skip_backups }) =>
      await stopHost({
        account_id,
        id,
        skip_backups,
      }),
    restartHost: async ({ account_id, id, mode }) =>
      await restartHost({
        account_id,
        id,
        mode,
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
      reason,
    }) =>
      await rolloutHostManagedComponents({
        account_id,
        id,
        components,
        reason,
      }),
    deleteHost: async ({ account_id, id, skip_backups }) =>
      await deleteHost({
        account_id,
        id,
        skip_backups,
      }),
    forceDeprovisionHost: async ({ account_id, id }) =>
      await forceDeprovisionHost({
        account_id,
        id,
      }),
    removeSelfHostConnector: async ({ account_id, id }) =>
      await removeSelfHostConnector({
        account_id,
        id,
      }),
    listHostRootfsImages: async ({ account_id, id }) =>
      await listHostRootfsImages({
        account_id,
        id,
      }),
    pullHostRootfsImage: async ({ account_id, id, image }) =>
      await pullHostRootfsImage({
        account_id,
        id,
        image,
      }),
    deleteHostRootfsImage: async ({ account_id, id, image }) =>
      await deleteHostRootfsImage({
        account_id,
        id,
        image,
      }),
    gcDeletedHostRootfsImages: async ({ account_id, id }) =>
      await gcDeletedHostRootfsImages({
        account_id,
        id,
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
    getSeedProjectBackupShards: async (opts = {}) =>
      await getProjectBackupShardAdminStatus({
        region: opts.region,
      }),
    getProjectOwnerEffectiveLimits: async ({ host_id, project_id }) =>
      await getProjectOwnerEffectiveLimitsLocal({
        host_id,
        project_id,
      }),
    recordProjectBackup: async ({ host_id, project_id, time }) =>
      await recordProjectBackupLocal({ host_id, project_id, time }),
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
    getRuntimeLog: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getRuntimeLog(get),
    getProjectRuntimeLog: async ({ host_id, get }) =>
      await (await getHostClient(host_id, 30_000)).getProjectRuntimeLog(get),
    listRootfsImages: async ({ host_id }) =>
      await (await getHostClient(host_id, 30_000)).listRootfsImages(),
    pullRootfsImage: async ({ host_id, pull }) =>
      await (
        await getHostClient(host_id, 10 * 60 * 1000)
      ).pullRootfsImage(pull),
    deleteRootfsImage: async ({ host_id, del }) =>
      await (await getHostClient(host_id, 30_000)).deleteRootfsImage(del),
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
    issue: async ({ account_id, actor, host_id, project_id, ttl_seconds }) =>
      await issueProjectHostAuthTokenLocal({
        account_id,
        actor,
        host_id,
        project_id,
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
