import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import { setConatPassword } from "@cocalc/backend/data";
import { setConatClient } from "@cocalc/conat/client";
import {
  acpAdmissionLimitsFromEffectiveLimits,
  disposeAcpAgents,
  runDetachedAcpQueueWorker,
  setAcpAdmissionLimitsProvider,
  setAcpSessionPublisherOverride,
  publishActiveAcpSessions,
} from "@cocalc/lite/hub/acp";
import { setContainerExec } from "@cocalc/lite/hub/acp/executor/container";
import { setPreferContainerExecutor } from "@cocalc/lite/hub/acp/workspace-root";
import { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import { init as initProjectRunnerFilesystem } from "@cocalc/project-runner/run/filesystem";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import { initCodexProjectRunner } from "./codex/codex-project";
import { initCodexGeneratedImageBlobWriter } from "./codex/generated-image-blobs";
import { initCodexSiteKeyGovernor } from "./codex/codex-site-metering";
import { configureProjectHostAcpContainerFileIO } from "./file-server";
import { wireHostsApi } from "./hub/hosts";
import { wireNotificationsApi } from "./hub/notifications";
import { wireSystemApi } from "./hub/system";
import {
  getAccountEffectiveLimits,
  getProjectOwnerEffectiveLimits,
  PROJECT_RUNNER_RPC_TIMEOUT_MS,
  wireProjectsApi,
} from "./hub/projects";
import { resolveProjectHostPreferredMasterConatServer } from "./master-conat-server";
import { getProjectHostMasterConatToken } from "./master-conat-token";
import { getMasterConatClient, setMasterConatClient } from "./master-status";
import { initSqlite } from "./sqlite/init";
import { getLocalHostId } from "./sqlite/hosts";
import { startEventLoopStallMonitor } from "./event-loop-stalls";
import { configureProjectHostAcpAdmissionDenialRecorder } from "./hub/acp/admission-denials";

const logger = getLogger("project-host:acp-worker");
const ACP_SESSION_PUBLISH_WARNING_THROTTLE_MS = 60_000;

let lastAcpSessionPublishWarningAt = 0;

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
      const current = readFileSync(pidFile, "utf8").trim();
      if (current !== `${process.pid}`) {
        return;
      }
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
  configureProjectHostAcpSessionPublisher();
  wireSystemApi();
  wireHostsApi();
  wireNotificationsApi();
  setAcpAdmissionLimitsProvider(async ({ account_id, project_id }) => {
    const accountId = `${account_id ?? ""}`.trim();
    if (accountId) {
      return acpAdmissionLimitsFromEffectiveLimits(
        await getAccountEffectiveLimits(accountId),
      );
    }
    const id = `${project_id ?? ""}`.trim();
    if (!id) return undefined;
    return acpAdmissionLimitsFromEffectiveLimits(
      await getProjectOwnerEffectiveLimits(id),
    );
  });
  configureProjectHostAcpAdmissionDenialRecorder();
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
  initCodexGeneratedImageBlobWriter();
}

function configureProjectHostAcpSessionPublisher(): void {
  setAcpSessionPublisherOverride(async (row) => {
    const client = getMasterConatClient();
    const host_id =
      `${process.env.PROJECT_HOST_ID ?? ""}`.trim() || getLocalHostId();
    if (!client || !host_id) {
      logger.debug("skipping ACP session state publication", {
        has_client: !!client,
        has_host_id: !!host_id,
        project_id: row.project_id,
        state: row.state,
      });
      return;
    }
    try {
      await callHub({
        client,
        host_id,
        name: "aiSessions.upsertProjectHostSession",
        args: [
          {
            ...row,
            terminal: row.terminal === 1,
          },
        ],
        timeout: 5_000,
      });
    } catch (err) {
      const now = Date.now();
      if (
        now - lastAcpSessionPublishWarningAt >=
        ACP_SESSION_PUBLISH_WARNING_THROTTLE_MS
      ) {
        lastAcpSessionPublishWarningAt = now;
        logger.warn("failed to publish ACP session state to master hub", {
          err: `${err}`,
          host_id,
          project_id: row.project_id,
          account_id: row.account_id,
          session_key: row.session_key,
          session_id: row.session_id,
          state: row.state,
          terminal: row.terminal,
        });
      }
      throw err;
    }
  });
}

function connectMasterClient() {
  const address =
    `${resolveProjectHostPreferredMasterConatServer() ?? ""}`.trim();
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
  const stopEventLoopStallMonitor = startEventLoopStallMonitor({
    loggerName: "project-host:acp-worker:event-loop-stalls",
    label: "project-host acp-worker",
  });
  const conatPassword = readRequiredEnv(
    "COCALC_PROJECT_HOST_ACP_WORKER_CONAT_PASSWORD",
  );
  const pidFile = readRequiredEnv("COCALC_PROJECT_HOST_ACP_WORKER_PID_FILE");
  const conatServer = readRequiredEnv("CONAT_SERVER");
  const restartReason =
    `${process.env.COCALC_PROJECT_HOST_ACP_WORKER_RESTART_REASON ?? ""}`.trim() ||
    undefined;
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
  const runnerId =
    `${process.env.PROJECT_RUNNER_NAME ?? ""}`.trim() || "project-host";
  wireProjectsApi(
    projectRunnerClient({
      client,
      subject: `project-runner.${runnerId}`,
      waitForInterest: false,
      timeout: PROJECT_RUNNER_RPC_TIMEOUT_MS,
    }),
  );
  initProjectRunnerFilesystem({ client });
  const masterClient = connectMasterClient();
  const republishedSessions = publishActiveAcpSessions();
  if (republishedSessions > 0) {
    logger.info("republished active ACP sessions to master hub", {
      count: republishedSessions,
    });
  }
  registerPidFile(pidFile, async () => {
    stopEventLoopStallMonitor();
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
      restartReason,
    });
  } finally {
    stopEventLoopStallMonitor();
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
