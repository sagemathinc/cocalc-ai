/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project app origins (trust-free step 6, phase 7).

A project's web server or app is served on its own origin under the content
domain:

  https://a<key>-<project32>.h-<host32>.<content domain>/<project_id>/port/8000/...

so that whatever it serves (a collaborator's server, student HTML) never runs
with the CoCalc app's or the host's credentials, nor another app's.

- The hub's /app-open signs a short-lived, single-use app capability; the
  browser brings it to /_a/<capability> here as a top-level navigation from
  the site, and gets a session cookie for this one origin (__Host-cocalc-app).
- Every other request on the hostname needs that session, for exactly this
  project and app, and a path of that app: anything else gets a 404.
- Host tokens, host cookies and Authorization never authenticate here;
  Authorization is passed through to the user's server.
- The session is checked on every request against the account's cutoffs,
  the project's content epoch and membership; websockets are tracked and
  swept the same way (http-proxy-auth.ts).

See kucalc content-origin-app-routes-design (v2).
*/

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidUUID } from "@cocalc/util/misc";
import { hostContentLabel } from "@cocalc/util/project-content-origin";
import {
  normalizeProjectAppPath,
  parseProjectAppHostLabel,
  projectAppKey,
  projectAppRouteFromPath,
  verifyProjectAppCapability,
  type ProjectAppCapabilityClaims,
} from "@cocalc/conat/auth/project-app-capability";

export const APP_SESSION_COOKIE = "__Host-cocalc-app";
export const APP_BOOTSTRAP_PREFIX = "/_a/";
// The app framed by the site (a chat card): its own partitioned session.
export const APP_FRAME_SESSION_COOKIE = "__Host-cocalc-app-frame";
export const APP_FRAME_BOOTSTRAP_PREFIX = "/_af/";
export const APP_FRAME_SESSION_MAX_SECONDS = 60 * 60;
const APP_SESSION_VERSION = "project-app-session-v1";
export const APP_SESSION_MAX_SECONDS = 12 * 60 * 60;
// Replay records outlive the capability by its clock tolerance and more.
const REPLAY_MARGIN_MS = 5 * 60 * 1000;

function normalizeHostname(value: unknown): string {
  let host = `${value ?? ""}`.trim().toLowerCase();
  if (host.startsWith("[")) return host;
  host = host.replace(/:\d*$/, "").replace(/\.+$/, "");
  return host;
}

const APP_HOSTNAME_SHAPE =
  /^a(?:p[1-9][0-9]{0,4}|s[0-9a-f]{10})-[0-9a-f]{32}\.h-[0-9a-f]{32}(?:\.[a-z0-9-]+)+$/;

// Whether a hostname has the shape of an app hostname, under any domain (see
// looksLikeContentHostname).
export function looksLikeAppHostname(hostHeader: unknown): boolean {
  return APP_HOSTNAME_SHAPE.test(normalizeHostname(hostHeader));
}

// The project and app named by an app hostname of exactly this host.
export function parseAppHostname(
  hostHeader: unknown,
  { domain, host_id }: { domain: string; host_id: string },
): { project_id: string; key: string; hostname: string } | undefined {
  const hostname = normalizeHostname(hostHeader);
  const suffix = `.${hostContentLabel(host_id)}.${domain}`;
  if (!hostname.endsWith(suffix)) return;
  const parsed = parseProjectAppHostLabel(hostname.slice(0, -suffix.length));
  return parsed ? { ...parsed, hostname } : undefined;
}

// ---- sessions ----

export type AppSessionKind = "app" | "app-frame";

export interface AppSession {
  // "app": the top-level session (/_a/); "app-frame": the framed one (/_af/).
  kind?: AppSessionKind;
  account_id: string;
  project_id: string;
  key: string;
  host_id: string;
  epoch: number;
  // When the hub session behind it was issued (cutoffs compare against it).
  auth_iat_s: number;
  exp_s: number;
}

