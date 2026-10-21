/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import path from "node:path";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import express from "express";
import type { Application } from "express";
import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { installProjectPersistVolumes } from "./persist-volume";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { getPersistStreamReleaseQueueDiagnostics } from "@cocalc/conat/persist/server";
import { initPersistFenceService } from "@cocalc/conat/persist/fence";
import {
  fileFenceStore,
  isFenceHolderAlive,
  removeFenceCapability,
  writeFenceCapability,
} from "@cocalc/backend/conat/persist-fence";
import { resolveHostAgentDataDir } from "./host-agent-state";
import {
  connect as connectToConat,
  type Client as ConatClient,
} from "@cocalc/conat/core/client";
import type { ConatSocketServer } from "@cocalc/conat/socket";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import {
  assertLocalBindOrInsecure,
  assertSecureUrlOrLocal,
} from "@cocalc/backend/network/policy";
import { resolveProjectHostConatRouterUrl } from "./conat-router";
import {
  createPersistMaintenanceCoordinator,
  type PersistMaintenanceCoordinator,
} from "@cocalc/backend/conat/persist-maintenance/coordinator";
import { loadPersistMaintenanceConfig } from "@cocalc/backend/conat/persist-maintenance/config";
import {
  collectProjectHostPersistDiagnostics,
  isLoopbackRemoteAddress,
  PROJECT_HOST_PERSIST_DIAGNOSTICS_PATH,
} from "./persist-diagnostics";

const logger = getLogger("project-host:conat-persist");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_PERSIST_READY_TIMEOUT_MS = Math.max(
  1000,
  Number(
    process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_READY_TIMEOUT_MS ?? 10_000,
  ),
);
const DEFAULT_PERSIST_READY_POLL_MS = Math.max(
  100,
  Number(process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_READY_POLL_MS ?? 250),
);
const DEFAULT_PERSIST_HEALTH_REQUEST_TIMEOUT_MS = Math.max(
  250,
  Number(
    process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_REQUEST_TIMEOUT_MS ??
      2_000,
  ),
);

function envIsTrue(name: string): boolean {
  return TRUE_VALUES.has(`${process.env[name] ?? ""}`.trim().toLowerCase());
}

function parsePositiveInteger(
  raw: string | undefined,
  name: string,
): number | undefined {
  const value = `${raw ?? ""}`.trim();
  if (!value) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Where the persist daemon keeps its fences and its capability file
// (conat/persist/fence.ts, persist-fence.ts).
export function persistFenceDir(): string {
  return path.join(resolveHostAgentDataDir(), "persist-fences");
}

export function isProjectHostExternalConatPersistEnabled(): boolean {
  return envIsTrue("COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST");
}

export function resolveProjectHostConatPersistHealthHost(): string {
  return (
    `${process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST ?? ""}`.trim() ||
    process.env.HOST ||
    "127.0.0.1"
  );
}

export function resolveProjectHostConatPersistHealthPort(): number | undefined {
  return parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT ??
      process.env.PORT,
    "COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT",
  );
}

export function resolveProjectHostConatPersistId(): string {
  return `${process.env.COCALC_PROJECT_HOST_PERSIST_ID ?? "0"}`.trim() || "0";
}

export async function checkProjectHostConatPersistReady({
  client,
  id = resolveProjectHostConatPersistId(),
  timeout = DEFAULT_PERSIST_HEALTH_REQUEST_TIMEOUT_MS,
}: {
  client: ConatClient;
  id?: string;
  timeout?: number;
}): Promise<boolean> {
  try {
    const response = await client.request(`${PERSIST_SERVICE}.hub.id`, null, {
      timeout,
    });
    return `${response?.data ?? ""}`.trim() === id;
  } catch (err) {
    logger.debug("project-host conat persist readiness check failed", {
      err: `${err}`,
      id,
      timeout,
    });
    return false;
  }
}

export async function waitForProjectHostConatPersistReady({
  client,
  id = resolveProjectHostConatPersistId(),
  timeoutMs = DEFAULT_PERSIST_READY_TIMEOUT_MS,
  pollMs = DEFAULT_PERSIST_READY_POLL_MS,
}: {
  client: ConatClient;
  id?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkProjectHostConatPersistReady({ client, id })) {
      return;
    }
    await delay(pollMs);
  }
  throw new Error(
    `project-host conat persist did not become ready within ${timeoutMs}ms`,
  );
}

