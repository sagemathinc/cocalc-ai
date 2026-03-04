/*
This starts a very lightweight http server listening on the requested port,
which proxies all http traffic (including websockets) as follows:

 - /base_url/server/PORT/... ---> http://localhost:PORT/base_url/server/PORT/...
 - /base_url/port/PORT/...   ---> http://localhost:PORT/...


Notice that the server format strips the whole /base_url/... business, and "port"
leaves it unchanged, meaning you have to run your application aware of a base_url.

NOTE: you can use "proxy" as an alias for "server", for compatibility with code-server,
which uses /base_url/proxy/PORT/ for *exactly* what we have /base_url/server/PORT/ for.

This uses the http-proxy-3 library, which is a modern supported version
of the old http-proxy nodejs npm library, with the same API.

For our application the base_url is the project_id, so url's look like

    /{project_id}/[server|port]
- We set xfwd headers and support WebSockets.

This proxy gets typically exposed externally via the proxy in

   packages/project-proxy/proxy.ts
*/

import * as http from "node:http";
import type express from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { userInfo } from "node:os";
import httpProxy from "http-proxy-3";
import { getLogger } from "@cocalc/project/logger";
import { project_id } from "@cocalc/project/data";
import { secretToken } from "@cocalc/project/data";
import { resolveAppProxyTarget } from "@cocalc/project/app-servers/control";
import {
  PROJECT_PROXY_AUTH_HEADER,
  getSingleHeaderValue,
} from "@cocalc/backend/auth/project-proxy-auth";
import listen from "@cocalc/backend/misc/async-server-listen";

const logger = getLogger("project:servers:proxy");
const STATIC_CACHE_CONTROL_DEFAULT = "public, max-age=300";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

type StaticResolvedFile = {
  absolutePath: string;
  stat: { size: number; mtimeMs: number };
};

interface StartOptions {
  base_url?: string;
  port?: number; // default to COCALC_PROXY_PORT or 80 for root, or 8080 for non-root
  host?: string; // default to COCALC_PROXY_HOST or 127.0.0.1
}

