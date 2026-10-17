/*
Which web pages may use the project-host's browser cookies.

The project-host browser-session and HTTP-session cookies are ambient: the
browser attaches them to requests for this host no matter which page made the
request. A request (or websocket) authenticated only by such a cookie is
accepted only when the browser shows it was made by an approved page.

Approved origins (exact scheme://host[:port]) are the CoCalc site and bay
public origins sent by the hub (system.getPublicSiteUrl, refreshed
periodically), COCALC_SITE_URL, and COCALC_PROJECT_HOST_ALLOWED_ORIGINS.
Pages served by the project host itself run project-controlled code, so its
own origin is approved only for proxied app routes (an app talking to
itself) and for reading files (GET/HEAD: an HTML preview loading its relative
images, CSS and scripts, PDF range requests, media seeking), never for
uploads, the session bootstrap or Conat. On a private app hostname it is
further bound to that app's project. On the host's public hostname
(PROJECT_HOST_PUBLIC_URL) it is not bound to a project: path-based apps (e.g.
JupyterLab at /<project_id>/port/...) need it, so any active content there can
act on every project's app routes and read files the viewer can read. That
residual is accepted for now (William, Oct 16 2026); only separate content
origins remove it.

With an Origin header, it must be approved (see above). Without one:
- non-GET/HEAD requests are refused (browsers send Origin on them);
- requests without fetch metadata (Sec-Fetch-Site) are refused: the page
  can't be identified, and non-browser clients use explicit tokens;
- Sec-Fetch-Site: none (typed URL, bookmark) is allowed;
- a Referer from an approved origin is allowed (the app's <img>, iframes,
  links; the app sends strict-origin-when-cross-origin);
- same-origin subresources are allowed on app routes;
- a top-level page navigation (Sec-Fetch-Dest: document) of an app or file
  is allowed, e.g. the app opening JupyterLab in a new tab with noreferrer;
- everything else is refused.

COCALC_PROJECT_HOST_ORIGIN_POLICY=report logs violations but behaves as
before (including CORS); "off" disables checks and logging.

Only the project-host app process asks the hub for the site URL and origins.
It also writes them to $COCALC_DATA/browser-origins.json, which every process
reads: a conat router respawned by the host agent inherits neither the app's
memory nor its runtime COCALC_SITE_URL, and would otherwise refuse every
browser.
*/

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import getLogger from "@cocalc/backend/logger";
import { getPrivateAppHostnameProject } from "./private-app-hostname";

const logger = getLogger("project-host:browser-origin-policy");

export type OriginPolicyMode = "enforce" | "report" | "off";
export type AmbientRoute = "file" | "upload" | "app" | "bootstrap" | "conat";

type Req = Pick<IncomingMessage, "headers"> & { method?: string };

let hubOrigins: string[] = [];

// A serialized http(s) origin exactly as browsers send it, lowercased.
export function parseOrigin(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw || raw === "null") return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (url.origin.toLowerCase() !== raw.toLowerCase()) return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

// The origin of a configured URL (site URL with a base path, etc.).
function originOfUrl(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

// Replace the hub-supplied origins. An empty list (old hub, failed lookup)
// keeps the last known-good set.
export function setHubBrowserOrigins(origins: unknown[]): void {
  const parsed = origins.map(originOfUrl).filter((x): x is string => !!x);
  if (parsed.length > 0) hubOrigins = parsed;
}

export function resetHubBrowserOriginsForTests(): void {
  hubOrigins = [];
  persistedCache = undefined;
}

const PERSISTED_ORIGINS_FILE = "browser-origins.json";
// How often a process re-checks the file for a newer refresh by the app.
const PERSISTED_ORIGINS_RECHECK_MS = 5_000;

type PersistedBrowserOrigins = { site_url?: string; origins: string[] };

let persistedCache:
  | {
      file: string;
      checkedAt: number;
      mtimeMs: number;
      value: PersistedBrowserOrigins;
    }
  | undefined;

function persistedOriginsFile(): string | undefined {
  const dir = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  return dir ? path.join(dir, PERSISTED_ORIGINS_FILE) : undefined;
}

// Record the hub-supplied site URL and origins for the host's other
// processes. Like setHubBrowserOrigins, an empty result keeps the last
// known-good file.
export function persistHubBrowserOrigins({
  site_url,
  browser_origins,
}: {
  site_url?: unknown;
  browser_origins?: unknown[];
}): void {
  const file = persistedOriginsFile();
  if (!file) return;
  const site = originOfUrl(site_url) ? `${site_url}`.trim() : undefined;
  const origins = (browser_origins ?? [])
    .map(originOfUrl)
    .filter((x): x is string => !!x);
  if (!site && origins.length === 0) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ site_url: site, browser_origins: origins }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn("unable to persist browser origins", { err: `${err}` });
    fs.rmSync(tmp, { force: true });
  }
}

