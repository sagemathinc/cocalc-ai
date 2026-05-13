/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { scanR2Objects, type R2ObjectListEntry } from "@cocalc/backend/r2";

const CACHE_TABLE = "cloudflare_r2_audit_cache";
const DEFAULT_AUDIT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_EXAMPLES_PER_CATEGORY = 3;
const MAX_TOP_OBJECTS = 20;
const MAX_TOP_PREFIXES = 30;

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
};

type CloudflareBucket = {
  name?: string;
  creation_date?: string;
  location?: string;
  jurisdiction?: string;
  storage_class?: string;
};

type CloudflareBucketList =
  | CloudflareBucket[]
  | { buckets?: CloudflareBucket[] };

type GraphqlR2StorageRow = {
  dimensions?: { bucketName?: string; datetime?: string };
  max?: {
    objectCount?: number;
    uploadCount?: number;
    payloadSize?: number;
    metadataSize?: number;
  };
};

type R2MetricStorageClass = {
  published?: {
    objects?: number;
    payloadSize?: number;
    metadataSize?: number;
  };
  uploaded?: {
    objects?: number;
    payloadSize?: number;
    metadataSize?: number;
  };
};

type R2AccountMetrics = {
  standard?: R2MetricStorageClass;
  infrequentAccess?: R2MetricStorageClass;
};

export type CloudflareR2BucketUsage = {
  bucket: string;
  location?: string;
  jurisdiction?: string;
  storage_class?: string;
  creation_date?: string;
  object_count?: number;
  payload_bytes?: number;
  metadata_bytes?: number;
  total_bytes?: number;
  upload_count?: number;
  measured_at?: string;
  metrics_source?: "graphql" | "unavailable";
  database?: {
    known: boolean;
    provider?: string;
    purpose?: string;
    region?: string;
    status?: string;
    project_backup_repos?: number;
    assigned_projects?: number;
  };
};

export type CloudflareR2UsageResult = {
  checked_at: string;
  account_id: string;
  bucket_prefix?: string;
  bucket_count: number;
  totals: {
    object_count?: number;
    payload_bytes?: number;
    metadata_bytes?: number;
    total_bytes?: number;
    upload_count?: number;
  };
  buckets: CloudflareR2BucketUsage[];
  warnings: string[];
  notes: string[];
};

export type CloudflareR2AuditCategory = {
  category: string;
  object_count: number;
  total_bytes: number;
  examples: string[];
};

export type CloudflareR2AuditPrefix = {
  prefix: string;
  object_count: number;
  total_bytes: number;
};

export type CloudflareR2AuditObject = {
  key: string;
  size: number;
};

export type CloudflareR2AuditResult = {
  account_id: string;
  bucket: string;
  prefix?: string;
  scanned_at: string;
  cache: {
    hit: boolean;
    max_age_minutes: number;
    expires_at: string;
  };
  object_count: number;
  total_bytes: number;
  categories: CloudflareR2AuditCategory[];
  top_prefixes: CloudflareR2AuditPrefix[];
  top_objects: CloudflareR2AuditObject[];
  database?: CloudflareR2BucketUsage["database"];
  warnings: string[];
  notes: string[];
};

function pool() {
  return getPool();
}

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = `${value}`.trim();
  return trimmed || undefined;
}

function normalizePrefix(prefix?: string): string | undefined {
  const value = clean(prefix);
  if (!value) return undefined;
  return value.replace(/^\/+/, "");
}