function sessionKey(secret: string): Buffer {
  // Its own key, derived from the host secret: no other token's MAC is ever
  // a valid app session MAC.
  return createHmac("sha256", secret)
    .update("cocalc project app session v1")
    .digest();
}

function sessionMac(secret: string, payload: string): string {
  return createHmac("sha256", sessionKey(secret))
    .update(`app.${payload}`)
    .digest("base64url");
}

export function createAppSessionToken(
  session: AppSession,
  { secret }: { secret: string },
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: APP_SESSION_VERSION,
      kind: session.kind ?? "app",
      sub: session.account_id,
      pid: session.project_id,
      key: session.key,
      hid: session.host_id,
      epoch: session.epoch,
      auth_iat: session.auth_iat_s,
      exp: session.exp_s,
      n: randomBytes(9).toString("base64url"),
    }),
  ).toString("base64url");
  return `${payload}.${sessionMac(secret, payload)}`;
}

export function verifyAppSessionToken(
  token: string,
  {
    secret,
    project_id,
    key,
    host_id,
    kind = "app",
    now_ms = Date.now(),
  }: {
    secret: string;
    project_id: string;
    key: string;
    host_id: string;
    kind?: AppSessionKind;
    now_ms?: number;
  },
): AppSession | undefined {
  const [payload, mac, extra] = `${token ?? ""}`.split(".");
  if (!payload || !mac || extra != null) return;
  const expected = Buffer.from(sessionMac(secret, payload));
  const got = Buffer.from(mac);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return;
  let p: any;
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return;
  }
  if (
    p?.v !== APP_SESSION_VERSION ||
    p.kind !== kind ||
    !isValidUUID(p.sub) ||
    p.pid !== project_id ||
    p.key !== key ||
    p.hid !== host_id ||
    !Number.isSafeInteger(p.epoch) ||
    p.epoch < 0 ||
    !Number.isSafeInteger(p.auth_iat) ||
    !Number.isSafeInteger(p.exp) ||
    p.exp <= Math.floor(now_ms / 1000)
  ) {
    return;
  }
  return {
    kind,
    account_id: p.sub,
    project_id,
    key,
    host_id,
    epoch: p.epoch,
    auth_iat_s: p.auth_iat,
    exp_s: p.exp,
  };
}

function readCookies(header: unknown, name: string): string[] {
  const out: string[] = [];
  for (const part of `${header ?? ""}`.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    if (value) out.push(value);
  }
  return out;
}

// The request's cookies without the app session (the user's server never
// sees it).
export function withoutAppSessionCookie(header: unknown): string | undefined {
  const kept = `${header ?? ""}`
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const i = part.indexOf("=");
      const name = i <= 0 ? part : part.slice(0, i).trim();
      return name !== APP_SESSION_COOKIE && name !== APP_FRAME_SESSION_COOKIE;
    });
  return kept.length ? kept.join("; ") : undefined;
}

// ---- request policy ----

const header = (req: Pick<IncomingMessage, "headers">, name: string) =>
  `${req.headers[name] ?? ""}`.trim().toLowerCase();

function isNavigation(req: Pick<IncomingMessage, "headers" | "method">) {
  const method = `${req.method ?? "GET"}`.toUpperCase();
  return (
    (method === "GET" || method === "HEAD") &&
    header(req, "sec-fetch-mode") === "navigate" &&
    header(req, "sec-fetch-dest") === "document"
  );
}

