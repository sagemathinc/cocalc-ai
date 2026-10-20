/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Per-project content origin (trust-free step 6, phase 1).

Project files are served at

  https://<project>.h-<host>.<content domain>/_c/<capability>/files/<path>

on a registrable domain separate from the app and the project hosts, one
origin per project.  Project HTML gets a real origin, so its relative images,
CSS, scripts and fetches work, but no credential of the viewer: the host
session cookie is never sent to that domain, and every request is authorized
only by the capability in its path.

Invariants (see kucalc step6-content-origin-design):
- Requests on any content hostname are answered here and nowhere else: the
  host's path-routed handlers never see them, and websocket upgrades on them
  are refused before any upgrade listener runs.
- The hostname must name this host and the capability's project exactly.
- Cookies and Authorization are ignored, and no response sets a cookie.
- The capability is never logged: the request URL is rewritten before any
  further handling.
*/

import type { IncomingMessage, Server, ServerResponse } from "http";
import { isValidUUID } from "@cocalc/util/misc";
import {
  hostContentLabel,
  normalizeContentDomain,
  projectContentHostname,
  projectContentLabel,
} from "@cocalc/util/project-content-origin";
import {
  contentPathWithinDir,
  verifyProjectContentCapability,
  type ProjectContentCapabilityClaims,
} from "@cocalc/conat/auth/project-content-capability";

export {
  hostContentLabel,
  normalizeContentDomain,
  projectContentHostname,
  projectContentLabel,
};

export const CONTENT_PATH_PREFIX = "/_c/";

function normalizeHostname(value: unknown): string {
  let host = `${value ?? ""}`.trim().toLowerCase();
  if (host.startsWith("[")) return host; // IPv6 literal: never a content host
  host = host.replace(/:\d*$/, "").replace(/\.+$/, "");
  return host;
}

// The content domain configured for this process, if any.
export function getProjectContentDomain(): string | undefined {
  return normalizeContentDomain(process.env.COCALC_PROJECT_CONTENT_DOMAIN);
}

// Whether the request is for the content domain at all (any project, any
// host).  Such requests are never handled by the host's other routes.
export function isContentHostname(hostHeader: unknown, domain: string): boolean {
  const host = normalizeHostname(hostHeader);
  return host === domain || host.endsWith(`.${domain}`);
}

const CONTENT_HOSTNAME_SHAPE =
  /^[0-9a-f]{32}\.h-[0-9a-f]{32}(?:\.[a-z0-9-]+)+$/;

// Whether a hostname has the shape of a content hostname, under any domain.
// This needs no configuration, so every process (including a respawned
// router daemon, or a host whose content domain is unset) treats such
// requests as content and never as its own: they fail closed instead.
export function looksLikeContentHostname(hostHeader: unknown): boolean {
  return CONTENT_HOSTNAME_SHAPE.test(normalizeHostname(hostHeader));
}

export function isContentRequestHost(
  hostHeader: unknown,
  domain: string | undefined,
): boolean {
  return (
    looksLikeContentHostname(hostHeader) ||
    (domain != null && isContentHostname(hostHeader, domain))
  );
}

function uuidFromLabel(label: string): string | undefined {
  if (!/^[0-9a-f]{32}$/.test(label)) return undefined;
  const id = `${label.slice(0, 8)}-${label.slice(8, 12)}-${label.slice(12, 16)}-${label.slice(16, 20)}-${label.slice(20)}`;
  return isValidUUID(id) ? id : undefined;
}

// The project named by a content hostname of exactly this host, or undefined.
export function parseContentHostname(
  hostHeader: unknown,
  { domain, host_id }: { domain: string; host_id: string },
): { project_id: string } | undefined {
  const host = normalizeHostname(hostHeader);
  const suffix = `.${hostContentLabel(host_id)}.${domain}`;
  if (!host.endsWith(suffix)) return undefined;
  const project_id = uuidFromLabel(host.slice(0, -suffix.length));
  return project_id ? { project_id } : undefined;
}

