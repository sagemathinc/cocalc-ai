/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import LRU from "lru-cache";
import getPool from "@cocalc/database/pool";
import siteUrl from "@cocalc/database/settings/site-url";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  deleteAppSubdomainDns,
  ensureAppSubdomainDns,
  hasDns,
} from "@cocalc/server/cloud/dns";
import { isLaunchpadProduct } from "@cocalc/server/launchpad/mode";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";

const TABLE = "project_app_public_subdomains";
const HOST_CACHE_TTL_MS = 30_000;
const hostCache = new LRU<string, PublicAppRouteTarget | null>({
  max: 20_000,
  ttl: HOST_CACHE_TTL_MS,
});

export interface PublicAppRouteTarget {
  project_id: string;
  app_id: string;
  base_path: string;
}

export interface ProjectAppPublicPolicy {
  enabled: boolean;
  launchpad: boolean;
  site_hostname?: string;
  dns_domain?: string;
  subdomain_suffix: string;
  provider?: string;
  metered_egress: boolean;
  warnings: string[];
}

export interface ReserveProjectAppPublicSubdomainResult {
  hostname: string;
  label: string;
  base_path: string;
  url_public: string;
  warnings: string[];
}

const ensureSchema = reuseInFlight(async () => {
  const pool = getPool();
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        project_id UUID NOT NULL,
        app_id TEXT NOT NULL,
        label TEXT NOT NULL,
        hostname TEXT NOT NULL,
        base_path TEXT NOT NULL,
        ttl_s INTEGER NOT NULL,
        dns_record_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, app_id),
        UNIQUE (hostname)
      )
    `,
  );
}, { createKey: () => "schema" });

function normalizeBasePath(value: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function normalizeLabel(raw?: string): string | undefined {
  const v = `${raw ?? ""}`.trim().toLowerCase();
  if (!v) return;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(v)) {
    throw new Error(
      "subdomain label must be 1-48 chars of lowercase letters, digits, and '-', and must start/end with alphanumeric",
    );
  }
  return v;
}

function normalizeSuffix(raw?: string): string {
  const v = `${raw ?? ""}`.trim().toLowerCase();
  if (!v) return "app";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,20}[a-z0-9])?$/.test(v)) {
    return "app";
  }
  return v;
}

function randomLabel(): string {
  // 40 bits entropy, short and URL-safe.
  return randomBytes(5).toString("hex");
}

function normalizeHostHeader(host?: string): string {
  const raw = `${host ?? ""}`.trim().toLowerCase();
  if (!raw) return "";
  return raw.split(":")[0] ?? "";
}

function buildHostname({
  label,
  suffix,
  dns_domain,
}: {
  label: string;
  suffix: string;
  dns_domain: string;
}): string {
  return suffix ? `${label}-${suffix}.${dns_domain}` : `${label}.${dns_domain}`;
}

async function getProjectHostCloudProvider(project_id: string): Promise<string | undefined> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      SELECT project_hosts.metadata AS metadata
      FROM projects
      LEFT JOIN project_hosts ON project_hosts.id = projects.host_id
      WHERE projects.project_id=$1
    `,
    [project_id],
  );
  const metadata = rows[0]?.metadata;
  const provider = `${metadata?.machine?.cloud ?? ""}`.trim().toLowerCase();
  return provider || undefined;
}

function resolveMetered(provider?: string): boolean {
  return provider === "google-cloud";
}

