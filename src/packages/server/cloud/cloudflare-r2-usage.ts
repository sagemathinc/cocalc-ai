/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  deleteR2ObjectsConcurrently,
  scanR2Objects,
  type R2ObjectListEntry,
} from "@cocalc/backend/r2";
import getLogger from "@cocalc/backend/logger";
import { updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";

const CACHE_TABLE = "cloudflare_r2_audit_cache";
const DEFAULT_AUDIT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_EXAMPLES_PER_CATEGORY = 3;
const MAX_TOP_OBJECTS = 20;
const MAX_TOP_PREFIXES = 30;
const R2_AUDIT_SCHEMA_VERSION = 4;
const R2_AUDIT_PROGRESS_INTERVAL_MS = 2000;
const BAY_BACKUP_CLEANUP_PROGRESS_INTERVAL_MS = 2000;
const BAY_BACKUP_CLEANUP_DELETE_CONCURRENCY = 32;

const logger = getLogger("server:cloud:cloudflare-r2-usage");

type CloudflareResponse<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
  result_info?: {
    page?: number;
    total_pages?: number;
  };
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
  metrics_source?: "graphql" | "s3-scan" | "s3-cache" | "unavailable";
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
  filtered_by_prefix: boolean;
  bucket_count: number;
  cloudflare_bucket_count: number;
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

export type CloudflareR2AuditUsageGroup = {
  object_count: number;
  total_bytes: number;
  examples: string[];
};

export type CloudflareR2AuditRusticRepo = CloudflareR2AuditUsageGroup & {
  repo: string;
  kind: "project-backup" | "bay-backup" | "rootfs" | "other";
};

export type CloudflareR2AuditResult = {
  audit_schema_version?: number;
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
  rustic_repos?: CloudflareR2AuditRusticRepo[];
  project_backup_index?: CloudflareR2AuditUsageGroup;
  rootfs_images?: CloudflareR2AuditUsageGroup;
  bay_backup_files?: CloudflareR2AuditUsageGroup;
  other?: CloudflareR2AuditUsageGroup;
  other_prefixes?: CloudflareR2AuditPrefix[];
  categories: CloudflareR2AuditCategory[];
  top_prefixes: CloudflareR2AuditPrefix[];
  top_objects: CloudflareR2AuditObject[];
  database?: CloudflareR2BucketUsage["database"];
  warnings: string[];
  notes: string[];
};

export type CloudflareR2AuditProgress = {
  phase: "starting" | "scanning" | "saving" | "done";
  bucket: string;
  prefix?: string;
  pages_seen: number;
  objects_seen: number;
  bytes_seen: number;
  expected_total_objects?: number;
  expected_total_bytes?: number;
  progress?: number;
  elapsed_ms: number;
  objects_per_second?: number;
  bytes_per_second?: number;
  eta_seconds?: number;
  message: string;
};

export type CloudflareR2BayBackupCleanupPlan = {
  bucket: string;
  prefix: string;
  checked_at: string;
  object_count: number;
  total_bytes: number;
  wal_object_count: number;
  wal_total_bytes: number;
  manifest_object_count: number;
  manifest_total_bytes: number;
  other_object_count: number;
  other_total_bytes: number;
  bay_prefixes: CloudflareR2AuditPrefix[];
  confirmation_text: string;
  warnings: string[];
  notes: string[];
};

export type CloudflareR2BayBackupCleanupProgress = {
  phase: "starting" | "scanning" | "deleting" | "done";
  bucket: string;
  prefix: string;
  objects_total?: number;
  bytes_total?: number;
  objects_seen: number;
  bytes_seen: number;
  objects_deleted: number;
  bytes_deleted: number;
  elapsed_ms: number;
  objects_per_second?: number;
  message: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function normalizeBayBackupCleanupPrefix(prefix?: string): string {
  const normalized = normalizePrefix(prefix) ?? "bay-backups/";
  const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  if (!withSlash.startsWith("bay-backups/")) {
    throw new Error("bay backup cleanup prefix must start with 'bay-backups/'");
  }
  if (withSlash.startsWith("rustic/")) {
    throw new Error("refusing to cleanup rustic backup repositories");
  }
  return withSlash;
}

function r2Endpoint(accountId: string, configured?: string): string {
  return clean(configured) ?? `https://${accountId}.r2.cloudflarestorage.com`;
}

async function getR2S3Auth(bucket: string) {
  const bucketName = clean(bucket);
  if (!bucketName) throw new Error("bucket is required");
  const settings = await getServerSettings();
  const accountId =
    clean(settings.r2_account_id) ??
    clean(settings.project_hosts_cloudflare_tunnel_account_id);
  const accessKey = clean(settings.r2_access_key_id);
  const secretKey = clean(settings.r2_secret_access_key);
  const bucketPrefix = clean(settings.r2_bucket_prefix);
  if (!accountId) throw new Error("missing r2_account_id");
  if (!accessKey) throw new Error("missing r2_access_key_id");
  if (!secretKey) throw new Error("missing r2_secret_access_key");
  return {
    bucketName,
    accountId,
    bucketPrefix,
    auth: {
      endpoint: r2Endpoint(accountId),
      accessKey,
      secretKey,
      bucket: bucketName,
      region: "auto" as const,
    },
  };
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
  const buckets: CloudflareBucket[] = [];
  let page = 1;
  while (page <= 100) {
    const qs = new URLSearchParams({ page: `${page}`, per_page: "100" });
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets?${qs.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    let payload: CloudflareResponse<CloudflareBucketList> | undefined;
    try {
      payload =
        (await response.json()) as CloudflareResponse<CloudflareBucketList>;
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
    const result = payload.result;
    buckets.push(
      ...(Array.isArray(result) ? result : (result?.buckets ?? [])).filter(
        (bucket) => !!bucket.name,
      ),
    );
    const totalPages = payload.result_info?.total_pages ?? page;
    if (page >= totalPages) break;
    page += 1;
  }
  const seen = new Set<string>();
  return buckets.filter((bucket) => {
    const name = clean(bucket.name);
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
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

export async function getCloudflareR2Usage({
  all_buckets,
  scan,
  refresh,
  max_age_minutes,
}: {
  all_buckets?: boolean;
  scan?: boolean;
  refresh?: boolean;
  max_age_minutes?: number;
} = {}): Promise<CloudflareR2UsageResult> {
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
  const bucketPrefix = clean(settings.r2_bucket_prefix);
  const allBuckets = await listBucketInfo(token, accountId);
  const filteredByPrefix = !!bucketPrefix && !all_buckets;
  const buckets = filteredByPrefix
    ? allBuckets.filter((bucket) =>
        clean(bucket.name)?.startsWith(`${bucketPrefix}-`),
      )
    : allBuckets;
  if (filteredByPrefix && buckets.length === 0) {
    warnings.push(
      `no Cloudflare R2 buckets match configured prefix '${bucketPrefix}-' among ${allBuckets.length} visible buckets; use --all to inspect every visible bucket`,
    );
  }
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
      `could not query per-bucket R2 GraphQL metrics: ${err}. The configured token likely needs Cloudflare account analytics permission; cached S3 listing fallback is used when enabled.`,
    );
    if (!filteredByPrefix) {
      try {
        accountMetricTotals = await queryAccountMetrics(token, accountId);
        notes.push(
          "Account-level totals use Cloudflare's R2 metrics REST endpoint because per-bucket GraphQL metrics were unavailable.",
        );
      } catch (metricsErr) {
        warnings.push(
          `could not query account-level R2 metrics: ${metricsErr}`,
        );
      }
    } else {
      notes.push(
        "Account-level R2 REST metrics are not used for filtered bucket output because Cloudflare's REST metrics endpoint is account-wide.",
      );
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

  const maxAgeMinutes = cacheMaxAgeMinutes(max_age_minutes);
  const shouldScan = !!scan;
  const shouldUseS3Cache =
    scan === false ? false : shouldScan || filteredByPrefix;
  if (shouldUseS3Cache && rows.length > 0) {
    notes.push(
      shouldScan
        ? "Per-bucket totals are filled from exact S3 listings and cached for later fast usage checks."
        : "Per-bucket totals use recent cached S3 listings when Cloudflare GraphQL analytics is unavailable.",
    );
    await ensureAuditCacheTable();
    for (const row of rows) {
      if (row.total_bytes != null && row.object_count != null) continue;
      try {
        const audit = shouldScan
          ? await auditCloudflareR2Bucket({
              bucket: row.bucket,
              refresh,
              max_age_minutes,
            })
          : await getCachedAudit({
              accountId,
              bucket: row.bucket,
              prefix: "",
              maxAgeMinutes,
            });
        if (!audit) {
          warnings.push(
            `no recent S3 usage cache for R2 bucket '${row.bucket}'; run 'cocalc cloudflare r2 usage --scan' to populate exact usage`,
          );
          continue;
        }
        row.object_count = audit.object_count;
        row.payload_bytes = audit.total_bytes;
        row.total_bytes = audit.total_bytes;
        row.measured_at = audit.scanned_at;
        row.metrics_source = audit.cache.hit ? "s3-cache" : "s3-scan";
      } catch (err) {
        warnings.push(
          `could not read R2 usage for bucket '${row.bucket}': ${err}`,
        );
      }
    }
    rows.sort((a, b) => (b.total_bytes ?? -1) - (a.total_bytes ?? -1));
  }

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
    bucket_prefix: bucketPrefix,
    filtered_by_prefix: filteredByPrefix,
    bucket_count: rows.length,
    cloudflare_bucket_count: allBuckets.length,
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

function rusticRepoForKey(
  key: string,
): Pick<CloudflareR2AuditRusticRepo, "repo" | "kind"> | undefined {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] !== "rustic" || !parts[1]) return undefined;
  if (parts[1].startsWith("shared-")) {
    return { repo: `rustic/${parts[1]}`, kind: "project-backup" };
  }
  if (parts[1] === "bay-backups" && parts[2]) {
    return { repo: `rustic/bay-backups/${parts[2]}`, kind: "bay-backup" };
  }
  if (parts[1] === "rootfs-images") {
    return { repo: "rustic/rootfs-images", kind: "rootfs" };
  }
  return { repo: `rustic/${parts[1]}`, kind: "other" };
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

function addToUsageGroup(
  group: CloudflareR2AuditUsageGroup,
  entry: R2ObjectListEntry,
): void {
  group.object_count += 1;
  group.total_bytes += entry.size;
  if (group.examples.length < MAX_EXAMPLES_PER_CATEGORY) {
    group.examples.push(entry.key);
  }
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

function makeAuditProgress({
  phase,
  bucket,
  prefix,
  pagesSeen,
  objectsSeen,
  bytesSeen,
  expectedTotalObjects,
  expectedTotalBytes,
  startedAt,
}: {
  phase: CloudflareR2AuditProgress["phase"];
  bucket: string;
  prefix: string;
  pagesSeen: number;
  objectsSeen: number;
  bytesSeen: number;
  expectedTotalObjects?: number;
  expectedTotalBytes?: number;
  startedAt: number;
}): CloudflareR2AuditProgress {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const elapsedSeconds = elapsedMs / 1000;
  const objectsPerSecond =
    elapsedSeconds > 0
      ? Math.round((objectsSeen / elapsedSeconds) * 10) / 10
      : undefined;
  const bytesPerSecond =
    elapsedSeconds > 0 ? Math.round(bytesSeen / elapsedSeconds) : undefined;
  const byteProgress =
    expectedTotalBytes && expectedTotalBytes > 0
      ? Math.min(1, bytesSeen / expectedTotalBytes)
      : undefined;
  const objectProgress =
    expectedTotalObjects && expectedTotalObjects > 0
      ? Math.min(1, objectsSeen / expectedTotalObjects)
      : undefined;
  const progress = byteProgress ?? objectProgress;
  const etaCandidates: number[] = [];
  if (
    byteProgress != null &&
    byteProgress > 0 &&
    byteProgress < 1 &&
    bytesPerSecond &&
    bytesPerSecond > 0
  ) {
    etaCandidates.push(
      Math.max(
        0,
        Math.round((expectedTotalBytes! - bytesSeen) / bytesPerSecond),
      ),
    );
  }
  if (
    objectProgress != null &&
    objectProgress > 0 &&
    objectProgress < 1 &&
    objectsPerSecond &&
    objectsPerSecond > 0
  ) {
    etaCandidates.push(
      Math.max(
        0,
        Math.round((expectedTotalObjects! - objectsSeen) / objectsPerSecond),
      ),
    );
  }
  const etaSeconds = etaCandidates.length
    ? Math.max(...etaCandidates)
    : undefined;
  return {
    phase,
    bucket,
    prefix: prefix || undefined,
    pages_seen: pagesSeen,
    objects_seen: objectsSeen,
    bytes_seen: bytesSeen,
    expected_total_objects: expectedTotalObjects,
    expected_total_bytes: expectedTotalBytes,
    progress,
    elapsed_ms: elapsedMs,
    objects_per_second: objectsPerSecond,
    bytes_per_second: bytesPerSecond,
    eta_seconds: etaSeconds,
    message:
      phase === "done"
        ? "audit complete"
        : phase === "saving"
          ? "saving audit result"
          : phase === "starting"
            ? "starting R2 bucket scan"
            : "scanning R2 bucket",
  };
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
  if (
    cached.audit_schema_version !== R2_AUDIT_SCHEMA_VERSION ||
    !Array.isArray(cached.rustic_repos) ||
    cached.project_backup_index == null ||
    cached.rootfs_images == null ||
    cached.bay_backup_files == null ||
    cached.other == null ||
    !Array.isArray(cached.other_prefixes)
  ) {
    return undefined;
  }
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

async function getCachedAuditProgressBaseline({
  accountId,
  bucket,
  prefix,
}: {
  accountId: string;
  bucket: string;
  prefix: string;
}): Promise<{ totalBytes?: number; objectCount?: number }> {
  const { rows } = await pool().query<{
    total_bytes: unknown;
    object_count: unknown;
  }>(
    `SELECT result_json->>'total_bytes' AS total_bytes,
            result_json->>'object_count' AS object_count
       FROM ${CACHE_TABLE}
      WHERE account_id=$1
        AND bucket=$2
        AND prefix=$3
      LIMIT 1`,
    [accountId, bucket, prefix],
  );
  const totalBytes = Number(rows[0]?.total_bytes);
  const objectCount = Number(rows[0]?.object_count);
  return {
    totalBytes:
      Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined,
    objectCount:
      Number.isFinite(objectCount) && objectCount > 0 ? objectCount : undefined,
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
  expected_total_objects,
  expected_total_bytes,
  onProgress,
}: {
  bucket: string;
  prefix?: string;
  refresh?: boolean;
  max_age_minutes?: number;
  expected_total_objects?: number;
  expected_total_bytes?: number;
  onProgress?: (progress: CloudflareR2AuditProgress) => void | Promise<void>;
}): Promise<CloudflareR2AuditResult> {
  const { bucketName, accountId, auth } = await getR2S3Auth(bucket);

  await ensureAuditCacheTable();
  const normalizedPrefix = normalizePrefix(prefix) ?? "";
  const maxAgeMinutes = cacheMaxAgeMinutes(max_age_minutes);
  const progressBaseline = onProgress
    ? await getCachedAuditProgressBaseline({
        accountId,
        bucket: bucketName,
        prefix: normalizedPrefix,
      })
    : {};
  const progressExpectedTotalObjects =
    expected_total_objects ?? progressBaseline.objectCount;
  const progressExpectedTotalBytes =
    expected_total_bytes ?? progressBaseline.totalBytes;
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
  const rusticRepos = new Map<string, CloudflareR2AuditRusticRepo>();
  const projectBackupIndex: CloudflareR2AuditUsageGroup = {
    object_count: 0,
    total_bytes: 0,
    examples: [],
  };
  const rootfsImages: CloudflareR2AuditUsageGroup = {
    object_count: 0,
    total_bytes: 0,
    examples: [],
  };
  const bayBackupFiles: CloudflareR2AuditUsageGroup = {
    object_count: 0,
    total_bytes: 0,
    examples: [],
  };
  const other: CloudflareR2AuditUsageGroup = {
    object_count: 0,
    total_bytes: 0,
    examples: [],
  };
  const otherPrefixes = new Map<
    string,
    { object_count: number; total_bytes: number }
  >();
  const topObjects: CloudflareR2AuditObject[] = [];
  const startedAt = Date.now();
  let pagesSeen = 0;
  let objectsSeen = 0;
  let bytesSeen = 0;
  let lastProgressAt = 0;

  const publishProgress = async (
    phase: CloudflareR2AuditProgress["phase"],
    force = false,
  ) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < R2_AUDIT_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    await onProgress(
      makeAuditProgress({
        phase,
        bucket: bucketName,
        prefix: normalizedPrefix,
        pagesSeen,
        objectsSeen,
        bytesSeen,
        expectedTotalObjects: progressExpectedTotalObjects,
        expectedTotalBytes: progressExpectedTotalBytes,
        startedAt,
      }),
    );
  };

  await publishProgress("starting", true);
  const { objectCount, totalSize } = await scanR2Objects({
    auth,
    prefix: normalizedPrefix || undefined,
    onPage: async (entries) => {
      pagesSeen += 1;
      objectsSeen += entries.length;
      bytesSeen += entries.reduce((sum, entry) => sum + entry.size, 0);
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
        const rusticRepo = rusticRepoForKey(entry.key);
        if (rusticRepo) {
          const currentRepo = rusticRepos.get(rusticRepo.repo) ?? {
            ...rusticRepo,
            object_count: 0,
            total_bytes: 0,
            examples: [],
          };
          addToUsageGroup(currentRepo, entry);
          rusticRepos.set(rusticRepo.repo, currentRepo);
        } else if (entry.key.startsWith("project-backup-index/v1/")) {
          addToUsageGroup(projectBackupIndex, entry);
        } else if (entry.key.startsWith("rootfs-images/")) {
          addToUsageGroup(rootfsImages, entry);
        } else if (entry.key.startsWith("bay-backups/")) {
          addToUsageGroup(bayBackupFiles, entry);
        } else {
          addToUsageGroup(other, entry);
          addToMap(otherPrefixes, prefixForKey(entry.key), entry.size);
        }
        pushTopObject(topObjects, entry);
      }
      await publishProgress("scanning");
    },
  });
  await publishProgress("saving", true);

  const scannedAt = new Date();
  const result: CloudflareR2AuditResult = {
    audit_schema_version: R2_AUDIT_SCHEMA_VERSION,
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
    rustic_repos: [...rusticRepos.values()].sort(
      (a, b) => b.total_bytes - a.total_bytes,
    ),
    project_backup_index: projectBackupIndex,
    rootfs_images: rootfsImages,
    bay_backup_files: bayBackupFiles,
    other,
    other_prefixes: [...otherPrefixes.entries()]
      .map(([prefixName, value]) => ({ prefix: prefixName, ...value }))
      .sort((a, b) => b.total_bytes - a.total_bytes)
      .slice(0, MAX_TOP_PREFIXES),
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
      "The refined breakdown treats rustic/* as rustic repositories, project-backup-index/v1/* as backup index files, rootfs-images/* as rootfs image artifacts, bay-backups/* as legacy bay backup files, and everything else as other bucket usage.",
    ],
  };
  await saveCachedAudit(result);
  await publishProgress("done", true);
  return result;
}

export async function getCachedCloudflareR2Audit({
  bucket,
  prefix,
  max_age_minutes,
}: {
  bucket: string;
  prefix?: string;
  max_age_minutes?: number;
}): Promise<CloudflareR2AuditResult | undefined> {
  const { bucketName, accountId } = await getR2S3Auth(bucket);
  await ensureAuditCacheTable();
  return await getCachedAudit({
    accountId,
    bucket: bucketName,
    prefix: normalizePrefix(prefix) ?? "",
    maxAgeMinutes: cacheMaxAgeMinutes(max_age_minutes),
  });
}

async function publishAuditLroSummary(summary?: LroSummary): Promise<void> {
  if (!summary) return;
  await publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  });
}

async function updateAuditLro({
  op_id,
  status,
  result,
  error,
  progress_summary,
}: {
  op_id: string;
  status?: "running" | "succeeded" | "failed";
  result?: CloudflareR2AuditResult;
  error?: string | null;
  progress_summary?: CloudflareR2AuditProgress;
}): Promise<LroSummary | undefined> {
  const summary = await updateLro({
    op_id,
    status,
    result,
    error,
    progress_summary,
    heartbeat_at: new Date(),
  });
  await publishAuditLroSummary(summary);
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
        progress: progress_summary.progress,
        detail: progress_summary,
      },
    });
  }
  return summary;
}

