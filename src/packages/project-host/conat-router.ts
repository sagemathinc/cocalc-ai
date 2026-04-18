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

function normalizeLoopbackHost(host: string): string {
  return host === "0.0.0.0" ||
    host === "::" ||
    host === "[::]" ||
    host === "localhost"
    ? "127.0.0.1"
    : host;
}

export function isProjectHostExternalConatRouterEnabled(): boolean {
  return envIsTrue("COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER");
}

export function isProjectHostManagedLocalConatRouter(): boolean {
  if (!isProjectHostExternalConatRouterEnabled()) {
    return false;
  }
  const explicit =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim();
  if (!explicit) {
    return true;
  }
  const rawPort =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT ?? ""}`.trim();
  if (!rawPort) {
    return false;
  }
  try {
    const parsed = new URL(explicit);
    const defaultPort =
      parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 0;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!Number.isInteger(port) || port <= 0) {
      return false;
    }
    const configuredHost = normalizeLoopbackHost(
      `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ?? "127.0.0.1"}`.trim() ||
        "127.0.0.1",
    );
    return (
      normalizeLoopbackHost(parsed.hostname) === configuredHost &&
      String(port) === rawPort
    );
  } catch {
    return false;
  }
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

function resolveProjectHostConatRouterIngressHost(): string | undefined {
  const raw =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_INGRESS_HOST ?? ""}`.trim();
  return raw || undefined;
}

function resolveProjectHostConatRouterIngressPort(): number | undefined {
  return parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_INGRESS_PORT,
    "COCALC_PROJECT_HOST_CONAT_ROUTER_INGRESS_PORT",
  );
}

function resolveProjectHostConatRouterUpstreamUrl(): string | undefined {
  const explicit =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_UPSTREAM_URL ?? ""}`.trim();
  if (!explicit) {
    return;
  }
  assertSecureUrlOrLocal({
    url: explicit,
    urlName: "COCALC_PROJECT_HOST_CONAT_ROUTER_UPSTREAM_URL",
  });
  return explicit;
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
  ingressHttpServer?: HttpServer;
  ingressHost?: string;
  ingressPort?: number;
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
  const ingressHost = resolveProjectHostConatRouterIngressHost();
  const ingressPort = resolveProjectHostConatRouterIngressPort();
  const upstreamUrl = resolveProjectHostConatRouterUpstreamUrl();
  let ingressHttpServer: HttpServer | undefined;
  if (ingressHost && ingressPort != null && upstreamUrl) {
    assertLocalBindOrInsecure({
      bindHost: ingressHost,
      serviceName: "project-host conat router ingress listener",
    });
    const ingressApp = express();
    ingressApp.get("/healthz", (_req, res) => {
      res.json({ ok: true, ready: true });
    });
    ingressHttpServer = createHttpServer(ingressApp);
    attachProjectHostConatRouterProxy({
      app: ingressApp,
      httpServer: ingressHttpServer,
      target: `http://${normalizeLoopbackHost(bindHost)}:${bindPort}`,
    });
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServer: ingressHttpServer,
      target: upstreamUrl,
    });
    ingressHttpServer.listen(ingressPort, ingressHost);
    await once(ingressHttpServer, "listening");
    logger.info("project-host conat router ingress ready", {
      ingressHost,
      ingressPort,
      upstreamUrl,
      conatTarget: `http://${normalizeLoopbackHost(bindHost)}:${bindPort}`,
    });
  }
  conatReady = true;
  return {
    app,
    host: bindHost,
    port: bindPort,
    httpServer,
    conatServer,
    ingressHttpServer,
    ingressHost,
    ingressPort,
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

export function attachProjectHostHttpFallbackProxy({
  app,
  httpServer,
  target,
}: {
  app: Application;
  httpServer: HttpServer;
  target: string;
}): void {
  const proxyTarget = parseProxyTarget(target);
  const { handleRequest, handleUpgrade } = createProxyHandlers({
    resolveTarget: () => ({ handled: true, target: proxyTarget }),
  });
  logger.info("project-host ingress fallback proxy enabled", {
    target,
    proxyTarget,
  });
  app.use((req, res) => {
    void handleRequest(req, res);
  });
  httpServer.on("upgrade", (req, socket, head) => {
    if (rewriteProjectHostConatProxyUrl(req.url)) {
      return;
    }
    void handleUpgrade(req, socket as any, head);
  });
}