function originOf(value: unknown): string | undefined {
  try {
    const url = new URL(`${value ?? ""}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return url.origin;
  } catch {
    return;
  }
}

// Why a request carrying the app session must be refused, or undefined.
// Same-origin requests are fine; otherwise only top-level navigations (a
// link to the app), and for Sec-Fetch-Site: none (typed, bookmarked) only
// safe methods.  Same-site requests (other apps under the content domain)
// are refused unless they are top-level navigations.  Sessions are only
// issued to browsers that send fetch metadata (/_a/ requires it), so a
// request without it is refused.
export function appRequestRejection(
  req: Pick<IncomingMessage, "headers" | "method">,
): string | undefined {
  const site = header(req, "sec-fetch-site");
  const dest = header(req, "sec-fetch-dest");
  const method = `${req.method ?? "GET"}`.toUpperCase();
  const safe = method === "GET" || method === "HEAD";
  if (site === "same-origin") return;
  if (site) {
    if (isNavigation(req)) return;
    if (site === "none" && safe && dest === "document") return;
    if (["iframe", "frame", "embed", "object"].includes(dest)) {
      return "framed by another site";
    }
    return "cross-origin request refused";
  }
  return "missing fetch metadata";
}

// The app key a request path belongs to, or undefined (W4: an app at its
// own base path serves only that prefix).
export async function appKeyOfPath({
  project_id,
  pathname,
  matchApp,
}: {
  project_id: string;
  pathname: string;
  matchApp: (opts: {
    project_id: string;
    url: string;
  }) => Promise<
    { spec: { id: string; proxy?: { base_path?: string } } } | undefined
  >;
}): Promise<string | undefined> {
  if (!pathname.startsWith(`/${project_id}/`)) return;
  const rest = pathname.slice(project_id.length + 2);
  if (rest.startsWith("files/") || rest === "files" || rest === "upload")
    return;
  const route = projectAppRouteFromPath(project_id, pathname);
  if (route != null) {
    try {
      return projectAppKey(route);
    } catch {
      return;
    }
  }
  // Paths of the fixed forms that didn't parse are never an app's.
  if (/^(?:port|proxy|server|apps)(?:\/|$)/.test(rest)) return;
  const match = await matchApp({ project_id, url: pathname });
  const base = `${match?.spec.proxy?.base_path ?? ""}`.replace(/\/+$/, "");
  if (!match?.spec.id || !base || base === "/") return;
  try {
    return projectAppKey({ kind: "app", id: match.spec.id });
  } catch {
    return;
  }
}

// ---- the handler ----

export interface AppOriginAuth {
  account_id: string;
  issued_at_s: number;
  exp_s: number;
  project_id: string;
  epoch: number;
}

export interface AppOriginHandlerOptions {
  domain: string;
  host_id: string;
  getPublicKey: () => string;
  getSecret: () => string;
  // Site origins allowed to send browsers to /_a/ (the Referer).
  approvedOrigins: () => Set<string>;
  // Where to send a navigation without a session: <site>/app-open/...
  siteOrigin: (req: IncomingMessage) => string | undefined;
  isCollaborator: (opts: { account_id: string; project_id: string }) => boolean;
  currentEpoch: (project_id: string) => number;
  observeEpoch?: (opts: { project_id: string; epoch: number }) => void;
  accountRevokedBeforeMs: (account_id: string) => number | undefined;
  consumeCapability: (opts: { jti: string; exp_ms: number }) => boolean;
  matchApp: Parameters<typeof appKeyOfPath>[0]["matchApp"];
  // Called with the authorized request (URL unchanged, app session cookie
  // removed) to proxy it to the project.
  proxy: (
    req: IncomingMessage,
    res: ServerResponse,
    auth: AppOriginAuth,
  ) => Promise<void>;
  onError?: (opts: { project_id?: string; err: unknown }) => void;
  now?: () => number;
}

function refuse(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(`${message}\n`);
}

// Headers on every response of an app origin.  The user's server may add its
// own CSP; ours is kept alongside it (both apply).
export const APP_ORIGIN_CSP = "frame-ancestors 'self'";
const APP_ORIGIN_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Origin-Agent-Cluster": "?1",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy":
    "usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=()",
};

// The user's server's Set-Cookie headers on an upstream response (HTTP, or
// a websocket's 101), rewritten in place by rewriteUpstreamSetCookie.
export function rewriteUpstreamResponseCookies(headers: {
  [name: string]: string | string[] | undefined;
}): void {
  const value = headers["set-cookie"];
  if (value == null) return;
  const kept = (Array.isArray(value) ? value : [value])
    .map((v) => rewriteUpstreamSetCookie(`${v}`))
    .filter((v): v is string => v != null);
  if (kept.length) headers["set-cookie"] = kept;
  else delete headers["set-cookie"];
}

// A Set-Cookie value from the user's server, made host-only (D8: no Domain,
// so it never reaches another app or project), or undefined to drop it (it
// names the app session cookie).
export function rewriteUpstreamSetCookie(value: string): string | undefined {
  const parts = `${value}`.split(";");
  const eq = parts[0].indexOf("=");
  const name = (eq === -1 ? parts[0] : parts[0].slice(0, eq)).trim();
  if (
    name.toLowerCase() === APP_SESSION_COOKIE.toLowerCase() ||
    name.toLowerCase() === APP_FRAME_SESSION_COOKIE.toLowerCase()
  ) {
    return;
  }
  return parts
    .filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part))
    .join(";");
}

// The CSP for a request authorized by a frame session: the site may frame it.
export function appFrameCsp(siteOrigins: Iterable<string>): string {
  const sites = [...siteOrigins].filter((o) =>
    /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(o),
  );
  return `frame-ancestors 'self'${sites.map((o) => ` ${o}`).join("")}`;
}

function setAppOriginHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", APP_ORIGIN_CSP);
  for (const [name, value] of Object.entries(APP_ORIGIN_HEADERS)) {
    res.setHeader(name, value);
  }
}

// Before the user's server answers: keep our headers and make its cookies
// host-only.
function guardUpstreamHeaders(
  res: ServerResponse,
  csp: string = APP_ORIGIN_CSP,
): void {
  const setHeader = res.setHeader.bind(res);
  const fix = (name: string, value: any): any => {
    const lower = `${name}`.toLowerCase();
    if (lower === "set-cookie") {
      const values = (Array.isArray(value) ? value : [value])
        .map((v) => rewriteUpstreamSetCookie(`${v}`))
        .filter((v): v is string => v != null);
      return values;
    }
    if (lower === "content-security-policy") {
      const values = (Array.isArray(value) ? value : [value]).map(String);
      return values.includes(csp) ? values : [csp, ...values];
    }
    if (lower in LOWER_FIXED) return LOWER_FIXED[lower];
    return value;
  };
  res.setHeader = ((name: string, value: any) =>
    setHeader(name, fix(name, value))) as typeof res.setHeader;
  const appendHeader = (res as any).appendHeader?.bind(res);
  if (appendHeader) {
    (res as any).appendHeader = (name: string, value: any) => {
      const lower = `${name}`.toLowerCase();
      if (lower in LOWER_FIXED) return res;
      if (lower === "set-cookie") {
        const kept = fix(name, value) as string[];
        return kept.length ? appendHeader(name, kept) : res;
      }
      return appendHeader(name, value);
    };
  }
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((...args: any[]) => {
    args = args.map((arg) => {
      if (Array.isArray(arg)) {
        const out: any[] = [];
        for (let i = 0; i + 1 < arg.length; i += 2) {
          const v = fix(arg[i], arg[i + 1]);
          for (const one of Array.isArray(v) ? v : [v]) out.push(arg[i], one);
        }
        return out;
      }
      if (arg != null && typeof arg === "object") {
        for (const key of Object.keys(arg)) arg[key] = fix(key, arg[key]);
      }
      return arg;
    });
    return writeHead(...(args as [any]));
  }) as typeof res.writeHead;
}

const LOWER_FIXED: Record<string, string> = Object.fromEntries(
  Object.entries(APP_ORIGIN_HEADERS).map(([k, v]) => [k.toLowerCase(), v]),
);

// A navigation of a frame (iframe/frame), as opposed to the top-level page.
function isFrameNavigation(req: Pick<IncomingMessage, "headers" | "method">) {
  const method = `${req.method ?? "GET"}`.toUpperCase();
  const dest = header(req, "sec-fetch-dest");
  return (
    (method === "GET" || method === "HEAD") &&
    header(req, "sec-fetch-mode") === "navigate" &&
    (dest === "iframe" || dest === "frame")
  );
}

// The page a framed app gets when it has no (valid) frame session: it tells
// the parent (the site's card) so, which then bootstraps again or offers to
// open the app in a new tab (third-party cookies blocked).  The message is a
// fixed object; the parent checks event.origin.
export function appFrameStatusPage(
  nonce: string,
  parentOrigin: string,
): string {
  return `<!doctype html><meta charset="utf-8"><title>App</title><script nonce="${nonce}">parent.postMessage({type:"cocalc-app-frame",status:"no-session"},${JSON.stringify(parentOrigin)});</script>`;
}

export function createAppOriginHandler(opts: AppOriginHandlerOptions) {
  const { domain, host_id } = opts;
  const now = () => opts.now?.() ?? Date.now();

  // The session of this kind on this request, if valid and still allowed.
  // `stale` says a session cookie was present but is no longer good
  // (expired, revoked, older epoch...).
  const sessionOf = (
    req: Pick<IncomingMessage, "headers">,
    target: { project_id: string; key: string },
    kind: AppSessionKind = "app",
  ): { session?: AppSession; stale: boolean; olderEpoch: boolean } => {
    const tokens = readCookies(
      req.headers.cookie,
      kind === "app" ? APP_SESSION_COOKIE : APP_FRAME_SESSION_COOKIE,
    );
    let olderEpoch = false;
    for (const token of tokens) {
      const session = verifyAppSessionToken(token, {
        secret: opts.getSecret(),
        project_id: target.project_id,
        key: target.key,
        host_id,
        kind,
        now_ms: now(),
      });
      if (!session) continue;
      if (session.epoch < opts.currentEpoch(target.project_id)) {
        olderEpoch = true;
        continue;
      }
      const cutoff = opts.accountRevokedBeforeMs(session.account_id);
      if (cutoff != null && session.auth_iat_s * 1000 <= cutoff) continue;
      if (
        !opts.isCollaborator({
          account_id: session.account_id,
          project_id: target.project_id,
        })
      ) {
        continue;
      }
      return { session, stale: false, olderEpoch };
    }
    return { stale: tokens.length > 0, olderEpoch };
  };

  // /_a/ (kind "app") and /_af/ (kind "app-frame"): redeem a single-use
  // capability for a session on this origin, then go to the app's path.
  const bootstrap = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: { project_id: string; key: string; hostname: string },
    url: URL,
    kind: AppSessionKind,
  ): Promise<void> => {
    // For /_af/, the redirected frame navigation must still carry the
    // site's origin as Referer (checked below); the referrer is the site's
    // page, never this capability URL, so nothing leaks either way.
    res.setHeader(
      "Referrer-Policy",
      kind === "app" ? "no-referrer" : "strict-origin",
    );
    res.setHeader("Cache-Control", "no-store");
    // D4: sent here by the site itself: a top-level navigation for /_a/;
    // for /_af/ the site's own frame (cross-site only: a same-site parent
    // would be a content page).
    const referer = originOf(req.headers.referer);
    const site = header(req, "sec-fetch-site");
    const shapeOk =
      kind === "app"
        ? isNavigation(req) && site !== "same-site"
        : isFrameNavigation(req) && site === "cross-site";
    if (
      `${req.method ?? "GET"}`.toUpperCase() !== "GET" ||
      !shapeOk ||
      !referer ||
      !opts.approvedOrigins().has(referer)
    ) {
      return refuse(res, 403, "open this app from CoCalc");
    }
    const prefix =
      kind === "app" ? APP_BOOTSTRAP_PREFIX : APP_FRAME_BOOTSTRAP_PREFIX;
    const token = url.pathname.slice(prefix.length);
    let claims: ProjectAppCapabilityClaims;
    try {
      if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("bad token");
      claims = verifyProjectAppCapability({
        token,
        project_id: target.project_id,
        key: target.key,
        host_id,
        public_key: opts.getPublicKey(),
        scope: kind,
        now_ms: now(),
      });
    } catch {
      return refuse(res, 403, "invalid or expired link");
    }
    const currentEpoch = opts.currentEpoch(target.project_id);
    const cutoff = opts.accountRevokedBeforeMs(claims.sub);
    if (
      claims.epoch < currentEpoch ||
      (cutoff != null && claims.iat * 1000 <= cutoff) ||
      !opts.isCollaborator({
        account_id: claims.sub,
        project_id: target.project_id,
      })
    ) {
      return refuse(res, 403, "invalid or expired link");
    }
    // Where to go: a path of exactly this app, rebuilt from its parts.
    let next: string;
    try {
      next = normalizeProjectAppPath(
        target.project_id,
        url.searchParams.get("next") ?? "",
      );
    } catch {
      return refuse(res, 400, "invalid app path");
    }
    const nextPath = next.split("?")[0];
    const nextKey = await appKeyOfPath({
      project_id: target.project_id,
      pathname: nextPath,
      matchApp: opts.matchApp,
    });
    if (nextKey !== target.key) {
      return refuse(res, 404, "not found");
    }
    if (
      !opts.consumeCapability({
        jti: claims.jti,
        exp_ms: claims.exp * 1000 + REPLAY_MARGIN_MS,
      })
    ) {
      return refuse(res, 403, "this link was already used");
    }
    if (claims.epoch > currentEpoch) {
      opts.observeEpoch?.({
        project_id: target.project_id,
        epoch: claims.epoch,
      });
    }
    const now_s = Math.floor(now() / 1000);
    const max =
      kind === "app" ? APP_SESSION_MAX_SECONDS : APP_FRAME_SESSION_MAX_SECONDS;
    const exp_s = Math.min(now_s + max, claims.bse ?? Infinity);
    if (!(exp_s > now_s)) {
      return refuse(res, 403, "invalid or expired link");
    }
    const session = createAppSessionToken(
      {
        kind,
        account_id: claims.sub,
        project_id: target.project_id,
        key: target.key,
        host_id,
        epoch: Math.max(claims.epoch, currentEpoch),
        auth_iat_s: claims.iat,
        exp_s,
      },
      { secret: opts.getSecret() },
    );
    // D10: a session of an older epoch was revoked; drop what it left.
    if (sessionOf(req, target, kind).olderEpoch) {
      res.setHeader("Clear-Site-Data", '"storage", "cache"');
    }
    // Built from parts: next is a path of this app on this origin.
    const location = new URL(next, `https://${target.hostname}`);
    if (location.origin !== `https://${target.hostname}`) {
      return refuse(res, 400, "invalid app path");
    }
    res.statusCode = 302;
    res.setHeader(
      "Set-Cookie",
      kind === "app"
        ? `${APP_SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${exp_s - now_s}`
        : // Partitioned: only ever sent inside the site's frames.
          `${APP_FRAME_SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${exp_s - now_s}`,
    );
    res.setHeader("Location", location.href);
    res.end();
  };

  const frameStatus = (res: ServerResponse, parentOrigin: string): void => {
    const nonce = randomBytes(16).toString("base64");
    res.statusCode = 401;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors ${parentOrigin}`,
    );
    res.end(appFrameStatusPage(nonce, parentOrigin));
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    // The capability may be in the URL: nothing after this may log it.
    const originalUrl = `${req.url ?? "/"}`;
    req.url = "/";
    if ("originalUrl" in req) (req as any).originalUrl = "/";
    setAppOriginHeaders(res);
    if (req.headers["service-worker"] != null) {
      // W1: a service worker would outlive the session and see every request.
      return refuse(res, 403, "service workers are not allowed");
    }
    const target = parseAppHostname(req.headers.host, { domain, host_id });
    if (target == null) return refuse(res, 404, "not found");
    let url: URL;
    try {
      url = new URL(originalUrl, `https://${target.hostname}`);
    } catch {
      return refuse(res, 400, "bad request");
    }
    if (url.origin !== `https://${target.hostname}`) {
      return refuse(res, 400, "bad request");
    }
    if (url.pathname.startsWith(APP_BOOTSTRAP_PREFIX)) {
      return await bootstrap(req, res, target, url, "app");
    }
    if (url.pathname.startsWith(APP_FRAME_BOOTSTRAP_PREFIX)) {
      return await bootstrap(req, res, target, url, "app-frame");
    }
    const key = await appKeyOfPath({
      project_id: target.project_id,
      pathname: url.pathname,
      matchApp: opts.matchApp,
    });
    if (key !== target.key) return refuse(res, 404, "not found");
    const site = header(req, "sec-fetch-site");
    let session: AppSession | undefined;
    if (isFrameNavigation(req) && site !== "same-origin") {
      // Framed by someone else: only the site's own card, with a frame
      // session (D3, F1).
      const referer = originOf(req.headers.referer);
      if (
        site !== "cross-site" ||
        !referer ||
        !opts.approvedOrigins().has(referer)
      ) {
        return refuse(res, 403, "framed by another site");
      }
      session = sessionOf(req, target, "app-frame").session;
      if (!session) return frameStatus(res, referer);
    } else {
      const top = sessionOf(req, target, "app");
      session = top.session;
      if (session) {
        const why = appRequestRejection(req);
        if (why) return refuse(res, 403, why);
      } else if (
        site === "same-origin" &&
        header(req, "sec-fetch-dest") !== "document"
      ) {
        // Inside the site's frame: the app's own requests (F5: never a
        // top-level page).
        session = sessionOf(req, target, "app-frame").session;
      }
      if (!session) {
        const siteOrigin = opts.siteOrigin(req);
        if (isNavigation(req) && siteOrigin) {
          res.statusCode = 302;
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(
            "Location",
            `${siteOrigin}/app-open${url.pathname}${url.search}`,
          );
          res.end();
          return;
        }
        return refuse(
          res,
          401,
          top.stale ? "session expired" : "sign in required",
        );
      }
    }
    let csp = APP_ORIGIN_CSP;
    if (session.kind === "app-frame") {
      csp = appFrameCsp(opts.approvedOrigins());
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    }
    const cookie = withoutAppSessionCookie(req.headers.cookie);
    if (cookie == null) delete req.headers.cookie;
    else req.headers.cookie = cookie;
    req.url = `${url.pathname}${url.search}`;
    guardUpstreamHeaders(res, csp);
    try {
      await opts.proxy(req, res, {
        account_id: session.account_id,
        issued_at_s: session.auth_iat_s,
        exp_s: session.exp_s,
        project_id: target.project_id,
        epoch: session.epoch,
      });
    } catch (err) {
      opts.onError?.({ project_id: target.project_id, err });
      refuse(res, 502, "app unavailable");
    }
  };

  // For a websocket upgrade on an app hostname: the authorization, or
  // undefined to refuse it.  The URL is left as is (an app path).
  const authorizeUpgrade = async (
    req: IncomingMessage,
  ): Promise<AppOriginAuth | undefined> => {
    if (req.headers["service-worker"] != null) return;
    const target = parseAppHostname(req.headers.host, { domain, host_id });
    if (target == null) return;
    const origin = `https://${target.hostname}`;
    // Browsers always send Origin on websockets; only the app itself may.
    if (originOf(req.headers.origin) !== origin) return;
    let url: URL;
    try {
      url = new URL(`${req.url ?? "/"}`, origin);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    const key = await appKeyOfPath({
      project_id: target.project_id,
      pathname: url.pathname,
      matchApp: opts.matchApp,
    });
    if (key !== target.key) return;
    // The top-level page's session, or the site's frame's.
    const session =
      sessionOf(req, target, "app").session ??
      sessionOf(req, target, "app-frame").session;
    if (!session) return;
    const cookie = withoutAppSessionCookie(req.headers.cookie);
    if (cookie == null) delete req.headers.cookie;
    else req.headers.cookie = cookie;
    req.url = `${url.pathname}${url.search}`;
    return {
      account_id: session.account_id,
      issued_at_s: session.auth_iat_s,
      exp_s: session.exp_s,
      project_id: target.project_id,
      epoch: session.epoch,
    };
  };

  return { handleRequest, authorizeUpgrade };
}
