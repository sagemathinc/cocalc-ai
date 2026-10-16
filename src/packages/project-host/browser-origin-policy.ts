/*
Which web origins may use the project-host's browser cookies.

The project-host browser-session and HTTP-session cookies are ambient: the
browser attaches them to any request for this host, including requests made
by pages on unrelated sites. A request (or websocket) authenticated only by
such a cookie is therefore accepted only when it comes from an allowed origin:

- the CoCalc site and bay public origins, as reported by the hub
  (system.getPublicSiteUrl), falling back to COCALC_SITE_URL;
- the request's own host (same-origin pages, e.g. a private app hostname
  fetching from itself);
- extra origins in COCALC_PROJECT_HOST_ALLOWED_ORIGINS (comma separated).

A request without an Origin header is allowed unless the browser says it is a
cross-site subresource (Sec-Fetch-Site: cross-site and not a navigation), so
links, downloads and iframes opened from the app keep working.

COCALC_PROJECT_HOST_ORIGIN_POLICY=report logs violations instead of rejecting
them (an escape hatch while rolling out); "off" disables the check.
*/

import type { IncomingMessage } from "node:http";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:browser-origin-policy");

export type OriginPolicyMode = "enforce" | "report" | "off";

let hubOrigins: string[] = [];

export function normalizeBrowserOrigin(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw || raw === "null") return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return url.origin.toLowerCase();
  } catch {
    return;
  }
}

export function setHubBrowserOrigins(origins: unknown[]): void {
  hubOrigins = origins
    .map(normalizeBrowserOrigin)
    .filter((x): x is string => !!x);
}

export function originPolicyMode(): OriginPolicyMode {
  const value = `${process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY ?? ""}`
    .trim()
    .toLowerCase();
  return value === "report" || value === "off" ? value : "enforce";
}

export function allowedBrowserOrigins(): Set<string> {
  const origins = new Set(hubOrigins);
  for (const value of [
    process.env.COCALC_SITE_URL,
    ...`${process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS ?? ""}`.split(","),
  ]) {
    const origin = normalizeBrowserOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function header(req: Pick<IncomingMessage, "headers">, name: string): string {
  const value = req.headers[name];
  return `${Array.isArray(value) ? value[0] : (value ?? "")}`.trim();
}

function requestHostnames(req: Pick<IncomingMessage, "headers">): string[] {
  const hosts: string[] = [];
  for (const value of [
    header(req, "host"),
    header(req, "x-forwarded-host").split(",")[0],
  ]) {
    const host = value.trim().toLowerCase();
    if (!host) continue;
    try {
      hosts.push(new URL(`http://${host}`).hostname);
    } catch {
      // ignore malformed host headers
    }
  }
  return hosts;
}

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  req: Pick<IncomingMessage, "headers">,
): boolean {
  const normalized = normalizeBrowserOrigin(origin);
  if (!normalized) return false;
  if (allowedBrowserOrigins().has(normalized)) return true;
  // Same origin as the request itself.
  return requestHostnames(req).includes(new URL(normalized).hostname);
}

// Why a cookie-authenticated request must be refused, or undefined if it is
// acceptable.
export function ambientCookieRejection(
  req: Pick<IncomingMessage, "headers">,
): string | undefined {
  const origin = header(req, "origin");
  if (origin) {
    return isAllowedBrowserOrigin(origin, req)
      ? undefined
      : "origin not allowed";
  }
  const site = header(req, "sec-fetch-site").toLowerCase();
  const mode = header(req, "sec-fetch-mode").toLowerCase();
  if (site === "cross-site" && mode !== "navigate") {
    return "cross-site subresource";
  }
  return;
}

const lastLogged = new Map<string, number>();

// Returns true when the request may proceed. Logs at most once a minute per
// (reason, origin) so a misconfigured allowlist is visible without flooding.
export function checkAmbientCookieRequest(
  req: Pick<IncomingMessage, "headers">,
  context: string,
): boolean {
  const mode = originPolicyMode();
  if (mode === "off") return true;
  const reason = ambientCookieRejection(req);
  if (!reason) return true;
  const origin = header(req, "origin") || "(none)";
  const key = `${context}|${reason}|${origin}`;
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) > 60_000) {
    lastLogged.set(key, now);
    if (lastLogged.size > 1000) lastLogged.clear();
    logger.warn("cookie-authenticated request from a disallowed origin", {
      context,
      reason,
      origin: origin.slice(0, 200),
      sec_fetch_site: header(req, "sec-fetch-site").slice(0, 40),
      mode,
    });
  }
  return mode === "report";
}

// CORS: reflect the request Origin only when it is allowed.
export function corsOrigin(
  req: Pick<IncomingMessage, "headers">,
): string | undefined {
  const origin = header(req, "origin");
  if (!origin || !isAllowedBrowserOrigin(origin, req)) return;
  return origin;
}
