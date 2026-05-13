/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "crypto";

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { deleteR2ObjectsConcurrently, scanR2Objects } from "@cocalc/backend/r2";
import { listBuckets as listR2Buckets } from "@cocalc/server/project-backup/r2";
import { updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  getR2S3Auth,
  getCachedCloudflareR2Audit,
  type CloudflareR2AuditResult,
} from "@cocalc/server/cloud/cloudflare-r2-usage";

const TABLE = "cloudflare_teardown_plans";
const PLAN_TTL_MS = 10 * 60 * 1000;
const R2_AUDIT_CACHE_MAX_AGE_MINUTES = 24 * 60;
const R2_DELETE_PROGRESS_INTERVAL_MS = 2000;
const R2_DELETE_CONCURRENCY = 32;

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
  result_info?: {
    page?: number;
    total_pages?: number;
  };
};

type CloudflareTunnelRow = {
  id?: string;
  name?: string;
  deleted_at?: string | null;
};

type CloudflareDnsRecord = {
  id?: string;
  name?: string;
  type?: string;
  content?: string;
  proxied?: boolean;
};

type Zone = {
  id?: string;
  name?: string;
  account?: { id?: string; name?: string };
};

export type CloudflareTeardownClassification =
  | "safe_owned"
  | "probably_owned"
  | "unknown"
  | "protected";

export type CloudflareTeardownResource = {
  kind: "tunnel" | "dns_record" | "r2_bucket" | "api_token";
  classification: CloudflareTeardownClassification;
  id?: string;
  name?: string;
  reason: string;
  details?: Record<string, unknown>;
};

export type CloudflareTeardownPlanSummary = {
  plan_id: string;
  status: string;
  include_r2: boolean;
  expires_at: string;
  confirmation_text: string;
  cloudflare_account_id?: string;
  zone_id?: string;
  zone_name?: string;
  selected: {
    tunnels: number;
    dns_records: number;
    r2_buckets: number;
    api_tokens: number;
  };
  counts: {
    active_projects: number;
    archived_project_candidates: number;
    projects_with_backups: number;
    r2_bucket_records: number;
    cloudflare_r2_buckets: number;
    r2_buckets_with_usage?: number;
    r2_buckets_missing_usage?: number;
    r2_objects?: number;
    r2_total_bytes?: number;
  };
  warnings: string[];
  notes: string[];
};

export type CloudflareTeardownPlan = {
  id: string;
  account_id: string;
  cloudflare_account_id?: string;
  zone_id?: string;
  zone_name?: string;
  status: string;
  include_r2: boolean;
  plan_json: {
    resources: CloudflareTeardownResource[];
    counts: CloudflareTeardownPlanSummary["counts"];
    warnings: string[];
    notes: string[];
  };
  confirmation_text: string;
  created_at: string;
  expires_at: string;
  applied_at?: string;
  summary: CloudflareTeardownPlanSummary;
};

export type CloudflareTeardownApplyAction = {
  kind: CloudflareTeardownResource["kind"];
  id?: string;
  name?: string;
  status: "deleted" | "skipped" | "failed";
  reason?: string;
  error?: string;
};

export type CloudflareTeardownApplyProgress = {
  phase:
    | "starting"
    | "deleting_dns"
    | "deleting_tunnels"
    | "deleting_r2_objects"
    | "deleting_r2_buckets"
    | "done";
  plan_id: string;
  deleted_dns_records: number;
  total_dns_records: number;
  deleted_tunnels: number;
  total_tunnels: number;
  skipped_r2_buckets: number;
  deleted_r2_objects: number;
  total_r2_objects: number;
  deleted_r2_bytes: number;
  total_r2_bytes: number;
  deleted_r2_buckets: number;
  total_r2_buckets: number;
  current_r2_bucket?: string;
  message: string;
};

export type CloudflareTeardownApplyResult = {
  plan_id: string;
  applied_at: string;
  actions: CloudflareTeardownApplyAction[];
  deleted_dns_records: number;
  deleted_tunnels: number;
  skipped_r2_buckets: number;
  deleted_r2_objects: number;
  deleted_r2_bytes: number;
  deleted_r2_buckets: number;
  notes: string[];
};

type KnownTunnel = {
  source: string;
  id?: string;
  name?: string;
  hostname?: string;
  record_id?: string;
  ssh_record_id?: string;
};

function pool() {
  return getPool();
}

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = `${value}`.trim();
  return trimmed || undefined;
}

function normalizeHostname(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let host = raw.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("http://") || host.startsWith("https://")) {
    host = new URL(host).hostname;
  }
  return host.split("/")[0].split(":")[0].replace(/\.+$/, "") || undefined;
}

