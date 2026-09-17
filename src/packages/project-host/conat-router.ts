/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import { createHmac } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
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
import {
  PROJECT_HOST_HTTP_AUTH_COOKIE_NAME,
  PROJECT_HOST_HTTP_SESSION_COOKIE_NAME,
} from "@cocalc/conat/auth/project-host-http";
import { PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME } from "@cocalc/conat/auth/project-host-browser-session";
import { createProxyHandlers } from "@cocalc/project-proxy/proxy";
import { getOrCreateSelfSigned } from "@cocalc/lite/tls";
import { isValidUUID } from "@cocalc/util/misc";
import { createProjectHostConatAuth } from "./conat-auth";

const logger = getLogger("project-host:conat-router");
const LONG_LIVED_HTTP_TIMEOUT_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_PROJECT_HOST_HTTP_KEEPALIVE_TIMEOUT_MS ?? 120_000,
  ) || 120_000,
);

function configureLongLivedHttpServer(httpServer: HttpServer): void {
  // Project-host ingress carries socket.io websocket traffic. Node's short
  // default keep-alive timeout can otherwise close quiet upgraded connections
  // before socket.io's own ping interval gets a chance to run.
  httpServer.keepAliveTimeout = LONG_LIVED_HTTP_TIMEOUT_MS;
  httpServer.headersTimeout = LONG_LIVED_HTTP_TIMEOUT_MS + 5_000;
  httpServer.requestTimeout = 0;
  httpServer.setTimeout(0);
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
  // Project-host now always routes through a dedicated local conat-router
  // daemon. Keep this helper as a compatibility shim for older callers.
  return true;
}

