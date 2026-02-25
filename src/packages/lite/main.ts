/*
Launching it like this:

PORT=30000 pnpm app
*/

import startProjectServices from "@cocalc/project/conat";
import { cleanup } from "@cocalc/project/project-setup";
import {
  init as createConatServer,
  type ConatServer,
} from "@cocalc/conat/core/server";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { type Client } from "@cocalc/conat/core/client";
import { setConatClient } from "@cocalc/conat/client";
import { once } from "@cocalc/util/async-utils";
import { setConatServer } from "@cocalc/backend/data";
import { project_id } from "@cocalc/project/data";
import { initHttpServer, initApp } from "./http";
import { localPathFileserver } from "@cocalc/backend/conat/files/local-path";
import { init as initBugCounter } from "@cocalc/project/bug-counter";
import { init as initChangefeeds } from "./hub/changefeeds";
import { init as initHubApi } from "./hub/api";
import { init as initLLM } from "./hub/llm";
import { init as initAcp } from "./hub/acp";
import { initWatchdog, closeWatchdog } from "./watchdog";
import {
  account_id,
  conatPassword,
  setConatPassword,
} from "@cocalc/backend/data";
import { getAuthToken } from "./auth-token";
import getLogger from "@cocalc/backend/logger";
import compression from "compression";
import { enableMemoryUseLogger } from "@cocalc/backend/memory";
import { connectionInfoPath } from "./connection-info";
import { secureRandomString } from "@cocalc/backend/misc";
import {
  allowUnauthenticatedConat,
  createLiteConatAuth,
} from "./conat-auth";
import { isLoopbackHost } from "@cocalc/backend/network/policy";

const logger = getLogger("lite:main");

export let conatServer: ConatServer | null = null;
export let persistServer: any = null;

const PRESERVED_COCALC_ENV_KEYS = [
  "COCALC_ACP_MODE",
  "COCALC_ACP_MOCK_SCRIPT",
  "COCALC_ACP_MOCK_FILE",
  "COCALC_ACP_EXECUTOR",
  "COCALC_CODEX_BIN",
  "COCALC_CODEX_HOME",
  "COCALC_CLI_BIN",
] as const;

function captureEnv(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = `${process.env[key] ?? ""}`.trim();
    if (value) out[key] = value;
  }
  return out;
}

function restoreEnv(env: Record<string, string>) {
  for (const key in env) {
    const value = `${env[key] ?? ""}`.trim();
    if (value) process.env[key] = value;
  }
}

function conat(opts?): Client {
  if (conatServer == null) {
    throw Error("not initialized");
  }
  return conatServer.client({
    path: "/",
    systemAccountPassword: conatPassword,
    ...opts,
  });
}

