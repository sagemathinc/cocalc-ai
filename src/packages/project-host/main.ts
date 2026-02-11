/**
 * Minimal project-host: spins up a local conat server, embeds the file-server
 * and project-runner, and exposes a tiny HTTP API to start/stop/status projects.
 *
 * Security: intentionally insecure for now. No auth, no TLS.
 */
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, chmodSync } from "node:fs";
import { basename, join } from "node:path";
import { URL } from "node:url";
import express from "express";
import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import {
  data as dataDir,
  setConatServer,
  setConatPassword,
} from "@cocalc/backend/data";
import {
  init as createConatServer,
  type ConatServer,
} from "@cocalc/conat/core/server";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { setConatClient } from "@cocalc/conat/client";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { init as initRunner } from "@cocalc/project-runner/run";
import { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import { initFileServer, initFsServer } from "./file-server";
import { DEFAULT_FILE_SERVICE } from "@cocalc/conat/files/fs";
import { initHttp, addCatchAll } from "./web";
import { initSqlite } from "./sqlite/init";
import {
  getOrCreateProjectLocalSecretToken,
  getProjectPorts,
} from "./sqlite/projects";
import { PROJECT_PROXY_AUTH_HEADER } from "@cocalc/backend/auth/project-proxy-auth";
import { attachProjectProxy } from "@cocalc/project-proxy/proxy";
import { init as initChangefeeds } from "@cocalc/lite/hub/changefeeds";
import { init as initHubApi } from "@cocalc/lite/hub/api";
import { wireProjectsApi } from "./hub/projects";
import { startMasterRegistration } from "./master";
import { startReconciler } from "./reconcile";
import { init as initAcp } from "@cocalc/lite/hub/acp";
import { setContainerExec } from "@cocalc/lite/hub/acp/executor/container";
import { initCodexProjectRunner } from "./codex/codex-project";
import { initCodexSiteKeyGovernor } from "./codex/codex-site-metering";
import { startCodexSubscriptionCacheGc } from "./codex/codex-subscription-cache-gc";
import { setPreferContainerExecutor } from "@cocalc/lite/hub/acp/workspace-root";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import { getOrCreateSelfSigned } from "@cocalc/lite/tls";
import { handleDaemonCli } from "./daemon";
import { startCopyWorker } from "./pending-copies";
import { startOnPremTunnel } from "./onprem-tunnel";
import { startDataPermissionHardener } from "./data-permissions";
import { resolveProjectHostId } from "./host-id";
import { createProjectHostConatAuth } from "./conat-auth";
import { startConatRevocationKickLoop } from "./conat-revocation-kick";
import { getOrCreateProjectHostConatPassword } from "./local-conat-password";
import { getProjectHostMasterConatToken } from "./master-conat-token";
import {
  assertLocalBindOrInsecure,
  assertSecureUrlOrLocal,
} from "@cocalc/backend/network/policy";
import { createProjectHostHttpProxyAuth } from "./http-proxy-auth";
import { runFsServiceFromEnv } from "./fs-service";

const logger = getLogger("project-host:main");

export interface ProjectHostConfig {
  hostId?: string;
  host?: string;
  port?: number;
}

export interface ProjectHostContext {
  port: number;
  host: string;
}

type TlsConfig = {
  enabled: boolean;
  hostname: string;
};

type FsServiceHandle = { close: () => void };

function resolveTlsConfig(host: string, port: number): TlsConfig {
  const httpsEnv = process.env.COCALC_PROJECT_HOST_HTTPS;
  const publicUrl = process.env.PROJECT_HOST_PUBLIC_URL ?? "";
  let enabled = false;
  let hostname = "";
  const explicitlyDisabled =
    !!httpsEnv && ["0", "false", "no"].includes(httpsEnv.toLowerCase());
  const overrideHostname = process.env.COCALC_PROJECT_HOST_HTTPS_HOSTNAME;
  if (explicitlyDisabled) {
    return {
      enabled: false,
      hostname: overrideHostname || host,
    };
  }
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      hostname = parsed.hostname;
      if (parsed.protocol === "https:") {
        enabled = true;
      }
    } catch {
      // ignore invalid URL
    }
  }
  if (httpsEnv && !explicitlyDisabled) {
    enabled = true;
  }
  if (!enabled && !explicitlyDisabled && port === 443) {
    enabled = true;
  }
  if (overrideHostname) {
    hostname = overrideHostname;
  }
  if (!hostname) {
    hostname = host;
  }
  return { enabled, hostname };
}

