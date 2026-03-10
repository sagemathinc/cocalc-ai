import * as http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy-3";
import type express from "express";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import TTLCache from "@isaacs/ttlcache";
import listen from "@cocalc/backend/misc/async-server-listen";

const logger = getLogger("project-proxy:http");

const CACHE_TTL = 1000;
const PROJECT_HOST_HTTP_AUTH_COOKIE_NAME = "cocalc_project_host_http_bearer";
const PROJECT_HOST_HTTP_SESSION_COOKIE_NAME =
  "cocalc_project_host_http_session";
const cache = new TTLCache<string, { proxy?: number; err? }>({
  max: 100000,
  ttl: CACHE_TTL,
  updateAgeOnGet: true,
});

type Target = { host: string; port: number };

type ResolveResult = { target?: Target; handled: boolean };

type ResolveFn = (
  req: http.IncomingMessage,
  res?: http.ServerResponse,
) => Promise<ResolveResult> | ResolveResult;

interface StartOptions {
  port?: number; // default 8080
  host?: string; // default 127.0.0.1
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
}

function stripProjectHostProxyAuthCookies(
  cookieHeader: string | string[] | undefined,
): string | undefined {
  if (cookieHeader == null) return undefined;
  const raw = Array.isArray(cookieHeader)
    ? cookieHeader.join(";")
    : cookieHeader;
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const idx = part.indexOf("=");
      const name = idx === -1 ? part : part.slice(0, idx).trim();
      return (
        name !== PROJECT_HOST_HTTP_AUTH_COOKIE_NAME &&
        name !== PROJECT_HOST_HTTP_SESSION_COOKIE_NAME
      );
    });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function parseProjectId(url: string | undefined): string | null {
  if (!url || !url.startsWith("/")) return null;
  const first = url.split("/")[1];
  if (!first || !isValidUUID(first)) return null;
  return first;
}

async function defaultResolveTarget(
  req: http.IncomingMessage,
): Promise<ResolveResult> {
  const project_id = parseProjectId(req.url);
  if (!project_id) {
    return { handled: false };
  }
  if (cache.has(project_id)) {
    const { proxy, err } = cache.get(project_id)!;
    if (err) throw err;
    if (proxy == null) {
      return { handled: false };
    }
    return { target: { host: "localhost", port: proxy }, handled: true };
  }
  // No default resolver in this package; callers should provide resolveTarget.
  cache.set(project_id, { proxy: undefined });
  return { handled: false };
}

export async function startProxyServer({
  port = 8080,
  host = "127.0.0.1",
  resolveTarget = defaultResolveTarget,
  onUpgradeAuthorized,
}: StartOptions = {}) {
  logger.debug("startProxyServer", { port, host });

  const { handleRequest, handleUpgrade } = createProxyHandlers({
    resolveTarget,
    onUpgradeAuthorized,
  });

  const proxyServer = http.createServer(handleRequest);
  proxyServer.on("upgrade", handleUpgrade);

  await listen({
    server: proxyServer,
    port,
    host,
    desc: "project HTTP proxy server",
  });

  return proxyServer;
}

export function createProxyHandlers({
  resolveTarget = defaultResolveTarget,
  onUpgradeAuthorized,
  rewriteRequest,
}: {
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
} = {}) {
  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
  });

  proxy.on("error", (err, req) => {
    const url = (req as http.IncomingMessage).url;
    logger.warn("proxy error", { err: `${err}`, url });
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    proxyReq.setHeader("X-Proxy-By", "cocalc-proxy");
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
    if (cookie) {
      proxyReq.setHeader("cookie", cookie);
    } else {
      proxyReq.removeHeader("cookie");
    }
  });

  proxy.on("proxyReqWs", (proxyReq, req) => {
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
    if (cookie) {
      proxyReq.setHeader("cookie", cookie);
    } else {
      proxyReq.removeHeader("cookie");
    }
    logger.debug("forwarding-ws", {
      url: req.url,
      host: req.headers?.host,
      origin: req.headers?.origin,
    });
  });

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    try {
      await rewriteRequest?.(req);
      const { target, handled } = await resolveTarget(req, res);
      if (handled && !target) return;
      if (!handled || !target) throw new Error("not matched");
      proxy.web(req, res, { target, prependPath: false });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode)
        ? err.statusCode
        : 404;
      res.writeHead(statusCode, { "Content-Type": "text/plain" });
      res.end(`${err?.message ?? "Not found"}\n`);
    }
  };

  const handleUpgrade = async (
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    try {
      await rewriteRequest?.(req);
      const { target, handled } = await resolveTarget(req);
      if (!handled || !target) {
        throw new Error("not matched");
      }
      onUpgradeAuthorized?.(req, socket);
      logger.debug("upgrade", { url: req.url, target });
      proxy.ws(req, socket, head, { target, prependPath: false });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode)
        ? err.statusCode
        : 404;
      const statusText =
        statusCode === 401
          ? "Unauthorized"
          : statusCode === 403
            ? "Forbidden"
            : "Not Found";
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
  };

  return { handleRequest, handleUpgrade };
}

// Express-friendly wrapper used by project-host.
export function attachProjectProxy({
  httpServer,
  app,
  resolveTarget = defaultResolveTarget,
  onUpgradeAuthorized,
  rewriteRequest,
}: {
  httpServer: http.Server;
  app: express.Application;
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
}) {
  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
  });

  proxy.on("error", (err, req) => {
    logger.debug("proxy error", { err: `${err}`, url: req?.url });
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    proxyReq.setHeader("X-Proxy-By", "cocalc-proxy");
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
    if (cookie) {
      proxyReq.setHeader("cookie", cookie);
    } else {
      proxyReq.removeHeader("cookie");
    }
  });

  proxy.on("proxyReqWs", (_proxyReq, req) => {
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
    if (cookie) {
      _proxyReq.setHeader("cookie", cookie);
    } else {
      _proxyReq.removeHeader("cookie");
    }
    logger.debug("forwarding-ws", {
      url: req.url,
      host: req.headers?.host,
      origin: req.headers?.origin,
    });
  });

  app.use(async (req, res, next) => {
    await rewriteRequest?.(req);
    // Only proxy URLs that start with a project UUID segment.
    if (!parseProjectId(req.url)) return next();
    try {
      const { target, handled } = await resolveTarget(req, res);
      logger.debug("resolveTarget", { url: req.url, handled, target });
      if (handled && !target) return;
      if (!handled || !target) return next();
      proxy.web(req, res, { target, prependPath: false });
    } catch (err) {
      logger.debug("proxy request failed", { err: `${err}`, url: req.url });
      if (!res.headersSent) {
        const statusCode = Number.isInteger((err as any)?.statusCode)
          ? (err as any).statusCode
          : 502;
        res.writeHead(statusCode, { "Content-Type": "text/plain" });
      }
      res.end(`${(err as any)?.message ?? "Bad Gateway"}\n`);
    }
  });

  httpServer.prependListener("upgrade", async (req, socket, head) => {
    await rewriteRequest?.(req);
    // Only proxy project-scoped websocket upgrades.
    if (!parseProjectId(req.url)) return;
    try {
      const { target, handled } = await resolveTarget(req);
      if (!handled || !target) {
        return;
      }
      onUpgradeAuthorized?.(req, socket);
      proxy.ws(req, socket, head, { target, prependPath: false });
    } catch (err: any) {
      const statusCode = Number.isInteger(err?.statusCode)
        ? err.statusCode
        : 502;
      const statusText =
        statusCode === 401
          ? "Unauthorized"
          : statusCode === 403
            ? "Forbidden"
            : "Bad Gateway";
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
    }
  });
}
