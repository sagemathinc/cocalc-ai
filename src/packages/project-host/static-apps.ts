/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type http from "node:http";
import path from "node:path";
import type { Stats } from "node:fs";
import { finished } from "node:stream/promises";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { hubApi } from "@cocalc/lite/hub/api";
import {
  COCALC_PUBLIC_VIEWER_MODE,
  isPublicViewerRenderablePath,
  parsePublicViewerManifest,
  publicViewerHtmlForPath,
  AppStaticIntegrationSpec,
  PublicViewerManifest,
  PublicViewerManifestEntry,
} from "./public-viewer";
import { getProjectSandboxFilesystem } from "./file-server";
import type { AppRequestMatch } from "./app-public-access";

const logger = getLogger("project-host:static-apps");
const STATIC_CACHE_CONTROL_DEFAULT = "public, max-age=60";
const PUBLIC_WEB_BASE_URL_CACHE = new TTL<string, string | null>({
  max: 1,
  ttl: 30_000,
});
const MAX_PUBLIC_VIEWER_RENDERABLE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_VIEWER_MANIFEST_BYTES = 1 * 1024 * 1024;

/*
Security and abuse-control invariants for host-side static serving:

1. Never serve by raw host path after resolving static.root.
   We first resolve static.root through the per-project sandbox, then create a
   second read-only sandbox rooted at that directory. Every stat/read for the
   request must go through that sub-sandbox. This is what keeps symlinks and
   path tricks inside the published subtree instead of merely inside the wider
   project mount.

2. Non-renderable static files may stream, but only through a sandbox API that
   opens and verifies the file descriptor first. Do not fall back to raw host
   path streaming. A direct host stream is exactly how symlink escapes get
   reintroduced.

3. Anything we intentionally parse/render in memory must still be size
   bounded. Oversized manifests or viewer payloads must fail closed with 413
   instead of letting a user turn the project-host into a large sparse-file
   reader.
*/

interface StaticResolvedPath {
  relativePath: string;
  fsPath: string;
  stat?: Stats;
}

interface StaticResolvedFile {
  fsPath: string;
  stat: Stats;
}

