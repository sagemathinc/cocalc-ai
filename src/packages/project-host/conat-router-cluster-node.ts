/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@cocalc/backend/conat/persist";
import { getLogger } from "@cocalc/backend/logger";
import { init, type Options } from "@cocalc/conat/core/server";
import { resolveProjectHostId } from "./host-id";
import { createProjectHostConatAuth } from "./conat-auth";

const logger = getLogger("project-host:conat-router-cluster-node");

export async function main(): Promise<void> {
  process.on("message", async (opts: Options) => {
    const hostId = resolveProjectHostId();
    const conatAuth = createProjectHostConatAuth({ host_id: hostId });
    const logPayload = {
      ...opts,
      systemAccountPassword: "•".repeat(
        opts.systemAccountPassword?.length ?? 0,
      ),
      hostId,
    };
    logger.debug("starting project-host conat router cluster node", logPayload);
    init({
      ...(opts as Options),
      getUser: conatAuth.getUser,
      isAllowed: conatAuth.isAllowed,
    });
  });
}
