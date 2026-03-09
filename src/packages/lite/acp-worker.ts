import { rmSync, writeFileSync } from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { connect } from "@cocalc/conat/core/client";
import { setConatClient } from "@cocalc/conat/client";
import { disposeAcpAgents, runDetachedAcpQueueWorker } from "./hub/acp";

const logger = getLogger("lite:acp-worker");

function readRequiredEnv(name: string): string {
  const value = `${process.env[name] ?? ""}`.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function registerPidFile(
  pidFile: string,
  onShutdown: () => Promise<void>,
): void {
  writeFileSync(pidFile, `${process.pid}\n`);
  const cleanup = () => {
    try {
      rmSync(pidFile, { force: true });
    } catch {
      // ignore
    }
  };
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void onShutdown()
      .catch((err) => {
        logger.warn("ACP worker shutdown failed", err);
      })
      .finally(() => {
        cleanup();
        process.exit(0);
      });
  };
  process.once("exit", cleanup);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function main(): Promise<void> {
  const conatPassword = readRequiredEnv("COCALC_LITE_ACP_WORKER_CONAT_PASSWORD");
  const pidFile = readRequiredEnv("COCALC_LITE_ACP_WORKER_PID_FILE");
  const conatServer = readRequiredEnv("CONAT_SERVER");
  setConatPassword(conatPassword);
  const createConatClient = () =>
    connect({
      address: conatServer,
      path: "/",
      systemAccountPassword: conatPassword,
      noCache: true,
    });
  setConatClient({
    conat: createConatClient,
    getLogger,
  });
  const client = createConatClient();
  registerPidFile(pidFile, async () => {
    await disposeAcpAgents();
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  });
  try {
    await runDetachedAcpQueueWorker(client);
  } finally {
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      logger.error("ACP worker failed", err);
      process.exit(1);
    });
}
