/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IncomingMessage } from "node:http";
import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/hub/logger";
import { getPublicAppRouteByHostname } from "@cocalc/server/app-public-subdomains";
import { isLaunchpadProduct } from "@cocalc/server/launchpad/mode";

const logger = getLogger("proxy:public-app-subdomain");

const PUBLIC_APP_SUBDOMAIN_MARKER = Symbol("cocalc.publicAppSubdomainRequest");

type MarkerValue = {
  project_id: string;
  app_id: string;
  base_path: string;
  hostname: string;
};

function normalizeHost(value?: string | string[]): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const host = `${raw ?? ""}`.trim().toLowerCase();
  if (!host) return "";
  return host.split(":")[0] ?? "";
}

function withBasePath(pathname: string): string {
  if (basePath.length <= 1) return pathname;
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (pathname.startsWith(prefix)) return pathname;
  return `${prefix}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

export async function maybeRewritePublicAppSubdomainRequest(
  req: IncomingMessage,
): Promise<boolean> {
  if (!isLaunchpadProduct()) {
    return false;
  }
  const hostname = normalizeHost(req.headers.host);
  if (!hostname) return false;
  const target = await getPublicAppRouteByHostname(hostname);
  if (!target) return false;

  const parsed = new URL(req.url ?? "/", "http://proxy.local");
  const incomingPath = parsed.pathname || "/";
  const appBasePath = normalizePrefix(target.base_path);
  const suffixPath = incomingPath === "/" ? "" : incomingPath;
  const proxiedPath = normalizePrefix(`/${target.project_id}${appBasePath}${suffixPath}`);
  const rewritten = withBasePath(`${proxiedPath}${parsed.search ?? ""}`);
  req.url = rewritten;
  (req as any)[PUBLIC_APP_SUBDOMAIN_MARKER] = {
    project_id: target.project_id,
    app_id: target.app_id,
    base_path: appBasePath,
    hostname,
  } satisfies MarkerValue;
  logger.debug("rewrote public app subdomain request", {
    hostname,
    project_id: target.project_id,
    app_id: target.app_id,
    from: incomingPath,
    to: rewritten,
  });
  return true;
}

export function isPublicAppSubdomainRequest(req: IncomingMessage): boolean {
  return !!(req as any)[PUBLIC_APP_SUBDOMAIN_MARKER];
}

