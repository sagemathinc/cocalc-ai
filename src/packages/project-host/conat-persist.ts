/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import express from "express";
import type { Application } from "express";
import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
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
  const persistServer = createPersistServer({ client, id });

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
    persistServer,
    port: bindPort,
  };
}