async function ensureTable(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      cloudflare_account_id TEXT,
      zone_id TEXT,
      zone_name TEXT,
      status TEXT NOT NULL,
      include_r2 BOOLEAN NOT NULL DEFAULT FALSE,
      plan_json JSONB NOT NULL,
      confirmation_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ,
      applied_by UUID,
      apply_lro_id UUID
    )
  `);
  await pool().query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_account_created_idx ON ${TABLE} (account_id, created_at DESC)`,
  );
  await pool().query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at)`,
  );
}

async function cloudflareRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  let payload: CloudflareResponse<T> | undefined;
  try {
    payload = (await response.json()) as CloudflareResponse<T>;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.success) {
    const details =
      payload?.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") ||
      `${response.status} ${response.statusText}`.trim() ||
      "unknown error";
    throw new Error(`cloudflare api failed: ${details}`);
  }
  return payload.result as T;
}

async function cloudflareDelete(token: string, path: string): Promise<void> {
  await cloudflareRequest<unknown>(token, path, { method: "DELETE" });
}

async function cloudflareListAll<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  while (page <= 50) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/${path}${separator}page=${page}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    const payload = (await response.json()) as CloudflareResponse<T[]>;
    if (!response.ok || !payload?.success) {
      const details =
        payload?.errors
          ?.map((err) => err.message)
          .filter(Boolean)
          .join(", ") ||
        `${response.status} ${response.statusText}`.trim() ||
        "unknown error";
      throw new Error(`cloudflare api failed: ${details}`);
    }
    out.push(...(payload.result ?? []));
    const totalPages = payload.result_info?.total_pages ?? page;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

function zoneCandidates(hostname: string): string[] {
  const parts = hostname.split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(parts.slice(i).join("."));
  }
  return candidates;
}

async function lookupZone(opts: {
  token?: string;
  zoneName?: string;
  hostname?: string;
}): Promise<Zone | undefined> {
  if (!opts.token) return undefined;
  const candidates = [
    clean(opts.zoneName)?.toLowerCase(),
    ...(opts.hostname ? zoneCandidates(opts.hostname) : []),
  ].filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i);
  for (const candidate of candidates) {
    try {
      const qs = new URLSearchParams({ name: candidate });
      const zones = await cloudflareRequest<Zone[]>(
        opts.token,
        `zones?${qs.toString()}`,
      );
      const zone = zones.find((z) => z.name === candidate);
      if (zone?.id) return zone;
    } catch {
      // Try the next candidate; the final plan notes the missing zone.
    }
  }
  return undefined;
}

async function listCloudflareTunnels(opts: {
  token?: string;
  accountId?: string;
}): Promise<{ rows: CloudflareTunnelRow[]; error?: string }> {
  if (!opts.token || !opts.accountId) return { rows: [] };
  try {
    const qs = new URLSearchParams({ per_page: "100" });
    const rows = await cloudflareListAll<CloudflareTunnelRow>(
      opts.token,
      `accounts/${opts.accountId}/cfd_tunnel?${qs.toString()}`,
    );
    return { rows: rows.filter((row) => !row.deleted_at) };
  } catch (err) {
    return { rows: [], error: `${err}` };
  }
}

async function listDnsRecords(opts: {
  token?: string;
  zoneId?: string;
}): Promise<{ rows: CloudflareDnsRecord[]; error?: string }> {
  if (!opts.token || !opts.zoneId) return { rows: [] };
  try {
    const qs = new URLSearchParams({ per_page: "100", type: "CNAME" });
    const rows = await cloudflareListAll<CloudflareDnsRecord>(
      opts.token,
      `zones/${opts.zoneId}/dns_records?${qs.toString()}`,
    );
    return { rows };
  } catch (err) {
    return { rows: [], error: `${err}` };
  }
}

async function listKnownTunnels(): Promise<KnownTunnel[]> {
  const { rows } = await pool().query<{
    id: string;
    name: string | null;
    metadata: any;
  }>(
    `SELECT id, name, metadata
       FROM project_hosts
      WHERE deleted IS NULL
        AND metadata ? 'cloudflare_tunnel'`,
  );
  return rows
    .map((row) => {
      const tunnel = row.metadata?.cloudflare_tunnel ?? {};
      return {
        source: `project_host:${row.id}`,
        id: clean(tunnel.id),
        name: clean(tunnel.name),
        hostname: clean(tunnel.hostname),
        record_id: clean(tunnel.record_id),
        ssh_record_id: clean(tunnel.ssh_record_id),
      };
    })
    .filter((tunnel) => tunnel.id || tunnel.record_id || tunnel.ssh_record_id);
}

async function getProjectCounts(): Promise<
  CloudflareTeardownPlanSummary["counts"]
> {
  const { rows } = await pool().query<{
    active_projects: number;
    archived_project_candidates: number;
    projects_with_backups: number;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE deleted IS NOT TRUE AND host_id IS NOT NULL)::INTEGER AS active_projects,
      COUNT(*) FILTER (WHERE deleted IS NOT TRUE AND host_id IS NULL AND last_backup IS NOT NULL)::INTEGER AS archived_project_candidates,
      COUNT(*) FILTER (WHERE deleted IS NOT TRUE AND last_backup IS NOT NULL)::INTEGER AS projects_with_backups
    FROM projects
  `);
  const bucketRows = await pool().query<{
    r2_bucket_records: number;
  }>(
    "SELECT COUNT(*)::INTEGER AS r2_bucket_records FROM buckets WHERE provider ILIKE '%r2%' OR provider ILIKE '%cloudflare%'",
  );
  return {
    active_projects: rows[0]?.active_projects ?? 0,
    archived_project_candidates: rows[0]?.archived_project_candidates ?? 0,
    projects_with_backups: rows[0]?.projects_with_backups ?? 0,
    r2_bucket_records: bucketRows.rows[0]?.r2_bucket_records ?? 0,
    cloudflare_r2_buckets: 0,
  };
}

