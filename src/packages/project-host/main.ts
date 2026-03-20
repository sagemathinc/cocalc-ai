/**
 * Minimal project-host: spins up a local conat server, embeds the file-server
 * and project-runner, and exposes a tiny HTTP API to start/stop/status projects.
 *
 * Security: intentionally insecure for now. No auth, no TLS.
 */
import { createServer as createHttpServer } from "http";
import type { IncomingMessage } from "http";
import { createServer as createHttpsServer } from "https";
import { once } from "node:events";
import { URL } from "node:url";
import express from "express";
import TTL from "@isaacs/ttlcache";
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
import { setConatClient } from "@cocalc/conat/client";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { init as initRunner } from "@cocalc/project-runner/run";
import { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import {
  configureProjectHostAcpContainerFileIO,
  initFileServer,
  initFsServer,
} from "./file-server";
import { initHttp, addCatchAll } from "./web";
import { initSqlite } from "./sqlite/init";
import {
  getOrCreateProjectLocalSecretToken,
  getProject,
  getProjectPorts,
  listProjects,
} from "./sqlite/projects";
import { PROJECT_PROXY_AUTH_HEADER } from "@cocalc/backend/auth/project-proxy-auth";
import { APP_PROXY_EXPOSURE_HEADER } from "@cocalc/backend/auth/app-proxy";
import { attachProjectProxy } from "@cocalc/project-proxy/proxy";
import { init as initChangefeeds } from "@cocalc/lite/hub/changefeeds";
import { hubApi, init as initHubApi } from "@cocalc/lite/hub/api";
import { PROJECT_RUNNER_RPC_TIMEOUT_MS, wireProjectsApi } from "./hub/projects";
import { wireSystemApi } from "./hub/system";
import { startMasterRegistration } from "./master";
import { startReconciler } from "./reconcile";
import {
  rehydrateAcpAutomationsForProject,
  configureAcpDetachedWorkerRunning,
  init as initAcp,
} from "@cocalc/lite/hub/acp";
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
  runRuntimeConformanceStartupChecks,
  startRuntimeConformanceMonitor,
} from "./runtime-conformance";
import { startRuntimePostureMonitor } from "./runtime-posture";
import {
  assertLocalBindOrInsecure,
  assertSecureUrlOrLocal,
} from "@cocalc/backend/network/policy";
import { createProjectHostHttpProxyAuth } from "./http-proxy-auth";
import { isValidUUID } from "@cocalc/util/misc";
import { main as runAcpWorkerMain } from "./acp-worker";
import {
  configureProjectHostAcpWorkerLauncher,
  ensureProjectHostAcpWorkerRunning,
  startProjectHostAcpWorkerSupervisor,
} from "./hub/acp/worker-manager";
import { matchAppRequest } from "./app-public-access";
import { maybeHandleStaticAppRequest } from "./static-apps";

const logger = getLogger("project-host:main");

export function reportFatalStartupError(message: string, err: unknown): void {
  if (logger.isEnabled("error")) {
    logger.error(message, err);
    return;
  }
  console.error(message, err);
}

const PUBLIC_APP_HOST_HEADER = "x-cocalc-public-app-host";
const PROJECT_HTTP_PORT_WAIT_MS = Math.max(
  1000,
  Number(process.env.COCALC_PROJECT_HTTP_PORT_WAIT_MS ?? 30_000),
);
const PROJECT_HTTP_PORT_POLL_MS = Math.max(
  100,
  Number(process.env.COCALC_PROJECT_HTTP_PORT_POLL_MS ?? 500),
);
const PUBLIC_APP_ROUTE_CACHE_MS = Math.max(
  1000,
  Number(process.env.COCALC_PROJECT_HOST_PUBLIC_APP_ROUTE_CACHE_MS ?? 30_000),
);

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

type PublicHostnameRoute = {
  project_id: string;
  app_id: string;
  base_path: string;
};