interface StaticRootContext {
  containerPath: string;
  fs: SandboxedFilesystem;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".ipynb": "application/x-ipynb+json; charset=utf-8",
  ".slides": "application/json; charset=utf-8",
  ".board": "application/json; charset=utf-8",
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
  const normalized = rel && rel !== "" ? rel : path.posix.basename(targetPath);
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

function buildRequestOrigin(req: http.IncomingMessage): string | undefined {
  const host = `${req.headers.host ?? ""}`.trim();
  if (!host) return;
  const protoHeader = `${req.headers["x-forwarded-proto"] ?? ""}`.trim();
  const proto =
    protoHeader.split(",")[0]?.trim() ||
    ((req.socket as any)?.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePublicWebBaseUrl(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return trimTrailingSlash(new URL(withProtocol).toString());
  } catch {
    return;
  }
}

async function getPublicWebBaseUrl(
  req: http.IncomingMessage,
): Promise<string | undefined> {
  const explicit = normalizePublicWebBaseUrl(process.env.COCALC_PUBLIC_WEB_URL);
  if (explicit) return explicit;
  const cached = PUBLIC_WEB_BASE_URL_CACHE.get("site");
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let resolved: string | undefined;
  try {
    const customize = await hubApi.system?.getCustomize?.(["dns"]);
    resolved = normalizePublicWebBaseUrl((customize as any)?.dns);
  } catch (err) {
    logger.debug("failed to fetch project-host public web base url", {
      err: `${err}`,
    });
  }
  if (!resolved) {
    resolved =
      normalizePublicWebBaseUrl(process.env.COCALC_API_URL) ??
      buildRequestOrigin(req);
  }
  PUBLIC_WEB_BASE_URL_CACHE.set("site", resolved ?? null);
  return resolved;
}

async function buildViewerRedirectUrl({
  req,
  sourcePath,
  title,
  autoRefreshS,
  viewerBundle,
}: {
  req: http.IncomingMessage;
  sourcePath: string;
  title: string;
  autoRefreshS?: number;
  viewerBundle?: string;
}): Promise<string> {
  const requestOrigin = buildRequestOrigin(req);
  const requestUrl = new URL(
    req.url ?? "/",
    requestOrigin ?? "http://127.0.0.1",
  );
  requestUrl.searchParams.set("raw", "1");
  const publicWebBaseUrl = await getPublicWebBaseUrl(req);
  if (!publicWebBaseUrl) {
    throw new Error("unable to determine public web base url");
  }
  const viewer = new URL(
    `${publicWebBaseUrl}/static/${publicViewerHtmlForPath(sourcePath, viewerBundle)}`,
  );
  viewer.searchParams.set("source", requestUrl.toString());
  viewer.searchParams.set("path", sourcePath);
  viewer.searchParams.set("title", title);
  if ((autoRefreshS ?? 0) > 0) {
    viewer.searchParams.set("refresh", `${autoRefreshS}`);
  }
  return viewer.toString();
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
  exposureMode: "private" | "public",
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (exposureMode === "public") {
    headers["Content-Security-Policy"] =
      "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; media-src 'self' data: blob: https: http:; connect-src 'self' https: http:";
  }
  return headers;
}

async function buildPublicFileHeaders({
  req,
  exposureMode,
}: {
  req: http.IncomingMessage;
  exposureMode: "private" | "public";
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  const requestOrigin = `${req.headers.origin ?? ""}`.trim();
  const publicWebBaseUrl = requestOrigin
    ? await getPublicWebBaseUrl(req)
    : undefined;
  if (requestOrigin && publicWebBaseUrl && requestOrigin === publicWebBaseUrl) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
    return headers;
  }
  if (exposureMode === "public") {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

function writeFileTooLarge(
  res: http.ServerResponse,
  {
    maxBytes,
    extraHeaders,
  }: {
    maxBytes: number;
    extraHeaders?: Record<string, string>;
  },
): void {
  res.writeHead(413, {
    "Content-Type": "text/plain; charset=utf-8",
    ...(extraHeaders ?? {}),
  });
  res.end(`File exceeds maximum supported size of ${maxBytes} bytes\n`);
}

function getStaticReadLimit({
  integration,
  relativePath,
}: {
  integration: AppStaticIntegrationSpec | undefined;
  relativePath: string;
}): number | undefined {
  if (
    integration?.mode === COCALC_PUBLIC_VIEWER_MODE &&
    isPublicViewerRenderablePath(relativePath, {
      file_types: integration.file_types,
    })
  ) {
    return MAX_PUBLIC_VIEWER_RENDERABLE_FILE_BYTES;
  }
  return;
}

async function resolveStaticRoot(
  project_id: string,
  root: string,
): Promise<StaticRootContext | undefined> {
  const normalized = root.replace(/\\/g, "/").trim();
  const allowRoot =
    normalized !== "" &&
    (!path.posix.isAbsolute(normalized) ||
      normalized === "/root" ||
      normalized.startsWith("/root/") ||
      normalized === "/scratch" ||
      normalized.startsWith("/scratch/"));
  if (!allowRoot) {
    logger.warn("rejected static app root outside project writable areas", {
      project_id,
      root,
    });
    return;
  }
  try {
    const projectFs = getProjectSandboxFilesystem(project_id);
    const rootAbs = await projectFs.safeAbsPath(root);
    return {
      containerPath: root,
      fs: new SandboxedFilesystem(rootAbs, { readonly: true }),
    };
  } catch (err) {
    logger.debug("failed to resolve static app root", {
      project_id,
      root,
      err: `${err}`,
    });
    return;
  }
}

async function resolveStaticPath({
  fs,
  requestPath,
}: {
  fs: SandboxedFilesystem;
  requestPath: string;
}): Promise<StaticResolvedPath | undefined> {
  let relativePath = "/";
  let fsPath = ".";
  try {
    const parsed = new URL(requestPath, "http://project-host.local");
    const decoded = decodeURIComponent(parsed.pathname || "/");
    const normalized = path.posix.normalize(
      decoded.startsWith("/") ? decoded : `/${decoded}`,
    );
    relativePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
    fsPath = relativePath === "/" ? "." : relativePath.slice(1);
  } catch {
    return;
  }
  let info: Stats | undefined;
  try {
    info = await fs.stat(fsPath);
  } catch {
    info = undefined;
  }
  return {
    relativePath,
    fsPath,
    stat: info,
  };
}

async function resolveStaticChildFile({
  fs,
  directory,
  child,
}: {
  fs: SandboxedFilesystem;
  directory: string;
  child: string;
}): Promise<StaticResolvedFile | undefined> {
  const candidate = path.posix.join(directory === "." ? "" : directory, child);
  let info: Stats | undefined;
  try {
    info = await fs.stat(candidate);
  } catch {
    info = undefined;
  }
  if (!info?.isFile()) {
    return;
  }
  return {
    fsPath: candidate,
    stat: info,
  };
}

async function writeResolvedStaticFile({
  req,
  res,
  fs,
  resolved,
  cacheControl,
  extraHeaders,
  maxBytes,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  fs: SandboxedFilesystem;
  resolved: StaticResolvedFile;
  cacheControl?: string;
  extraHeaders?: Record<string, string>;
  maxBytes?: number;
}): Promise<void> {
  const { fsPath, stat: info } = resolved;
  const ext = path.extname(fsPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  if (maxBytes != null && Number(info.size) > maxBytes) {
    writeFileTooLarge(res, {
      maxBytes,
      extraHeaders,
    });
    return;
  }
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
      if (to != null && Number.isFinite(to)) {
        end = Math.min(info.size - 1, to);
      }
      if (m[1] === "" && to != null && Number.isFinite(to)) {
        start = Math.max(0, info.size - to);
        end = info.size - 1;
      }
      if (start <= end && start < info.size) {
        partial = true;
      } else {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
    }
  }
  const contentLength = end - start + 1;
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl || STATIC_CACHE_CONTROL_DEFAULT,
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
  const stream = await fs.createReadStream(fsPath, { start, end });
  stream.on("error", (err) => {
    logger.warn("static file stream error", { err: `${err}`, fsPath });
    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        ...(extraHeaders ?? {}),
      });
    }
    if (!res.writableEnded) {
      res.end("Static file read failed\n");
    }
  });
  stream.pipe(res);
  try {
    await finished(stream);
  } catch {
    // handled above
  }
}

function writeStaticHtmlResponse({
  req,
  res,
  html,
  cacheControl,
  mtimeMs,
  extraHeaders,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  html: string;
  cacheControl?: string;
  mtimeMs?: number;
  extraHeaders?: Record<string, string>;
}): void {
  const body = Buffer.from(html, "utf8");
  const headers: Record<string, string | number> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheControl || STATIC_CACHE_CONTROL_DEFAULT,
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
}

function writeNotFound(
  res: http.ServerResponse,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    ...(extraHeaders ?? {}),
  });
  res.end("Not found\n");
}