async function listR2BucketNames(opts: {
  token?: string;
  accountId?: string;
}): Promise<{ names: string[]; error?: string }> {
  if (!opts.token || !opts.accountId) return { names: [] };
  try {
    return {
      names: await listR2Buckets(opts.token, opts.accountId),
    };
  } catch (err) {
    return { names: [], error: `${err}` };
  }
}

function classifyTunnels(opts: {
  cloudflareRows: CloudflareTunnelRow[];
  known: KnownTunnel[];
  prefix?: string;
}): CloudflareTeardownResource[] {
  const knownById = new Map(opts.known.map((tunnel) => [tunnel.id, tunnel]));
  const prefix = clean(opts.prefix) ?? "cocalc";
  return opts.cloudflareRows.map((tunnel) => {
    const known = tunnel.id ? knownById.get(tunnel.id) : undefined;
    if (known) {
      return {
        kind: "tunnel",
        classification: "safe_owned",
        id: tunnel.id,
        name: tunnel.name,
        reason: `referenced by ${known.source}`,
      };
    }
    if (tunnel.name?.startsWith(`${prefix}-`)) {
      return {
        kind: "tunnel",
        classification: "probably_owned",
        id: tunnel.id,
        name: tunnel.name,
        reason: `name starts with configured CoCalc prefix '${prefix}-'`,
      };
    }
    return {
      kind: "tunnel",
      classification: "unknown",
      id: tunnel.id,
      name: tunnel.name,
      reason: "not referenced by CoCalc metadata",
    };
  });
}

function classifyDnsRecords(opts: {
  records: CloudflareDnsRecord[];
  known: KnownTunnel[];
  hostSuffix?: string;
}): CloudflareTeardownResource[] {
  const knownRecordIds = new Set(
    opts.known.flatMap((tunnel) =>
      [tunnel.record_id, tunnel.ssh_record_id].filter(Boolean),
    ),
  );
  const suffix = clean(opts.hostSuffix);
  return opts.records.map((record) => {
    if (record.id && knownRecordIds.has(record.id)) {
      return {
        kind: "dns_record",
        classification: "safe_owned",
        id: record.id,
        name: record.name,
        reason: "record id is referenced by CoCalc tunnel metadata",
        details: { content: record.content, type: record.type },
      };
    }
    if (
      record.type === "CNAME" &&
      record.content?.endsWith(".cfargotunnel.com") &&
      (!suffix || record.name?.endsWith(suffix.replace(/^[.-]/, ".")))
    ) {
      return {
        kind: "dns_record",
        classification: "probably_owned",
        id: record.id,
        name: record.name,
        reason: "CNAME points at a Cloudflare tunnel and matches host suffix",
        details: { content: record.content, type: record.type },
      };
    }
    return {
      kind: "dns_record",
      classification: "unknown",
      id: record.id,
      name: record.name,
      reason: "not referenced by CoCalc tunnel metadata",
      details: { content: record.content, type: record.type },
    };
  });
}

async function classifyR2Buckets(opts: {
  names: string[];
  includeR2: boolean;
  bucketPrefix?: string;
  warnings: string[];
}): Promise<CloudflareTeardownResource[]> {
  if (!opts.includeR2) return [];
  const dbBuckets = await pool().query<{ name: string }>(
    "SELECT name FROM buckets WHERE provider ILIKE '%r2%' OR provider ILIKE '%cloudflare%'",
  );
  const known = new Set(dbBuckets.rows.map((row) => row.name));
  const prefix = clean(opts.bucketPrefix);
  const resources: CloudflareTeardownResource[] = [];
  for (const name of opts.names) {
    let audit: CloudflareR2AuditResult | undefined;
    try {
      audit = await getCachedCloudflareR2Audit({
        bucket: name,
        max_age_minutes: R2_AUDIT_CACHE_MAX_AGE_MINUTES,
      });
    } catch (err) {
      opts.warnings.push(`could not read R2 audit cache for '${name}': ${err}`);
    }
    const details = audit ? r2AuditDetails(audit) : { usage_cache: "missing" };
    if (!audit) {
      opts.warnings.push(
        `no recent R2 audit cache for '${name}'; run 'cocalc cloudflare r2 audit ${name} --refresh' before full R2 teardown`,
      );
    }
    if (known.has(name)) {
      resources.push({
        kind: "r2_bucket",
        classification: "safe_owned",
        name,
        reason: "bucket is referenced by CoCalc bucket metadata",
        details,
      });
      continue;
    }
    if (prefix && name.startsWith(`${prefix}-`)) {
      resources.push({
        kind: "r2_bucket",
        classification: "probably_owned",
        name,
        reason: `bucket name starts with configured prefix '${prefix}-'`,
        details,
      });
      continue;
    }
    resources.push({
      kind: "r2_bucket",
      classification: "unknown",
      name,
      reason: "bucket is not referenced by CoCalc metadata",
      details,
    });
  }
  return resources;
}