function r2Endpoint(accountId: string, configured?: string): string {
  return clean(configured) ?? `https://${accountId}.r2.cloudflarestorage.com`;
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

async function listBucketInfo(
  token: string,
  accountId: string,
): Promise<CloudflareBucket[]> {
  const result = await cloudflareRequest<CloudflareBucketList>(
    token,
    `accounts/${accountId}/r2/buckets`,
  );
  return (Array.isArray(result) ? result : (result.buckets ?? [])).filter(
    (bucket) => !!bucket.name,
  );
}

async function queryStorageMetrics({
  token,
  accountId,
  startDate,
  endDate,
}: {
  token: string;
  accountId: string;
  startDate: string;
  endDate: string;
}): Promise<Map<string, GraphqlR2StorageRow>> {
  const query = `
    query CoCalcR2StorageUsage($accountTag: string!, $startDate: Time, $endDate: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $startDate, datetime_leq: $endDate }
            orderBy: [datetime_DESC]
          ) {
            max {
              objectCount
              uploadCount
              payloadSize
              metadataSize
            }
            dimensions {
              bucketName
              datetime
            }
          }
        }
      }
    }
  `;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, startDate, endDate },
    }),
  });
  const payload = (await response.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{ r2StorageAdaptiveGroups?: GraphqlR2StorageRow[] }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || payload.errors?.length) {
    const details =
      payload.errors
        ?.map((err) => err.message)
        .filter(Boolean)
        .join(", ") ||
      `${response.status} ${response.statusText}`.trim() ||
      "unknown error";
    throw new Error(`cloudflare graphql failed: ${details}`);
  }
  const rows =
    payload.data?.viewer?.accounts?.flatMap(
      (account) => account.r2StorageAdaptiveGroups ?? [],
    ) ?? [];
  const byBucket = new Map<string, GraphqlR2StorageRow>();
  for (const row of rows) {
    const bucket = clean(row.dimensions?.bucketName);
    if (!bucket || byBucket.has(bucket)) continue;
    byBucket.set(bucket, row);
  }
  return byBucket;
}

async function queryAccountMetrics(
  token: string,
  accountId: string,
): Promise<CloudflareR2UsageResult["totals"]> {
  const metrics = await cloudflareRequest<R2AccountMetrics>(
    token,
    `accounts/${accountId}/r2/metrics`,
  );
  const classes = [metrics.standard, metrics.infrequentAccess];
  const total = (
    selector: (entry: R2MetricStorageClass) => number | undefined,
  ) => {
    let value = 0;
    let seen = false;
    for (const entry of classes) {
      if (!entry) continue;
      const n = selector(entry);
      if (typeof n === "number" && Number.isFinite(n)) {
        value += n;
        seen = true;
      }
    }
    return seen ? value : undefined;
  };
  const payload = total((entry) => entry.published?.payloadSize);
  const metadata = total((entry) => entry.published?.metadataSize);
  return {
    object_count: total((entry) => entry.published?.objects),
    payload_bytes: payload,
    metadata_bytes: metadata,
    total_bytes:
      payload != null || metadata != null
        ? (payload ?? 0) + (metadata ?? 0)
        : undefined,
    upload_count: total((entry) => entry.uploaded?.objects),
  };
}

async function loadBucketDatabaseInfo(): Promise<
  Map<string, NonNullable<CloudflareR2BucketUsage["database"]>>