export function isProjectHostManagedLocalConatRouter(): boolean {
  try {
    resolveProjectHostConatRouterUrl();
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectHostConatRouterUrl(): string {
  const configuredHost = normalizeLoopbackHost(
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ?? "127.0.0.1"}`.trim() ||
      "127.0.0.1",
  );
  const port = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT,
    "COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
  );
  if (port == null) {
    throw new Error(
      "project-host requires COCALC_PROJECT_HOST_CONAT_ROUTER_PORT so it can connect to the managed local conat router daemon",
    );
  }
  const derived = `http://${configuredHost}:${port}`;
  const explicit =
    `${process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim();
  if (explicit) {
    assertSecureUrlOrLocal({
      url: explicit,
      urlName: "COCALC_PROJECT_HOST_CONAT_ROUTER_URL",
    });
    try {
      const parsed = new URL(explicit);
      const explicitPort =
        parsed.port.length > 0
          ? Number(parsed.port)
          : parsed.protocol === "http:"
            ? 80
            : parsed.protocol === "https:"
              ? 443
              : undefined;
      if (
        parsed.protocol !== "http:" ||
        (parsed.pathname && parsed.pathname !== "/") ||
        normalizeLoopbackHost(parsed.hostname) !== configuredHost ||
        explicitPort !== port
      ) {
        throw new Error(
          "project-host does not support an external conat router; use the managed local daemon port configuration instead",
        );
      }
    } catch (err) {
      if (err instanceof Error) {
        throw err;
      }
      throw new Error(
        "project-host does not support an external conat router; use the managed local daemon port configuration instead",
      );
    }
  }
  return derived;
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

export function resolveProjectHostDirectHttpsConfig():
  | { host: string; port: number; hostname: string }
  | undefined {
  const rawPort =
    `${process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT ?? ""}`.trim();
  if (!rawPort) return;
  const port = parsePositiveInteger(
    rawPort,
    "COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT",
  );
  if (port == null || port > 65_535) {
    throw new Error(
      "COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT must be an integer from 1 through 65535",
    );
  }
  const host =
    `${process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOST ?? ""}`.trim() ||
    "0.0.0.0";
  let hostname =
    `${process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOSTNAME ?? ""}`.trim();
  if (!hostname) {
    try {
      hostname = new URL(`${process.env.PROJECT_HOST_PUBLIC_URL ?? ""}`)
        .hostname;
    } catch {
      // The certificate hostname is diagnostic only behind Cloudflare TLS.
    }
  }
  return { host, port, hostname: hostname || "localhost" };
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

export function deriveProjectHostConatClusterLinkPassword(
  systemAccountPassword: string,
): string {
  if (!systemAccountPassword) {
    throw new Error("project-host conat system account password is required");
  }
  return createHmac("sha256", systemAccountPassword)
    .update("cocalc-project-host-conat-cluster-link-v1")
    .digest("base64url");
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
    clusterLinkPassword: deriveProjectHostConatClusterLinkPassword(
      systemAccountPassword,
    ),
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
  directHttpsServer?: ReturnType<typeof createHttpsServer>;
  ingressHost?: string;
  ingressPort?: number;
  directHttpsHost?: string;
  directHttpsPort?: number;
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
      res.status(503).json(projectHostConatRouterHealthState(hostId, false));
      return;
    }
    res.json(projectHostConatRouterHealthState(hostId, true));
  });
  const httpServer = createHttpServer(app);
  configureLongLivedHttpServer(httpServer);
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
  const directHttps = resolveProjectHostDirectHttpsConfig();
  let ingressHttpServer: HttpServer | undefined;
  let directHttpsServer: ReturnType<typeof createHttpsServer> | undefined;
  if (upstreamUrl && ((ingressHost && ingressPort != null) || directHttps)) {
    const ingressApp = express();
    ingressApp.get("/healthz", (_req, res) => {
      res.json(projectHostConatRouterHealthState(hostId, true));
    });
    const ingressServers: HttpServer[] = [];
    if (ingressHost && ingressPort != null) {
      assertLocalBindOrInsecure({
        bindHost: ingressHost,
        serviceName: "project-host conat router ingress listener",
      });
      ingressHttpServer = createHttpServer(ingressApp);
      configureLongLivedHttpServer(ingressHttpServer);
      ingressServers.push(ingressHttpServer);
    }
    if (directHttps) {
      if (
        ingressHost === directHttps.host &&
        ingressPort === directHttps.port
      ) {
        throw new Error(
          "direct HTTPS ingress must not duplicate the HTTP ingress address",
        );
      }
      const { key, cert, keyPath, certPath } = getOrCreateSelfSigned(
        directHttps.hostname,
      );
      directHttpsServer = createHttpsServer({ key, cert }, ingressApp);
      configureLongLivedHttpServer(directHttpsServer);
      ingressServers.push(directHttpsServer);
      logger.info("project-host direct HTTPS certificate ready", {
        hostname: directHttps.hostname,
        keyPath,
        certPath,
      });
    }
    attachProjectHostConatRouterProxy({
      app: ingressApp,
      httpServers: ingressServers,
      target: `http://${normalizeLoopbackHost(bindHost)}:${bindPort}`,
    });
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServers: ingressServers,
      target: upstreamUrl,
    });
    if (ingressHttpServer && ingressHost && ingressPort != null) {
      ingressHttpServer.listen(ingressPort, ingressHost);
      await once(ingressHttpServer, "listening");
      logger.info("project-host conat router ingress ready", {
        ingressHost,
        ingressPort,
        upstreamUrl,
        conatTarget: `http://${normalizeLoopbackHost(bindHost)}:${bindPort}`,
      });
    }
    if (directHttpsServer && directHttps) {
      directHttpsServer.listen(directHttps.port, directHttps.host);
      await once(directHttpsServer, "listening");
      logger.info("project-host direct HTTPS ingress ready", {
        host: directHttps.host,
        port: directHttps.port,
        hostname: directHttps.hostname,
        upstreamUrl,
        conatTarget: `http://${normalizeLoopbackHost(bindHost)}:${bindPort}`,
      });
    }
  }
  conatReady = true;
  return {
    app,
    host: bindHost,
    port: bindPort,
    httpServer,
    conatServer,
    ingressHttpServer,
    directHttpsServer,
    ingressHost,
    ingressPort,
    directHttpsHost: directHttps?.host,
    directHttpsPort: directHttps?.port,
  };
}

export function projectHostConatRouterHealthState(
  hostId: string,
  ready: boolean,
): { ok: boolean; ready: boolean; host_id: string } {
  return { ok: ready, ready, host_id: hostId };
}

export function rewriteProjectHostConatProxyUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return;
  const parsed = new URL(url, "http://project-host.local");
  const firstPathSegment = parsed.pathname.split("/").filter(Boolean)[0];
  if (firstPathSegment && isValidUUID(firstPathSegment)) {
    return;
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/conat") && trimmedPath !== "/conat") {
    return;
  }
  parsed.pathname = "/conat/";
  return `${parsed.pathname}${parsed.search ?? ""}`;
}