function usageGroupObjects(group?: { object_count?: number }): number {
  return Number(group?.object_count ?? 0);
}

function usageGroupBytes(group?: { total_bytes?: number }): number {
  return Number(group?.total_bytes ?? 0);
}

function r2AuditDetails(
  audit: CloudflareR2AuditResult,
): Record<string, unknown> {
  const rusticRepos = audit.rustic_repos ?? [];
  return {
    usage_cache: audit.cache?.hit ? "hit" : "scan",
    scanned_at: audit.scanned_at,
    object_count: audit.object_count,
    total_bytes: audit.total_bytes,
    rustic_repos: rusticRepos.length,
    rustic_objects: rusticRepos.reduce(
      (total, repo) => total + usageGroupObjects(repo),
      0,
    ),
    rustic_total_bytes: rusticRepos.reduce(
      (total, repo) => total + usageGroupBytes(repo),
      0,
    ),
    project_backup_index_objects: usageGroupObjects(audit.project_backup_index),
    project_backup_index_bytes: usageGroupBytes(audit.project_backup_index),
    rootfs_image_objects: usageGroupObjects(audit.rootfs_images),
    rootfs_image_bytes: usageGroupBytes(audit.rootfs_images),
    bay_backup_objects: usageGroupObjects(audit.bay_backup_files),
    bay_backup_bytes: usageGroupBytes(audit.bay_backup_files),
    other_objects: usageGroupObjects(audit.other),
    other_bytes: usageGroupBytes(audit.other),
  };
}

function summarizePlan(args: {
  id: string;
  status: string;
  includeR2: boolean;
  expiresAt: Date;
  confirmationText: string;
  cloudflareAccountId?: string;
  zoneId?: string;
  zoneName?: string;
  resources: CloudflareTeardownResource[];
  counts: CloudflareTeardownPlanSummary["counts"];
  warnings: string[];
  notes: string[];
}): CloudflareTeardownPlanSummary {
  const safe = args.resources.filter(
    (resource) => resource.classification === "safe_owned",
  );
  const selectedOfKind = (kind: CloudflareTeardownResource["kind"]) =>
    safe.filter((resource) => resource.kind === kind).length;
  return {
    plan_id: args.id,
    status: args.status,
    include_r2: args.includeR2,
    expires_at: args.expiresAt.toISOString(),
    confirmation_text: args.confirmationText,
    cloudflare_account_id: args.cloudflareAccountId,
    zone_id: args.zoneId,
    zone_name: args.zoneName,
    selected: {
      tunnels: selectedOfKind("tunnel"),
      dns_records: selectedOfKind("dns_record"),
      r2_buckets: selectedOfKind("r2_bucket"),
      api_tokens: selectedOfKind("api_token"),
    },
    counts: args.counts,
    warnings: args.warnings,
    notes: args.notes,
  };
}

function confirmationText(summary: {
  tunnels: number;
  dns: number;
  r2: number;
}): string {
  return `delete ${summary.tunnels} tunnels, ${summary.dns} dns records, ${summary.r2} r2 buckets`;
}

function rowToPlan(row: any): CloudflareTeardownPlan {
  const planJson = row.plan_json ?? {};
  const expiresAt = new Date(row.expires_at);
  const summary = summarizePlan({
    id: row.id,
    status: row.status,
    includeR2: !!row.include_r2,
    expiresAt,
    confirmationText: row.confirmation_text,
    cloudflareAccountId: row.cloudflare_account_id ?? undefined,
    zoneId: row.zone_id ?? undefined,
    zoneName: row.zone_name ?? undefined,
    resources: planJson.resources ?? [],
    counts: planJson.counts ?? {
      active_projects: 0,
      archived_project_candidates: 0,
      projects_with_backups: 0,
      r2_bucket_records: 0,
      cloudflare_r2_buckets: 0,
      r2_buckets_with_usage: 0,
      r2_buckets_missing_usage: 0,
      r2_objects: 0,
      r2_total_bytes: 0,
    },
    warnings: planJson.warnings ?? [],
    notes: planJson.notes ?? [],
  });
  return {
    id: row.id,
    account_id: row.account_id,
    cloudflare_account_id: row.cloudflare_account_id ?? undefined,
    zone_id: row.zone_id ?? undefined,
    zone_name: row.zone_name ?? undefined,
    status: row.status,
    include_r2: !!row.include_r2,
    plan_json: planJson,
    confirmation_text: row.confirmation_text,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: expiresAt.toISOString(),
    applied_at: row.applied_at
      ? new Date(row.applied_at).toISOString()
      : undefined,
    summary,
  };
}

