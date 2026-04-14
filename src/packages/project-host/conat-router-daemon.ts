/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { getOrCreateProjectHostConatPassword } from "./local-conat-password";
import { resolveProjectHostId } from "./host-id";
import { startStandaloneProjectHostConatRouter } from "./conat-router";

const logger = getLogger("project-host:conat-router-daemon");

export interface ProjectHostConatRouterDaemonContext {
  host: string;
  port: number;
}

export async function main(): Promise<ProjectHostConatRouterDaemonContext> {
  const hostId = resolveProjectHostId();
  const systemAccountPassword = getOrCreateProjectHostConatPassword();
  setConatPassword(systemAccountPassword);
  const { host, port, httpServer, conatServer } =
    await startStandaloneProjectHostConatRouter({
      hostId,
      systemAccountPassword,
    });
  logger.info("project-host conat router daemon ready", {
    hostId,
    host,
    port,
    address: conatServer.address(),
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await conatServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };
  const closeWithSignal = (signal: string) => {
    logger.info("stopping project-host conat router daemon", { signal });
    void close()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        logger.warn("failed stopping project-host conat router daemon", {
          signal,
          err: `${err}`,
        });
        process.exit(1);
      });
  };
  process.once("exit", () => {
    void close();
  });
  ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) =>
    process.once(sig, () => closeWithSignal(sig)),
  );

  return { host, port };
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("project-host conat router daemon failed", err);
    process.exit(1);
  });
}
