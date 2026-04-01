/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import getLogger from "@cocalc/backend/logger";
import { project_id } from "@cocalc/project/data";
import type { AppStaticIntegrationSpec } from "@cocalc/project/app-servers/public-viewer";
import {
  COCALC_PUBLIC_VIEWER_MODE,
  isPublicViewerRenderablePath,
  parsePublicViewerManifest,
  type PublicViewerManifest,
  type PublicViewerManifestEntry,
} from "@cocalc/project/app-servers/public-viewer";

const logger = getLogger("lite:static-apps");
const STATIC_CACHE_CONTROL_DEFAULT = "private, max-age=60";
const MAX_PUBLIC_VIEWER_MANIFEST_BYTES = 1 * 1024 * 1024;

// Lite has a different trust model than launchpad:
// there is one local user, requests are same-user, and the server already
// has direct access to the project filesystem.  We therefore serve static
// apps directly from local paths here instead of going through the
// project-host sandbox layer.  Keep this split explicit; launchpad security
// constraints do not apply unchanged to lite mode.

interface AppSpec {
  id: string;
  kind: "service" | "static";
  proxy?: { base_path?: string; strip_prefix?: boolean };
  static?: {
    root?: string;
    index?: string;
    cache_control?: string;
    refresh?: {
      command?: {
        exec?: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      };
      timeout_s?: number;
      stale_after_s?: number;
      trigger_on_hit?: boolean;
    };
  };
  integration?: AppStaticIntegrationSpec;
}

interface StaticAppMatch {
  spec: AppSpec;
  requestPath: string;
}

let cachedSpecs: { value: AppSpec[]; expires: number } | undefined;
type StaticRefreshState = {
  running?: Promise<void>;
  last_success_ms?: number;
  last_error?: string;
  stdout: Buffer;
  stderr: Buffer;
};
const staticRefresh: Record<string, StaticRefreshState> = Object.create(null);

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
  ".chat": "application/json; charset=utf-8",
  ".sage-chat": "application/json; charset=utf-8",
};

function liteHomeDir(): string {
  return `${process.env.HOME ?? ""}`.trim() || process.cwd();
}