export async function getProjectAppPublicPolicy(
  project_id: string,
): Promise<ProjectAppPublicPolicy> {
  const warnings: string[] = [];
  const launchpad = isLaunchpadProduct();
  if (!launchpad) {
    return {
      enabled: false,
      launchpad: false,
      subdomain_suffix: "app",
      metered_egress: false,
      warnings: ["public app subdomains are only supported in launchpad mode"],
    };
  }
  const settings = await getServerSettings();
  const dns_domain = `${settings.project_hosts_dns ?? ""}`.trim().toLowerCase();
  const suffix = normalizeSuffix(
    settings.project_hosts_app_public_subdomain_suffix as string | undefined,
  );
  const hasCloudflareDns = await hasDns();
  let site_hostname = "";
  try {
    site_hostname = new URL(await siteUrl()).hostname.toLowerCase();
  } catch {
    site_hostname = "";
  }

  const provider = await getProjectHostCloudProvider(project_id);
  const metered_egress = resolveMetered(provider);
  if (metered_egress) {
    warnings.push(
      "Metered egress host detected (google-cloud). Use Cloudflare caching and short TTL unless traffic is expected.",
    );
  }
  if (!hasCloudflareDns) {
    warnings.push("Cloudflare DNS automation is not configured on this server.");
  }
  if (!dns_domain) {
    warnings.push("Project Hosts domain is not configured.");
  }
  if (!site_hostname) {
    warnings.push("Public site URL is not configured.");
  }
  return {
    enabled: hasCloudflareDns && !!dns_domain && !!site_hostname,
    launchpad: true,
    site_hostname: site_hostname || undefined,
    dns_domain: dns_domain || undefined,
    subdomain_suffix: suffix,
    provider,
    metered_egress,
    warnings,
  };
}

async function reserveWithLabel(opts: {
  project_id: string;
  app_id: string;
  base_path: string;
  ttl_s: number;
  label: string;
  hostname: string;
}): Promise<{
  hostname: string;
  label: string;
  base_path: string;
  ttl_s: number;
  previous?: { hostname?: string; dns_record_id?: string };
  dns_record_id?: string;
}> {
  const pool = getPool();
  const current = await pool.query(
    `SELECT hostname, dns_record_id FROM ${TABLE} WHERE project_id=$1 AND app_id=$2`,
    [opts.project_id, opts.app_id],
  );
  const previous = current.rows[0] as
    | { hostname?: string; dns_record_id?: string }
    | undefined;
  const { rows } = await pool.query(
    `
      INSERT INTO ${TABLE}
        (project_id, app_id, label, hostname, base_path, ttl_s, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (project_id, app_id)
      DO UPDATE SET
        label=EXCLUDED.label,
        hostname=EXCLUDED.hostname,
        base_path=EXCLUDED.base_path,
        ttl_s=EXCLUDED.ttl_s,
        updated_at=NOW()
      RETURNING hostname, label, base_path, ttl_s, dns_record_id
    `,
    [
      opts.project_id,
      opts.app_id,
      opts.label,
      opts.hostname,
      opts.base_path,
      opts.ttl_s,
    ],
  );
  const row = rows[0];
  return {
    hostname: row.hostname,
    label: row.label,
    base_path: row.base_path,
    ttl_s: row.ttl_s,
    dns_record_id: row.dns_record_id ?? undefined,
    previous,
  };
}

