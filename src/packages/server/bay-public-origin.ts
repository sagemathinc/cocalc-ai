/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterBayIdsForStaticEnumerationOnly,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";
import type { Request, Response } from "express";

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

export function normalizeHostname(value: unknown): string | undefined {
  const raw = trim(value);
  if (!raw) return;
  let host = raw;
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).host;
    } catch {
      host = host.replace(/^https?:\/\//, "");
    }
  }
  host = host.split("/")[0];
  if (host.includes("@")) {
    host = host.split("@").pop() ?? host;
  }
  if (host.includes(":")) {
    host = host.split(":")[0];
  }
  const normalized = host.toLowerCase();
  return normalized || undefined;
}

export function normalizeOrigin(value: unknown): string | undefined {
  const raw = trim(value);
  if (!raw) return;
  try {
    const url = new URL(raw);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function parseKeyValueMapping(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of trim(value).split(",")) {
    const raw = entry.trim();
    if (!raw) continue;
    const i = raw.indexOf("=");
    if (i <= 0) continue;
    const key = raw.slice(0, i).trim();
    const val = raw.slice(i + 1).trim();
    if (!key || !val) continue;
    out[key] = val;
  }
  return out;
}

export async function getConfiguredSiteDnsHostname(): Promise<
  string | undefined
> {
  const settings = await getServerSettings();
  return normalizeHostname(settings.dns);
}

function deriveBrowserCookieDomain(
  site: string | undefined,
): string | undefined {
  if (!site || site === "localhost" || looksLikeIp(site)) {
    return;
  }
  const parts = site.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return site;
  }
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (last.length === 2 && secondLast.length <= 3) {
      return parts.slice(-3).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

export function deriveBayHostnameFromSiteDns({
  bay_id,
  site_hostname,
}: {
  bay_id: string;
  site_hostname?: string;
}): string | undefined {
  const site = normalizeHostname(site_hostname);
  const bay = trim(bay_id).toLowerCase();
  if (!site || !bay) return;
  return `${bay}-${site}`;
}

function defaultSchemeForHostname(hostname: string): "http" | "https" {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
    ? "http"
    : "https";
}

function isPublicHostname(hostname: string | undefined): boolean {
  return !!hostname && hostname !== "localhost" && !looksLikeIp(hostname);
}

function isUsablePublicOrigin(origin: string | undefined): boolean {
  return isPublicHostname(normalizeHostname(origin));
}

function originFromRegistryEntry(entry: {
  public_origin?: string | null;
  dns_hostname?: string | null;
}): string | undefined {
  const registryOrigin = normalizeOrigin(entry?.public_origin);
  if (isUsablePublicOrigin(registryOrigin)) {
    return registryOrigin;
  }
  const hostname = normalizeHostname(entry?.dns_hostname);
  if (!hostname || !isPublicHostname(hostname)) {
    return;
  }
  return `${defaultSchemeForHostname(hostname)}://${hostname}`;
}

async function getBayPublicOriginFromRegistry(
  bay_id: string,
): Promise<string | undefined> {
  try {
    const mod = (await import("./bay-registry")) as {
      listClusterBayRegistry?: () => Promise<
        {
          bay_id?: string | null;
          public_origin?: string | null;
          dns_hostname?: string | null;
        }[]
      >;
    };
    const entries = await mod.listClusterBayRegistry?.();
    const entry = entries?.find(
      (candidate) => trim(candidate?.bay_id) === bay_id,
    );
    if (!entry) return;
    return originFromRegistryEntry(entry);
  } catch {
    return;
  }
}

export async function getBayPublicOrigin(
  bay_id: string,
): Promise<string | undefined> {
  const requested = trim(bay_id);
  if (!requested) return;
  const explicitCurrent = normalizeOrigin(process.env.COCALC_BAY_PUBLIC_URL);
  if (
    requested === getConfiguredBayId() &&
    isUsablePublicOrigin(explicitCurrent)
  ) {
    return explicitCurrent;
  }
  const explicitCluster = parseKeyValueMapping(
    process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS ??
      process.env.HUB_CLUSTER_BAY_PUBLIC_URLS,
  );
  const explicit = normalizeOrigin(explicitCluster[requested]);
  if (isUsablePublicOrigin(explicit)) {
    return explicit;
  }
  if (requested === getConfiguredClusterSeedBayId()) {
    const siteOrigin = await getSitePublicOrigin();
    if (siteOrigin) {
      return siteOrigin;
    }
  }
  const registryOrigin = await getBayPublicOriginFromRegistry(requested);
  if (registryOrigin) {
    return registryOrigin;
  }
  const site = await getConfiguredSiteDnsHostname();
  const hostname = deriveBayHostnameFromSiteDns({
    bay_id: requested,
    site_hostname: site,
  });
  if (!hostname) return;
  return `${defaultSchemeForHostname(hostname)}://${hostname}`;
}

export async function getDerivedBayPublicHostname(
  bay_id: string,
): Promise<string | undefined> {
  return deriveBayHostnameFromSiteDns({
    bay_id,
    site_hostname: await getConfiguredSiteDnsHostname(),
  });
}

export async function getClusterBayPublicOrigins(): Promise<
  Record<string, string>
> {
  const result: Record<string, string> = {};
  for (const bay_id of getConfiguredClusterBayIdsForStaticEnumerationOnly()) {
    const origin = await getBayPublicOrigin(bay_id);
    if (origin) {
      result[bay_id] = origin;
    }
  }
  try {
    const mod = (await import("./bay-registry")) as {
      listClusterBayRegistry?: () => Promise<
        {
          bay_id?: string | null;
          public_origin?: string | null;
          dns_hostname?: string | null;
        }[]
      >;
    };
    const entries = await mod.listClusterBayRegistry?.();
    for (const entry of entries ?? []) {
      const bay_id = trim(entry?.bay_id);
      const origin = originFromRegistryEntry(entry);
      if (!bay_id || !origin || !isUsablePublicOrigin(origin)) continue;
      result[bay_id] = origin;
    }
  } catch {
    // Keep CORS/origin checks best-effort. Static config is still enough for
    // simpler deployments, and registry access can fail transiently on attached
    // bays during startup.
  }
  return result;
}

export async function getSitePublicOrigin(): Promise<string | undefined> {
  const site = await getConfiguredSiteDnsHostname();
  if (!site) return;
  return `${defaultSchemeForHostname(site)}://${site}`;
}

export async function getSitePublicOriginForRequest(
  req?: Request,
): Promise<string | undefined> {
  const configured = await getSitePublicOrigin();
  if (configured) return configured;
  if (!req) return;
  const request_origin = detectRequestOrigin(req);
  if (!request_origin) {
    return;
  }
  const site_hostname = deriveSiteHostnameFromRequestOrigin({
    request_origin,
    current_bay_id: getConfiguredBayId(),
  });
  if (!site_hostname) {
    return request_origin;
  }
  const scheme = request_origin.startsWith("https://") ? "https" : "http";
  return `${scheme}://${site_hostname}`;
}

function looksLikeIp(hostname: string): boolean {
  return /^[0-9.]+$/.test(hostname) || hostname.includes(":");
}

// This is intentionally simple and deterministic. It is enough for the
// supported launchpad patterns:
//   - cocalc.com            -> cocalc.com
//   - lite4b.cocalc.ai      -> cocalc.ai
//   - launchpad.example.com -> example.com
// For exotic multi-level public suffixes, this can be refined later.
export async function getBrowserCookieDomain(): Promise<string | undefined> {
  return deriveBrowserCookieDomain(await getConfiguredSiteDnsHostname());
}

export async function getBrowserCookieDomainForRequest(
  req?: Request,
): Promise<string | undefined> {
  const configured = await getBrowserCookieDomain();
  if (configured) return configured;
  if (!req) return;
  const request_origin = detectRequestOrigin(req);
  const site_hostname = deriveSiteHostnameFromRequestOrigin({
    request_origin,
    current_bay_id: getConfiguredBayId(),
  });
  return deriveBrowserCookieDomain(site_hostname);
}

export function detectRequestOrigin(req: Request): string | undefined {
  const xfProto = trim(req.headers["x-forwarded-proto"]).split(",")[0];
  const xfHost = trim(req.headers["x-forwarded-host"]).split(",")[0];
  const host = xfHost || trim(req.headers.host);
  const proto =
    xfProto ||
    (req.protocol === "https" ? "https" : req.secure ? "https" : "http");
  const hostname = normalizeHostname(host);
  if (!hostname) return;
  const rawHost = trim(host);
  const withPort =
    rawHost && !rawHost.startsWith(hostname) ? rawHost : rawHost || hostname;
  return normalizeOrigin(`${proto}://${withPort}`);
}

function deriveSiteHostnameFromRequestOrigin(opts: {
  request_origin?: string;
  current_bay_id: string;
}): string | undefined {
  const hostname = normalizeHostname(opts.request_origin);
  if (!hostname) return;
  const currentBay = trim(opts.current_bay_id).toLowerCase();
  const prefix = currentBay ? `${currentBay}-` : "";
  if (
    prefix &&
    hostname.startsWith(prefix) &&
    hostname.length > prefix.length
  ) {
    return hostname.slice(prefix.length);
  }
  return hostname;
}

export async function getCurrentBayPublicOriginForRequest(
  req?: Request,
): Promise<string | undefined> {
  const configured = await getBayPublicOrigin(getConfiguredBayId());
  if (configured) return configured;
  if (req) return detectRequestOrigin(req);
  return;
}

export async function getBayPublicOriginForRequest(
  req: Request | undefined,
  bay_id: string,
): Promise<string | undefined> {
  const requested = trim(bay_id);
  if (!requested) return;
  const configured = await getBayPublicOrigin(requested);
  if (configured) {
    return configured;
  }
  const request_origin = detectRequestOrigin(req as Request);
  if (!request_origin) {
    return;
  }
  if (requested === getConfiguredBayId()) {
    return request_origin;
  }
  const site_hostname = deriveSiteHostnameFromRequestOrigin({
    request_origin,
    current_bay_id: getConfiguredBayId(),
  });
  const hostname = deriveBayHostnameFromSiteDns({
    bay_id: requested,
    site_hostname,
  });
  if (!hostname) {
    return;
  }
  const scheme = request_origin.startsWith("https://") ? "https" : "http";
  return `${scheme}://${hostname}`;
}

export function getCurrentBayPublicTarget(): string | undefined {
  const explicit = normalizeHostname(
    process.env.COCALC_BAY_PUBLIC_TARGET ??
      process.env.COCALC_BAY_PUBLIC_DNS_TARGET,
  );
  if (explicit) return explicit;
  const fromPublicUrl = normalizeHostname(process.env.COCALC_BAY_PUBLIC_URL);
  if (fromPublicUrl?.endsWith(".cfargotunnel.com")) {
    return fromPublicUrl;
  }
  return;
}

export function detectSignupRegionHint(req: Request): string | undefined {
  const candidates = [
    req.headers["cf-region-code"],
    req.headers["cf-region"],
    req.headers["cf-ipcountry"],
    req.headers["x-cocalc-region"],
  ];
  for (const value of candidates) {
    const v = trim(Array.isArray(value) ? value[0] : value).toLowerCase();
    if (v) return v;
  }
}

export async function isAllowedBrowserOrigin(
  origin: string | undefined,
): Promise<boolean> {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const site = await getSitePublicOrigin();
  if (site && normalized === site) return true;
  const cluster = await getClusterBayPublicOrigins();
  return Object.values(cluster).includes(normalized);
}

export async function applyBrowserCors(
  req: Request,
  res: Response,
): Promise<void> {
  const origin = trim(req.headers.origin);
  if (!(await isAllowedBrowserOrigin(origin))) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}
