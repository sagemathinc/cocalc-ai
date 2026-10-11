/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { URL } from "node:url";
import type { IncomingMessage } from "node:http";
import TTL from "@isaacs/ttlcache";
import { isValidUUID } from "@cocalc/util/misc";
import { trimTrailingSlashes } from "@cocalc/util/linear-text";

export const PRIVATE_APP_HOST_HEADER = "x-cocalc-private-app-host";
export const APP_HOSTNAME_ROUTING_PENDING_URL =
  "/__cocalc_app_hostname_routing_pending__";

export interface PrivateAppHostnameRoute {
  project_id: string;
  app_id: string;
  base_path: string;
}

export interface PrivateAppHostnameTrace {
  matched: boolean;
  project_id?: string;
  app_id?: string;
  base_path?: string;
}

interface PrivateAppHostnameRequestContext {
  canonical_base_path: string;
  hostname: string;
}

const PRIVATE_APP_HOSTNAME_REQUEST_CONTEXT = Symbol(
  "cocalc-private-app-hostname-request-context",
);
const PRIVATE_APP_HOSTNAME_REWRITE_PROMISE = Symbol(
  "cocalc-private-app-hostname-rewrite-promise",
);

type PrivateAppHostnameRequest = IncomingMessage & {
  [PRIVATE_APP_HOSTNAME_REQUEST_CONTEXT]?: PrivateAppHostnameRequestContext;
  [PRIVATE_APP_HOSTNAME_REWRITE_PROMISE]?: Promise<void>;
};

export function createAppHostnameRequestRewriteBarrier({
  shouldClaim,
  rewrite,
}: {
  shouldClaim: (req: IncomingMessage) => boolean;
  rewrite: (req: IncomingMessage, originalUrl: string) => Promise<void>;
}): (req: IncomingMessage) => Promise<void> {
  const rewrites = new WeakMap<IncomingMessage, Promise<void>>();

  return (req: IncomingMessage): Promise<void> => {
    const existing = rewrites.get(req);
    if (existing) return existing;

    const originalUrl = `${req.url ?? ""}`;
    if (originalUrl && shouldClaim(req)) {
      // Node invokes every upgrade listener without awaiting promises. Hide
      // root-level app paths from infrastructure listeners while routing.
      req.url = APP_HOSTNAME_ROUTING_PENDING_URL;
    }
    const promise = rewrite(req, originalUrl);
    rewrites.set(req, promise);
    return promise;
  };
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlashes(withLeading) || "/";
}

function normalizeHostHeader(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase().split(":")[0] ?? "";
}

export function rewritePrivateAppHostnameUrl({
  originalUrl,
  route,
}: {
  originalUrl?: string;
  route: PrivateAppHostnameRoute;
}): string {
  const parsed = new URL(originalUrl ?? "/", "http://project-host.local");
  const incomingPath = parsed.pathname || "/";
  const canonicalBasePath = normalizePrefix(
    `/${route.project_id}${route.base_path}`,
  );
  const proxiedPath =
    incomingPath === canonicalBasePath ||
    incomingPath.startsWith(`${canonicalBasePath}/`)
      ? incomingPath
      : `${canonicalBasePath}${incomingPath}`;
  return `${proxiedPath}${parsed.search ?? ""}`;
}

export function privateAppHostnameExternalLocation(
  req: IncomingMessage,
  location: string,
): string {
  const context = (req as PrivateAppHostnameRequest)[
    PRIVATE_APP_HOSTNAME_REQUEST_CONTEXT
  ];
  if (!context || !location) return location;
  let parsed: URL;
  try {
    parsed = new URL(location, "http://project-host.local");
  } catch {
    return location;
  }
  const { canonical_base_path: basePath } = context;
  const externalPath =
    parsed.pathname === basePath
      ? "/"
      : parsed.pathname.startsWith(`${basePath}/`)
        ? parsed.pathname.slice(basePath.length) || "/"
        : undefined;
  if (!externalPath) return location;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
    const hostname = normalizeHostHeader(parsed.host);
    if (
      hostname !== context.hostname &&
      hostname !== "127.0.0.1" &&
      hostname !== "localhost"
    ) {
      return location;
    }
    parsed.pathname = externalPath;
    return parsed.toString();
  }
  return `${externalPath}${parsed.search}${parsed.hash}`;
}

export function rewritePrivateAppHostnameResponseLocation(
  proxyRes: IncomingMessage,
  req: IncomingMessage,
): void {
  const location = proxyRes.headers.location;
  if (typeof location !== "string" || !location) return;
  proxyRes.headers.location = privateAppHostnameExternalLocation(req, location);
}

export function createPrivateAppHostnameRequestRewriter({
  trace,
  cacheMs = 30_000,
  onTraceError,
}: {
  trace: (hostname: string) => Promise<PrivateAppHostnameTrace | undefined>;
  cacheMs?: number;
  onTraceError?: (hostname: string, err: unknown) => void;
}): (req: IncomingMessage, originalUrl?: string) => Promise<void> {
  const routeCache = new TTL<string, PrivateAppHostnameRoute | null>({
    max: 20_000,
    ttl: Math.max(1_000, cacheMs),
  });

  const rewrite = async (
    req: IncomingMessage,
    originalUrl?: string,
  ): Promise<void> => {
    const currentUrl = `${originalUrl ?? req.url ?? ""}`;
    if (!currentUrl) return;
    const parsed = new URL(currentUrl, "http://project-host.local");
    const maybeProjectPrefix = (parsed.pathname || "/").split("/")[1];
    if (maybeProjectPrefix && isValidUUID(maybeProjectPrefix)) return;

    const hostname = normalizeHostHeader(req.headers.host);
    if (!hostname) return;
    let route = routeCache.get(hostname);
    if (route === undefined) {
      try {
        const traced = await trace(hostname);
        route =
          traced?.matched &&
          traced.project_id &&
          traced.app_id &&
          traced.base_path
            ? {
                project_id: traced.project_id,
                app_id: traced.app_id,
                base_path: normalizePrefix(traced.base_path),
              }
            : null;
      } catch (err) {
        onTraceError?.(hostname, err);
        route = null;
      }
      routeCache.set(hostname, route);
    }
    if (!route) return;

    (req as PrivateAppHostnameRequest)[PRIVATE_APP_HOSTNAME_REQUEST_CONTEXT] = {
      canonical_base_path: normalizePrefix(
        `/${route.project_id}${route.base_path}`,
      ),
      hostname,
    };
    req.url = rewritePrivateAppHostnameUrl({
      originalUrl: currentUrl,
      route,
    });
    req.headers[PRIVATE_APP_HOST_HEADER] = hostname;
  };

  return (req: IncomingMessage, originalUrl?: string): Promise<void> => {
    const privateReq = req as PrivateAppHostnameRequest;
    if (privateReq[PRIVATE_APP_HOSTNAME_REWRITE_PROMISE]) {
      return privateReq[PRIVATE_APP_HOSTNAME_REWRITE_PROMISE];
    }
    const promise = rewrite(req, originalUrl);
    privateReq[PRIVATE_APP_HOSTNAME_REWRITE_PROMISE] = promise;
    return promise;
  };
}