// The site URL and origins last persisted by the app (cached; re-read only
// when the file changes). A missing or unreadable file keeps the last value.
export function persistedBrowserOrigins(): PersistedBrowserOrigins {
  const empty = { origins: [] };
  const file = persistedOriginsFile();
  if (!file) return empty;
  const now = Date.now();
  if (
    persistedCache?.file === file &&
    now - persistedCache.checkedAt < PERSISTED_ORIGINS_RECHECK_MS
  ) {
    return persistedCache.value;
  }
  const previous = persistedCache?.file === file ? persistedCache : undefined;
  try {
    const { mtimeMs } = fs.statSync(file);
    if (previous && previous.mtimeMs === mtimeMs) {
      previous.checkedAt = now;
      return previous.value;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const site = originOfUrl(data?.site_url)
      ? `${data.site_url}`.trim()
      : undefined;
    const origins = [
      ...(Array.isArray(data?.browser_origins) ? data.browser_origins : []),
      site,
    ]
      .map(originOfUrl)
      .filter((x): x is string => !!x);
    const value = { site_url: site, origins };
    persistedCache = { file, checkedAt: now, mtimeMs, value };
    return value;
  } catch {
    if (previous) {
      previous.checkedAt = now;
      return previous.value;
    }
    return empty;
  }
}

export function originPolicyMode(): OriginPolicyMode {
  const value = `${process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY ?? ""}`
    .trim()
    .toLowerCase();
  return value === "report" || value === "off" ? value : "enforce";
}

export function approvedBrowserOrigins(): Set<string> {
  const origins = new Set([
    ...hubOrigins,
    ...persistedBrowserOrigins().origins,
  ]);
  for (const value of [
    process.env.COCALC_SITE_URL,
    ...`${process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS ?? ""}`.split(","),
  ]) {
    const origin = originOfUrl(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function header(req: Req, name: string): string {
  const value = req.headers[name];
  return `${Array.isArray(value) ? value[0] : (value ?? "")}`.trim();
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

// Whether origin is this request's own origin. Uses the Host header only (a
// browser cannot set it for another site); the scheme must be https except on
// localhost.
function isOwnOrigin(origin: string, req: Req): boolean {
  const host = header(req, "host").toLowerCase();
  if (!host) return false;
  const url = new URL(origin);
  let own: string;
  try {
    // Canonicalize so "host:443" matches "https://host".
    own = new URL(`${url.protocol}//${host}`).host;
  } catch {
    return false;
  }
  if (url.host !== own) return false;
  return url.protocol === "https:" || isLocalHostname(url.hostname);
}

// The own-origin allowance for app routes: on a private app hostname only for
// that app's own project; unbound only on the host's own public hostname
// (PROJECT_HOST_PUBLIC_URL). Any other hostname, including a private hostname
// whose lookup failed, gets no allowance.
function ownAppOriginAllowed(
  req: Req,
  project_id: string | undefined,
): boolean {
  const privateProject = getPrivateAppHostnameProject(req as IncomingMessage);
  if (privateProject != null) return privateProject === project_id;
  return isCanonicalHost(req);
}

function isCanonicalHost(req: Req): boolean {
  const publicUrl = `${process.env.PROJECT_HOST_PUBLIC_URL ?? ""}`.trim();
  const host = header(req, "host").toLowerCase();
  if (!publicUrl || !host) return false;
  try {
    const canonical = new URL(publicUrl);
    return new URL(`${canonical.protocol}//${host}`).host === canonical.host;
  } catch {
    return false;
  }
}

// The one route classifier: main.ts dispatch uses it too, so a path can't be
// judged an app route here and then served as a file.
export function classifyProjectRoute(
  req: Req & { url?: string },
  project_id: string,
): AmbientRoute {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://project-host.local").pathname;
  } catch {
    return "app";
  }
  if (pathname.startsWith(`/${project_id}/files/`)) return "file";
  if (pathname === `/${project_id}/upload`) return "upload";
  return "app";
}

// Routes where the host's own pages may use the cookie: apps, and reading
// files.
function ownOriginRoute(req: Req, route: AmbientRoute): boolean {
  if (route === "app") return true;
  const method = (req.method ?? "GET").toUpperCase();
  return route === "file" && (method === "GET" || method === "HEAD");
}

// Why a cookie-authenticated request must be refused, or undefined if it is
// acceptable.
export function ambientCookieRejection(
  req: Req & { url?: string },
  route: AmbientRoute,
  project_id?: string,
): string | undefined {
  const approved = approvedBrowserOrigins();
  const originHeader = header(req, "origin");
  if (originHeader) {
    const origin = parseOrigin(originHeader);
    if (!origin) return "invalid or opaque origin";
    if (approved.has(origin)) return;
    if (
      ownOriginRoute(req, route) &&
      isOwnOrigin(origin, req) &&
      ownAppOriginAllowed(req, project_id)
    ) {
      return;
    }
    return "origin not allowed";
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (route === "conat") return; // browsers always send Origin on websockets
  if (method !== "GET" && method !== "HEAD") return "no origin";
  const site = header(req, "sec-fetch-site").toLowerCase();
  if (!site) return "no fetch metadata";
  if (site === "none") return;
  const referer = header(req, "referer");
  if (referer) {
    const origin = originOfUrl(referer);
    if (origin && approved.has(origin)) return;
  }
  if (
    ownOriginRoute(req, route) &&
    site === "same-origin" &&
    ownAppOriginAllowed(req, project_id)
  ) {
    return;
  }
  // A top-level page navigation (a new tab or window, a link, a redirect)
  // replaces the whole page, so whoever started it cannot read the result.
  // The app opens apps and files this way, often with noreferrer (no
  // Referer). Frames, fetches and subresources from other pages stay refused.
  if (
    (route === "app" || route === "file") &&
    header(req, "sec-fetch-mode").toLowerCase() === "navigate" &&
    header(req, "sec-fetch-dest").toLowerCase() === "document" &&
    // Same serving-host rule as the own-origin cases: the shared host
    // (PROJECT_HOST_PUBLIC_URL) unbound, a private app hostname only for its
    // own project, anything else (including a failed lookup) refused.
    ownAppOriginAllowed(req, project_id)
  ) {
    return;
  }
  return "not from an approved page";
}

const lastLogged = new Map<string, number>();

function logRejection(req: Req, context: string, reason: string): void {
  const origin = header(req, "origin") || "(none)";
  const key = `${context}|${reason}|${origin}`;
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) < 60_000) return;
  lastLogged.set(key, now);
  if (lastLogged.size > 1000) lastLogged.clear();
  logger.warn("cookie-authenticated request from an unapproved page", {
    context,
    reason,
    origin: origin.slice(0, 200),
    sec_fetch_site: header(req, "sec-fetch-site").slice(0, 40),
    sec_fetch_dest: header(req, "sec-fetch-dest").slice(0, 40),
    mode: originPolicyMode(),
  });
}

// Returns true when the request may proceed (always, in report and off mode).
export function checkAmbientCookieRequest(
  req: Req & { url?: string },
  route: AmbientRoute,
  context: string = route,
  project_id?: string,
): boolean {
  const mode = originPolicyMode();
  if (mode === "off") return true;
  const reason = ambientCookieRejection(req, route, project_id);
  if (!reason) return true;
  logRejection(req, context, reason);
  return mode === "report";
}

// The value for Access-Control-Allow-Origin, if any. Only approved origins
// get credentialed CORS; report and off mode keep the old behavior of
// reflecting any origin.
export function corsOrigin(req: Req): string | undefined {
  const originHeader = header(req, "origin");
  if (!originHeader) return;
  const mode = originPolicyMode();
  const origin = parseOrigin(originHeader);
  if (origin && approvedBrowserOrigins().has(origin)) return originHeader;
  if (mode === "enforce") return;
  if (mode === "report") logRejection(req, "cors", "origin not allowed");
  return originHeader;
}
