/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAuthTokenHandlers,
  createInterBayAccountProjectFeedHandlers,
  createInterBayAccountDirectoryHandlers,
  createInterBayAccountLocalHandler,
  createInterBayProjectCollabInviteHandlers,
  createInterBayProjectControlAddressHandler,
  createInterBayProjectControlActiveOpHandler,
  createInterBayDirectoryHandlers,
  createInterBayProjectControlHandler,
  createInterBayProjectControlRestartHandler,
  createInterBayProjectControlStateHandler,
  createInterBayProjectLroHandler,
  createInterBayProjectReferenceHandler,
  createInterBayProjectControlStopHandler,
  type InterBayAuthTokenApi,
  type InterBayAccountProjectFeedApi,
  type InterBayAccountDirectoryApi,
  type InterBayAccountLocalApi,
  type InterBayDirectoryApi,
  type InterBayProjectCollabInviteApi,
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
  applyAccountProjectFeedRemoveOnHomeBay,
  applyAccountProjectFeedUpsertOnHomeBay,
} from "@cocalc/server/account/project-feed";
import {
  createClusterAccount,
  getClusterAccountByEmail,
  getClusterAccountById,
  getClusterAccountsByIds,
  provisionLocalClusterAccount,
  searchClusterAccounts,
} from "@cocalc/server/inter-bay/accounts";
import {
  resolveHostBayDirect,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  handleProjectControlAddress,
  handleProjectControlActiveOperation,
  handleProjectControlRestart,
  handleProjectControlStart,
  handleProjectControlState,
  handleProjectLroPublishProgress,
  handleProjectReferenceGet,
  handleProjectControlStop,
} from "@cocalc/server/inter-bay/project-control";
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
    await startAccountDirectoryService();
    await startAccountLocalService();
    await startAccountProjectFeedService();
    await startProjectControlStartService();
    await startProjectReferenceService();
    await startProjectLroService();
    await startProjectCollabInviteService();
  } catch (err) {
    serviceStarted = false;
    throw err;
  }
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
  const role = getConfiguredClusterRole();
  if (role === "attached") {
    return;
  }
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayDirectoryApi = {
    resolveProjectBay: async ({ project_id }) =>
      await resolveProjectBayDirect(`${project_id ?? ""}`),
    resolveHostBay: async ({ host_id }) =>
      await resolveHostBayDirect(`${host_id ?? ""}`),
  };
  services.push(
    ...createInterBayDirectoryHandlers({
      client,
      parallel: true,
      impl,
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