function appsDir(): string {
  return path.join(liteHomeDir(), ".local", "share", "cocalc", "apps");
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

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

function sortPublicViewerEntries(
  left: PublicViewerManifestEntry,
  right: PublicViewerManifestEntry,
): number {
  const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return `${left.title ?? left.path}`.localeCompare(
    `${right.title ?? right.path}`,
  );
}

function buildRequestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function isViewerRawRequest(req: Request): boolean {
  const requestUrl = req.originalUrl || req.url || "/";
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

function hasTrailingSlash(req: Request): boolean {
  const requestUrl = req.originalUrl || req.url || "/";
  try {
    const url = new URL(requestUrl, "http://127.0.0.1");
    return url.pathname.endsWith("/");
  } catch {
    return requestUrl.split("?")[0]?.endsWith("/") ?? false;
  }
}

function trailingSlashRedirectLocation(req: Request): string {
  const requestUrl = req.originalUrl || req.url || "/";
  try {
    const url = new URL(requestUrl, "http://127.0.0.1");
    return `${url.pathname}/${url.search ?? ""}`;
  } catch {
    const [pathname, search = ""] = requestUrl.split("?", 2);
    return `${pathname}/${search !== "" ? `?${search}` : ""}`;
  }
}

function publicViewerHtmlForPath(entryPath: string): string {
  switch (path.posix.extname(entryPath).toLowerCase()) {
    case ".md":
      return "public-viewer-md.html";
    case ".ipynb":
      return "public-viewer-ipynb.html";
    case ".slides":
      return "public-viewer-slides.html";
    case ".board":
      return "public-viewer-board.html";
    case ".chat":
    case ".sage-chat":
      return "public-viewer-chat.html";
    default:
      return "public-viewer.html";
  }
}

async function loadSpecs(): Promise<AppSpec[]> {
  if (cachedSpecs && cachedSpecs.expires > Date.now()) {
    return cachedSpecs.value;
  }
  const out: AppSpec[] = [];
  let names: string[] = [];
  try {
    names = await readdir(appsDir());
  } catch {
    cachedSpecs = { value: out, expires: Date.now() + 1000 };
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === "runtime-state.json" || name === "metrics-state.json") {
      continue;
    }
    try {
      const raw = await readFile(path.join(appsDir(), name), "utf8");
      const parsed = JSON.parse(raw) as AppSpec;
      if (!parsed?.id || parsed.kind !== "static" || !parsed.proxy?.base_path) {
        continue;
      }
      out.push(parsed);
    } catch {
      // ignore bad specs in lite mode
    }
  }
  cachedSpecs = { value: out, expires: Date.now() + 1000 };
  return out;
}

function matchPrefixes(): string[] {
  return [
    normalizePrefix(`/projects/${project_id}`),
    normalizePrefix(`/${project_id}`),
  ];
}

async function matchStaticAppRequest(
  url: string,
): Promise<StaticAppMatch | undefined> {
  const parsed = new URL(url, "http://lite.local");
  let localPath: string | undefined;
  for (const prefix of matchPrefixes()) {
    if (
      parsed.pathname === prefix ||
      parsed.pathname.startsWith(`${prefix}/`)
    ) {
      localPath = normalizePrefix(parsed.pathname.slice(prefix.length) || "/");
      break;
    }
  }
  if (!localPath) return;
  const specs = await loadSpecs();
  for (const spec of specs) {
    const basePath = normalizePrefix(spec.proxy?.base_path ?? "/");
    if (!(localPath === basePath || localPath.startsWith(`${basePath}/`))) {
      continue;
    }
    const suffix =
      localPath.length > basePath.length
        ? localPath.slice(basePath.length)
        : "";
    const requestPath =
      spec.proxy?.strip_prefix === false
        ? `${localPath}${parsed.search ?? ""}`
        : `${suffix || "/"}${parsed.search ?? ""}`;
    return { spec, requestPath };
  }
}

function resolveStaticRoot(root?: string): string | undefined {
  const trimmed = `${root ?? ""}`.trim();
  if (!trimmed) return;
  const home = `${process.env.HOME ?? ""}`.trim();
  if (home && (trimmed === "/root" || trimmed.startsWith("/root/"))) {
    return path.join(home, path.posix.relative("/root", trimmed));
  }
  return path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(liteHomeDir(), trimmed);
}

function contentTypeForFile(filePath: string): string {
  return (
    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

function appendLimited(
  current: Buffer,
  chunk: Buffer,
  limit = 32 * 1024,
): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const merged =
    current.length === 0
      ? chunk
      : Buffer.concat([current, chunk], current.length + chunk.length);
  return merged.length > limit
    ? merged.subarray(merged.length - limit)
    : merged;
}

function getStaticRefreshState(id: string): StaticRefreshState {
  if (!staticRefresh[id]) {
    staticRefresh[id] = {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }
  return staticRefresh[id];
}

async function runStaticRefresh(spec: AppSpec): Promise<void> {
  const refresh = spec.static?.refresh;
  const exec = `${refresh?.command?.exec ?? ""}`.trim();
  if (!exec) return;
  const root = resolveStaticRoot(spec.static?.root);
  if (!root) return;
  const state = getStaticRefreshState(spec.id);
  if (state.running) {
    await state.running;
    return;
  }
  const timeoutMs = Math.max(1, Number(refresh?.timeout_s ?? 120)) * 1000;
  const args = refresh?.command?.args ?? [];
  const cwd = refresh?.command?.cwd ?? root;
  const env = {
    ...process.env,
    ...(refresh?.command?.env ?? {}),
    APP_ID: spec.id,
    APP_STATIC_ROOT: root,
    APP_BASE_PATH: spec.proxy?.base_path ?? `/apps/${spec.id}`,
  };
  const run = (async () => {
    state.stdout = Buffer.alloc(0);
    state.stderr = Buffer.alloc(0);
    state.last_error = undefined;
    const child = spawn(exec, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      state.stdout = appendLimited(state.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      state.stderr = appendLimited(state.stderr, chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeoutMs);
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: 1, signal: null }));
    });
    clearTimeout(timer);
    if (timedOut) {
      state.last_error = `timed out after ${refresh?.timeout_s ?? 120}s`;
      logger.warn("lite static refresh timed out", { app_id: spec.id });
      return;
    }
    if (result.code === 0) {
      state.last_success_ms = Date.now();
      state.last_error = undefined;
      return;
    }
    state.last_error = `exit code ${result.code ?? "unknown"}${result.signal ? ` (signal ${result.signal})` : ""}`;
    logger.warn("lite static refresh failed", {
      app_id: spec.id,
      code: result.code,
      signal: result.signal,
      stderr: state.stderr.toString("utf8").slice(-1000),
    });
  })();
  state.running = run;
  try {
    await run;
  } finally {
    state.running = undefined;
  }
}

