/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPort from "@cocalc/backend/get-port";
import basePath from "@cocalc/backend/base-path";
import { init as createConatServer } from "@cocalc/conat/core/server";
import { once } from "@cocalc/util/async-utils";
import { getUser, isAllowed } from "@cocalc/server/conat/socketio/auth";
import { join } from "node:path";

const logger = getLogger("server:inter-bay:dev-fabric");

async function main() {
  const requestedPort = Number.parseInt(
    process.env.COCALC_INTER_BAY_FABRIC_PORT ?? "",
    10,
  );
  const port = Number.isFinite(requestedPort) ? requestedPort : await getPort();
  const server = createConatServer({
    port,
    path: join(basePath, "conat"),
    ssl: false,
    httpServer: undefined,
    getUser,
    isAllowed,
  });
  if (server.state !== "ready") {
    await once(server, "ready");
  }
  logger.info("inter-bay dev fabric ready", {
    address: server.address(),
    port,
  });
  console.log(server.address());

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
}

void main().catch((err) => {
  logger.error("inter-bay dev fabric failed", { err: `${err}` });
  process.exit(1);
});