function normalizeHostHeader(value: unknown): string {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  if (!raw) return "";
  return raw.split(":")[0] ?? "";
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function rewritePublicAppUrl({
  originalUrl,
  route,
}: {
  originalUrl?: string;
  route: PublicHostnameRoute;
}): string {
  const parsed = new URL(originalUrl ?? "/", "http://project-host.local");
  const incomingPath = parsed.pathname || "/";
  const canonicalBasePath = normalizePrefix(
    `/${route.project_id}${route.base_path}`,
  );
  const proxiedPath =
    incomingPath === canonicalBasePath ||
    incomingPath.startsWith(`${canonicalBasePath}/`)
      ? incomingPath
      : normalizePrefix(
          `${canonicalBasePath}${incomingPath === "/" ? "" : incomingPath}`,
        );
  return `${proxiedPath}${parsed.search ?? ""}`;
}

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

async function startHttpServer(port: number, host: string, tls: TlsConfig) {
  const app = express();
  app.use(express.json());

  let httpServer:
    | ReturnType<typeof createHttpServer>
    | ReturnType<typeof createHttpsServer>;
  if (tls.enabled) {
    const { key, cert, keyPath, certPath } = getOrCreateSelfSigned(
      tls.hostname,
    );
    httpServer = createHttpsServer({ key, cert }, app);
    logger.info(`TLS enabled (key=${keyPath}, cert=${certPath})`);
  } else {
    httpServer = createHttpServer(app);
  }
  httpServer.listen(port, host);
  await once(httpServer, "listening");

  return { app, httpServer, isHttps: tls.enabled };
}

async function waitForProjectHttpPort(project_id: string): Promise<number> {
  const deadline = Date.now() + PROJECT_HTTP_PORT_WAIT_MS;
  while (true) {
    const { http_port } = getProjectPorts(project_id);
    if (
      typeof http_port === "number" &&
      Number.isInteger(http_port) &&
      http_port > 0
    ) {
      return http_port;
    }
    if (Date.now() >= deadline) {
      throw new Error(`no http_port recorded for project ${project_id}`);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROJECT_HTTP_PORT_POLL_MS),
    );
  }
}