export async function startStandaloneProjectHostConatPersist({
  systemAccountPassword,
}: {
  systemAccountPassword: string;
}): Promise<{
  app: Application;
  client: ConatClient;
  conatRouterUrl: string;
  host: string;
  httpServer: HttpServer;
  id: string;
  persistServer: ConatSocketServer;
  // The board write service (conat/persist/board-policy.ts): the host's board
  // managers write board streams only through it.
  boardPersistServer: ConatSocketServer;
  // Lets the host's main process fence a project's streams, e.g., while it
  // restores the project's files (conat/persist/fence.ts).
  fenceService: { close: () => void };
  maintenance?: PersistMaintenanceCoordinator;
  port: number;
}> {
  const conatRouterUrl = resolveProjectHostConatRouterUrl();
  assertSecureUrlOrLocal({
    url: conatRouterUrl,
    urlName: "COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
  });
  const bindHost = resolveProjectHostConatPersistHealthHost();
  const bindPort =
    resolveProjectHostConatPersistHealthPort() ?? (await getPort());
  assertLocalBindOrInsecure({
    bindHost,
    serviceName: "project-host conat persist health listener",
  });

  const client = connectToConat({
    address: conatRouterUrl,
    systemAccountPassword,
  });
  const id = resolveProjectHostConatPersistId();
  const maintenanceConfig = loadPersistMaintenanceConfig();
  let maintenance: PersistMaintenanceCoordinator | undefined;
  if (maintenanceConfig.enabled) {
    try {
      maintenance = createPersistMaintenanceCoordinator({
        expectedWorkerIds: [id],
        config: maintenanceConfig,
      });
    } catch (err) {
      // Catalog failure must not prevent the data plane from starting.
      logger.error("failed starting persist maintenance coordinator", err);
    }
  }
  // Before the persist server serves: it holds again the fences it held
  // before a restart, and its capability file tells the host's main process
  // that it has fences (persist-fence.ts).
  const fenceDir = persistFenceDir();
  const fenceService = await initPersistFenceService({
    client,
    holderAlive: isFenceHolderAlive,
    store: fileFenceStore(fenceDir),
  });
  // the history in volumes of their own (persist-volume.ts), which restores
  // rely on (persist-fence.ts), before anything is served
  const persistVolumes = installProjectPersistVolumes();
  writeFenceCapability(fenceDir, persistVolumes ? ["persist-volume"] : []);
  const closeFenceService = () => {
    fenceService.close();
    removeFenceCapability(fenceDir);
  };
  // Both services share this process's stream cache, and so its maintenance
  // hooks.
  const maintenanceHooks = maintenance?.createLocalHooks(id);
  const persistServer = createPersistServer({
    client,
    id,
    maintenance: maintenanceHooks,
  });
  const boardPersistServer = createPersistServer({
    client,
    id,
    service: BOARD_WRITE_SERVICE,
    maintenance: maintenanceHooks,
  });
  maintenance?.start();

  let persistReady = false;
  const app = express();
  app.get("/healthz", async (_req, res) => {
    if (!persistReady) {
      res.status(503).json({ ok: false, ready: false });
      return;
    }
    const ok = await checkProjectHostConatPersistReady({ client, id });
    if (!ok) {
      res.status(503).json({ ok: false, ready: false });
      return;
    }
    res.json({ ok: true, ready: true, id });
  });
  app.get("/maintenancez", (_req, res) => {
    if (!maintenance) {
      res.json({
        enabled: false,
        dryRun: true,
        catalogHealthy: false,
        pauseReason: "disabled",
      });
      return;
    }
    res.json(maintenance.status());
  });
  let maintenanceDiagnostics:
    | ReturnType<PersistMaintenanceCoordinator["diagnostics"]>
    | undefined;
  let maintenanceDiagnosticsAt = 0;
  const getMaintenanceDiagnostics = () => {
    if (!maintenance) return undefined;
    if (
      maintenanceDiagnostics == null ||
      Date.now() - maintenanceDiagnosticsAt >= 60_000
    ) {
      maintenanceDiagnostics = maintenance.diagnostics();
      maintenanceDiagnosticsAt = Date.now();
    }
    return maintenanceDiagnostics;
  };
  app.get(PROJECT_HOST_PERSIST_DIAGNOSTICS_PATH, (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.json(
        collectProjectHostPersistDiagnostics({
          includePersistenceDetail: `${req.query.persistence ?? ""}` === "full",
          maintenance: getMaintenanceDiagnostics(),
          ready: persistReady,
          serverId: id,
          streamReleases: getPersistStreamReleaseQueueDiagnostics(),
        }),
      );
    } catch (err) {
      logger.warn("failed collecting conat-persist diagnostics", {
        err: `${err}`,
      });
      res.status(500).json({ error: "diagnostics unavailable" });
    }
  });
  const httpServer = createHttpServer(app);
  httpServer.listen(bindPort, bindHost);
  await once(httpServer, "listening");
  await waitForProjectHostConatPersistReady({ client, id });
  persistReady = true;
  logger.info("project-host conat persist ready", {
    conatRouterUrl,
    healthAddress: `http://${bindHost}:${bindPort}`,
    id,
  });

  return {
    app,
    client,
    conatRouterUrl,
    host: bindHost,
    httpServer,
    id,
    maintenance,
    persistServer,
    boardPersistServer,
    fenceService: { close: closeFenceService },
    port: bindPort,
  };
}