// Splits /_c/<capability>/files/<path> into the capability and the still
// URL-encoded file path.  The query string is dropped.  Dot segments and NUL
// are rejected rather than resolved.
export function parseContentPath(
  url: unknown,
): { capability: string; filePath: string } | undefined {
  const raw = `${url ?? ""}`;
  const pathname = raw.split(/[?#]/, 1)[0];
  if (!pathname.startsWith(CONTENT_PATH_PREFIX)) return undefined;
  const rest = pathname.slice(CONTENT_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const capability = rest.slice(0, slash);
  if (!/^[A-Za-z0-9_.-]+$/.test(capability)) return undefined;
  const after = rest.slice(slash);
  if (!after.startsWith("/files/")) return undefined;
  const filePath = after.slice("/files/".length);
  if (!filePath) return undefined;
  for (const segment of filePath.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    // The download handler decodes the whole path, so an encoded slash or
    // backslash would turn one segment into several.
    if (
      decoded === "." ||
      decoded === ".." ||
      /[\0/\\]/.test(decoded)
    ) {
      return undefined;
    }
  }
  return { capability, filePath };
}

export function contentResponseHeaders({
  frameAncestors,
}: {
  frameAncestors: string[];
}): Record<string, string> {
  const ancestors = frameAncestors.filter((origin) =>
    /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin),
  );
  return {
    "X-Content-Type-Options": "nosniff",
    "Origin-Agent-Cluster": "?1",
    "Strict-Transport-Security": "max-age=31536000",
    "Cross-Origin-Opener-Policy": "same-origin",
    // Browsers may keep a private copy but must revalidate it on every use
    // (the file handler answers 304 when unchanged); no shared caches.
    "Cache-Control": "private, no-cache",
    // A default only: pages can override it, and the capability is in
    // location.href anyway.  Scope, lifetime and the epoch are the controls.
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `frame-ancestors 'self'${ancestors.map((o) => ` ${o}`).join("")}`,
    "Permissions-Policy":
      "usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=()",
  };
}

// Whether path, with symlinks resolved, is dir or inside it (dir resolved
// the same way), on a project's sandboxed filesystem.
export async function canonicalPathWithinDir({
  fs,
  path,
  dir,
}: {
  fs: { canonicalSyncIdentityPath: (path: string) => Promise<string> };
  path: string;
  dir: string;
}): Promise<boolean> {
  if (dir === "/") return true;
  const absolute = (p: string) => (p.startsWith("/") ? p : `/${p}`);
  const [realPath, realDir] = await Promise.all([
    fs.canonicalSyncIdentityPath(path),
    fs.canonicalSyncIdentityPath(dir),
  ]);
  return contentPathWithinDir(absolute(realPath), absolute(realDir));
}

type CanonicalFs = Parameters<typeof canonicalPathWithinDir>[0]["fs"];

// realPathWithinDir for the handler.  A page's subresources arrive in
// bursts, so each project's filesystem is reused for a short while.
export function createContentPathChecker({
  createFs,
  ttlMs = 30_000,
  now = () => Date.now(),
}: {
  createFs: (project_id: string) => Promise<CanonicalFs>;
  ttlMs?: number;
  now?: () => number;
}): ((opts: {
  project_id: string;
  path: string;
  dir: string;
}) => Promise<boolean>) & { cacheSize: () => number } {
  const cache = new Map<string, { fs: Promise<CanonicalFs>; expires: number }>();
  const check = async ({
    project_id,
    path,
    dir,
  }: {
    project_id: string;
    path: string;
    dir: string;
  }) => {
    if (dir === "/") return true;
    let entry = cache.get(project_id);
    if (entry == null || entry.expires <= now()) {
      for (const [id, old] of cache) {
        if (old.expires <= now()) cache.delete(id);
      }
      const fs = createFs(project_id);
      entry = { fs, expires: now() + ttlMs };
      cache.set(project_id, entry);
      fs.catch(() => {
        if (cache.get(project_id)?.fs === fs) cache.delete(project_id);
      });
    }
    return await canonicalPathWithinDir({ fs: await entry.fs, path, dir });
  };
  return Object.assign(check, { cacheSize: () => cache.size });
}

export interface ContentOriginHandlerOptions {
  domain: string;
  host_id: string;
  getPublicKey: () => string;
  frameAncestors: () => string[];
  // Whether the account may read the whole project.  Phase 1 allows owners
  // and collaborators only; restricted readers (viewers) are refused until
  // capabilities carry the project-wide read floor.
  hasReadAccess: (opts: { account_id: string; project_id: string }) => boolean;
  currentEpoch: (project_id: string) => number;
  // Called with a newer epoch seen in a hub-signed capability, so the host
  // catches up (and refuses older links) even if a sync from the hub was
  // missed.
  observeEpoch?: (opts: { project_id: string; epoch: number }) => void;
  // Links issued at or before this time (ms) were revoked for the account:
  // "sign out everywhere", a ban or a deletion.
  accountRevokedBeforeMs: (account_id: string) => number | undefined;
  // Whether path, with symlinks resolved, is still inside dir (also
  // resolved).  Only members can create symlinks in a project, but a
  // collected or copied folder can carry one that points elsewhere.
  realPathWithinDir: (opts: {
    project_id: string;
    path: string;
    dir: string;
  }) => Promise<boolean>;
  serveFile: (opts: {
    req: IncomingMessage;
    res: ServerResponse;
    project_id: string;
    account_id: string;
  }) => Promise<void>;
  onError?: (opts: { project_id?: string; err: unknown }) => void;
  now?: () => number;
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(`${message}\n`);
}

// Never let a response on the content origin set a cookie, whatever handler
// writes it.  The setHeader wrapper is the main guard: the handler always sets
// its headers first, so Node merges headers later passed to writeHead through
// setHeader.  The writeHead filter is a second layer for any path that writes
// headers before setHeader was called.
function dropSetCookie(res: ServerResponse): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: any) => {
    if (`${name}`.toLowerCase() === "set-cookie") return res;
    return setHeader(name, value);
  }) as typeof res.setHeader;
  const writeHead = res.writeHead.bind(res);
  const isSetCookie = (name: unknown) =>
    `${name}`.toLowerCase() === "set-cookie";
  res.writeHead = ((...args: any[]) => {
    args = args.map((arg) => {
      if (Array.isArray(arg)) {
        // the flat [name, value, name, value, ...] form
        const kept: any[] = [];
        for (let i = 0; i + 1 < arg.length; i += 2) {
          if (!isSetCookie(arg[i])) kept.push(arg[i], arg[i + 1]);
        }
        return kept;
      }
      if (arg != null && typeof arg === "object") {
        for (const key of Object.keys(arg)) {
          if (isSetCookie(key)) delete arg[key];
        }
      }
      return arg;
    });
    if (res.hasHeader("set-cookie")) res.removeHeader("set-cookie");
    return writeHead(...(args as [any]));
  }) as typeof res.writeHead;
}

