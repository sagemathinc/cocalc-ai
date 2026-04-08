/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayDirectoryHandlers,
  createInterBayProjectControlHandler,
  createInterBayProjectReferenceHandler,
  createInterBayProjectControlStopHandler,
  type InterBayDirectoryApi,
  type InterBayProjectControlApi,
  type InterBayProjectReferenceApi,
} from "@cocalc/conat/inter-bay/api";
import type { ConatService } from "@cocalc/conat/service/typed";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";
import {
  resolveHostBayDirect,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  handleProjectControlStart,
  handleProjectReferenceGet,
  handleProjectControlStop,
} from "@cocalc/server/inter-bay/project-control";

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
    await startProjectControlStartService();
    await startProjectReferenceService();
  } catch (err) {
    serviceStarted = false;
    throw err;
  }
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

async function startProjectControlStartService(): Promise<void> {
  const client = getInterBayFabricClient({ noCache: true });
  const impl: InterBayProjectControlApi = {
    start: async (opts) => {
      await handleProjectControlStart(opts);
    },
    stop: async (opts) => {
      await handleProjectControlStop(opts);
    },
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