export async function maybeHandleStaticAppRequest({
  req,
  res,
  project_id,
  match,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  project_id: string;
  match: AppRequestMatch | undefined;
}): Promise<boolean> {
  if (match?.spec.kind !== "static") {
    return false;
  }
  const rootRel = `${match.spec.static?.root ?? ""}`.trim();
  if (!rootRel) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Static app root is not configured\n");
    return true;
  }
  const rootContext = await resolveStaticRoot(project_id, rootRel);
  if (!rootContext) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Static app root is invalid\n");
    return true;
  }

  const integration = match.spec.integration;
  const exposureMode = match.exposure?.mode === "public" ? "public" : "private";
  const extraHtmlHeaders =
    integration?.mode === COCALC_PUBLIC_VIEWER_MODE
      ? buildPublicViewerHeaders(exposureMode)
      : undefined;
  const fileHeaders =
    integration?.mode === COCALC_PUBLIC_VIEWER_MODE
      ? await buildPublicFileHeaders({ req, exposureMode })
      : undefined;

  const pathInfo = await resolveStaticPath({
    fs: rootContext.fs,
    requestPath: match.requestPath,
  });
  if (!pathInfo) {
    writeNotFound(res, extraHtmlHeaders);
    return true;
  }

  if (pathInfo.stat?.isFile()) {
    if (
      integration?.mode === COCALC_PUBLIC_VIEWER_MODE &&
      isPublicViewerRenderablePath(pathInfo.relativePath, {
        file_types: integration.file_types,
      }) &&
      !isViewerRawRequest(req)
    ) {
      const location = await buildViewerRedirectUrl({
        req,
        sourcePath: pathInfo.relativePath,
        title:
          path.posix.basename(pathInfo.relativePath) || "CoCalc Public Viewer",
        autoRefreshS: integration.auto_refresh_s,
        viewerBundle: integration.viewer_bundle,
      });
      res.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
      });
      res.end();
      return true;
    }
    await writeResolvedStaticFile({
      req,
      res,
      fs: rootContext.fs,
      resolved: {
        fsPath: pathInfo.fsPath,
        stat: pathInfo.stat,
      },
      cacheControl: match.spec.static?.cache_control,
      extraHeaders: fileHeaders,
      maxBytes: getStaticReadLimit({
        integration,
        relativePath: pathInfo.relativePath,
      }),
    });
    return true;
  }

  if (!pathInfo.stat?.isDirectory()) {
    writeNotFound(res, extraHtmlHeaders);
    return true;
  }

  const indexFile = await resolveStaticChildFile({
    fs: rootContext.fs,
    directory: pathInfo.fsPath,
    child: match.spec.static?.index ?? "index.html",
  });
  if (indexFile) {
    const indexRelativePath = path.posix.join(
      pathInfo.relativePath === "/" ? "" : pathInfo.relativePath,
      match.spec.static?.index ?? "index.html",
    );
    if (
      integration?.mode === COCALC_PUBLIC_VIEWER_MODE &&
      isPublicViewerRenderablePath(indexRelativePath, {
        file_types: integration.file_types,
      }) &&
      !isViewerRawRequest(req)
    ) {
      const location = await buildViewerRedirectUrl({
        req,
        sourcePath: indexRelativePath,
        title: path.posix.basename(indexRelativePath) || "CoCalc Public Viewer",
        autoRefreshS: integration.auto_refresh_s,
        viewerBundle: integration.viewer_bundle,
      });
      res.writeHead(302, {
        Location: location,
        "Cache-Control": "no-store",
      });
      res.end();
      return true;
    }
    await writeResolvedStaticFile({
      req,
      res,
      fs: rootContext.fs,
      resolved: indexFile,
      cacheControl: match.spec.static?.cache_control,
      extraHeaders: fileHeaders,
      maxBytes: getStaticReadLimit({
        integration,
        relativePath: indexRelativePath,
      }),
    });
    return true;
  }

  if (
    integration?.mode !== COCALC_PUBLIC_VIEWER_MODE ||
    integration.directory_listing !== "manifest-only"
  ) {
    writeNotFound(res, extraHtmlHeaders);
    return true;
  }

  const manifestFile = await resolveStaticChildFile({
    fs: rootContext.fs,
    directory: pathInfo.fsPath,
    child: integration.manifest,
  });
  if (!manifestFile) {
    writeNotFound(res, extraHtmlHeaders);
    return true;
  }
  if (Number(manifestFile.stat.size) > MAX_PUBLIC_VIEWER_MANIFEST_BYTES) {
    writeFileTooLarge(res, {
      maxBytes: MAX_PUBLIC_VIEWER_MANIFEST_BYTES,
      extraHeaders: extraHtmlHeaders,
    });
    return true;
  }

  try {
    const manifestRaw = (await rootContext.fs.readFile(
      manifestFile.fsPath,
      "utf8",
    )) as string;
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
      cacheControl: match.spec.static?.cache_control,
      mtimeMs: manifestFile.stat.mtimeMs,
      extraHeaders: extraHtmlHeaders,
    });
  } catch (err) {
    logger.warn("public viewer manifest error", {
      err: `${err}`,
      manifest: path.posix.join(rootContext.containerPath, manifestFile.fsPath),
      requestPath: match.requestPath,
    });
    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8",
      ...(extraHtmlHeaders ?? {}),
    });
    res.end("Invalid public viewer manifest\n");
  }
  return true;
}