function setRequestUrl(req: IncomingMessage, url: string): void {
  req.url = url;
  if ("originalUrl" in req) {
    (req as IncomingMessage & { originalUrl?: string }).originalUrl = url;
  }
}

export function createContentOriginHandler(opts: ContentOriginHandlerOptions) {
  const { domain, host_id } = opts;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> => {
    if (!isContentRequestHost(req.headers.host, domain)) {
      return next();
    }
    // From here on this request is answered here and never passed on.  The
    // capability is in the URL, so nothing after this point may see it
    // (Express keeps a copy in originalUrl).
    const originalUrl = req.url;
    setRequestUrl(req, "/");
    delete req.headers.cookie;
    delete req.headers.authorization;
    dropSetCookie(res);
    for (const [name, value] of Object.entries(
      contentResponseHeaders({ frameAncestors: opts.frameAncestors() }),
    )) {
      res.setHeader(name, value);
    }
    if (req.headers["service-worker"] != null) {
      return refuse(res, 403, "service workers are not allowed");
    }
    const target = parseContentHostname(req.headers.host, { domain, host_id });
    if (target == null) {
      return refuse(res, 404, "not found");
    }
    const { project_id } = target;
    const method = `${req.method ?? "GET"}`.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return refuse(res, 405, "method not allowed");
    }
    const parsed = parseContentPath(originalUrl);
    if (parsed == null) {
      return refuse(res, 404, "not found");
    }
    let claims: ProjectContentCapabilityClaims;
    try {
      claims = verifyProjectContentCapability({
        token: parsed.capability,
        project_id,
        host_id,
        public_key: opts.getPublicKey(),
        now_ms: opts.now?.(),
      });
    } catch {
      return refuse(res, 403, "invalid or expired link");
    }
    // An older epoch was revoked ("Revoke content links").  A newer one is
    // signed by the hub, so it is current even if this host hasn't heard yet.
    const currentEpoch = opts.currentEpoch(project_id);
    if (claims.epoch < currentEpoch) {
      return refuse(res, 403, "invalid or expired link");
    }
    const account_id = claims.sub;
    const revokedBeforeMs = opts.accountRevokedBeforeMs(account_id);
    if (revokedBeforeMs != null && claims.iat * 1000 <= revokedBeforeMs) {
      return refuse(res, 403, "invalid or expired link");
    }
    if (!opts.hasReadAccess({ account_id, project_id })) {
      return refuse(res, 403, "invalid or expired link");
    }
    if (claims.epoch > currentEpoch) {
      opts.observeEpoch?.({ project_id, epoch: claims.epoch });
    }
    // parseContentPath rejected dot segments and encoded slashes, so this is
    // the absolute path the file route will read.
    const path = `/${parsed.filePath
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/")}`;
    if (!contentPathWithinDir(path, claims.dir)) {
      return refuse(res, 403, "outside this link's folder");
    }
    try {
      if (
        !(await opts.realPathWithinDir({ project_id, path, dir: claims.dir }))
      ) {
        return refuse(res, 403, "outside this link's folder");
      }
    } catch (err) {
      opts.onError?.({ project_id, err });
      return refuse(res, 404, "not found");
    }
    setRequestUrl(req, `/${project_id}/files/${parsed.filePath}`);
    try {
      await opts.serveFile({ req, res, project_id, account_id });
    } catch (err) {
      opts.onError?.({ project_id, err });
      if (!res.headersSent) {
        refuse(res, 404, "not found");
      } else {
        res.destroy();
      }
    }
  };
}

// Refuses websocket upgrades on content hostnames before any upgrade
// listener sees them (the host attaches several, matched by path).
export function installContentHostnameUpgradeGuard(
  server: Server,
  domain: string | undefined,
): void {
  const emit = server.emit;
  server.emit = function (this: Server, event: string | symbol, ...args: any[]) {
    if (event === "upgrade") {
      const [req, socket] = args as [IncomingMessage, { destroy: () => void }];
      if (isContentRequestHost(req?.headers?.host, domain)) {
        socket?.destroy?.();
        return true;
      }
    }
    return emit.apply(this, [event, ...args] as any);
  } as typeof server.emit;
}