export async function main(
  _config: ProjectHostConfig = {},
): Promise<ProjectHostContext> {
  configureProjectHostAcpWorkerLauncher({ entryPoint: __filename });
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
  await runRuntimeConformanceStartupChecks();
  const stopRuntimeConformanceMonitor = startRuntimeConformanceMonitor();
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
  wireSystemApi();

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
  configureProjectHostAcpContainerFileIO();
  initCodexProjectRunner();
  initCodexSiteKeyGovernor();
  const stopCodexSubscriptionCacheGc = startCodexSubscriptionCacheGc();
  // Local persist must exist before ACP startup so automation indexes can
  // republish into the project-scoped DKV stores on restart.
  const persistServer = createPersistServer({ client: conatClient });
  configureAcpDetachedWorkerRunning(ensureProjectHostAcpWorkerRunning);
  await initAcp(conatClient, { manageDetachedWorker: false });
  for (const row of listProjects()) {
    const project_id = `${row.project_id ?? ""}`.trim();
    if (!project_id) continue;
    void rehydrateAcpAutomationsForProject(project_id).catch((err) => {
      logger.warn("failed to rehydrate project ACP automations on startup", {
        project_id,
        err: `${err}`,
      });
    });
  }

  logger.info("Proxy HTTP/WS traffic to running project containers.");
  const httpProxyAuth = createProjectHostHttpProxyAuth({ host_id: hostId });
  const stopHttpProxyRevocationKickLoop =
    httpProxyAuth.startUpgradeRevocationKickLoop();
  const publicAppRouteCache = new TTL<string, PublicHostnameRoute | null>({
    max: 20_000,
    ttl: PUBLIC_APP_ROUTE_CACHE_MS,
  });
  const maybeRewritePublicHostnameRequest = async (req: IncomingMessage) => {
    const currentUrl = `${req.url ?? ""}`;
    if (!currentUrl || currentUrl.startsWith(`/${hostId}/`)) {
      return;
    }
    const parsed = new URL(currentUrl || "/", "http://project-host.local");
    const pathname = parsed.pathname || "/";
    const maybeProjectPrefix = pathname.split("/")[1];
    if (maybeProjectPrefix && isValidUUID(maybeProjectPrefix)) {
      return;
    }
    const hostname = normalizeHostHeader(req.headers.host);
    if (!hostname) return;
    let route = publicAppRouteCache.get(hostname);
    if (route === undefined) {
      try {
        const traced = await hubApi.system.tracePublicAppHostname({
          hostname,
        });
        route =
          traced?.matched &&
          traced.project_id &&
          traced.app_id &&
          traced.base_path
            ? {
                project_id: traced.project_id,
                app_id: traced.app_id,
                base_path: normalizePrefix(traced.base_path),
              }
            : null;
      } catch (err) {
        logger.debug("public hostname trace failed", {
          hostname,
          err: `${err}`,
        });
        route = null;
      }
      publicAppRouteCache.set(hostname, route);
    }
    if (!route) return;
    req.url = rewritePublicAppUrl({
      originalUrl: currentUrl,
      route,
    });
    req.headers[PUBLIC_APP_HOST_HEADER] = hostname;
  };
  attachProjectProxy({
    httpServer,
    app,
    rewriteRequest: maybeRewritePublicHostnameRequest,
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
      const publicAppHost =
        `${req.headers[PUBLIC_APP_HOST_HEADER] ?? ""}`.trim();
      if (publicAppHost) {
        req.headers.host = publicAppHost;
      }
      delete req.headers[PUBLIC_APP_HOST_HEADER];
      if (res) {
        const match = await matchAppRequest({
          project_id,
          url: req.url,
        });
        if (
          await maybeHandleStaticAppRequest({
            req,
            res,
            project_id,
            match,
          })
        ) {
          return { handled: true };
        }
      }
      const projectRow = getProject(project_id);
      if (
        projectRow?.state !== "running" ||
        !Number.isInteger(projectRow?.http_port)
      ) {
        if (!hubApi.projects?.start) {
          throw new Error(`project start unavailable for ${project_id}`);
        }
        logger.debug("project proxy resolveTarget starting project", {
          project_id,
          state: projectRow?.state,
          http_port: projectRow?.http_port,
          url: req.url,
        });
        await hubApi.projects.start({ project_id });
      }
      const upstreamSecret = getOrCreateProjectLocalSecretToken(project_id);
      req.headers[PROJECT_PROXY_AUTH_HEADER] = upstreamSecret;
      req.headers[APP_PROXY_EXPOSURE_HEADER] = publicAppHost
        ? "public"
        : "private";
      const http_port = await waitForProjectHttpPort(project_id);
      return { handled: true, target: { host: "127.0.0.1", port: http_port } };
    },
  });

  logger.info(
    "Serve per-project files via the fs.* conat service, mounting from the local file-server.",
  );
  const fsServer = await initFsServer({ client: conatClient });

  logger.info("HTTP static + customize + API wiring");
  await initHttp({ app, conatClient });

  logger.info("Project-runner bound to the same conat + file-server");
  await initRunner({ id: runnerId, client: conatClient });
  const runnerApi = projectRunnerClient({
    client: conatClient,
    subject: `project-runner.${runnerId}`,
    waitForInterest: false,
    timeout: PROJECT_RUNNER_RPC_TIMEOUT_MS,
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
  let stopRuntimePostureMonitor: () => void = () => {};
  try {
    await initFileServer({ client: conatClient });
    stopOnPremTunnel = await startOnPremTunnel({ localHttpPort: port });
    stopRuntimePostureMonitor = startRuntimePostureMonitor();
  } catch (err) {
    reportFatalStartupError("FATAL: Failed to init file server", err);
    process.exit(1);
  }

  const stopCopyWorker = startCopyWorker();
  startProjectHostAcpWorkerSupervisor();
  await ensureProjectHostAcpWorkerRunning();

  logger.info("project-host ready");

  const close = () => {
    persistServer?.close?.();
    fsServer?.close?.();
    stopMasterRegistration?.();
    stopReconciler?.();
    stopDataPermissionHardener?.();
    stopRuntimeConformanceMonitor?.();
    stopRuntimePostureMonitor?.();
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
  if (`${process.env.COCALC_PROJECT_HOST_ACP_WORKER ?? ""}`.trim() === "1") {
    runAcpWorkerMain()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        console.error("project-host ACP worker failed:", err);
        process.exit(1);
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