function normalizeHostname(value: unknown): string {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(`http://${raw}`).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  } catch {
    return "";
  }
}

function hostnameFromUrl(value: unknown): string {
  try {
    return normalizeHostname(new URL(`${value ?? ""}`).host);
  } catch {
    return "";
  }
}

export function examHostnameFromProjectHostPublicUrl(
  value: unknown,
): string | undefined {
  const publicHostname = hostnameFromUrl(value);
  if (!publicHostname) return;
  const labels = publicHostname.split(".");
  const first = labels[0] ?? "";
  if (!first.startsWith("host-")) return;
  labels[0] = `exam-${first.slice("host-".length)}`;
  return labels.join(".");
}

export function shouldRouteProjectHostIngressToApp(
  req: Pick<IncomingMessage, "headers">,
): boolean {
  const requestHostname = normalizeHostname(req.headers.host);
  if (
    !requestHostname ||
    requestHostname === "localhost" ||
    isIP(requestHostname)
  ) {
    return false;
  }
  const publicHostname = hostnameFromUrl(process.env.PROJECT_HOST_PUBLIC_URL);
  if (!publicHostname) {
    return false;
  }
  const infrastructureHostnames = new Set([
    publicHostname,
    hostnameFromUrl(process.env.PROJECT_HOST_INTERNAL_URL),
    examHostnameFromProjectHostPublicUrl(process.env.PROJECT_HOST_PUBLIC_URL),
  ]);
  return !infrastructureHostnames.has(requestHostname);
}

export function attachProjectHostConatRouterProxy({
  app,
  httpServer,
  httpServers,
  target,
  rewriteIngressRequest,
}: {
  app: Application;
  httpServer?: HttpServer;
  httpServers?: readonly HttpServer[];
  target: string;
  rewriteIngressRequest?: (req: IncomingMessage) => Promise<void> | void;
}): void {
  const ingressServers = httpServers ?? (httpServer ? [httpServer] : []);
  if (ingressServers.length === 0) {
    throw new Error(
      "attachProjectHostConatRouterProxy requires at least one HTTP server",
    );
  }
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
    preserveCookieNames: [PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME],
  });
  logger.info("project-host conat router proxy enabled", {
    target,
    proxyTarget,
  });
  app.use(async (req, res, next) => {
    await rewriteIngressRequest?.(req);
    if (
      shouldRouteProjectHostIngressToApp(req) ||
      !rewriteProjectHostConatProxyUrl(req.url)
    ) {
      return next();
    }
    void handleRequest(req, res);
  });
  for (const ingressServer of ingressServers) {
    ingressServer.prependListener("upgrade", async (req, socket, head) => {
      await rewriteIngressRequest?.(req);
      if (
        shouldRouteProjectHostIngressToApp(req) ||
        !rewriteProjectHostConatProxyUrl(req.url)
      ) {
        return;
      }
      void handleUpgrade(req, socket as any, head);
    });
  }
}

export function attachProjectHostHttpFallbackProxy({
  app,
  httpServer,
  httpServers,
  target,
}: {
  app: Application;
  httpServer?: HttpServer;
  httpServers?: readonly HttpServer[];
  target: string;
}): void {
  const ingressServers = httpServers ?? (httpServer ? [httpServer] : []);
  if (ingressServers.length === 0) {
    throw new Error(
      "attachProjectHostHttpFallbackProxy requires at least one HTTP server",
    );
  }
  const proxyTarget = parseProxyTarget(target);
  const { handleRequest, handleUpgrade } = createProxyHandlers({
    resolveTarget: () => ({ handled: true, target: proxyTarget }),
    preserveCookieNames: [
      PROJECT_HOST_HTTP_AUTH_COOKIE_NAME,
      PROJECT_HOST_HTTP_SESSION_COOKIE_NAME,
      PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME,
    ],
  });
  logger.info("project-host ingress fallback proxy enabled", {
    target,
    proxyTarget,
  });
  app.use((req, res) => {
    void handleRequest(req, res);
  });
  for (const ingressServer of ingressServers) {
    ingressServer.on("upgrade", (req, socket, head) => {
      if (
        rewriteProjectHostConatProxyUrl(req.url) &&
        !shouldRouteProjectHostIngressToApp(req)
      ) {
        return;
      }
      void handleUpgrade(req, socket as any, head);
    });
  }
}