async function maybeRefreshStaticOnHit(spec: AppSpec): Promise<void> {
  const refresh = spec.static?.refresh;
  if (!refresh?.trigger_on_hit || !refresh.command?.exec) return;
  const state = getStaticRefreshState(spec.id);
  if (state.running) {
    await state.running;
    return;
  }
  const staleAfterMs =
    Math.max(1, Number(refresh.stale_after_s ?? 3600)) * 1000;
  const shouldRun =
    state.last_success_ms == null ||
    Date.now() - state.last_success_ms >= staleAfterMs;
  if (!shouldRun) return;
  try {
    await runStaticRefresh(spec);
  } catch (err) {
    state.last_error = `${err}`;
    logger.warn("lite static refresh on-hit failed", {
      app_id: spec.id,
      err: `${err}`,
    });
  }
}

async function buildViewerRedirectUrl({
  req,
  sourcePath,
  title,
  autoRefreshS,
}: {
  req: Request;
  sourcePath: string;
  title: string;
  autoRefreshS?: number;
}): Promise<string> {
  const requestUrl = new URL(
    req.originalUrl || req.url || "/",
    buildRequestOrigin(req),
  );
  requestUrl.searchParams.set("raw", "1");
  const viewer = new URL(
    `/static/${publicViewerHtmlForPath(sourcePath)}`,
    buildRequestOrigin(req),
  );
  viewer.searchParams.set("source", requestUrl.toString());
  viewer.searchParams.set("path", sourcePath);
  viewer.searchParams.set("title", title);
  if ((autoRefreshS ?? 0) > 0) {
    viewer.searchParams.set("refresh", `${autoRefreshS}`);
  }
  return viewer.toString();
}