export async function runCloudflareR2AuditLro({
  op_id,
  bucket,
  prefix,
  refresh,
  max_age_minutes,
}: {
  op_id: string;
  bucket: string;
  prefix?: string;
  refresh?: boolean;
  max_age_minutes?: number;
}): Promise<void> {
  let lastProgress: CloudflareR2AuditProgress | undefined;
  try {
    const result = await auditCloudflareR2Bucket({
      bucket,
      prefix,
      refresh,
      max_age_minutes,
      onProgress: async (progress) => {
        lastProgress = progress;
        await updateAuditLro({
          op_id,
          status: "running",
          progress_summary: progress,
        });
      },
    });
    await updateAuditLro({
      op_id,
      status: "succeeded",
      result,
      progress_summary: {
        ...lastProgress,
        phase: "done",
        bucket: result.bucket,
        prefix: result.prefix,
        pages_seen: lastProgress?.pages_seen ?? 0,
        objects_seen: result.object_count,
        bytes_seen: result.total_bytes,
        expected_total_objects: result.object_count,
        expected_total_bytes: result.total_bytes,
        progress: 1,
        elapsed_ms: lastProgress?.elapsed_ms ?? 0,
        objects_per_second: lastProgress?.objects_per_second,
        bytes_per_second: lastProgress?.bytes_per_second,
        message: "audit complete",
      },
    });
  } catch (err) {
    const message = errorMessage(err);
    logger.warn("R2 audit LRO failed", { op_id, bucket, err });
    await updateAuditLro({
      op_id,
      status: "failed",
      error: message,
      progress_summary: {
        phase: "done",
        bucket,
        prefix,
        pages_seen: 0,
        objects_seen: 0,
        bytes_seen: 0,
        elapsed_ms: 0,
        message,
      },
    });
  }
}