export async function startProxyServer({
  base_url = getProxyBaseUrl({ project_id }),
  port,
  host = process.env.COCALC_PROXY_HOST ?? "127.0.0.1",
}: StartOptions = {}) {
  if (!port) {
    if (process.env.COCALC_PROXY_PORT) {
      port = parseInt(process.env.COCALC_PROXY_PORT);
    } else if (userInfo().username == "root") {
      port = 80;
    } else {
      port = 8080;
    }
  }

  logger.debug("startProxyServer", { base_url, port, host });
  const { proxy, getTarget } = createProxyResolver({
    base_url,
    host: "localhost",
  });

  const proxyServer = http.createServer((req, res) => {
    (async () => {
      try {
        const target = await getTarget(req, res);
        if (!target) {
          return;
        }
        if (!hasValidInternalProxySecret(req)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden\n");
          return;
        }
        proxy.web(req, res, { target, prependPath: false });
      } catch {
        // Not matched — 404 so it's obvious when a wrong base is used.
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found\n");
      }
    })();
  });

  proxyServer.on("upgrade", (req, socket, head) => {
    (async () => {
      try {
        const target = await getTarget(req);
        if (!target) {
          throw Error("not matched");
        }
        if (!hasValidInternalProxySecret(req)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        proxy.ws(req, socket, head, {
          target,
        });
      } catch {
        // Not matched — close gracefully.
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    })();
  });

  await listen({
    server: proxyServer,
    port,
    host,
    desc: "project HTTP proxy server",
  });
  return proxyServer;
}

export function attachProxyServer({
  app,
  httpServer,
  base_url = getProxyBaseUrl({ project_id }),
  host = "localhost",
}: {
  app?: express.Application;
  httpServer?: http.Server;
  base_url?: string;
  host?: string;
}) {
  if (!app && !httpServer) {
    throw new Error("attachProxyServer requires app or httpServer");
  }
  const { proxy, getTarget } = createProxyResolver({ base_url, host });

  if (app) {
    app.use(async (req, res, next) => {
      try {
        const target = await getTarget(req, res);
        if (!target) {
          return;
        }
        if (!hasValidInternalProxySecret(req)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden\n");
          return;
        }
        proxy.web(req, res, { target, prependPath: false });
      } catch {
        return next();
      }
    });
  }

  if (httpServer) {
    httpServer.prependListener("upgrade", (req, socket, head) => {
      (async () => {
        try {
          const target = await getTarget(req);
          if (!target) {
            return;
          }
          if (!hasValidInternalProxySecret(req)) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          proxy.ws(req, socket, head, {
            target,
          });
        } catch {
          return;
        }
      })();
    });
  }
}

// Build the default base_url from project/compute ids.
function getProxyBaseUrl({ project_id }: { project_id: string }): string {
  return `${project_id}`;
}

// Ensure base_url has no leading/trailing slashes; proxy matches start after a single slash.
function normalizeBase(base_url: string): string {
  return base_url.replace(/^\/+|\/+$/g, "");
}

// Escape string for use inside a RegExp literal.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a matcher:
//  - type "server": ^/<base>/server/(\d+)(/.*)?$
//  - type "port":   ^/<base>/port/(\d+)(/.*)?$
function buildPattern(base: string, type: "server" | "port" | "proxy"): RegExp {
  const prefix = `/${escapeRegExp(base)}/${type}/`;
  // capture numeric port, then optionally capture the rest of the path
  return new RegExp(`^${prefix}(\\d+)(/.*)?$`);
}

function createProxyResolver({
  base_url,
  host,
}: {
  base_url: string;
  host: string;
}) {
  const base = normalizeBase(base_url);
  const serverPattern = buildPattern(base, "server");
  const proxyPattern = buildPattern(base, "proxy");
  const portPattern = buildPattern(base, "port");

  const resolveStaticFile = async ({
    root,
    index,
    requestPath,
  }: {
    root: string;
    index?: string;
    requestPath: string;
  }): Promise<StaticResolvedFile | undefined> => {
    const rootAbs = path.resolve(root);
    const parsed = new URL(requestPath, "http://project.local");
    let relative = decodeURIComponent(parsed.pathname || "/");
    if (!relative.startsWith("/")) {
      relative = `/${relative}`;
    }
    const wanted = relative === "/" ? "" : relative.slice(1);
    let candidate = path.resolve(rootAbs, wanted);
    if (!(candidate === rootAbs || candidate.startsWith(`${rootAbs}${path.sep}`))) {
      return;
    }

    let info;
    try {
      info = await stat(candidate);
    } catch {
      info = undefined;
    }

    if (info?.isDirectory()) {
      const indexName = (index || "index.html").replace(/^\/+/, "");
      candidate = path.resolve(candidate, indexName);
      if (!(candidate === rootAbs || candidate.startsWith(`${rootAbs}${path.sep}`))) {
        return;
      }
      try {
        info = await stat(candidate);
      } catch {
        info = undefined;
      }
    }

    if (!info?.isFile()) {
      return;
    }

    return {
      absolutePath: candidate,
      stat: {
        size: info.size,
        mtimeMs: info.mtimeMs,
      },
    };
  };

  const writeStaticResponse = async ({
    req,
    res,
    root,
    index,
    cache_control,
    requestPath,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    root: string;
    index?: string;
    cache_control?: string;
    requestPath: string;
  }) => {
    const resolved = await resolveStaticFile({ root, index, requestPath });
    if (!resolved) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found\n");
      return;
    }
    const { absolutePath, stat: info } = resolved;
    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const cacheControl = cache_control || STATIC_CACHE_CONTROL_DEFAULT;
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = info.size - 1;
    let partial = false;
    if (typeof rangeHeader === "string") {
      const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
      if (m) {
        const from = m[1] ? Number(m[1]) : undefined;
        const to = m[2] ? Number(m[2]) : undefined;
        if (from != null && Number.isFinite(from)) start = Math.max(0, from);
        if (to != null && Number.isFinite(to)) end = Math.min(info.size - 1, to);
        if (m[1] === "" && to != null && Number.isFinite(to)) {
          start = Math.max(0, info.size - to);
          end = info.size - 1;
        }
        if (start <= end && start < info.size) {
          partial = true;
        } else {
          res.writeHead(416, {
            "Content-Range": `bytes */${info.size}`,
          });
          res.end();
          return;
        }
      }
    }

    const contentLength = end - start + 1;
    const headers: Record<string, string | number> = {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(info.mtimeMs).toUTCString(),
      "Content-Length": contentLength,
    };
    if (partial) {
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(absolutePath, { start, end });
    stream.on("error", (err) => {
      logger.warn("static file stream error", { err: `${err}`, absolutePath });
      if (!res.writableEnded) {
        res.end();
      }
    });
    stream.pipe(res);
  };

  async function getTarget(req: http.IncomingMessage, res?: http.ServerResponse) {
    const url = req.url ?? "";
    const mPort = portPattern.exec(url);
    if (mPort) {
      const port = Number(mPort[1]);
      return { port, host };
    }
    const mServer = serverPattern.exec(url) || proxyPattern.exec(url);
    if (mServer) {
      const port = Number(mServer[1]);
      const rest = mServer[2] || "/";
      // Rewrite path by mutating req.url before proxying
      req.url = rest;
      return { port, host };
    }

    const appTarget = await resolveAppProxyTarget({ base, url });
    if (appTarget) {
      if (appTarget.kind === "static") {
        if (!res) {
          throw Error("static apps do not support websocket upgrades");
        }
        await writeStaticResponse({
          req,
          res,
          root: appTarget.root,
          index: appTarget.index,
          cache_control: appTarget.cache_control,
          requestPath: appTarget.rewritePath,
        });
        return undefined;
      }
      req.url = appTarget.rewritePath;
      return { port: appTarget.port, host };
    }

    logger.debug("URL not matched", { url });
    throw Error("not matched");
  }

  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
    // We set target per-request.
  });

  proxy.on("error", (err, req, res) => {
    const url = (req as http.IncomingMessage).url;
    logger.warn("proxy error", { err, url });
    // Best-effort error response (HTTP only):
    if (!res || (res as http.ServerResponse).headersSent) return;
    try {
      (res as http.ServerResponse).writeHead(502, {
        "Content-Type": "text/plain",
      });
      (res as http.ServerResponse).end("Bad Gateway\n");
    } catch {
      /* ignore */
    }
  });

  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("X-Proxy-By", "cocalc-lite-proxy");
  });

  return { proxy, getTarget };
}

function hasValidInternalProxySecret(req: http.IncomingMessage): boolean {
  const expected = `${secretToken ?? ""}`.trim();
  if (!expected) return false;
  const got = getSingleHeaderValue(req.headers[PROJECT_PROXY_AUTH_HEADER]);
  return `${got ?? ""}`.trim() === expected;
}
