import * as http from "node:http";
import type { ClientRequest } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy-3";
import type express from "express";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import TTLCache from "@isaacs/ttlcache";
import listen from "@cocalc/backend/misc/async-server-listen";
import { stripProjectHostProxyAuthCookies } from "@cocalc/conat/auth/project-host-proxy-boundary";

const logger = getLogger("project-proxy:http");

const CACHE_TTL = 1000;
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

type NoteProxyBoundaryBytesFn = (opts: {
  req: http.IncomingMessage;
  bytes: number;
}) => void;

interface StartOptions {
  port?: number; // default 8080
  host?: string; // default 127.0.0.1
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
  noteUpstreamHttpBytes?: NoteProxyBoundaryBytesFn;
  noteUpstreamWsBytes?: NoteProxyBoundaryBytesFn;
}

export { stripProjectHostProxyAuthCookies };

function parseProjectId(url: string | undefined): string | null {
  if (!url || !url.startsWith("/")) return null;
  const first = url.split("/")[1];
  if (!first || !isValidUUID(first)) return null;
  return first;
}

function getChunkByteLength(chunk: unknown): number {
  if (chunk == null) return 0;
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

function observeUpstreamWebSocketBytes({
  proxyReq,
  req,
  noteUpstreamWsBytes,
}: {
  proxyReq: ClientRequest;
  req: http.IncomingMessage;
  noteUpstreamWsBytes: NoteProxyBoundaryBytesFn;
}): void {
  // http-proxy-3 registers its upgrade listener after proxyReqWs handlers
  // return. Register ours in a microtask so its pipe sees the upgrade head
  // before any metering listener can put the upstream socket in flowing mode.
  queueMicrotask(() => {
    proxyReq.once("upgrade", (_proxyRes, proxySocket, proxyHead) => {
      const headBytes = getChunkByteLength(proxyHead);
      if (headBytes > 0) {
        noteUpstreamWsBytes({ req, bytes: headBytes });
      }
      proxySocket.on("data", (chunk) => {
        const bytes = getChunkByteLength(chunk);
        if (bytes > 0) {
          noteUpstreamWsBytes({ req, bytes });
        }
      });
    });
  });
}

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return `${value[0] ?? ""}`.trim();
  return `${value ?? ""}`.trim();
}

function forwardedProto(req: http.IncomingMessage): string {
  const proto = firstHeaderValue(req.headers["x-forwarded-proto"])
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto) return proto;
  // @ts-ignore node IncomingMessage.socket may have encrypted in tls mode.
  return req.socket?.encrypted ? "https" : "http";
}

function stripDefaultPort(host: string, proto: string): string {
  if (!host) return host;
  if (proto === "https") return host.replace(/:443$/, "").replace(/:80$/, "");
  if (proto === "http") return host.replace(/:80$/, "");
  return host;
}

function forwardedHost(req: http.IncomingMessage): string {
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ||
    firstHeaderValue(req.headers.host);
  return stripDefaultPort(host, forwardedProto(req));
}

function normalizeForwardedHeaders(
  proxyReq: ClientRequest,
  req: http.IncomingMessage,
): void {
  const proto = forwardedProto(req);
  const host = forwardedHost(req);
  if (proto) {
    proxyReq.setHeader("x-forwarded-proto", proto);
    proxyReq.setHeader("x-forwarded-port", proto === "https" ? "443" : "80");
  }
  if (host) {
    proxyReq.setHeader("x-forwarded-host", host);
  }
}

function serializeParsedBody(body: unknown): Buffer | undefined {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return Buffer.from(JSON.stringify(body));
}

function restreamParsedBody(
  proxyReq: ClientRequest,
  req: http.IncomingMessage,
  assertForwardAllowed?: () => void,
): void {
  const body = serializeParsedBody((req as any).body);
  if (body == null) return;
  assertForwardAllowed?.();
  proxyReq.setHeader("content-length", `${body.byteLength}`);
  proxyReq.write(body);
}

