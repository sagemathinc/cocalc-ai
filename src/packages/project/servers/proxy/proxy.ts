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
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import httpProxy from "http-proxy-3";
import { getLogger } from "@cocalc/project/logger";
import { project_id } from "@cocalc/project/data";
import { secretToken } from "@cocalc/project/data";
import {
  managedServiceAppForPort,
  resolveAppProxyTarget,
} from "../../app-servers/control";
import {
  recordAppHttpMetric,
  recordAppWebsocketClosed,
  recordAppWebsocketOpened,
} from "../../app-servers/metrics";
import {
  PROJECT_PROXY_AUTH_HEADER,
  getSingleHeaderValue,
} from "@cocalc/backend/auth/project-proxy-auth";
import {
  APP_PROXY_EXPOSURE_HEADER,
  type AppProxyExposureMode,
} from "@cocalc/backend/auth/app-proxy";
import listen from "@cocalc/backend/misc/async-server-listen";
import { resolveProxyListenPort } from "./config";
import {
  COCALC_PUBLIC_VIEWER_MODE,
  isPublicViewerRenderablePath,
  parsePublicViewerManifest,
  type AppStaticIntegrationSpec,
  type PublicViewerManifest,
  type PublicViewerManifestEntry,
} from "../../app-servers/public-viewer";
import { renderPublicViewerFile } from "../../app-servers/public-viewer-render";

const logger = getLogger("project:servers:proxy");
const STATIC_CACHE_CONTROL_DEFAULT = "public, max-age=300";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ipynb": "application/json; charset=utf-8",
  ".slides": "application/json; charset=utf-8",
  ".board": "application/json; charset=utf-8",
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

type StaticResolvedPath = {
  rootAbs: string;
  relativePath: string;
  absolutePath: string;
  stat?: Awaited<ReturnType<typeof stat>>;
};

type AppMetricsContext = {
  app_id: string;
  kind: "service" | "static";
  exposure_mode: AppProxyExposureMode;
  request_started_ms: number;
  bytes_received: number;
};

const APP_METRICS_CONTEXT = Symbol("cocalc-app-metrics-context");

interface StartOptions {
  base_url?: string;
  port?: number; // default to COCALC_PROXY_PORT or 80 for root, or 8080 for non-root
  host?: string; // default to COCALC_PROXY_HOST or 127.0.0.1
}

function getExposureMode(req: http.IncomingMessage): AppProxyExposureMode {
  return req.headers[APP_PROXY_EXPOSURE_HEADER] === "public"
    ? "public"
    : "private";
}