function hostUserName(): string {
  return (
    `${process.env.COCALC_PROJECT_HOST_USER ?? process.env.USER ?? process.env.LOGNAME ?? ""}`.trim() ||
    "root"
  );
}

function runnerUserName(): string {
  return `${process.env.COCALC_PODMAN_RUN_AS_USER ?? process.env.COCALC_PROJECT_RUNNER_USER ?? ""}`.trim();
}

function splitRunnerMode(): boolean {
  const runner = runnerUserName();
  if (!runner) return false;
  return runner !== hostUserName();
}

function fsServiceModeFromEnv(): boolean {
  const value = `${process.env.COCALC_PROJECT_HOST_FS_INPROCESS ?? "no"}`
    .trim()
    .toLowerCase();
  return !["1", "true", "yes", "on"].includes(value);
}

function fsServiceFallbackEnabled(): boolean {
  const value = `${process.env.COCALC_PROJECT_HOST_FS_FALLBACK_INPROCESS ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function resolveNodeExecForRunner(nodeExec: string): string {
  if (!nodeExec.startsWith("/home/")) {
    return nodeExec;
  }
  const nodeBinRoot = `${process.env.COCALC_PROJECT_NODE_BIN ?? ""}`.trim();
  if (!nodeBinRoot) {
    return nodeExec;
  }
  const candidate = join(nodeBinRoot, "node");
  return existsSync(candidate) ? candidate : nodeExec;
}

function resolveFsServiceDataRoot(): string {
  const configured = `${process.env.COCALC_PROJECT_HOST_FS_DATA ?? ""}`.trim();
  if (configured) return configured;
  const hostData = `${
    process.env.COCALC_DATA_DIR ?? process.env.COCALC_DATA ?? process.env.DATA ?? ""
  }`.trim();
  if (hostData) return join(hostData, "runner-fs-service");
  return "/btrfs/data/runner-fs-service";
}

function runSudoCommand(args: string[]): void {
  const result = spawnSync("sudo", ["-n", ...args], {
    cwd: "/",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `sudo ${args.join(" ")} failed`);
  }
}

function ensureFsServiceDataPaths(fsDataRoot: string, runner: string): void {
  const dirs = [fsDataRoot, join(fsDataRoot, "secrets"), join(fsDataRoot, "tmp")];
  try {
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    return;
  } catch {
    // fallback below
  }
  runSudoCommand(["mkdir", "-p", ...dirs]);
  runSudoCommand(["chown", "-R", `${runner}:${runner}`, fsDataRoot]);
  runSudoCommand(["chmod", "700", ...dirs]);
}

function firstReadableFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const path = `${candidate ?? ""}`.trim();
    if (!path) continue;
    try {
      accessSync(path, constants.R_OK);
      return path;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function resolveFsServiceScriptPath(): string {
  const currentRoot = `${process.env.COCALC_PROJECT_HOST_CURRENT ?? ""}`.trim();
  const currentCandidates = currentRoot
    ? [
        join(currentRoot, "bundle", "index.js"),
        join(currentRoot, "main", "index.js"),
        join(currentRoot, "dist", "main.js"),
      ]
    : [];
  const explicit = `${process.env.COCALC_PROJECT_HOST_FS_SERVICE_SCRIPT ?? ""}`.trim();
  return (
    firstReadableFile([
      explicit,
      ...currentCandidates,
      __filename,
      `${process.argv[1] ?? ""}`.trim(),
    ]) ?? __filename
  );
}

function resolveFsServiceExec(): { command: string; args: string[] } {
  let command =
    `${process.env.COCALC_PROJECT_HOST_FS_SERVICE_EXEC ?? ""}`.trim() ||
    process.execPath;
  const base = basename(command);
  if (base === "node" || base.startsWith("node")) {
    command = resolveNodeExecForRunner(command);
    // Prefer a readable entrypoint under COCALC_PROJECT_HOST_CURRENT, then
    // fall back to current module/argv path for dev/local runs.
    const script = resolveFsServiceScriptPath();
    return {
      command,
      args: [script, "--fs-service"],
    };
  }
  return { command, args: ["--fs-service"] };
}

async function startFsService({
  client,
  conatServerAddress,
  systemAccountPassword,
}: {
  client: ConatClient;
  conatServerAddress: string;
  systemAccountPassword: string;
}): Promise<FsServiceHandle> {
  const startInProcess = async (): Promise<FsServiceHandle> => {
    logger.info("starting fs service in-process");
    const server = await initFsServer({
      client,
      service: DEFAULT_FILE_SERVICE,
    });
    return {
      close: () => {
        server?.close?.();
      },
    };
  };

  const enableSubprocess = splitRunnerMode() && fsServiceModeFromEnv();
  if (!enableSubprocess) {
    return await startInProcess();
  }

  const runner = runnerUserName();
  if (!runner) {
    throw new Error("split runner mode requires COCALC_PROJECT_RUNNER_USER");
  }
  const { command, args } = resolveFsServiceExec();
  const fsDataRoot = resolveFsServiceDataRoot();
  const fsTmpDir = join(fsDataRoot, "tmp");
  const fsLogFile = join(fsDataRoot, "log");
  ensureFsServiceDataPaths(fsDataRoot, runner);
  const preserveVars = [
    "COCALC_PROJECT_HOST_MODE",
    "COCALC_FS_SERVICE_CONAT_SERVER",
    "COCALC_FS_SERVICE_SYSTEM_PASSWORD",
    "COCALC_FS_SERVICE_NAME",
    "COCALC_PROJECT_HOST_FS_DATA",
    "COCALC_FILE_SERVER_MOUNTPOINT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "CONAT_SERVER",
    "DEBUG",
    "DEBUG_CONSOLE",
    "DEBUG_FILE",
    "NODE_OPTIONS",
    "COCALC_PROJECT_NODE_BIN",
    "COCALC_PROJECT_HOST_CURRENT",
    "COCALC_PROJECT_HOST_FS_SERVICE_SCRIPT",
  ];
  const env = {
    ...process.env,
    COCALC_PROJECT_HOST_FS_DATA: fsDataRoot,
    COCALC_DATA_DIR: fsDataRoot,
    COCALC_DATA: fsDataRoot,
    DATA: fsDataRoot,
    SECRETS: join(fsDataRoot, "secrets"),
    TMPDIR: fsTmpDir,
    TMP: fsTmpDir,
    TEMP: fsTmpDir,
    DEBUG_FILE: fsLogFile,
    COCALC_PROJECT_HOST_MODE: "fs-service",
    COCALC_FS_SERVICE_CONAT_SERVER: conatServerAddress,
    COCALC_FS_SERVICE_SYSTEM_PASSWORD: systemAccountPassword,
    COCALC_FS_SERVICE_NAME: DEFAULT_FILE_SERVICE,
    CONAT_SERVER: conatServerAddress,
  };
  const sudoArgs = [
    "-n",
    "-u",
    runner,
    "-H",
    `--preserve-env=${preserveVars.join(",")}`,
    command,
    ...args,
  ];
  logger.info("starting fs service subprocess", {
    runner,
    command,
    args,
    cwd: "/",
  });
  const child: ChildProcess = spawn("sudo", sudoArgs, {
    cwd: "/",
    env,
    stdio: "inherit",
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const earlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        reject(
          new Error(
            `runner fs service exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      };
      child.once("exit", earlyExit);
      setTimeout(() => {
        if (done) return;
        done = true;
        child.off("exit", earlyExit);
        resolve();
      }, 500);
    });
  } catch (err) {
    if (!fsServiceFallbackEnabled()) {
      throw err;
    }
    logger.warn(
      "runner fs service subprocess failed; falling back to in-process fs service",
      { err: `${err}` },
    );
    try {
      child.kill("SIGKILL");
    } catch {}
    return await startInProcess();
  }

  let stopping = false;
  child.on("exit", (code, signal) => {
    if (stopping) return;
    logger.error("runner fs service exited unexpectedly", {
      code,
      signal,
    });
  });

  return {
    close: () => {
      if (stopping) return;
      stopping = true;
      if (child.killed || child.exitCode != null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.killed || child.exitCode != null) return;
        child.kill("SIGKILL");
      }, 2000);
    },
  };
}