function normalizeRedirectLocation(
  location: string,
  req: http.IncomingMessage,
): string {
  try {
    const parsed = new URL(location);
    if (parsed.toString() !== location && parsed.port === "") {
      return parsed.toString();
    }
    if (parsed.protocol === "https:" && parsed.port === "80") {
      parsed.port = "";
      return parsed.toString();
    }
    if (parsed.protocol === "http:" && parsed.port === "443") {
      parsed.port = "";
      return parsed.toString();
    }
    const isLoopback =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (isLoopback) {
      const proto = forwardedProto(req);
      const host = forwardedHost(req);
      if (host) {
        return `${proto}://${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    }
  } catch {
    // Relative or malformed locations are left alone.
  }
  return location;
}

function normalizeProxyRedirectHeaders(
  proxyRes: http.IncomingMessage,
  req: http.IncomingMessage,
): void {
  const location = proxyRes.headers.location;
  if (typeof location !== "string" || !location) return;
  const normalized = normalizeRedirectLocation(location, req);
  if (normalized !== location) {
    proxyRes.headers.location = normalized;
  }
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
  noteUpstreamHttpBytes,
  noteUpstreamWsBytes,
}: StartOptions = {}) {
  logger.debug("startProxyServer", { port, host });

  const { handleRequest, handleUpgrade } = createProxyHandlers({
    resolveTarget,
    onUpgradeAuthorized,
    noteUpstreamHttpBytes,
    noteUpstreamWsBytes,
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
  preserveCookieNames,
  noteUpstreamHttpBytes,
  noteUpstreamWsBytes,
}: {
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
  preserveCookieNames?: string[];
  noteUpstreamHttpBytes?: NoteProxyBoundaryBytesFn;
  noteUpstreamWsBytes?: NoteProxyBoundaryBytesFn;
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
    normalizeForwardedHeaders(proxyReq, req);
    proxyReq.setHeader("X-Proxy-By", "cocalc-proxy");
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie, {
      preserveCookieNames,
    });
    if (cookie) {
      proxyReq.setHeader("cookie", cookie);
    } else {
      proxyReq.removeHeader("cookie");
    }
    restreamParsedBody(proxyReq, req);
  });

  proxy.on("proxyReqWs", (proxyReq, req) => {
    normalizeForwardedHeaders(proxyReq, req);
    const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie, {
      preserveCookieNames,
    });
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
    if (noteUpstreamWsBytes) {
      observeUpstreamWebSocketBytes({
        proxyReq,
        req,
        noteUpstreamWsBytes,
      });
    }
  });

  proxy.on("proxyRes", (proxyRes, req) => {
    normalizeProxyRedirectHeaders(proxyRes, req);
    if (noteUpstreamHttpBytes) {
      proxyRes.on("data", (chunk) => {
        const bytes = getChunkByteLength(chunk);
        if (bytes > 0) {
          noteUpstreamHttpBytes({ req, bytes });
        }
      });
    }
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
            : statusCode === 429
              ? "Too Many Requests"
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
  httpServers,
  app,
  resolveTarget = defaultResolveTarget,
  onUpgradeAuthorized,
  rewriteRequest,
  rewriteResponse,
  assertForwardAllowed,
  noteUpstreamHttpBytes,
  noteUpstreamWsBytes,
}: {
  httpServer?: http.Server;
  httpServers?: readonly http.Server[];
  app: express.Application;
  resolveTarget?: ResolveFn;
  onUpgradeAuthorized?: (
    req: http.IncomingMessage,
    socket: Socket | Duplex,
  ) => void;
  rewriteRequest?: (req: http.IncomingMessage) => Promise<void> | void;
  rewriteResponse?: (
    proxyRes: http.IncomingMessage,
    req: http.IncomingMessage,
  ) => void;
  assertForwardAllowed?: (req: http.IncomingMessage) => void;
  noteUpstreamHttpBytes?: NoteProxyBoundaryBytesFn;
  noteUpstreamWsBytes?: NoteProxyBoundaryBytesFn;
}) {
  const ingressServers = httpServers ?? (httpServer ? [httpServer] : []);
  if (ingressServers.length === 0) {
    throw new Error("attachProjectProxy requires at least one HTTP server");
  }
  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
  });

  const assertLive = (req: http.IncomingMessage, res?: http.ServerResponse) => {
    if (req.aborted || res?.destroyed || res?.writableEnded) {
      throw new Error("proxy request is no longer live");
    }
    assertForwardAllowed?.(req);
  };

  proxy.on("error", (err, req) => {
    logger.debug("proxy error", { err: `${err}`, url: req?.url });
  });

  proxy.on("proxyReq", (proxyReq, req, res) => {
    try {
      assertLive(req, res);
      normalizeForwardedHeaders(proxyReq, req);
      proxyReq.setHeader("X-Proxy-By", "cocalc-proxy");
      const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
      if (cookie) {
        proxyReq.setHeader("cookie", cookie);
      } else {
        proxyReq.removeHeader("cookie");
      }
      restreamParsedBody(proxyReq, req, () => assertLive(req, res));
    } catch {
      proxyReq.destroy();
      res.destroy();
    }
  });

  proxy.on("proxyReqWs", (_proxyReq, req) => {
    try {
      assertLive(req);
    } catch {
      _proxyReq.destroy();
      return;
    }
    normalizeForwardedHeaders(_proxyReq, req);
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
    if (noteUpstreamWsBytes) {
      observeUpstreamWebSocketBytes({
        proxyReq: _proxyReq,
        req,
        noteUpstreamWsBytes,
      });
    }
  });

  proxy.on("proxyRes", (proxyRes, req) => {
    normalizeProxyRedirectHeaders(proxyRes, req);
    rewriteResponse?.(proxyRes, req);
    if (noteUpstreamHttpBytes) {
      proxyRes.on("data", (chunk) => {
        const bytes = getChunkByteLength(chunk);
        if (bytes > 0) {
          noteUpstreamHttpBytes({ req, bytes });
        }
      });
    }
  });

  const handleRequest = async (req, res, next) => {
    await rewriteRequest?.(req);
    // Only proxy URLs that start with a project UUID segment.
    if (!parseProjectId(req.url)) return next();
    try {
      const { target, handled } = await resolveTarget(req, res);
      logger.debug("resolveTarget", { url: req.url, handled, target });
      if (handled && !target) return;
      if (!handled || !target) return next();
      assertLive(req, res);
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
  };
  app.use(handleRequest);

  const handleUpgrade = async (req, socket, head) => {
    await rewriteRequest?.(req);
    // Only proxy project-scoped websocket upgrades.
    if (!parseProjectId(req.url)) return;
    try {
      const { target, handled } = await resolveTarget(req);
      if (!handled || !target) {
        return;
      }
      onUpgradeAuthorized?.(req, socket);
      if (socket.destroyed) return;
      assertLive(req);
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
            : statusCode === 429
              ? "Too Many Requests"
              : "Bad Gateway";
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
    }
  };
  for (const ingressServer of ingressServers) {
    ingressServer.prependListener("upgrade", handleUpgrade);
  }

  return { handleRequest, handleUpgrade };
}