function bayBackupCleanupConfirmation({
  bucket,
  prefix,
  objectCount,
  totalBytes,
}: {
  bucket: string;
  prefix: string;
  objectCount: number;
  totalBytes: number;
}): string {
  return `delete direct bay backups from ${bucket}/${prefix}: ${objectCount} objects ${totalBytes} bytes`;
}

function classifyBayBackupCleanupKey(
  key: string,
): "wal" | "manifest" | "other" {
  if (/^bay-backups\/[^/]+\/wal\/[^/]+$/.test(key)) return "wal";
  if (/^bay-backups\/[^/]+\/[^/]+\/manifest\.json$/.test(key)) {
    return "manifest";
  }
  return "other";
}

function bayPrefixForCleanupKey(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "bay-backups";
}

export async function getCloudflareR2BayBackupCleanupPlan({
  bucket,
  prefix,
}: {
  bucket: string;
  prefix?: string;
}): Promise<CloudflareR2BayBackupCleanupPlan> {
  const { bucketName, bucketPrefix, auth } = await getR2S3Auth(bucket);
  if (bucketPrefix && !bucketName.startsWith(`${bucketPrefix}-`)) {
    throw new Error(
      `refusing bay backup cleanup for bucket '${bucketName}' because it does not match configured r2_bucket_prefix '${bucketPrefix}-'`,
    );
  }
  const cleanupPrefix = normalizeBayBackupCleanupPrefix(prefix);
  const bayPrefixes = new Map<
    string,
    { object_count: number; total_bytes: number }
  >();
  let objectCount = 0;
  let totalBytes = 0;
  let walObjectCount = 0;
  let walTotalBytes = 0;
  let manifestObjectCount = 0;
  let manifestTotalBytes = 0;
  let otherObjectCount = 0;
  let otherTotalBytes = 0;

  await scanR2Objects({
    auth,
    prefix: cleanupPrefix,
    onPage: (entries) => {
      for (const entry of entries) {
        objectCount += 1;
        totalBytes += entry.size;
        addToMap(bayPrefixes, bayPrefixForCleanupKey(entry.key), entry.size);
        const kind = classifyBayBackupCleanupKey(entry.key);
        if (kind === "wal") {
          walObjectCount += 1;
          walTotalBytes += entry.size;
        } else if (kind === "manifest") {
          manifestObjectCount += 1;
          manifestTotalBytes += entry.size;
        } else {
          otherObjectCount += 1;
          otherTotalBytes += entry.size;
        }
      }
    },
  });

  return {
    bucket: bucketName,
    prefix: cleanupPrefix,
    checked_at: new Date().toISOString(),
    object_count: objectCount,
    total_bytes: totalBytes,
    wal_object_count: walObjectCount,
    wal_total_bytes: walTotalBytes,
    manifest_object_count: manifestObjectCount,
    manifest_total_bytes: manifestTotalBytes,
    other_object_count: otherObjectCount,
    other_total_bytes: otherTotalBytes,
    bay_prefixes: [...bayPrefixes.entries()]
      .map(([prefixName, value]) => ({ prefix: prefixName, ...value }))
      .sort((a, b) => b.total_bytes - a.total_bytes),
    confirmation_text: bayBackupCleanupConfirmation({
      bucket: bucketName,
      prefix: cleanupPrefix,
      objectCount,
      totalBytes,
    }),
    warnings:
      objectCount > 0
        ? [
            "Deleting these objects removes direct R2 WAL/PITR coverage for bay database backups under this prefix.",
          ]
        : [],
    notes: [
      "This plan only covers direct R2 objects under bay-backups/*.",
      "It does not delete rustic bay backup repositories under rustic/bay-backups/*.",
      "After deleting direct bay backup objects, run a fresh bay backup to start a new recoverable database backup chain.",
    ],
  };
}