export async function createCloudflareTeardownPlan(opts: {
  account_id: string;
  include_r2?: boolean;
}): Promise<CloudflareTeardownPlan> {
  await ensureTable();
  const settings = await getServerSettings();
  const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
  const cloudflareAccountId = clean(
    settings.project_hosts_cloudflare_tunnel_account_id,
  );
  const zoneName = clean(settings.project_hosts_dns);
  const hostname = normalizeHostname(settings.dns);
  const includeR2 = !!opts.include_r2;
  const warnings: string[] = [];
  const notes: string[] = [
    "This is a read-only plan. It does not delete or modify Cloudflare resources.",
    "CoCalc local database rows and active project-host storage are not selected for deletion.",
  ];
  if (!token) warnings.push("missing Cloudflare tunnel API token");
  if (!cloudflareAccountId)
    warnings.push("missing Cloudflare tunnel account id");

  const zone = await lookupZone({ token, zoneName, hostname });
  if (!zone?.id) warnings.push("Cloudflare zone could not be resolved");

  const knownTunnels = await listKnownTunnels();
  const tunnels = await listCloudflareTunnels({
    token,
    accountId: cloudflareAccountId,
  });
  if (tunnels.error) warnings.push(`could not list tunnels: ${tunnels.error}`);

  const dnsRecords = await listDnsRecords({ token, zoneId: zone?.id });
  if (dnsRecords.error)
    warnings.push(`could not list DNS records: ${dnsRecords.error}`);

  const r2 = includeR2
    ? await listR2BucketNames({
        token: clean(settings.r2_api_token) ?? token,
        accountId: clean(settings.r2_account_id) ?? cloudflareAccountId,
      })
    : { names: [] as string[] };
  if (r2.error) warnings.push(`could not list R2 buckets: ${r2.error}`);

  const counts = await getProjectCounts();
  counts.cloudflare_r2_buckets = r2.names.length;

  const resources = [
    ...classifyTunnels({
      cloudflareRows: tunnels.rows,
      known: knownTunnels,
      prefix: clean(settings.project_hosts_cloudflare_tunnel_prefix),
    }),
    ...classifyDnsRecords({
      records: dnsRecords.rows,
      known: knownTunnels,
      hostSuffix: clean(settings.project_hosts_cloudflare_tunnel_host_suffix),
    }),
    ...(await classifyR2Buckets({
      names: r2.names,
      includeR2,
      bucketPrefix: clean(settings.r2_bucket_prefix),
      warnings,
    })),
  ];
  if (includeR2) {
    const r2Resources = resources.filter(
      (resource) => resource.kind === "r2_bucket",
    );
    counts.r2_buckets_with_usage = r2Resources.filter(
      (resource) => resource.details?.usage_cache !== "missing",
    ).length;
    counts.r2_buckets_missing_usage =
      r2Resources.length - counts.r2_buckets_with_usage;
    counts.r2_objects = r2Resources.reduce(
      (total, resource) => total + Number(resource.details?.object_count ?? 0),
      0,
    );
    counts.r2_total_bytes = r2Resources.reduce(
      (total, resource) => total + Number(resource.details?.total_bytes ?? 0),
      0,
    );
    notes.push(
      "R2 bucket usage comes from recent cached S3 audit data; missing buckets must be audited before full R2 teardown.",
    );
  }
  const safe = resources.filter(
    (resource) => resource.classification === "safe_owned",
  );
  const confirm = confirmationText({
    tunnels: safe.filter((resource) => resource.kind === "tunnel").length,
    dns: safe.filter((resource) => resource.kind === "dns_record").length,
    r2: safe.filter((resource) => resource.kind === "r2_bucket").length,
  });
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
  const planJson = { resources, counts, warnings, notes };
  const { rows } = await pool().query(
    `INSERT INTO ${TABLE}
       (id, account_id, cloudflare_account_id, zone_id, zone_name, status,
        include_r2, plan_json, confirmation_text, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     RETURNING *`,
    [
      id,
      opts.account_id,
      cloudflareAccountId ?? null,
      zone?.id ?? null,
      zone?.name ?? zoneName ?? null,
      "planned",
      includeR2,
      JSON.stringify(planJson),
      confirm,
      expiresAt,
    ],
  );
  return rowToPlan(rows[0]);
}