export async function reserveProjectAppPublicSubdomain(opts: {
  project_id: string;
  app_id: string;
  base_path: string;
  ttl_s: number;
  preferred_label?: string;
  random_subdomain?: boolean;
}): Promise<ReserveProjectAppPublicSubdomainResult> {
  await ensureSchema();
  const project_id = `${opts.project_id ?? ""}`.trim();
  const app_id = `${opts.app_id ?? ""}`.trim();
  if (!project_id) throw new Error("project_id required");
  if (!app_id) throw new Error("app_id required");
  const base_path = normalizeBasePath(opts.base_path);
  const ttl_s = Math.max(60, Math.floor(Number(opts.ttl_s) || 0));

  const policy = await getProjectAppPublicPolicy(project_id);
  if (!policy.enabled || !policy.dns_domain || !policy.site_hostname) {
    throw new Error(
      policy.warnings[0] ??
        "public app subdomains are not available; cloudflare dns and public site url are required",
    );
  }

  const explicitLabel = normalizeLabel(opts.preferred_label);
  const randomEnabled = opts.random_subdomain !== false;
  let reserved:
    | {
        hostname: string;
        label: string;
        base_path: string;
        ttl_s: number;
        previous?: { hostname?: string; dns_record_id?: string };
        dns_record_id?: string;
      }
    | undefined;

  if (explicitLabel) {
    const hostname = buildHostname({
      label: explicitLabel,
      suffix: policy.subdomain_suffix,
      dns_domain: policy.dns_domain,
    });
    try {
      reserved = await reserveWithLabel({
        project_id,
        app_id,
        base_path,
        ttl_s,
        label: explicitLabel,
        hostname,
      });
    } catch (err: any) {
      if (`${err?.code ?? ""}` === "23505") {
        throw new Error(`subdomain label '${explicitLabel}' is already in use`);
      }
      throw err;
    }
  } else {
    const maxAttempts = randomEnabled ? 16 : 1;
    let lastErr: any;
    for (let i = 0; i < maxAttempts; i++) {
      const fallbackLabel = normalizeLabel(app_id);
      if (!randomEnabled && !fallbackLabel) {
        throw new Error(
          "app_id is not a valid subdomain label; use --subdomain-label or enable random subdomain",
        );
      }
      const label = randomEnabled ? randomLabel() : fallbackLabel!;
      const hostname = buildHostname({
        label,
        suffix: policy.subdomain_suffix,
        dns_domain: policy.dns_domain,
      });
      try {
        reserved = await reserveWithLabel({
          project_id,
          app_id,
          base_path,
          ttl_s,
          label,
          hostname,
        });
        break;
      } catch (err: any) {
        // unique violation on hostname collision; retry random labels.
        if (`${err?.code ?? ""}` !== "23505") {
          throw err;
        }
        lastErr = err;
      }
    }
    if (!reserved) {
      throw lastErr ?? new Error("failed to allocate random app subdomain");
    }
  }

  const dns = await ensureAppSubdomainDns({
    hostname: reserved.hostname,
    target_hostname: policy.site_hostname,
    record_id: reserved.dns_record_id,
  });

  const pool = getPool();
  await pool.query(
    `UPDATE ${TABLE} SET dns_record_id=$3, updated_at=NOW() WHERE project_id=$1 AND app_id=$2`,
    [project_id, app_id, dns.record_id],
  );
  if (reserved.previous?.hostname && reserved.previous.hostname !== reserved.hostname) {
    await deleteAppSubdomainDns({ record_id: reserved.previous.dns_record_id });
  }
  hostCache.delete(reserved.hostname.toLowerCase());
  if (reserved.previous?.hostname) {
    hostCache.delete(reserved.previous.hostname.toLowerCase());
  }
  return {
    hostname: reserved.hostname,
    label: reserved.label,
    base_path,
    url_public: `https://${reserved.hostname}`,
    warnings: policy.warnings,
  };
}

export async function releaseProjectAppPublicSubdomain(opts: {
  project_id: string;
  app_id: string;
}): Promise<{ released: boolean }> {
  await ensureSchema();
  const project_id = `${opts.project_id ?? ""}`.trim();
  const app_id = `${opts.app_id ?? ""}`.trim();
  if (!project_id || !app_id) return { released: false };
  const pool = getPool();
  const { rows } = await pool.query(
    `
      DELETE FROM ${TABLE}
      WHERE project_id=$1 AND app_id=$2
      RETURNING hostname, dns_record_id
    `,
    [project_id, app_id],
  );
  const row = rows[0];
  if (!row) return { released: false };
  await deleteAppSubdomainDns({ record_id: row.dns_record_id ?? undefined });
  hostCache.delete(`${row.hostname ?? ""}`.toLowerCase());
  return { released: true };
}

export async function getPublicAppRouteByHostname(
  hostnameRaw: string,
): Promise<PublicAppRouteTarget | undefined> {
  await ensureSchema();
  const hostname = normalizeHostHeader(hostnameRaw);
  if (!hostname) return;
  if (hostCache.has(hostname)) {
    return hostCache.get(hostname) ?? undefined;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    `
      SELECT project_id, app_id, base_path
      FROM ${TABLE}
      WHERE LOWER(hostname)=LOWER($1)
      LIMIT 1
    `,
    [hostname],
  );
  const row = rows[0] as
    | { project_id: string; app_id: string; base_path: string }
    | undefined;
  const value = row
    ? {
        project_id: row.project_id,
        app_id: row.app_id,
        base_path: normalizeBasePath(row.base_path),
      }
    : undefined;
  hostCache.set(hostname, value ?? null);
  return value;
}