function renderManifestPage({
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
    "Read-only manifest-driven listing for CoCalc files.";
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
      return `<li class="entry">
  <a class="entry-link" href="${escapeHtml(href)}">
    <span class="entry-title">${escapeHtml(entry.title || entry.path)}</span>
    <span class="entry-meta">${escapeHtml(entry.type || "file")}</span>
  </a>
  ${
    entry.description
      ? `<p class="entry-description">${escapeHtml(entry.description)}</p>`
      : ""
  }
  <div class="entry-footer"><code>${escapeHtml(entry.path)}</code></div>
</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; color: #142235; background: linear-gradient(180deg, #fbfcfe 0%, #eef3f9 100%); }
    main { max-width: 960px; margin: 0 auto; padding: 48px 24px 64px; }
    h1 { margin: 0 0 12px; font-size: clamp(2rem, 4vw, 3rem); }
    .description { color: #5c6c82; max-width: 58rem; }
    ul { list-style: none; padding: 0; display: grid; gap: 14px; }
    .entry { background: #fff; border: 1px solid #d5dce8; border-radius: 18px; padding: 18px 20px; }
    .entry-link { color: inherit; text-decoration: none; display: flex; justify-content: space-between; gap: 16px; }
    .entry-title { font-size: 1.1rem; font-weight: 700; }
    .entry-meta, .entry-description { color: #5c6c82; }
    code { padding: 4px 8px; border-radius: 999px; background: #f7f9fc; color: ${escapeHtml(accent)}; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="description">${escapeHtml(description)}</p>
    <p><a href="${escapeHtml(relativeUrlFromDirectory(directoryRelativePath, manifestPath))}">Open manifest JSON</a></p>
    <ul>
${entries}
    </ul>
  </main>
</body>
</html>`;
}

async function streamFile(
  res: Response,
  filePath: string,
  cacheControl?: string,
) {
  res.setHeader("Content-Type", contentTypeForFile(filePath));
  res.setHeader("Cache-Control", cacheControl || STATIC_CACHE_CONTROL_DEFAULT);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const stream = createReadStream(filePath);
  stream.pipe(res);
  await finished(stream);
}

export async function maybeHandleLiteStaticAppRequest({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const match = await matchStaticAppRequest(req.originalUrl || req.url || "/");
  if (!match) return false;

  const root = resolveStaticRoot(match.spec.static?.root);
  if (!root) {
    res.status(500).type("text/plain").send("Static app root is invalid\n");
    return true;
  }

  await maybeRefreshStaticOnHit(match.spec);

  const integration = match.spec.integration;
  const parsed = new URL(match.requestPath, "http://lite.local");
  const requestPath = decodeURIComponent(parsed.pathname || "/");
  const relativePath =
    requestPath === "/" ? "" : requestPath.replace(/^\/+/, "");
  const resolvedPath = path.join(root, relativePath);

  let resolvedStat;
  try {
    resolvedStat = await stat(resolvedPath);
  } catch {
    res.status(404).type("text/plain").send("Not found\n");
    return true;
  }

  if (resolvedStat.isFile()) {
    if (
      integration?.mode === COCALC_PUBLIC_VIEWER_MODE &&
      isPublicViewerRenderablePath(relativePath, {
        file_types: integration.file_types,
      }) &&
      !isViewerRawRequest(req)
    ) {
      const location = await buildViewerRedirectUrl({
        req,
        sourcePath: relativePath,
        title: path.posix.basename(relativePath) || "CoCalc Public Viewer",
        autoRefreshS: integration.auto_refresh_s,
      });
      res.redirect(location);
      return true;
    }
    await streamFile(res, resolvedPath, match.spec.static?.cache_control);
    return true;
  }

  if (!resolvedStat.isDirectory()) {
    res.status(404).type("text/plain").send("Not found\n");
    return true;
  }

  if (!hasTrailingSlash(req)) {
    res.redirect(trailingSlashRedirectLocation(req));
    return true;
  }

  const indexName = match.spec.static?.index ?? "index.html";
  const indexPath = path.join(resolvedPath, indexName);
  try {
    const indexStat = await stat(indexPath);
    if (indexStat.isFile()) {
      const indexRelativePath = path.posix.join(relativePath, indexName);
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
          title:
            path.posix.basename(indexRelativePath) || "CoCalc Public Viewer",
          autoRefreshS: integration.auto_refresh_s,
        });
        res.redirect(location);
        return true;
      }
      await streamFile(res, indexPath, match.spec.static?.cache_control);
      return true;
    }
  } catch {
    // handled below for public-viewer manifest
  }

  if (integration?.mode !== COCALC_PUBLIC_VIEWER_MODE) {
    res.status(404).type("text/plain").send("Not found\n");
    return true;
  }

  const manifestPath = path.join(resolvedPath, integration.manifest);
  let manifestStat;
  try {
    manifestStat = await stat(manifestPath);
  } catch {
    res.status(404).type("text/plain").send("Not found\n");
    return true;
  }
  if (!manifestStat.isFile()) {
    res.status(404).type("text/plain").send("Not found\n");
    return true;
  }
  if (manifestStat.size > MAX_PUBLIC_VIEWER_MANIFEST_BYTES) {
    res
      .status(413)
      .type("text/plain")
      .send("File exceeds maximum supported size\n");
    return true;
  }
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = parsePublicViewerManifest(raw, {
      file_types: integration.file_types,
    });
    res
      .status(200)
      .type("text/html; charset=utf-8")
      .send(
        renderManifestPage({
          manifest,
          manifestPath: path.posix.join(relativePath, integration.manifest),
          directoryRelativePath: relativePath,
          integration,
        }),
      );
  } catch (err) {
    logger.debug("failed to render lite public viewer manifest", {
      err: `${err}`,
    });
    res.status(500).type("text/plain").send("Unable to read manifest\n");
  }
  return true;
}