function getRequestBytes(req: http.IncomingMessage): number {
  const header = req.headers["content-length"];
  const raw = Array.isArray(header) ? header[0] : header;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function byteLengthOfChunk(chunk: unknown, encoding?: BufferEncoding): number {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding);
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function observeHttpResponse({
  req,
  res,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
}): void {
  const context = (req as any)[APP_METRICS_CONTEXT] as
    | AppMetricsContext
    | undefined;
  if (!context) return;
  let bytesSent = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let finished = false;

  (res.write as any) = (
    chunk: any,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    const actualEncoding = typeof encoding === "string" ? encoding : undefined;
    bytesSent += byteLengthOfChunk(chunk, actualEncoding);
    return originalWrite(chunk, encoding as any, callback);
  };

  (res.end as any) = (
    chunk?: any,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    const actualEncoding = typeof encoding === "string" ? encoding : undefined;
    bytesSent += byteLengthOfChunk(chunk, actualEncoding);
    return originalEnd(chunk, encoding as any, callback);
  };

  const finalize = () => {
    if (finished) return;
    finished = true;
    delete (req as any)[APP_METRICS_CONTEXT];
    recordAppHttpMetric({
      app_id: context.app_id,
      exposure_mode: context.exposure_mode,
      status_code: res.statusCode || 0,
      bytes_sent: bytesSent,
      bytes_received: context.bytes_received,
      duration_ms: Date.now() - context.request_started_ms,
    });
  };

  res.once("finish", finalize);
  res.once("close", finalize);
}

export async function startProxyServer({
  base_url = getProxyBaseUrl({ project_id }),
  port,
  host = process.env.COCALC_PROXY_HOST ?? "127.0.0.1",
}: StartOptions = {}) {
  port = resolveProxyListenPort(port);

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
        observeHttpResponse({ req, res });
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
        const context = (req as any)[APP_METRICS_CONTEXT] as
          | AppMetricsContext
          | undefined;
        if (context) {
          recordAppWebsocketOpened({ app_id: context.app_id });
          socket.once("close", () => recordAppWebsocketClosed(context.app_id));
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
        observeHttpResponse({ req, res });
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
          const context = (req as any)[APP_METRICS_CONTEXT] as
            | AppMetricsContext
            | undefined;
          if (context) {
            recordAppWebsocketOpened({ app_id: context.app_id });
            socket.once("close", () =>
              recordAppWebsocketClosed(context.app_id),
            );
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

  const resolveStaticPath = async ({
    root,
    requestPath,
  }: {
    root: string;
    requestPath: string;
  }): Promise<StaticResolvedPath | undefined> => {
    const rootAbs = path.resolve(root);
    const parsed = new URL(requestPath, "http://project.local");
    let relative = decodeURIComponent(parsed.pathname || "/");
    if (!relative.startsWith("/")) {
      relative = `/${relative}`;
    }
    const wanted = relative === "/" ? "" : relative.slice(1);
    const candidate = path.resolve(rootAbs, wanted);
    if (
      !(candidate === rootAbs || candidate.startsWith(`${rootAbs}${path.sep}`))
    ) {
      return;
    }

    let info: StaticResolvedPath["stat"] | undefined;
    try {
      info = await stat(candidate);
    } catch {
      info = undefined;
    }

    return {
      rootAbs,
      relativePath: relative,
      absolutePath: candidate,
      stat: info,
    };
  };

  const resolveStaticChildFile = async ({
    rootAbs,
    directory,
    child,
  }: {
    rootAbs: string;
    directory: string;
    child: string;
  }): Promise<StaticResolvedFile | undefined> => {
    const candidate = path.resolve(directory, child.replace(/^\/+/, ""));
    if (
      !(candidate === rootAbs || candidate.startsWith(`${rootAbs}${path.sep}`))
    ) {
      return;
    }
    let info: StaticResolvedPath["stat"] | undefined;
    try {
      info = await stat(candidate);
    } catch {
      info = undefined;
    }
    if (!info?.isFile()) {
      return;
    }
    return {
      absolutePath: candidate,
      stat: {
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
      },
    };
  };

  const resolveStaticFile = async ({
    root,
    index,
    requestPath,
  }: {
    root: string;
    index?: string;
    requestPath: string;
  }): Promise<StaticResolvedFile | undefined> => {
    const resolvedPath = await resolveStaticPath({ root, requestPath });
    if (!resolvedPath) {
      return;
    }
    const { rootAbs, absolutePath, stat: info } = resolvedPath;

    if (info?.isDirectory()) {
      return await resolveStaticChildFile({
        rootAbs,
        directory: absolutePath,
        child: index || "index.html",
      });
    }

    if (!info?.isFile()) {
      return;
    }

    return {
      absolutePath,
      stat: {
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
      },
    };
  };

  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function encodeUrlPath(relativePath: string): string {
    return relativePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function relativeUrlFromDirectory(
    directoryRelativePath: string,
    targetPath: string,
  ): string {
    const currentDir = directoryRelativePath
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const rel = path.posix.relative(currentDir, targetPath);
    const normalized =
      rel && rel !== "" ? rel : path.posix.basename(targetPath);
    return encodeUrlPath(normalized);
  }

  function appendViewerRawQuery(href: string): string {
    return href.includes("?") ? `${href}&raw=1` : `${href}?raw=1`;
  }

  function isViewerRawRequest(req: http.IncomingMessage): boolean {
    const requestUrl = req.url ?? "/";
    try {
      const url = new URL(requestUrl, "http://127.0.0.1");
      return (
        url.searchParams.get("raw") === "1" ||
        url.searchParams.get("render") === "raw"
      );
    } catch {
      return false;
    }
  }

  function sortPublicViewerEntries(
    left: PublicViewerManifestEntry,
    right: PublicViewerManifestEntry,
  ): number {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const leftTitle = `${left.title ?? left.path}`.toLowerCase();
    const rightTitle = `${right.title ?? right.path}`.toLowerCase();
    return leftTitle.localeCompare(rightTitle);
  }

  function renderPublicViewerManifestPage({
    manifest,
    manifestPath,
    directoryRelativePath,
    integration,
  }: {
    manifest: PublicViewerManifest;
    manifestPath: string;
    directoryRelativePath: string;
    integration: AppStaticIntegrationSpec;
  }): string {
    const title = manifest.title || "CoCalc Public Viewer";
    const description =
      manifest.description ||
      "Read-only manifest-driven listing for CoCalc public files.";
    const accent = manifest.theme?.accent_color || "#1f5aa6";
    const entries = [...manifest.entries]
      .filter((entry) => entry.render !== "hidden")
      .sort(sortPublicViewerEntries)
      .map((entry) => {
        const baseHref = relativeUrlFromDirectory(
          directoryRelativePath,
          entry.path,
        );
        const href =
          entry.render === "raw" &&
          isPublicViewerRenderablePath(entry.path, {
            file_types: integration.file_types,
          })
            ? appendViewerRawQuery(baseHref)
            : baseHref;
        const tags = (entry.tags ?? [])
          .map((tag) => `<span class="tag">${escapeHtml(`${tag}`)}</span>`)
          .join("");
        const mode = entry.render === "viewer" ? "viewer page" : "raw file";
        return `<li class="entry">
  <a class="entry-link" href="${escapeHtml(href)}">
    <span class="entry-title">${escapeHtml(entry.title || entry.path)}</span>
    <span class="entry-meta">${escapeHtml(entry.type || "file")} · ${escapeHtml(mode)}</span>
  </a>
  ${
    entry.description
      ? `<p class="entry-description">${escapeHtml(entry.description)}</p>`
      : ""
  }
  <div class="entry-footer">
    <code>${escapeHtml(entry.path)}</code>
    <span class="tags">${tags}</span>
  </div>
</li>`;
      })
      .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <style>
    :root {
      --accent: ${escapeHtml(accent)};
      --accent-soft: color-mix(in srgb, var(--accent) 14%, white);
      --border: #d5dce8;
      --text: #142235;
      --muted: #5c6c82;
      --surface: #f7f9fc;
      --card: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(31,90,166,0.10), transparent 30%),
        linear-gradient(180deg, #fbfcfe 0%, #eef3f9 100%);
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 24px 64px;
    }
    header {
      margin-bottom: 28px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 1.02;
    }
    .description {
      margin: 0;
      color: var(--muted);
      font-size: 1.05rem;
      max-width: 58rem;
    }
    .manifest-link {
      display: inline-flex;
      margin-top: 16px;
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 14px;
    }
    .entry {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px 20px;
      box-shadow: 0 12px 30px rgba(20,34,53,0.06);
    }
    .entry-link {
      color: inherit;
      text-decoration: none;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
    }
    .entry-title {
      font-size: 1.1rem;
      font-weight: 700;
    }
    .entry-meta {
      color: var(--muted);
      font-size: 0.95rem;
      text-transform: lowercase;
      white-space: nowrap;
    }
    .entry-description {
      margin: 10px 0 0;
      color: var(--muted);
    }
    .entry-footer {
      margin-top: 12px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    code {
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--surface);
      color: var(--accent);
    }
    .tags {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tag {
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p class="description">${escapeHtml(description)}</p>
      <a class="manifest-link" href="${escapeHtml(relativeUrlFromDirectory(directoryRelativePath, manifestPath))}">Open manifest JSON</a>
    </header>
    <ul>
${entries}
    </ul>
  </main>
</body>
</html>`;
  }

  function buildPublicViewerHeaders(
    exposureMode: AppProxyExposureMode,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (exposureMode === "public") {
      headers["Content-Security-Policy"] =
        "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; media-src 'self' data: blob: https: http:; connect-src 'self'";
      headers["Cross-Origin-Resource-Policy"] = "same-origin";
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
    }
    return headers;
  }

  const writeResolvedStaticFile = async ({
    req,
    res,
    resolved,
    cache_control,
    extraHeaders,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    resolved: StaticResolvedFile;
    cache_control?: string;
    extraHeaders?: Record<string, string>;
  }) => {
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
        if (to != null && Number.isFinite(to))
          end = Math.min(info.size - 1, to);
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
      ...(extraHeaders ?? {}),
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

  const writeStaticHtmlResponse = ({
    req,
    res,
    html,
    cache_control,
    mtimeMs,
    extraHeaders,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    html: string;
    cache_control?: string;
    mtimeMs?: number;
    extraHeaders?: Record<string, string>;
  }) => {
    const body = Buffer.from(html, "utf8");
    const headers: Record<string, string | number> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cache_control || STATIC_CACHE_CONTROL_DEFAULT,
      "Content-Length": body.byteLength,
      ...(extraHeaders ?? {}),
    };
    if (mtimeMs != null) {
      headers["Last-Modified"] = new Date(mtimeMs).toUTCString();
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  };

  const writePublicViewerResponse = async ({
    req,
    res,
    root,
    index,
    cache_control,
    requestPath,
    integration,
    exposureMode,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    root: string;
    index?: string;
    cache_control?: string;
    requestPath: string;
    integration: AppStaticIntegrationSpec;
    exposureMode: AppProxyExposureMode;
  }) => {
    const extraHeaders = buildPublicViewerHeaders(exposureMode);
    const pathInfo = await resolveStaticPath({ root, requestPath });
    if (!pathInfo) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...extraHeaders,
      });
      res.end("Not found\n");
      return;
    }
    if (pathInfo.stat?.isFile()) {
      const relativePath = pathInfo.relativePath;
      const shouldRenderViewer =
        isPublicViewerRenderablePath(relativePath, {
          file_types: integration.file_types,
        }) && !isViewerRawRequest(req);
      if (shouldRenderViewer) {
        try {
          const content = await readFile(pathInfo.absolutePath, "utf8");
          const rendered = renderPublicViewerFile({
            relativePath,
            content,
            rawHref: "?raw=1",
            integration,
          });
          if (rendered != null) {
            writeStaticHtmlResponse({
              req,
              res,
              html: rendered.html,
              cache_control,
              mtimeMs: Number(pathInfo.stat.mtimeMs),
              extraHeaders: {
                ...extraHeaders,
                "Content-Type": rendered.contentType,
              },
            });
            return;
          }
        } catch (err) {
          logger.warn("public viewer render error", {
            err: `${err}`,
            requestPath,
            absolutePath: pathInfo.absolutePath,
          });
          res.writeHead(500, {
            "Content-Type": "text/plain; charset=utf-8",
            ...extraHeaders,
          });
          res.end("Unable to render public viewer file\n");
          return;
        }
      }
      await writeResolvedStaticFile({
        req,
        res,
        resolved: {
          absolutePath: pathInfo.absolutePath,
          stat: {
            size: Number(pathInfo.stat.size),
            mtimeMs: Number(pathInfo.stat.mtimeMs),
          },
        },
        cache_control,
        extraHeaders,
      });
      return;
    }
    if (!pathInfo.stat?.isDirectory()) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...extraHeaders,
      });
      res.end("Not found\n");
      return;
    }
    const indexFile = await resolveStaticChildFile({
      rootAbs: pathInfo.rootAbs,
      directory: pathInfo.absolutePath,
      child: index || "index.html",
    });
    if (indexFile) {
      await writeResolvedStaticFile({
        req,
        res,
        resolved: indexFile,
        cache_control,
        extraHeaders,
      });
      return;
    }
    if (
      integration.mode !== COCALC_PUBLIC_VIEWER_MODE ||
      integration.directory_listing !== "manifest-only"
    ) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...extraHeaders,
      });
      res.end("Not found\n");
      return;
    }
    const manifestFile = await resolveStaticChildFile({
      rootAbs: pathInfo.rootAbs,
      directory: pathInfo.absolutePath,
      child: integration.manifest,
    });
    if (!manifestFile) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...extraHeaders,
      });
      res.end("Not found\n");
      return;
    }
    try {
      const manifestRaw = await readFile(manifestFile.absolutePath, "utf8");
      const manifest = parsePublicViewerManifest(manifestRaw, {
        file_types: integration.file_types,
      });
      const html = renderPublicViewerManifestPage({
        manifest,
        manifestPath: integration.manifest,
        directoryRelativePath: pathInfo.relativePath,
        integration,
      });
      writeStaticHtmlResponse({
        req,
        res,
        html,
        cache_control,
        mtimeMs: manifestFile.stat.mtimeMs,
        extraHeaders,
      });
    } catch (err) {
      logger.warn("public viewer manifest error", {
        err: `${err}`,
        manifest: manifestFile.absolutePath,
        requestPath,
      });
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        ...extraHeaders,
      });
      res.end("Invalid public viewer manifest\n");
    }
  };

  const writeStaticResponse = async ({
    req,
    res,
    root,
    index,
    cache_control,
    requestPath,
    integration,
    exposureMode,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    root: string;
    index?: string;
    cache_control?: string;
    requestPath: string;
    integration?: AppStaticIntegrationSpec;
    exposureMode: AppProxyExposureMode;
  }) => {
    if (integration?.mode === COCALC_PUBLIC_VIEWER_MODE) {
      await writePublicViewerResponse({
        req,
        res,
        root,
        index,
        cache_control,
        requestPath,
        integration,
        exposureMode,
      });
      return;
    }
    const resolved = await resolveStaticFile({ root, index, requestPath });
    if (!resolved) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found\n");
      return;
    }
    await writeResolvedStaticFile({ req, res, resolved, cache_control });
  };

  async function getTarget(
    req: http.IncomingMessage,
    res?: http.ServerResponse,
  ) {
    const url = req.url ?? "";
    const mPort = portPattern.exec(url);
    if (mPort) {
      const port = Number(mPort[1]);
      const rest = mPort[2] || "/";
      const managedApp = await managedServiceAppForPort(port);
      if (managedApp) {
        (req as any)[APP_METRICS_CONTEXT] = {
          app_id: managedApp.app_id,
          kind: managedApp.kind,
          exposure_mode: getExposureMode(req),
          request_started_ms: Date.now(),
          bytes_received: getRequestBytes(req),
        } satisfies AppMetricsContext;
      }
      req.url = rest;
      return { port, host };
    }
    const mServer = serverPattern.exec(url) || proxyPattern.exec(url);
    if (mServer) {
      const port = Number(mServer[1]);
      const rest = mServer[2] || "/";
      const managedApp = await managedServiceAppForPort(port);
      if (managedApp) {
        (req as any)[APP_METRICS_CONTEXT] = {
          app_id: managedApp.app_id,
          kind: managedApp.kind,
          exposure_mode: getExposureMode(req),
          request_started_ms: Date.now(),
          bytes_received: getRequestBytes(req),
        } satisfies AppMetricsContext;
      }
      // Rewrite path by mutating req.url before proxying
      req.url = rest;
      return { port, host };
    }

    const appTarget = await resolveAppProxyTarget({
      base,
      url,
      exposureMode: getExposureMode(req),
    });
    if (appTarget) {
      const metricsContext: AppMetricsContext = {
        app_id: appTarget.app_id,
        kind: appTarget.kind,
        exposure_mode: getExposureMode(req),
        request_started_ms: Date.now(),
        bytes_received: getRequestBytes(req),
      };
      if (appTarget.kind === "static") {
        if (!res) {
          throw Error("static apps do not support websocket upgrades");
        }
        (req as any)[APP_METRICS_CONTEXT] = metricsContext;
        observeHttpResponse({ req, res });
        await writeStaticResponse({
          req,
          res,
          root: appTarget.root,
          index: appTarget.index,
          cache_control: appTarget.cache_control,
          requestPath: appTarget.rewritePath,
          integration: appTarget.integration,
          exposureMode: getExposureMode(req),
        });
        return undefined;
      }
      (req as any)[APP_METRICS_CONTEXT] = metricsContext;
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
    proxyReq.removeHeader(APP_PROXY_EXPOSURE_HEADER);
  });

  proxy.on("proxyReqWs", (proxyReq) => {
    proxyReq.removeHeader(APP_PROXY_EXPOSURE_HEADER);
  });

  return { proxy, getTarget };
}

function hasValidInternalProxySecret(req: http.IncomingMessage): boolean {
  const expected = `${secretToken ?? ""}`.trim();
  if (!expected) return false;
  const got = getSingleHeaderValue(req.headers[PROJECT_PROXY_AUTH_HEADER]);
  return `${got ?? ""}`.trim() === expected;
}