function makeBayBackupCleanupProgress({
  phase,
  bucket,
  prefix,
  objectsTotal,
  bytesTotal,
  objectsSeen,
  bytesSeen,
  objectsDeleted,
  bytesDeleted,
  startedAt,
}: {
  phase: CloudflareR2BayBackupCleanupProgress["phase"];
  bucket: string;
  prefix: string;
  objectsTotal?: number;
  bytesTotal?: number;
  objectsSeen: number;
  bytesSeen: number;
  objectsDeleted: number;
  bytesDeleted: number;
  startedAt: number;
}): CloudflareR2BayBackupCleanupProgress {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const elapsedSeconds = elapsedMs / 1000;
  const objectsPerSecond =
    elapsedSeconds > 0
      ? Math.round((objectsDeleted / elapsedSeconds) * 10) / 10
      : undefined;
  return {
    phase,
    bucket,
    prefix,
    objects_total: objectsTotal,
    bytes_total: bytesTotal,
    objects_seen: objectsSeen,
    bytes_seen: bytesSeen,
    objects_deleted: objectsDeleted,
    bytes_deleted: bytesDeleted,
    elapsed_ms: elapsedMs,
    objects_per_second: objectsPerSecond,
    message:
      phase === "done"
        ? "bay backup cleanup complete"
        : phase === "deleting"
          ? "deleting direct bay backup objects"
          : phase === "scanning"
            ? "scanning direct bay backup objects"
            : "starting bay backup cleanup",
  };
}