export async function getCloudflareTeardownPlan(opts: {
  account_id: string;
  plan_id: string;
}): Promise<CloudflareTeardownPlan> {
  await ensureTable();
  const { rows } = await pool().query(
    `SELECT * FROM ${TABLE} WHERE id=$1 AND account_id=$2`,
    [opts.plan_id, opts.account_id],
  );
  if (!rows[0]) throw new Error("Cloudflare teardown plan not found");
  return rowToPlan(rows[0]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeResources(
  plan: CloudflareTeardownPlan,
  kind: CloudflareTeardownResource["kind"],
): CloudflareTeardownResource[] {
  return (plan.plan_json.resources ?? []).filter(
    (resource) =>
      resource.kind === kind && resource.classification === "safe_owned",
  );
}

function makeApplyProgress({
  phase,
  plan,
  deletedDnsRecords,
  deletedTunnels,
  skippedR2Buckets,
  deletedR2Objects,
  totalR2Objects,
  deletedR2Bytes,
  totalR2Bytes,
  deletedR2Buckets,
  currentR2Bucket,
}: {
  phase: CloudflareTeardownApplyProgress["phase"];
  plan: CloudflareTeardownPlan;
  deletedDnsRecords: number;
  deletedTunnels: number;
  skippedR2Buckets?: number;
  deletedR2Objects?: number;
  totalR2Objects?: number;
  deletedR2Bytes?: number;
  totalR2Bytes?: number;
  deletedR2Buckets?: number;
  currentR2Bucket?: string;
}): CloudflareTeardownApplyProgress {
  const totalDnsRecords = safeResources(plan, "dns_record").length;
  const totalTunnels = safeResources(plan, "tunnel").length;
  const totalR2Buckets = safeResources(plan, "r2_bucket").length;
  const r2Objects = totalR2Objects ?? r2ObjectTotal(plan);
  const r2Bytes = totalR2Bytes ?? r2ByteTotal(plan);
  return {
    phase,
    plan_id: plan.id,
    deleted_dns_records: deletedDnsRecords,
    total_dns_records: totalDnsRecords,
    deleted_tunnels: deletedTunnels,
    total_tunnels: totalTunnels,
    skipped_r2_buckets: skippedR2Buckets ?? totalR2Buckets,
    deleted_r2_objects: deletedR2Objects ?? 0,
    total_r2_objects: r2Objects,
    deleted_r2_bytes: deletedR2Bytes ?? 0,
    total_r2_bytes: r2Bytes,
    deleted_r2_buckets: deletedR2Buckets ?? 0,
    total_r2_buckets: totalR2Buckets,
    current_r2_bucket: currentR2Bucket,
    message:
      phase === "done"
        ? "Cloudflare teardown apply complete"
        : phase === "deleting_r2_buckets"
          ? "deleting empty Cloudflare R2 buckets"
          : phase === "deleting_r2_objects"
            ? "deleting Cloudflare R2 bucket contents"
            : phase === "deleting_tunnels"
              ? "deleting Cloudflare tunnels"
              : phase === "deleting_dns"
                ? "deleting Cloudflare DNS records"
                : "starting Cloudflare teardown apply",
  };
}

function r2ObjectTotal(plan: CloudflareTeardownPlan): number {
  return safeResources(plan, "r2_bucket").reduce(
    (total, resource) => total + Number(resource.details?.object_count ?? 0),
    0,
  );
}

function r2ByteTotal(plan: CloudflareTeardownPlan): number {
  return safeResources(plan, "r2_bucket").reduce(
    (total, resource) => total + Number(resource.details?.total_bytes ?? 0),
    0,
  );
}

async function updateApplyLro({
  op_id,
  status,
  result,
  error,
  progress_summary,
}: {
  op_id: string;
  status?: "running" | "succeeded" | "failed";
  result?: any;
  error?: string | null;
  progress_summary?: CloudflareTeardownApplyProgress;
}): Promise<LroSummary | undefined> {
  const summary = await updateLro({
    op_id,
    status,
    result,
    error,
    progress_summary,
    heartbeat_at: new Date(),
  });
  if (summary) {
    await publishLroSummary({
      scope_type: summary.scope_type,
      scope_id: summary.scope_id,
      summary,
    });
  }
  if (summary && progress_summary) {
    await publishLroEvent({
      scope_type: summary.scope_type,
      scope_id: summary.scope_id,
      op_id,
      event: {
        type: "progress",
        ts: Date.now(),
        phase: progress_summary.phase,
        message: progress_summary.message,
        detail: progress_summary,
      },
    });
  }
  return summary;
}

function assertR2TeardownReady(plan: CloudflareTeardownPlan): void {
  const r2Buckets = safeResources(plan, "r2_bucket");
  if (r2Buckets.length === 0) return;
  if (!plan.include_r2) {
    throw new Error("teardown plan did not include R2 resources");
  }
  const missingUsage = r2Buckets.filter(
    (resource) =>
      resource.details?.usage_cache === "missing" ||
      typeof resource.details?.object_count !== "number" ||
      typeof resource.details?.total_bytes !== "number",
  );
  if (missingUsage.length > 0) {
    throw new Error(
      `R2 bucket usage cache is missing for ${missingUsage
        .map((resource) => resource.name)
        .filter(Boolean)
        .join(
          ", ",
        )}; run 'cocalc cloudflare r2 audit <bucket> --refresh' for each bucket and create a new teardown plan`,
    );
  }
  if (
    !Number.isInteger(plan.summary.counts.archived_project_candidates) ||
    plan.summary.counts.archived_project_candidates < 0
  ) {
    throw new Error(
      "teardown plan does not have a reliable archived project candidate count",
    );
  }
}

async function deleteR2BucketContents({
  plan,
  bucket,
  op_id,
  deletedDnsRecords,
  deletedTunnels,
  deletedR2Objects,
  deletedR2Bytes,
  deletedR2Buckets,
}: {
  plan: CloudflareTeardownPlan;
  bucket: CloudflareTeardownResource;
  op_id: string;
  deletedDnsRecords: number;
  deletedTunnels: number;
  deletedR2Objects: { value: number };
  deletedR2Bytes: { value: number };
  deletedR2Buckets: number;
}): Promise<void> {
  if (!bucket.name) {
    throw new Error("R2 bucket resource is missing a bucket name");
  }
  const { auth } = await getR2S3Auth(bucket.name);
  let lastProgressAt = 0;
  const publishProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < R2_DELETE_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    await updateApplyLro({
      op_id,
      status: "running",
      progress_summary: makeApplyProgress({
        phase: "deleting_r2_objects",
        plan,
        deletedDnsRecords,
        deletedTunnels,
        skippedR2Buckets: 0,
        deletedR2Objects: deletedR2Objects.value,
        totalR2Objects: r2ObjectTotal(plan),
        deletedR2Bytes: deletedR2Bytes.value,
        totalR2Bytes: r2ByteTotal(plan),
        deletedR2Buckets,
        currentR2Bucket: bucket.name,
      }),
    });
  };
  await publishProgress(true);
  await scanR2Objects({
    auth,
    onPage: async (entries) => {
      const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
      await deleteR2ObjectsConcurrently({
        auth,
        keys: entries.map((entry) => entry.key),
        concurrency: R2_DELETE_CONCURRENCY,
        onDeleted: async (key) => {
          const entry = entryByKey.get(key);
          deletedR2Objects.value += 1;
          deletedR2Bytes.value += entry?.size ?? 0;
          await publishProgress();
        },
      });
      await publishProgress();
    },
  });
}

export async function runCloudflareTeardownApplyLro({
  op_id,
  account_id,
  plan_id,
  confirm,
  delete_r2_contents,
}: {
  op_id: string;
  account_id: string;
  plan_id: string;
  confirm: string;
  delete_r2_contents?: boolean;
}): Promise<void> {
  let plan: CloudflareTeardownPlan | undefined;
  let deletedDnsRecords = 0;
  let deletedTunnels = 0;
  const deletedR2Objects = { value: 0 };
  const deletedR2Bytes = { value: 0 };
  let deletedR2Buckets = 0;
  let skippedR2Buckets = 0;
  const actions: CloudflareTeardownApplyAction[] = [];
  try {
    plan = await getCloudflareTeardownPlan({ account_id, plan_id });
    if (plan.status !== "planned" && plan.status !== "failed") {
      throw new Error(
        `plan status is '${plan.status}', not 'planned' or 'failed'`,
      );
    }
    if (new Date(plan.expires_at).valueOf() < Date.now()) {
      throw new Error("Cloudflare teardown plan has expired");
    }
    if (confirm !== plan.confirmation_text) {
      throw new Error("confirmation text does not match teardown plan");
    }
    const r2Buckets = safeResources(plan, "r2_bucket");
    if (delete_r2_contents) {
      assertR2TeardownReady(plan);
    }
    await pool().query(
      `UPDATE ${TABLE}
          SET status='applying', apply_lro_id=$3
        WHERE id=$1 AND account_id=$2 AND status IN ('planned', 'failed')`,
      [plan_id, account_id, op_id],
    );
    await updateApplyLro({
      op_id,
      status: "running",
      progress_summary: makeApplyProgress({
        phase: "starting",
        plan,
        deletedDnsRecords,
        deletedTunnels,
        skippedR2Buckets: delete_r2_contents ? 0 : r2Buckets.length,
      }),
    });

    const settings = await getServerSettings();
    const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
    if (!token) {
      throw new Error("missing Cloudflare tunnel API token");
    }
    if (!plan.cloudflare_account_id) {
      throw new Error("teardown plan has no Cloudflare account id");
    }
    if (!plan.zone_id && safeResources(plan, "dns_record").length > 0) {
      throw new Error(
        "teardown plan has DNS records but no Cloudflare zone id",
      );
    }

    for (const resource of safeResources(plan, "dns_record")) {
      await updateApplyLro({
        op_id,
        status: "running",
        progress_summary: makeApplyProgress({
          phase: "deleting_dns",
          plan,
          deletedDnsRecords,
          deletedTunnels,
          skippedR2Buckets: delete_r2_contents ? 0 : r2Buckets.length,
          deletedR2Objects: deletedR2Objects.value,
          deletedR2Bytes: deletedR2Bytes.value,
          deletedR2Buckets,
        }),
      });
      if (!resource.id || !plan.zone_id) {
        actions.push({
          kind: resource.kind,
          id: resource.id,
          name: resource.name,
          status: "skipped",
          reason: "missing DNS record id or zone id",
        });
        continue;
      }
      await cloudflareDelete(
        token,
        `zones/${plan.zone_id}/dns_records/${resource.id}`,
      );
      deletedDnsRecords += 1;
      actions.push({
        kind: resource.kind,
        id: resource.id,
        name: resource.name,
        status: "deleted",
      });
    }

    for (const resource of safeResources(plan, "tunnel")) {
      await updateApplyLro({
        op_id,
        status: "running",
        progress_summary: makeApplyProgress({
          phase: "deleting_tunnels",
          plan,
          deletedDnsRecords,
          deletedTunnels,
          skippedR2Buckets: delete_r2_contents ? 0 : r2Buckets.length,
          deletedR2Objects: deletedR2Objects.value,
          deletedR2Bytes: deletedR2Bytes.value,
          deletedR2Buckets,
        }),
      });
      if (!resource.id) {
        actions.push({
          kind: resource.kind,
          id: resource.id,
          name: resource.name,
          status: "skipped",
          reason: "missing tunnel id",
        });
        continue;
      }
      await cloudflareDelete(
        token,
        `accounts/${plan.cloudflare_account_id}/cfd_tunnel/${resource.id}`,
      );
      deletedTunnels += 1;
      actions.push({
        kind: resource.kind,
        id: resource.id,
        name: resource.name,
        status: "deleted",
      });
    }

    if (delete_r2_contents) {
      const r2Token = clean(settings.r2_api_token) ?? token;
      const r2AccountId =
        clean(settings.r2_account_id) ?? plan.cloudflare_account_id;
      if (!r2Token) throw new Error("missing Cloudflare R2 API token");
      if (!r2AccountId) throw new Error("missing Cloudflare R2 account id");
      for (const resource of r2Buckets) {
        await deleteR2BucketContents({
          plan,
          bucket: resource,
          op_id,
          deletedDnsRecords,
          deletedTunnels,
          deletedR2Objects,
          deletedR2Bytes,
          deletedR2Buckets,
        });
        await updateApplyLro({
          op_id,
          status: "running",
          progress_summary: makeApplyProgress({
            phase: "deleting_r2_buckets",
            plan,
            deletedDnsRecords,
            deletedTunnels,
            skippedR2Buckets: 0,
            deletedR2Objects: deletedR2Objects.value,
            deletedR2Bytes: deletedR2Bytes.value,
            deletedR2Buckets,
            currentR2Bucket: resource.name,
          }),
        });
        await cloudflareDelete(
          r2Token,
          `accounts/${r2AccountId}/r2/buckets/${encodeURIComponent(
            resource.name ?? "",
          )}`,
        );
        deletedR2Buckets += 1;
        actions.push({
          kind: resource.kind,
          name: resource.name,
          status: "deleted",
        });
      }
    } else {
      skippedR2Buckets = r2Buckets.length;
      for (const resource of r2Buckets) {
        actions.push({
          kind: resource.kind,
          name: resource.name,
          status: "skipped",
          reason: "R2 bucket deletion requires --delete-r2-contents",
        });
      }
    }

    const result: CloudflareTeardownApplyResult = {
      plan_id,
      applied_at: new Date().toISOString(),
      actions,
      deleted_dns_records: deletedDnsRecords,
      deleted_tunnels: deletedTunnels,
      skipped_r2_buckets: skippedR2Buckets,
      deleted_r2_objects: deletedR2Objects.value,
      deleted_r2_bytes: deletedR2Bytes.value,
      deleted_r2_buckets: deletedR2Buckets,
      notes: [
        delete_r2_contents
          ? "Safe-owned R2 bucket contents and empty buckets were deleted from the saved plan."
          : "R2 buckets were not modified; pass --delete-r2-contents to delete safe-owned bucket contents and buckets.",
        "API tokens, local database rows, local site settings, and active project-host storage are not modified.",
      ],
    };
    await pool().query(
      `UPDATE ${TABLE}
          SET status='applied', applied_at=NOW(), applied_by=$2, apply_lro_id=$3
        WHERE id=$1 AND account_id=$2`,
      [plan_id, account_id, op_id],
    );
    await updateApplyLro({
      op_id,
      status: "succeeded",
      result,
      progress_summary: makeApplyProgress({
        phase: "done",
        plan,
        deletedDnsRecords,
        deletedTunnels,
        skippedR2Buckets,
        deletedR2Objects: deletedR2Objects.value,
        deletedR2Bytes: deletedR2Bytes.value,
        deletedR2Buckets,
      }),
    });
  } catch (err) {
    const message = errorMessage(err);
    if (plan) {
      await pool().query(
        `UPDATE ${TABLE}
            SET status='failed', apply_lro_id=$3
          WHERE id=$1 AND account_id=$2 AND status='applying'`,
        [plan_id, account_id, op_id],
      );
    }
    await updateApplyLro({
      op_id,
      status: "failed",
      error: message,
      result: {
        plan_id,
        actions,
        deleted_dns_records: deletedDnsRecords,
        deleted_tunnels: deletedTunnels,
        skipped_r2_buckets: skippedR2Buckets,
        deleted_r2_objects: deletedR2Objects.value,
        deleted_r2_bytes: deletedR2Bytes.value,
        deleted_r2_buckets: deletedR2Buckets,
      },
      progress_summary: plan
        ? makeApplyProgress({
            phase: "done",
            plan,
            deletedDnsRecords,
            deletedTunnels,
            skippedR2Buckets,
            deletedR2Objects: deletedR2Objects.value,
            deletedR2Bytes: deletedR2Bytes.value,
            deletedR2Buckets,
          })
        : undefined,
    });
  }
}
