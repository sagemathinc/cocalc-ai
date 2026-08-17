/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

export interface NormalizedSiteUrl {
  entered_app_url: string;
  canonical_app_url: string;
  app_base_path: string;
  origin: string;
}

export interface NormalizeSiteUrlOptions {
  allowInsecureHosts?: readonly string[];
}

function normalizedPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 0 ? "" : `/${parts.join("/")}`;
}

export function normalizeSiteUrl(
  entered: string,
  { allowInsecureHosts = [] }: NormalizeSiteUrlOptions = {},
): NormalizedSiteUrl {
  const value = entered.trim();
  if (!value) {
    throw new Error("Enter a CoCalc site URL.");
  }
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("Enter a valid absolute CoCalc site URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CoCalc site URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("CoCalc site URLs cannot contain a username or password.");
  }
  if (url.search || url.hash) {
    throw new Error("Remove query parameters and fragments from the site URL.");
  }
  const allowedHttp = new Set(
    allowInsecureHosts.map((host) => host.trim().toLowerCase()),
  );
  if (
    url.protocol === "http:" &&
    !allowedHttp.has(url.hostname.toLowerCase())
  ) {
    throw new Error("This site must use HTTPS.");
  }
  const app_base_path = normalizedPath(url.pathname);
  const origin = url.origin;
  return {
    entered_app_url: value,
    canonical_app_url: `${origin}${app_base_path}`,
    app_base_path,
    origin,
  };
}

export function siteApiUrl(
  site: Pick<NormalizedSiteUrl, "canonical_app_url">,
  endpoint: string,
): string {
  const relative = endpoint.replace(/^\/+/, "");
  return `${site.canonical_app_url}/api/v2/${relative}`;
}

export function siteWithBasePath(
  originOrAppUrl: string,
  appBasePath: string,
): NormalizedSiteUrl {
  const url = new URL(originOrAppUrl);
  const existing = normalizedPath(url.pathname);
  const path = existing || normalizedPath(appBasePath);
  return normalizeSiteUrl(`${url.origin}${path}`, {
    allowInsecureHosts:
      url.protocol === "http:" ? [url.hostname.toLowerCase()] : [],
  });
}

export function rememberMeCookieHeader(
  appBasePath: string,
  rememberMe: string,
): string {
  const basePath = normalizedPath(appBasePath) || "/";
  const scopedName = `${basePath.length <= 1 ? "" : encodeURIComponent(basePath)}remember_me`;
  const names =
    scopedName === "remember_me" ? [scopedName] : [scopedName, "remember_me"];
  return names.map((name) => `${name}=${rememberMe}`).join("; ");
}
