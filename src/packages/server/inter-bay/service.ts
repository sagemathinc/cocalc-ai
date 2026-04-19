/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAuthTokenHandlers,
  createInterBayAccountProjectFeedHandlers,
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
  createInterBayBayDirectoryHandlers,
  createInterBayDirectoryHandlers,
  createInterBayProjectControlHandler,
  createInterBayProjectControlMoveHandler,
  createInterBayProjectControlRestartHandler,
  createInterBayProjectControlStateHandler,
  createInterBayProjectLroHandler,
  createInterBayProjectReferenceHandler,
  createInterBayProjectControlStopHandler,
  type InterBayAuthTokenApi,
  type InterBayAccountProjectFeedApi,
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
  getClusterAccountByEmail,
  getClusterAccountById,
  getClusterAccountHomeBayCounts,
  getClusterAccountsByIds,
  provisionLocalClusterAccount,
  searchClusterAccounts,
} from "@cocalc/server/inter-bay/accounts";
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
  handleProjectControlMove,
  handleProjectControlRestart,
  handleProjectControlStart,
  handleProjectControlState,
  handleProjectDetailsGet,
  handleProjectLroPublishProgress,
  handleProjectReferenceGet,
  handleProjectControlStop,
} from "@cocalc/server/inter-bay/project-control";
import {
  getProjectStartMetadataLocal,
  listHostProjectsLocalSnapshot,
  issueProjectHostAuthTokenLocal,
  listHostsLocal,
  resolveHostConnectionLocal,
} from "@cocalc/server/conat/api/hosts";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  deleteProjectedCollabInviteDirect,
  toWire as collabInviteToWire,
  upsertProjectedCollabInviteDirect,
} from "@cocalc/server/projects/collab-invite-inbox";
import { respondCollabInviteCanonical } from "@cocalc/server/projects/collaborators";

const logger = getLogger("server:inter-bay:service");

let serviceStarted = false;
let services: ConatService[] = [];

export async function initInterBayServices(): Promise<void> {
  if (serviceStarted) {
    return;
  }
  serviceStarted = true;
  try {
    await startDirectoryService();
    await startAuthTokenService();
    await startBayRegistryService();
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
    resolveHostBay: async ({ host_id }) =>
      await resolveHostBayDirect(`${host_id ?? ""}`),
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
        resolveHostBay: async ({ host_id }) =>
          await resolveHostBayAcrossCluster(`${host_id ?? ""}`),
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
    create: async (opts) => await createClusterAccount(opts),
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
  };
  services.push(
    createInterBayAccountLocalHandler({
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
    state: async (opts) => await handleProjectControlState(opts),
    address: async (opts) => await handleProjectControlAddress(opts),
    move: async (opts) => await handleProjectControlMove(opts),
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
    createInterBayProjectControlStateHandler({
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
    list: async (opts) => await listHostsLocal(opts),
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
    listHostProjects: async ({ id, risk_only, state_filter, project_state }) =>
      await listHostProjectsLocalSnapshot({
        id,
        risk_only,
        state_filter,
        project_state,
      }),
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
    issue: async ({ account_id, host_id, project_id, ttl_seconds }) =>
      await issueProjectHostAuthTokenLocal({
        account_id,
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
