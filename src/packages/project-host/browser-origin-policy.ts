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
itself), never for files, uploads, the session bootstrap or Conat. On a
private app hostname it is further bound to that app's project. On the shared
host hostname it is not bound to a project: path-based apps (e.g. JupyterLab
at /<project_id>/port/...) need it, and only separate content origins can
remove that residual risk.

With an Origin header, it must be approved (see above). Without one:
- non-GET/HEAD requests are refused (browsers send Origin on them);
- requests without fetch metadata (Sec-Fetch-Site) are refused: the page
  can't be identified, and non-browser clients use explicit tokens;
- Sec-Fetch-Site: none (typed URL, bookmark) is allowed;
- a Referer from an approved origin is allowed (the app's <img>, iframes,
  links; the app sends strict-origin-when-cross-origin);
- same-origin subresources are allowed on app routes;
- a user-activated top-level explicit download (?download) of a file is
  allowed;
- everything else is refused.

COCALC_PROJECT_HOST_ORIGIN_POLICY=report logs violations but behaves as
before (including CORS); "off" disables checks and logging.
*/

import type { IncomingMessage } from "node:http";
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
}

export function originPolicyMode(): OriginPolicyMode {
  const value = `${process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY ?? ""}`
    .trim()
    .toLowerCase();
  return value === "report" || value === "off" ? value : "enforce";
}

export function approvedBrowserOrigins(): Set<string> {
  const origins = new Set(hubOrigins);
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

// The own-origin allowance for app routes; on a private app hostname only for
// that app's own project.
function ownAppOriginAllowed(
  req: Req,
  project_id: string | undefined,
): boolean {
  const privateProject = getPrivateAppHostnameProject(req as IncomingMessage);
  return privateProject == null || privateProject === project_id;
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

function isExplicitDownload(req: Req & { url?: string }): boolean {
  try {
    return new URL(
      req.url ?? "/",
      "http://project-host.local",
    ).searchParams.has("download");
  } catch {
    return false;
  }
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
      route === "app" &&
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
    route === "app" &&
    site === "same-origin" &&
    ownAppOriginAllowed(req, project_id)
  ) {
    return;
  }
  if (
    route === "file" &&
    header(req, "sec-fetch-mode").toLowerCase() === "navigate" &&
    header(req, "sec-fetch-dest").toLowerCase() === "document" &&
    header(req, "sec-fetch-user") === "?1" &&
    isExplicitDownload(req)
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
