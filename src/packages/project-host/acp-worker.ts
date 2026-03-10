import { rmSync, writeFileSync } from "node:fs";
import { connect } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { setConatClient } from "@cocalc/conat/client";
import {
  disposeAcpAgents,
  runDetachedAcpQueueWorker,
} from "@cocalc/lite/hub/acp";
import { setContainerExec } from "@cocalc/lite/hub/acp/executor/container";
import { setPreferContainerExecutor } from "@cocalc/lite/hub/acp/workspace-root";
import { init as initProjectRunnerFilesystem } from "@cocalc/project-runner/run/filesystem";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import { initCodexProjectRunner } from "./codex/codex-project";
import { initCodexSiteKeyGovernor } from "./codex/codex-site-metering";
import { configureProjectHostAcpContainerFileIO } from "./file-server";
import { getProjectHostMasterConatToken } from "./master-conat-token";
import { setMasterConatClient } from "./master-status";
import { initSqlite } from "./sqlite/init";
import { getLocalHostId } from "./sqlite/hosts";

const logger = getLogger("project-host:acp-worker");

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
        logger.warn("project-host ACP worker shutdown failed", err);
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

function configureProjectHostAcpRuntime(): void {
  setPreferContainerExecutor(true);
  setContainerExec((opts) =>
    sandboxExec({
      ...opts,
      project_id: opts.projectId,
      useEphemeral: true,
    }),
  );
  configureProjectHostAcpContainerFileIO();
  initCodexProjectRunner();
  initCodexSiteKeyGovernor();
}

function connectMasterClient() {
  const address =
    `${process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER ?? ""}`.trim();
  if (!address) {
    return;
  }
  const host_id =
    `${process.env.PROJECT_HOST_ID ?? ""}`.trim() || getLocalHostId();
  if (!host_id) {
    logger.warn("skipping ACP worker master client setup: host id missing");
    return;
  }
  const currentToken = getProjectHostMasterConatToken();
  if (!`${currentToken ?? ""}`.trim()) {
    logger.warn(
      "starting ACP worker without master token; hub-backed Codex auth/metering may be unavailable",
    );
  }
  const client = connect({
    address,
    inboxPrefix: inboxPrefix({ host_id }),
    noCache: true,
    auth: (cb) => {
      const token = getProjectHostMasterConatToken();
      if (`${token ?? ""}`.trim()) {
        cb({ bearer: token });
      } else {
        cb({});
      }
    },
  });
  setMasterConatClient(client);
  return client;
}

export async function main(): Promise<void> {
  const conatPassword = readRequiredEnv(
    "COCALC_PROJECT_HOST_ACP_WORKER_CONAT_PASSWORD",
  );
  const pidFile = readRequiredEnv("COCALC_PROJECT_HOST_ACP_WORKER_PID_FILE");
  const conatServer = readRequiredEnv("CONAT_SERVER");
  setConatPassword(conatPassword);
  initSqlite();
  configureProjectHostAcpRuntime();
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
  initProjectRunnerFilesystem({ client });
  const masterClient = connectMasterClient();
  registerPidFile(pidFile, async () => {
    await disposeAcpAgents();
    try {
      masterClient?.close();
    } catch {
      // ignore close errors
    }
    setMasterConatClient(undefined);
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  });
  try {
    await runDetachedAcpQueueWorker(client, {
      idleExitMs: null,
    });
  } finally {
    setMasterConatClient(undefined);
    try {
      masterClient?.close();
    } catch {
      // ignore close errors
    }
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }
}
