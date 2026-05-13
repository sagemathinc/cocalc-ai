/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "crypto";

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { listBuckets as listR2Buckets } from "@cocalc/server/project-backup/r2";

const TABLE = "cloudflare_teardown_plans";
const PLAN_TTL_MS = 10 * 60 * 1000;

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

async function cloudflareRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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
}): Promise<CloudflareTeardownResource[]> {
  if (!opts.includeR2) return [];
  const dbBuckets = await pool().query<{ name: string }>(
    "SELECT name FROM buckets WHERE provider ILIKE '%r2%' OR provider ILIKE '%cloudflare%'",
  );
  const known = new Set(dbBuckets.rows.map((row) => row.name));
  const prefix = clean(opts.bucketPrefix);
  return opts.names.map((name) => {
    if (known.has(name)) {
      return {
        kind: "r2_bucket",
        classification: "safe_owned",
        name,
        reason: "bucket is referenced by CoCalc bucket metadata",
      };
    }
    if (prefix && name.startsWith(`${prefix}-`)) {
      return {
        kind: "r2_bucket",
        classification: "probably_owned",
        name,
        reason: `bucket name starts with configured prefix '${prefix}-'`,
      };
    }
    return {
      kind: "r2_bucket",
      classification: "unknown",
      name,
      reason: "bucket is not referenced by CoCalc metadata",
    };
  });
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
    })),
  ];
  if (includeR2) {
    notes.push(
      "R2 bucket object counts are not computed in Phase 1; R2 apply remains unavailable.",
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