export async function main(opts?: {
  sshUi?: any;
  reflectUi?: any;
}): Promise<number> {
  logger.debug("main");
  enableMemoryUseLogger();
  process.chdir(process.env.HOME ?? "");
  initBugCounter();

  const AUTH_TOKEN = await getAuthToken();
  const AGENT_TOKEN = await getAgentToken();
  const CLI_BIN = `${process.env.COCALC_CLI_BIN ?? ""}`.trim();
  const preservedEnv = captureEnv(PRESERVED_COCALC_ENV_KEYS);
  if (AGENT_TOKEN) {
    process.env.COCALC_AGENT_TOKEN = AGENT_TOKEN;
  }
  if (!conatPassword) {
    setConatPassword(await secureRandomString(24));
  }

  logger.debug("start http server");
  const { httpServer, app, port, isHttps, hostname } = await initHttpServer({
    AUTH_TOKEN,
  });
  const LOCAL_API_URL = `http://localhost:${port}`;
  process.env.COCALC_API_URL = LOCAL_API_URL;
  if (!AUTH_TOKEN) {
    if (isLoopbackHost(hostname)) {
      logger.warn(
        "lite auth warning: AUTH_TOKEN is not set; conat access is unauthenticated on loopback.",
      );
    } else if (allowUnauthenticatedConat()) {
      logger.warn(
        "lite auth warning: AUTH_TOKEN is not set on non-loopback host and unauthenticated conat is explicitly enabled.",
      );
    }
  }

  await writeConnectionInfo({
    port,
    AUTH_TOKEN,
    AGENT_TOKEN,
    isHttps,
    hostname,
    acpMode: `${process.env.COCALC_ACP_MODE ?? ""}`.trim() || "codex",
  });

  logger.debug("create server");
  const conatAuth = createLiteConatAuth({
    account_id,
    project_id,
    bindHost: hostname,
    AUTH_TOKEN,
    AGENT_TOKEN,
    hub_password: conatPassword,
  });
  const options = {
    httpServer,
    ssl: isHttps,
    port,
    getUser: conatAuth.getUser,
    isAllowed: conatAuth.isAllowed,
    systemAccountPassword: conatPassword,
  };
  conatServer = createConatServer(options);
  if (conatServer.state != "ready") {
    await once(conatServer, "ready");
  }
  logger.debug("conat address: ", conatServer.address());
  setConatServer(conatServer.address());

  // CRITICAL: keep this *AFTER* the websocket Conat stuff or anything you do not
  // want to have compressed to avoid massive performance problems.
  // suggested by http://expressjs.com/en/advanced/best-practice-performance.html#use-gzip-compression
  app.use(compression());

  logger.debug("create client");
  const conatClient = conat();
  setConatClient({ conat, getLogger });

  logger.debug("init app");
  initApp({ app, conatClient, AUTH_TOKEN, isHttps });

  logger.debug("create persist server");
  persistServer = createPersistServer({ client: conatClient });

  logger.debug("start project services");
  cleanup();
  // cleanup() intentionally drops inherited COCALC_* env vars; restore the
  // subset needed by lite ACP/Codex runtime wiring.
  restoreEnv(preservedEnv);
  process.env.COCALC_API_URL = LOCAL_API_URL;
  if (AGENT_TOKEN) {
    process.env.COCALC_AGENT_TOKEN = AGENT_TOKEN;
  }
  if (CLI_BIN) {
    process.env.COCALC_CLI_BIN = CLI_BIN;
  }
  const acpMode = `${process.env.COCALC_ACP_MODE ?? ""}`.trim() || "codex";
  logger.info("lite acp mode", { mode: acpMode });
  // After environment cleanup, default lite process monitoring to owned scope.
  process.env.COCALC_PROJECT_INFO_SCOPE ??= "owned";
  startProjectServices({ client: conatClient });

  logger.debug("start changefeed server");
  initChangefeeds({ client: conatClient });

  logger.debug("start llm conat server");
  await initLLM();

  logger.debug("start acp conat server");
  await initAcp(conatClient);

  logger.debug("start watchdog");
  initWatchdog();

  const path = process.cwd();

  logger.debug("start hub api");
  await initHubApi({
    client: conatClient,
    sshUi: opts?.sshUi,
    reflectUi: opts?.reflectUi,
  });

  logger.debug("start fs service");
  localPathFileserver({
    client: conatClient,
    path,
    project_id,
    unsafeMode: true,
  });

  process.once("exit", () => {
    closeWatchdog();
    conatServer?.close();
    conatServer = null;
    persistServer?.close?.();
    httpServer?.close();
  });

  ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => {
    process.once(sig, () => {
      process.exit();
    });
  });

  return port;
}

async function writeConnectionInfo({
  port,
  AUTH_TOKEN,
  AGENT_TOKEN,
  isHttps,
  hostname,
  acpMode,
}: {
  port: number;
  AUTH_TOKEN?: string;
  AGENT_TOKEN?: string;
  isHttps: boolean;
  hostname: string;
  acpMode: string;
}) {
  const output = connectionInfoPath();
  try {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const info = {
      port,
      token: AUTH_TOKEN ?? "",
      agent_token: AGENT_TOKEN ?? "",
      account_id,
      project_id,
      protocol: isHttps ? "https" : "http",
      host: hostname,
      url: `${isHttps ? "https" : "http"}://${hostname}:${port}`,
      acp_mode: acpMode,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(info, null, 2), "utf8");
    await chmod(output, 0o600);
    logger.debug("wrote connection info", { output, port, pid: process.pid });
  } catch (err) {
    logger.warn("failed to write connection info", err);
  }
}

async function getAgentToken(): Promise<string | undefined> {
  const value = `${process.env.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (value) return value;
  return await secureRandomString(40);
}