async function startHttpServer(
  port: number,
  host: string,
  tls: TlsConfig,
) {
  const app = express();
  app.use(express.json());

  let httpServer: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  if (tls.enabled) {
    const { key, cert, keyPath, certPath } = getOrCreateSelfSigned(tls.hostname);
    httpServer = createHttpsServer({ key, cert }, app);
    logger.info(`TLS enabled (key=${keyPath}, cert=${certPath})`);
  } else {
    httpServer = createHttpServer(app);
  }
  httpServer.listen(port, host);
  await once(httpServer, "listening");

  return { app, httpServer, isHttps: tls.enabled };
}

export async function main(
  _config: ProjectHostConfig = {},
): Promise<ProjectHostContext> {
  const runnerId = process.env.PROJECT_RUNNER_NAME || "project-host";
  const host = _config.host ?? process.env.HOST ?? "127.0.0.1";
  const port = _config.port ?? (Number(process.env.PORT) || (await getPort()));
  assertLocalBindOrInsecure({
    bindHost: host,
    serviceName: "project-host http listener",
  });
  assertSecureUrlOrLocal({
    url: process.env.PROJECT_HOST_PUBLIC_URL ?? "",
    urlName: "PROJECT_HOST_PUBLIC_URL",
  });
  assertSecureUrlOrLocal({
    url: process.env.PROJECT_HOST_INTERNAL_URL ?? "",
    urlName: "PROJECT_HOST_INTERNAL_URL",
  });
  const tls = resolveTlsConfig(host, port);
  // Project-host internal conat auth is always local and host-specific.
  const localConatPassword = getOrCreateProjectHostConatPassword();
  const masterConatToken = getProjectHostMasterConatToken();
  setConatPassword(localConatPassword);

  const scheme = tls.enabled ? "https" : "http";
  logger.info(
    `starting project-host on ${scheme}://${host}:${port} (runner=${runnerId})`,
  );

  logger.info("Local sqlite + changefeeds for UI data");
  initSqlite();
  const hostId = resolveProjectHostId(_config.hostId);
  const conatAuth = createProjectHostConatAuth({ host_id: hostId });

  // 1) HTTP + conat server
  const { app, httpServer, isHttps } = await startHttpServer(port, host, tls);
  const conatServer: ConatServer = createConatServer({
    httpServer,
    ssl: isHttps,
    port,
    getUser: conatAuth.getUser,
    isAllowed: conatAuth.isAllowed,
    systemAccountPassword: localConatPassword,
  });
  if (conatServer.state !== "ready") {
    await once(conatServer, "ready");
  }
  const conatClient = conatServer.client({
    path: "/",
    systemAccountPassword: localConatPassword,
  });
  setConatServer(conatServer.address());
  setConatClient({
    conat: () => conatClient,
    getLogger,
  });
  const stopConatRevocationKickLoop = startConatRevocationKickLoop({
    client: conatClient,
  });

  initChangefeeds({ client: conatClient });
  await initHubApi({ client: conatClient });

  // ACP runs inside project-host in container mode (no env flag needed).
  setPreferContainerExecutor(true);
  // Use containerized podman for ACP container execution.
  setContainerExec((opts) =>
    sandboxExec({
      ...opts,
      project_id: opts.projectId,
      // use ephemeral so works even if project is off, and get clean
      // container for each terminal command, with no process's left around
      // as side effects
      useEphemeral: true,
    }),
  );
  initCodexProjectRunner();
  initCodexSiteKeyGovernor();
  const stopCodexSubscriptionCacheGc = startCodexSubscriptionCacheGc();
  await initAcp(conatClient);

  // Minimal local persistence so DKV/state works (no external hub needed).
  const persistServer = createPersistServer({ client: conatClient });

  logger.info("Proxy HTTP/WS traffic to running project containers.");
  const httpProxyAuth = createProjectHostHttpProxyAuth({ host_id: hostId });
  const stopHttpProxyRevocationKickLoop =
    httpProxyAuth.startUpgradeRevocationKickLoop();
  attachProjectProxy({
    httpServer,
    app,
    onUpgradeAuthorized: (req, socket) =>
      httpProxyAuth.trackUpgradedSocket(req, socket),
    resolveTarget: async (req, res) => {
      const project_id = req.url?.split("/")[1];
      if (!project_id) return { handled: false };
      if (res) {
        await httpProxyAuth.authorizeHttpRequest(req, res, project_id);
        if (res.writableEnded) {
          return { handled: true };
        }
      } else {
        await httpProxyAuth.authorizeUpgradeRequest(req, project_id);
      }
      const upstreamSecret = getOrCreateProjectLocalSecretToken(project_id);
      req.headers[PROJECT_PROXY_AUTH_HEADER] = upstreamSecret;
      const { http_port } = getProjectPorts(project_id);
      if (!http_port) {
        throw new Error(`no http_port recorded for project ${project_id}`);
      }
      return { handled: true, target: { host: "127.0.0.1", port: http_port } };
    },
  });

  logger.info(
    "Serve per-project files via the fs.* conat service, mounting from the local file-server.",
  );
  const fsService = await startFsService({
    client: conatClient,
    conatServerAddress: conatServer.address(),
    systemAccountPassword: localConatPassword,
  });

  logger.info("HTTP static + customize + API wiring");
  await initHttp({ app, conatClient });

  logger.info("Project-runner bound to the same conat + file-server");
  await initRunner({ id: runnerId, client: conatClient });
  const runnerApi = projectRunnerClient({
    client: conatClient,
    subject: `project-runner.${runnerId}`,
    waitForInterest: false,
  });
  wireProjectsApi(runnerApi);

  logger.info("Minimal HTTP API");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  addCatchAll(app);

  logger.info("start Master Registration");
  const stopMasterRegistration = await startMasterRegistration({
    hostId,
    runnerId,
    host,
    port,
    masterConatToken,
  });
  const stopReconciler = startReconciler();
  const stopDataPermissionHardener = startDataPermissionHardener(dataDir);

  // file server must be started AFTER master registration, since it connects
  // to master to get rustic backup config.
  logger.info("File-server (local btrfs + optional ssh proxy if enabled)");
  let stopOnPremTunnel: (() => void) | undefined;
  try {
    await initFileServer({ client: conatClient });
    stopOnPremTunnel = await startOnPremTunnel({ localHttpPort: port });
  } catch (err) {
    logger.error("FATAL: Failed to init file server", err);
    process.exit(1);
  }

  const stopCopyWorker = startCopyWorker();

  logger.info("project-host ready");

  const close = () => {
    persistServer?.close?.();
    fsService?.close?.();
    stopMasterRegistration?.();
    stopReconciler?.();
    stopDataPermissionHardener?.();
    stopConatRevocationKickLoop?.();
    stopCodexSubscriptionCacheGc?.();
    stopCopyWorker?.();
    stopOnPremTunnel?.();
    stopHttpProxyRevocationKickLoop?.();
  };
  process.once("exit", close);
  ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => process.once(sig, close));

  return { port, host };
}

// Allow running directly via `node dist/main.js`.
if (require.main === module) {
  const fsServiceMode =
    process.argv.includes("--fs-service") ||
    process.env.COCALC_PROJECT_HOST_MODE === "fs-service";
  if (fsServiceMode) {
    runFsServiceFromEnv().catch((err) => {
      console.error("project-host fs-service failed:", err);
      process.exitCode = 1;
    });
  } else {
    try {
      if (handleDaemonCli(process.argv.slice(2))) {
        process.exit(0);
      }
    } catch (err) {
      console.error(`${err}`);
      process.exit(1);
    }
    main().catch((err) => {
      console.error("project-host failed to start:", err);
      process.exitCode = 1;
    });
  }
}