> {
  try {
    const { rows } = await pool().query<{
      name: string;
      provider: string | null;
      purpose: string | null;
      region: string | null;
      status: string | null;
      project_backup_repos: number | string | null;
      assigned_projects: number | string | null;
    }>(`
      SELECT
        b.name,
        b.provider,
        b.purpose,
        b.region,
        b.status,
        COUNT(DISTINCT r.id)::INTEGER AS project_backup_repos,
        COUNT(DISTINCT p.project_id)::INTEGER AS assigned_projects
      FROM buckets AS b
      LEFT JOIN project_backup_repos AS r ON r.bucket_id = b.id
      LEFT JOIN projects AS p ON p.backup_repo_id = r.id
      WHERE b.name IS NOT NULL
      GROUP BY b.id, b.name, b.provider, b.purpose, b.region, b.status
    `);
    return new Map(
      rows.map((row) => [
        row.name,
        {
          known: true,
          provider: row.provider ?? undefined,
          purpose: row.purpose ?? undefined,
          region: row.region ?? undefined,
          status: row.status ?? undefined,
          project_backup_repos: Number(row.project_backup_repos ?? 0),
          assigned_projects: Number(row.assigned_projects ?? 0),
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

function bucketNameForMetricAliases(bucket: CloudflareBucket): string[] {
  const name = clean(bucket.name);
  if (!name) return [];
  const aliases = [name];
  const jurisdiction = clean(bucket.jurisdiction);
  if (jurisdiction && jurisdiction !== "default") {
    aliases.push(`${jurisdiction}_${name}`);
  }
  return aliases;
}

export async function getCloudflareR2Usage(): Promise<CloudflareR2UsageResult> {
  const settings = await getServerSettings();
  const accountId =
    clean(settings.r2_account_id) ??
    clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const token =
    clean(settings.r2_api_token) ??
    clean(settings.project_hosts_cloudflare_tunnel_api_token);
  if (!accountId) throw new Error("missing r2_account_id");
  if (!token) throw new Error("missing r2_api_token");

  const warnings: string[] = [];
  const notes: string[] = [
    "Storage metrics come from Cloudflare GraphQL analytics when available; they can lag behind live S3 object listings.",
  ];
  const buckets = await listBucketInfo(token, accountId);
  const dbInfo = await loadBucketDatabaseInfo();
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
  let metrics = new Map<string, GraphqlR2StorageRow>();
  let accountMetricTotals: CloudflareR2UsageResult["totals"] | undefined;
  try {
    metrics = await queryStorageMetrics({
      token,
      accountId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });
  } catch (err) {
    warnings.push(
      `could not query per-bucket R2 GraphQL metrics: ${err}. Run 'cocalc cloudflare r2 audit <bucket>' for exact S3-listing totals.`,
    );
    try {
      accountMetricTotals = await queryAccountMetrics(token, accountId);
      notes.push(
        "Account-level totals use Cloudflare's R2 metrics REST endpoint because per-bucket GraphQL metrics were unavailable.",
      );
    } catch (metricsErr) {
      warnings.push(`could not query account-level R2 metrics: ${metricsErr}`);
    }
  }

  const rows = buckets
    .map((bucket): CloudflareR2BucketUsage => {
      const name = clean(bucket.name)!;
      const metric = bucketNameForMetricAliases(bucket)
        .map((alias) => metrics.get(alias))
        .find(Boolean);
      const payload = Number(metric?.max?.payloadSize ?? NaN);
      const metadata = Number(metric?.max?.metadataSize ?? NaN);
      const objectCount = Number(metric?.max?.objectCount ?? NaN);
      const uploadCount = Number(metric?.max?.uploadCount ?? NaN);
      return {
        bucket: name,
        location: clean(bucket.location),
        jurisdiction: clean(bucket.jurisdiction),
        storage_class: clean(bucket.storage_class),
        creation_date: clean(bucket.creation_date),
        object_count: Number.isFinite(objectCount) ? objectCount : undefined,
        payload_bytes: Number.isFinite(payload) ? payload : undefined,
        metadata_bytes: Number.isFinite(metadata) ? metadata : undefined,
        total_bytes:
          Number.isFinite(payload) || Number.isFinite(metadata)
            ? (Number.isFinite(payload) ? payload : 0) +
              (Number.isFinite(metadata) ? metadata : 0)
            : undefined,
        upload_count: Number.isFinite(uploadCount) ? uploadCount : undefined,
        measured_at: clean(metric?.dimensions?.datetime),
        metrics_source: metric ? "graphql" : "unavailable",
        database: dbInfo.get(name) ?? { known: false },
      };
    })
    .sort((a, b) => (b.total_bytes ?? -1) - (a.total_bytes ?? -1));

  const sum = (field: keyof CloudflareR2BucketUsage) => {
    let total = 0;
    let seen = false;
    for (const row of rows) {
      const value = row[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
        seen = true;
      }
    }
    return seen ? total : undefined;
  };

  return {
    checked_at: new Date().toISOString(),
    account_id: accountId,
    bucket_prefix: clean(settings.r2_bucket_prefix),
    bucket_count: rows.length,
    totals: {
      object_count: sum("object_count") ?? accountMetricTotals?.object_count,
      payload_bytes: sum("payload_bytes") ?? accountMetricTotals?.payload_bytes,
      metadata_bytes:
        sum("metadata_bytes") ?? accountMetricTotals?.metadata_bytes,
      total_bytes: sum("total_bytes") ?? accountMetricTotals?.total_bytes,
      upload_count: sum("upload_count") ?? accountMetricTotals?.upload_count,
    },
    buckets: rows,
    warnings,
    notes,
  };
}

async function ensureAuditCacheTable(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
      account_id TEXT NOT NULL,
      bucket TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      result_json JSONB NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, bucket, prefix)
    )
  `);
  await pool().query(
    `CREATE INDEX IF NOT EXISTS ${CACHE_TABLE}_updated_idx ON ${CACHE_TABLE} (updated_at)`,
  );
}

function categoryForKey(key: string): string {
  if (key.startsWith("project-backup-index/v1/")) {
    return "project_backup_index";
  }
  if (key.startsWith("rustic/shared-")) {
    return "project_backup_rustic_repo";
  }
  if (key.startsWith("bay-backups/")) {
    return "bay_backup_files";
  }
  if (key.startsWith("rustic/bay-backups/")) {
    return "bay_backup_rustic_repo";
  }
  if (key.startsWith("rootfs-images/")) {
    return "rootfs_images";
  }
  if (key.startsWith("rustic/")) {
    return "rustic_other";
  }
  return "unknown";
}

function prefixForKey(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts[0] === "rustic" && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "project-backup-index" && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "bay-backups" && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function addToMap(
  map: Map<string, { object_count: number; total_bytes: number }>,
  key: string,
  size: number,
): void {
  const existing = map.get(key) ?? { object_count: 0, total_bytes: 0 };
  existing.object_count += 1;
  existing.total_bytes += size;
  map.set(key, existing);
}

function pushTopObject(
  top: CloudflareR2AuditObject[],
  entry: R2ObjectListEntry,
): void {
  top.push({ key: entry.key, size: entry.size });
  top.sort((a, b) => b.size - a.size);
  if (top.length > MAX_TOP_OBJECTS) top.length = MAX_TOP_OBJECTS;
}

function cacheMaxAgeMinutes(maxAgeMinutes?: number): number {
  if (maxAgeMinutes == null) return DEFAULT_AUDIT_CACHE_TTL_MS / 60000;
  const value = Math.max(0, Math.min(24 * 60, Math.floor(maxAgeMinutes)));
  return value;
}

async function getCachedAudit(opts: {
  accountId: string;
  bucket: string;
  prefix: string;
  maxAgeMinutes: number;
}): Promise<CloudflareR2AuditResult | undefined> {
  const { rows } = await pool().query<{
    result_json: CloudflareR2AuditResult;
    scanned_at: Date;
  }>(
    `SELECT result_json, scanned_at
       FROM ${CACHE_TABLE}
      WHERE account_id=$1
        AND bucket=$2
        AND prefix=$3
        AND scanned_at >= NOW() - ($4::TEXT || ' minutes')::INTERVAL`,
    [opts.accountId, opts.bucket, opts.prefix, opts.maxAgeMinutes],
  );
  const cached = rows[0]?.result_json;
  if (!cached) return undefined;
  const scannedAt = new Date(cached.scanned_at);
  return {
    ...cached,
    cache: {
      hit: true,
      max_age_minutes: opts.maxAgeMinutes,
      expires_at: new Date(
        scannedAt.getTime() + opts.maxAgeMinutes * 60 * 1000,
      ).toISOString(),
    },
  };
}

async function saveCachedAudit(result: CloudflareR2AuditResult): Promise<void> {
  await pool().query(
    `INSERT INTO ${CACHE_TABLE}
       (account_id, bucket, prefix, result_json, scanned_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (account_id, bucket, prefix)
     DO UPDATE SET result_json=EXCLUDED.result_json,
                   scanned_at=EXCLUDED.scanned_at,
                   updated_at=NOW()`,
    [
      result.account_id,
      result.bucket,
      result.prefix ?? "",
      JSON.stringify(result),
      result.scanned_at,
    ],
  );
}

export async function auditCloudflareR2Bucket({
  bucket,
  prefix,
  refresh,
  max_age_minutes,
}: {
  bucket: string;
  prefix?: string;
  refresh?: boolean;
  max_age_minutes?: number;
}): Promise<CloudflareR2AuditResult> {
  const bucketName = clean(bucket);
  if (!bucketName) throw new Error("bucket is required");
  const settings = await getServerSettings();
  const accountId =
    clean(settings.r2_account_id) ??
    clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const accessKey = clean(settings.r2_access_key_id);
  const secretKey = clean(settings.r2_secret_access_key);
  if (!accountId) throw new Error("missing r2_account_id");
  if (!accessKey) throw new Error("missing r2_access_key_id");
  if (!secretKey) throw new Error("missing r2_secret_access_key");

  await ensureAuditCacheTable();
  const normalizedPrefix = normalizePrefix(prefix) ?? "";
  const maxAgeMinutes = cacheMaxAgeMinutes(max_age_minutes);
  if (!refresh && maxAgeMinutes > 0) {
    const cached = await getCachedAudit({
      accountId,
      bucket: bucketName,
      prefix: normalizedPrefix,
      maxAgeMinutes,
    });
    if (cached) return cached;
  }

  const dbInfo = await loadBucketDatabaseInfo();
  const categories = new Map<
    string,
    { object_count: number; total_bytes: number; examples: string[] }
  >();
  const prefixes = new Map<
    string,
    { object_count: number; total_bytes: number }
  >();
  const topObjects: CloudflareR2AuditObject[] = [];

  const { objectCount, totalSize } = await scanR2Objects({
    auth: {
      endpoint: r2Endpoint(accountId),
      accessKey,
      secretKey,
      bucket: bucketName,
      region: "auto",
    },
    prefix: normalizedPrefix || undefined,
    onPage: (entries) => {
      for (const entry of entries) {
        const category = categoryForKey(entry.key);
        const current = categories.get(category) ?? {
          object_count: 0,
          total_bytes: 0,
          examples: [],
        };
        current.object_count += 1;
        current.total_bytes += entry.size;
        if (current.examples.length < MAX_EXAMPLES_PER_CATEGORY) {
          current.examples.push(entry.key);
        }
        categories.set(category, current);
        addToMap(prefixes, prefixForKey(entry.key), entry.size);
        pushTopObject(topObjects, entry);
      }
    },
  });

  const scannedAt = new Date();
  const result: CloudflareR2AuditResult = {
    account_id: accountId,
    bucket: bucketName,
    prefix: normalizedPrefix || undefined,
    scanned_at: scannedAt.toISOString(),
    cache: {
      hit: false,
      max_age_minutes: maxAgeMinutes,
      expires_at: new Date(
        scannedAt.getTime() + maxAgeMinutes * 60 * 1000,
      ).toISOString(),
    },
    object_count: objectCount,
    total_bytes: totalSize,
    categories: [...categories.entries()]
      .map(([category, value]) => ({ category, ...value }))
      .sort((a, b) => b.total_bytes - a.total_bytes),
    top_prefixes: [...prefixes.entries()]
      .map(([prefixName, value]) => ({ prefix: prefixName, ...value }))
      .sort((a, b) => b.total_bytes - a.total_bytes)
      .slice(0, MAX_TOP_PREFIXES),
    top_objects: topObjects,
    database: dbInfo.get(bucketName) ?? { known: false },
    warnings: [],
    notes: [
      "This audit is based on live S3 ListObjectsV2 metadata and is exact for objects visible to the configured R2 S3 credentials.",
      "Category labels are heuristic groupings of CoCalc object-key prefixes.",
    ],
  };
  await saveCachedAudit(result);
  return result;
}