async function updateBayBackupCleanupLro({
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
  progress_summary?: CloudflareR2BayBackupCleanupProgress;
}): Promise<LroSummary | undefined> {
  const summary = await updateLro({
    op_id,
    status,
    result,
    error,
    progress_summary,
    heartbeat_at: new Date(),
  });
  await publishAuditLroSummary(summary);
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

export async function runCloudflareR2BayBackupCleanupLro({
  op_id,
  bucket,
  prefix,
  confirm,
}: {
  op_id: string;
  bucket: string;
  prefix?: string;
  confirm: string;
}): Promise<void> {
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let objectsSeen = 0;
  let bytesSeen = 0;
  let objectsDeleted = 0;
  let bytesDeleted = 0;
  try {
    const plan = await getCloudflareR2BayBackupCleanupPlan({ bucket, prefix });
    if (confirm !== plan.confirmation_text) {
      throw new Error("confirmation text does not match cleanup plan");
    }
    const { auth } = await getR2S3Auth(plan.bucket);
    const publishProgress = async (
      phase: CloudflareR2BayBackupCleanupProgress["phase"],
      force = false,
    ) => {
      const now = Date.now();
      if (
        !force &&
        now - lastProgressAt < BAY_BACKUP_CLEANUP_PROGRESS_INTERVAL_MS
      ) {
        return;
      }
      lastProgressAt = now;
      await updateBayBackupCleanupLro({
        op_id,
        status: "running",
        progress_summary: makeBayBackupCleanupProgress({
          phase,
          bucket: plan.bucket,
          prefix: plan.prefix,
          objectsTotal: plan.object_count,
          bytesTotal: plan.total_bytes,
          objectsSeen,
          bytesSeen,
          objectsDeleted,
          bytesDeleted,
          startedAt,
        }),
      });
    };
    await publishProgress("starting", true);
    await scanR2Objects({
      auth,
      prefix: plan.prefix,
      onPage: async (entries) => {
        objectsSeen += entries.length;
        bytesSeen += entries.reduce((sum, entry) => sum + entry.size, 0);
        await publishProgress("scanning");
        const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
        await deleteR2ObjectsConcurrently({
          auth,
          keys: entries.map((entry) => entry.key),
          concurrency: BAY_BACKUP_CLEANUP_DELETE_CONCURRENCY,
          onDeleted: async (key) => {
            const entry = entryByKey.get(key);
            objectsDeleted += 1;
            bytesDeleted += entry?.size ?? 0;
            await publishProgress("deleting");
          },
        });
        await publishProgress("deleting");
      },
    });
    const progress = makeBayBackupCleanupProgress({
      phase: "done",
      bucket: plan.bucket,
      prefix: plan.prefix,
      objectsTotal: plan.object_count,
      bytesTotal: plan.total_bytes,
      objectsSeen,
      bytesSeen,
      objectsDeleted,
      bytesDeleted,
      startedAt,
    });
    await updateBayBackupCleanupLro({
      op_id,
      status: "succeeded",
      progress_summary: progress,
      result: {
        ...plan,
        deleted_at: new Date().toISOString(),
        deleted_object_count: objectsDeleted,
        deleted_total_bytes: bytesDeleted,
      },
    });
  } catch (err) {
    const message = errorMessage(err);
    logger.warn("R2 bay backup cleanup LRO failed", { op_id, bucket, err });
    await updateBayBackupCleanupLro({
      op_id,
      status: "failed",
      error: message,
      progress_summary: makeBayBackupCleanupProgress({
        phase: "done",
        bucket,
        prefix: prefix ?? "bay-backups/",
        objectsSeen,
        bytesSeen,
        objectsDeleted,
        bytesDeleted,
        startedAt,
      }),
    });
  }
}
