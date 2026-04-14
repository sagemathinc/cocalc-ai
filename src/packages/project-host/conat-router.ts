/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { availableParallelism } from "node:os";
import express from "express";
import type { Application } from "express";
import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import {
  assertLocalBindOrInsecure,
  assertSecureUrlOrLocal,
} from "@cocalc/backend/network/policy";
import { init as createConatServer } from "@cocalc/conat/core/server";
import type {
  AllowFunction,
  ConatServer,
  UserFunction,
} from "@cocalc/conat/core/server";
import { createProxyHandlers } from "@cocalc/project-proxy/proxy";
import { createProjectHostConatAuth } from "./conat-auth";

const logger = getLogger("project-host:conat-router");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

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

function parseProxyTarget(address: string): { host: string; port: number } {
  const parsed = new URL(address);
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error(
      `project-host conat router proxy target must not include a path: ${address}`,
    );
  }
  const defaultPort =
    parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `invalid project-host conat router target port: ${address}`,
    );
  }
  return { host: parsed.hostname, port };
}

export function isProjectHostExternalConatRouterEnabled(): boolean {
  return envIsTrue("COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER");
}

export function resolveProjectHostConatRouterUrl(): string {
  const explicit =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim();
  if (explicit) {
    assertSecureUrlOrLocal({
      url: explicit,
      urlName: "COCALC_PROJECT_HOST_CONAT_ROUTER_URL",
    });
    return explicit;
  }
  const port = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT,
    "COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
  );
  if (port != null) {
    return `http://127.0.0.1:${port}`;
  }
  throw new Error(
    "external conat router mode requires COCALC_PROJECT_HOST_CONAT_ROUTER_URL or COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
  );
}

export function resolveProjectHostConatRouterLocalClusterSize(): number {
  const explicit = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_LOCAL_CLUSTER_SIZE,
    "COCALC_PROJECT_HOST_CONAT_ROUTER_LOCAL_CLUSTER_SIZE",
  );
  if (explicit != null) {
    return explicit;
  }
  const parallelism = Math.max(1, availableParallelism());
  return Math.min(8, Math.max(1, Math.floor(parallelism / 4))) || 1;
}

export function resolveProjectHostConatRouterClusterName({
  hostId,
  localClusterSize,
}: {
  hostId: string;
  localClusterSize: number;
}): string | undefined {
  if (localClusterSize < 2) {
    return;
  }
  return (
    `${process.env.COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME ?? ""}`.trim() ||
    `project-host-router-${hostId}`
  );
}

export async function startProjectHostConatRouterServer({
  httpServer,
  ssl,
  port,
  hostId,
  systemAccountPassword,
  getUser,
  isAllowed,
}: {
  httpServer: HttpServer;
  ssl: boolean;
  port: number;
  hostId: string;
  systemAccountPassword: string;
  getUser?: UserFunction;
  isAllowed?: AllowFunction;
}): Promise<ConatServer> {
  const conatAuth =
    getUser != null && isAllowed != null
      ? { getUser, isAllowed }
      : createProjectHostConatAuth({ host_id: hostId });
  const localClusterSize = resolveProjectHostConatRouterLocalClusterSize();
  const clusterName = resolveProjectHostConatRouterClusterName({
    hostId,
    localClusterSize,
  });
  const conatServer = createConatServer({
    httpServer,
    ssl,
    port,
    getUser: conatAuth.getUser,
    isAllowed: conatAuth.isAllowed,
    systemAccountPassword,
    localClusterSize,
    clusterName,
  });
  if (conatServer.state !== "ready") {
    await once(conatServer, "ready");
  }
  logger.info("project-host conat router ready", {
    address: conatServer.address(),
    localClusterSize,
    clusterName,
  });
  return conatServer;
}

export async function startStandaloneProjectHostConatRouter({
  host,
  port,
  hostId,
  systemAccountPassword,
}: {
  host?: string;
  port?: number;
  hostId: string;
  systemAccountPassword: string;
}): Promise<{
  app: Application;
  host: string;
  port: number;
  httpServer: HttpServer;
  conatServer: ConatServer;
}> {
  const bindHost =
    host ??
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ??
    process.env.HOST ??
    "127.0.0.1";
  const bindPort =
    port ??
    parsePositiveInteger(
      process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT ?? process.env.PORT,
      "COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
    ) ??
    (await getPort());
  assertLocalBindOrInsecure({
    bindHost,
    serviceName: "project-host conat router listener",
  });
  const app = express();
  let conatReady = false;
  app.get("/healthz", (_req, res) => {
    if (!conatReady) {
      res.status(503).json({ ok: false, ready: false });
      return;
    }
    res.json({ ok: true, ready: true });
  });
  const httpServer = createHttpServer(app);
  httpServer.listen(bindPort, bindHost);
  await once(httpServer, "listening");
  const conatServer = await startProjectHostConatRouterServer({
    httpServer,
    ssl: false,
    port: bindPort,
    hostId,
    systemAccountPassword,
  });
  conatReady = true;
  return {
    app,
    host: bindHost,
    port: bindPort,
    httpServer,
    conatServer,
  };
}

export function rewriteProjectHostConatProxyUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return;
  const parsed = new URL(url, "http://project-host.local");
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/conat") && trimmedPath !== "/conat") {
    return;
  }
  parsed.pathname = "/conat/";
  return `${parsed.pathname}${parsed.search ?? ""}`;
}

export function attachProjectHostConatRouterProxy({
  app,
  httpServer,
  target,
}: {
  app: Application;
  httpServer: HttpServer;
  target: string;
}): void {
  const proxyTarget = parseProxyTarget(target);
  const rewriteRequest = (req: IncomingMessage) => {
    const rewritten = rewriteProjectHostConatProxyUrl(req.url);
    if (!rewritten) {
      throw Object.assign(new Error("not matched"), { statusCode: 404 });
    }
    req.url = rewritten;
  };
  const { handleRequest, handleUpgrade } = createProxyHandlers({
    resolveTarget: () => ({ handled: true, target: proxyTarget }),
    rewriteRequest,
  });
  logger.info("project-host conat router proxy enabled", {
    target,
    proxyTarget,
  });
  app.use((req, res, next) => {
    if (!rewriteProjectHostConatProxyUrl(req.url)) {
      return next();
    }
    void handleRequest(req, res);
  });
  httpServer.prependListener("upgrade", (req, socket, head) => {
    if (!rewriteProjectHostConatProxyUrl(req.url)) {
      return;
    }
    void handleUpgrade(req, socket as any, head);
  });
}
