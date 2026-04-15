/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { getOrCreateProjectHostConatPassword } from "./local-conat-password";
import { startStandaloneProjectHostConatPersist } from "./conat-persist";
import { startEventLoopStallMonitor } from "./event-loop-stalls";

const logger = getLogger("project-host:conat-persist-daemon");

export interface ProjectHostConatPersistDaemonContext {
  host: string;
  id: string;
  port: number;
}

export async function main(): Promise<ProjectHostConatPersistDaemonContext> {
  const stopEventLoopStallMonitor = startEventLoopStallMonitor({
    loggerName: "project-host:conat-persist-daemon:event-loop-stalls",
    label: "project-host conat persist daemon",
  });
  const systemAccountPassword = getOrCreateProjectHostConatPassword();
  setConatPassword(systemAccountPassword);
  const { host, port, id, client, httpServer, persistServer } =
    await startStandaloneProjectHostConatPersist({
      systemAccountPassword,
    });
  logger.info("project-host conat persist daemon ready", {
    host,
    id,
    port,
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await persistServer.end();
    } finally {
      stopEventLoopStallMonitor();
      try {
        client.close();
      } catch {
        // ignore close errors during shutdown
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };
  const closeWithSignal = (signal: string) => {
    logger.info("stopping project-host conat persist daemon", { signal });
    void close()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        logger.warn("failed stopping project-host conat persist daemon", {
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

  return { host, id, port };
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("project-host conat persist daemon failed", err);
    process.exit(1);
  });
}
