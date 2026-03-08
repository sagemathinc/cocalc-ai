import { rmSync, writeFileSync } from "node:fs";
import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { connect } from "@cocalc/conat/core/client";
import { setConatClient } from "@cocalc/conat/client";
import { runDetachedAcpQueueWorker } from "./hub/acp";

const logger = getLogger("lite:acp-worker");

function readRequiredEnv(name: string): string {
  const value = `${process.env[name] ?? ""}`.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function registerPidFile(pidFile: string): void {
  writeFileSync(pidFile, `${process.pid}\n`);
  const cleanup = () => {
    try {
      rmSync(pidFile, { force: true });
    } catch {
      // ignore
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
}

export async function main(): Promise<void> {
  const conatPassword = readRequiredEnv("COCALC_LITE_ACP_WORKER_CONAT_PASSWORD");
  const pidFile = readRequiredEnv("COCALC_LITE_ACP_WORKER_PID_FILE");
  const conatServer = readRequiredEnv("CONAT_SERVER");
  setConatPassword(conatPassword);
  registerPidFile(pidFile);
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
