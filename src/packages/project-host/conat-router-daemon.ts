/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { getOrCreateProjectHostConatPassword } from "./local-conat-password";
import { resolveProjectHostId } from "./host-id";
import { startStandaloneProjectHostConatRouter } from "./conat-router";
import { startConatRouterTrafficMetricsLoop } from "./conat-router-metrics";
import { startEventLoopStallMonitor } from "./event-loop-stalls";

const logger = getLogger("project-host:conat-router-daemon");

export interface ProjectHostConatRouterDaemonContext {
  host: string;
  port: number;
}

export async function main(): Promise<ProjectHostConatRouterDaemonContext> {
  const stopEventLoopStallMonitor = startEventLoopStallMonitor({
    loggerName: "project-host:conat-router-daemon:event-loop-stalls",
    label: "project-host conat router daemon",
  });
  const hostId = resolveProjectHostId();
  const systemAccountPassword = getOrCreateProjectHostConatPassword();
  setConatPassword(systemAccountPassword);
  const { host, port, httpServer, conatServer, ingressHttpServer } =
    await startStandaloneProjectHostConatRouter({
      hostId,
      systemAccountPassword,
    });
  const stopTrafficMetricsLoop = startConatRouterTrafficMetricsLoop({
    conatServer,
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
    try {
      await conatServer.close();
    } finally {
      stopTrafficMetricsLoop();
      stopEventLoopStallMonitor();
      if (ingressHttpServer) {
        await new Promise<void>((resolve) => {
          ingressHttpServer.close(() => resolve());
        });
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
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
