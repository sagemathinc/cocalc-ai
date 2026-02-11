import { once } from "node:events";
import getLogger from "@cocalc/backend/logger";
import { connect as connectToConat, type Client } from "@cocalc/conat/core/client";
import { DEFAULT_FILE_SERVICE } from "@cocalc/conat/files/fs";
import { initFsServer } from "./file-server";

const logger = getLogger("project-host:fs-service");

function requireEnv(name: string): string {
  const value = `${process.env[name] ?? ""}`.trim();
  if (!value) {
    throw new Error(`${name} is required for fs-service mode`);
  }
  return value;
}

export async function runFsServiceFromEnv(): Promise<void> {
  const address =
    `${process.env.COCALC_FS_SERVICE_CONAT_SERVER ?? process.env.CONAT_SERVER ?? ""}`.trim() ||
    requireEnv("COCALC_FS_SERVICE_CONAT_SERVER");
  const systemAccountPassword = requireEnv("COCALC_FS_SERVICE_SYSTEM_PASSWORD");
  const service =
    `${process.env.COCALC_FS_SERVICE_NAME ?? DEFAULT_FILE_SERVICE}`.trim() ||
    DEFAULT_FILE_SERVICE;

  const client: Client = connectToConat({
    address,
    systemAccountPassword,
  });

  const server = await initFsServer({ client, service });
  logger.info("runner fs service ready", { address, service });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      server?.close?.();
    } catch {}
    try {
      client?.close?.();
    } catch {}
  };

  process.once("exit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  process.once("SIGQUIT", () => {
    close();
    process.exit(0);
  });

  await once(process, "beforeExit");
}
