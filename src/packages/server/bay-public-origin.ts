/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterBayIds } from "@cocalc/server/cluster-config";
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

async function getConfiguredSiteDnsHostname(): Promise<string | undefined> {
  const settings = await getServerSettings();
  return normalizeHostname(settings.dns);
}

function deriveBayHostnameFromSiteDns({
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

export async function getBayPublicOrigin(
  bay_id: string,
): Promise<string | undefined> {
  const requested = trim(bay_id);
  if (!requested) return;
  const explicitCurrent = normalizeOrigin(process.env.COCALC_BAY_PUBLIC_URL);
  if (requested === getConfiguredBayId() && explicitCurrent) {
    return explicitCurrent;
  }
  const explicitCluster = parseKeyValueMapping(
    process.env.COCALC_CLUSTER_BAY_PUBLIC_URLS ??
      process.env.HUB_CLUSTER_BAY_PUBLIC_URLS,
  );
  const explicit = normalizeOrigin(explicitCluster[requested]);
  if (explicit) {
    return explicit;
  }
  const site = await getConfiguredSiteDnsHostname();
  const hostname = deriveBayHostnameFromSiteDns({
    bay_id: requested,
    site_hostname: site,
  });
  if (!hostname) return;
  return `${defaultSchemeForHostname(hostname)}://${hostname}`;
}

export async function getClusterBayPublicOrigins(): Promise<
  Record<string, string>
> {
  const result: Record<string, string> = {};
  for (const bay_id of getConfiguredClusterBayIds()) {
    const origin = await getBayPublicOrigin(bay_id);
    if (origin) {
      result[bay_id] = origin;
    }
  }
  return result;
}

export async function getSitePublicOrigin(): Promise<string | undefined> {
  const site = await getConfiguredSiteDnsHostname();
  if (!site) return;
  return `${defaultSchemeForHostname(site)}://${site}`;
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
  const site = await getConfiguredSiteDnsHostname();
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

export async function getCurrentBayPublicOriginForRequest(
  req?: Request,
): Promise<string | undefined> {
  const configured = await getBayPublicOrigin(getConfiguredBayId());
  if (configured) return configured;
  if (req) return detectRequestOrigin(req);
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
