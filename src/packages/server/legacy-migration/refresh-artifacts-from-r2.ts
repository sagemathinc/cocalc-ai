/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { sendR2Request, sha256Hex } from "@cocalc/backend/r2";

const DEFAULT_BUCKET = "cocalc-projects";
const DEFAULT_PREFIX = "prod3/default/";
const DEFAULT_SUFFIX = ".tar.zst";
const DEFAULT_BATCH_SIZE = 2000;
const LIST_PAGE_SIZE = 1000;

type Options = {
  bucket: string;
  prefix: string;
  suffix: string;
  batchSize: number;
  dryRun: boolean;
  markMissingUnavailable: boolean;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  limitObjects?: number;
  limitPages?: number;
};

type R2Object = {
  key: string;
  size: number;
  etag?: string;
  lastModified?: string;
};

type Stats = {
  pages: number;
  listedObjects: number;
  matchedObjects: number;
  insertedTempRows: number;
  availableRows: number;
  unavailableRows: number;
  totalCompressedBytes: number;
};

type QueryClient = {
  query: <T = any>(
    text: string,
    values?: any[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/refresh-artifacts-from-r2.js [options]

Options:
  --bucket <name>       R2 bucket name. Default: ${DEFAULT_BUCKET}.
  --prefix <prefix>     Object key prefix to list. Default: ${DEFAULT_PREFIX}.
  --suffix <suffix>     Object key suffix for project archives. Default: ${DEFAULT_SUFFIX}.
  --batch-size <n>      Database insert batch size. Default: ${DEFAULT_BATCH_SIZE}.
  --endpoint <url>      R2 S3 endpoint. Defaults to COCALC_LEGACY_PROJECTS_R2_ENDPOINT
                        or https://<site r2_account_id>.r2.cloudflarestorage.com.
  --access-key <key>    R2 access key. Defaults to site setting r2_access_key_id.
  --secret-key <key>    R2 secret key. Defaults to site setting r2_secret_access_key.
  --limit-objects <n>   Stop after n listed objects. Implies --no-mark-missing-unavailable.
  --limit-pages <n>     Stop after n list pages. Implies --no-mark-missing-unavailable.
  --no-mark-missing-unavailable
                        Do not mark legacy project rows missing from the listing as unavailable.
  --dry-run             Run the listing and database updates in a rolled-back transaction.
  --help                Show this help.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    bucket: DEFAULT_BUCKET,
    prefix: DEFAULT_PREFIX,
    suffix: DEFAULT_SUFFIX,
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    markMissingUnavailable: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-mark-missing-unavailable") {
      options.markMissingUnavailable = false;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--bucket") {
      options.bucket = required(value, arg);
    } else if (arg === "--prefix") {
      options.prefix = required(value, arg);
    } else if (arg === "--suffix") {
      options.suffix = required(value, arg);
    } else if (arg === "--batch-size") {
      options.batchSize = positiveInt(value, arg);
    } else if (arg === "--endpoint") {
      options.endpoint = required(value, arg);
    } else if (arg === "--access-key") {
      options.accessKey = required(value, arg);
    } else if (arg === "--secret-key") {
      options.secretKey = required(value, arg);
    } else if (arg === "--limit-objects") {
      options.limitObjects = positiveInt(value, arg);
    } else if (arg === "--limit-pages") {
      options.limitPages = positiveInt(value, arg);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.limitObjects != null || options.limitPages != null) {
    options.markMissingUnavailable = false;
  }
  if (!options.prefix.endsWith("/")) {
    options.prefix = `${options.prefix}/`;
  }
  return options;
}

function required(value: string, name: string): string {
  const s = value.trim();
  if (!s) throw new Error(`${name} must not be empty`);
  return s;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

async function getR2Auth(options: Options) {
  const settings = await getServerSettings();
  const accountId = clean((settings as any).r2_account_id);
  const endpoint =
    clean(options.endpoint) ??
    clean(process.env.COCALC_LEGACY_PROJECTS_R2_ENDPOINT) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const accessKey =
    clean(options.accessKey) ?? clean((settings as any).r2_access_key_id);
  const secretKey =
    clean(options.secretKey) ?? clean((settings as any).r2_secret_access_key);
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("missing R2 credentials for legacy artifact refresh");
  }
  return {
    endpoint,
    accessKey,
    secretKey,
    bucket: options.bucket,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstXmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match?.[1] != null ? decodeXml(match[1]) : undefined;
}

function parseListObjectsXml(xml: string): {
  objects: R2Object[];
  nextContinuationToken?: string;
  isTruncated: boolean;
} {
  const objects: R2Object[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/gi;
  let match: RegExpExecArray | null;
  while ((match = contentsRe.exec(xml)) != null) {
    const block = match[1] ?? "";
    const key = firstXmlValue(block, "Key");
    if (!key) continue;
    const size = Number(firstXmlValue(block, "Size"));
    objects.push({
      key,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      etag: firstXmlValue(block, "ETag")?.replace(/^"|"$/g, ""),
      lastModified: firstXmlValue(block, "LastModified"),
    });
  }
  return {
    objects,
    nextContinuationToken: firstXmlValue(xml, "NextContinuationToken"),
    isTruncated: firstXmlValue(xml, "IsTruncated") === "true",
  };
}

function legacyProjectIdFromKey(
  key: string,
  { prefix, suffix }: Pick<Options, "prefix" | "suffix">,
): string | undefined {
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  const projectId = key.slice(prefix.length, key.length - suffix.length);
  return projectId.trim() || undefined;
}

async function* listR2Objects(
  options: Options,
): AsyncGenerator<R2Object[], void> {
  const auth = await getR2Auth(options);
  let continuationToken: string | undefined;
  let pages = 0;
  let remainingObjects = options.limitObjects;
  while (true) {
    if (options.limitPages != null && pages >= options.limitPages) return;
    const response = await sendR2Request({
      auth,
      method: "GET",
      payloadSha256: sha256Hex(""),
      query: {
        "list-type": 2,
        prefix: options.prefix,
        "max-keys": LIST_PAGE_SIZE,
        "continuation-token": continuationToken,
      },
      label: `R2 LIST ${options.bucket}/${options.prefix}`,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `R2 list failed (${response.statusCode}): ${response.body.toString("utf8")}`,
      );
    }
    const parsed = parseListObjectsXml(response.body.toString("utf8"));
    pages += 1;
    const objects =
      remainingObjects == null
        ? parsed.objects
        : parsed.objects.slice(0, remainingObjects);
    yield objects;
    if (remainingObjects != null) {
      remainingObjects -= objects.length;
    }
    if (remainingObjects != null && remainingObjects <= 0) {
      return;
    }
    if (!parsed.isTruncated || !parsed.nextContinuationToken) return;
    continuationToken = parsed.nextContinuationToken;
  }
}

async function createTempTable(client: QueryClient): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE legacy_migration_r2_artifacts_refresh (
      legacy_project_id TEXT PRIMARY KEY,
      artifact_key TEXT NOT NULL,
      artifact_bytes BIGINT NOT NULL,
      etag TEXT,
      last_modified TIMESTAMPTZ
    ) ON COMMIT DROP
  `);
}

async function insertTempBatch({
  client,
  rows,
}: {
  client: QueryClient;
  rows: Array<{
    legacy_project_id: string;
    artifact_key: string;
    artifact_bytes: number;
    etag?: string;
    last_modified?: string;
  }>;
}): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await client.query(
    `
    WITH input AS (
      SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          legacy_project_id TEXT,
          artifact_key TEXT,
          artifact_bytes BIGINT,
          etag TEXT,
          last_modified TIMESTAMPTZ
        )
    )
    INSERT INTO legacy_migration_r2_artifacts_refresh (
      legacy_project_id,
      artifact_key,
      artifact_bytes,
      etag,
      last_modified
    )
    SELECT legacy_project_id,
           artifact_key,
           COALESCE(artifact_bytes, 0),
           etag,
           last_modified
      FROM input
     WHERE COALESCE(legacy_project_id, '') <> ''
       AND COALESCE(artifact_key, '') <> ''
    ON CONFLICT (legacy_project_id) DO UPDATE SET
      artifact_key=EXCLUDED.artifact_key,
      artifact_bytes=EXCLUDED.artifact_bytes,
      etag=EXCLUDED.etag,
      last_modified=EXCLUDED.last_modified
    `,
    [JSON.stringify(rows)],
  );
  return rowCount ?? 0;
}

async function applyAvailabilityRefresh({
  client,
  options,
}: {
  client: QueryClient;
  options: Options;
}): Promise<Pick<Stats, "availableRows" | "unavailableRows">> {
  const available = await client.query(
    `
    UPDATE legacy_migration_projects p
       SET artifact_bucket=$1::text,
           artifact_key=r.artifact_key,
           artifact_status='available',
           artifact_manifest=jsonb_strip_nulls(
             COALESCE(p.artifact_manifest, '{}'::jsonb)
             || jsonb_build_object(
                  'artifact_bytes', r.artifact_bytes,
                  'compressed_bytes', r.artifact_bytes,
                  'r2_bucket', $1::text,
                  'r2_key', r.artifact_key,
                  'r2_etag', r.etag,
                  'r2_last_modified', r.last_modified,
                  'r2_refreshed_at', NOW()
                )
           ),
           updated=NOW()
      FROM legacy_migration_r2_artifacts_refresh r
     WHERE p.legacy_project_id=r.legacy_project_id
    `,
    [options.bucket],
  );

  let unavailableRows = 0;
  if (options.markMissingUnavailable) {
    const unavailable = await client.query(
      `
      UPDATE legacy_migration_projects p
         SET artifact_key=NULL,
             artifact_status='unavailable',
             artifact_manifest=jsonb_strip_nulls(
               COALESCE(p.artifact_manifest, '{}'::jsonb)
               || jsonb_build_object(
                    'r2_bucket', $1::text,
                    'r2_key', NULL::text,
                    'r2_missing', true,
                    'r2_refreshed_at', NOW()
                  )
             ),
             updated=NOW()
       WHERE (p.artifact_bucket IS NULL OR p.artifact_bucket=$1::text)
         AND (
           p.artifact_key IS NULL
           OR p.artifact_key=$2::text || p.legacy_project_id || $3::text
           OR p.artifact_key LIKE $2::text || '%'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM legacy_migration_r2_artifacts_refresh r
            WHERE r.legacy_project_id=p.legacy_project_id
         )
      `,
      [options.bucket, options.prefix, options.suffix],
    );
    unavailableRows = unavailable.rowCount ?? 0;
  }

  return {
    availableRows: available.rowCount ?? 0,
    unavailableRows,
  };
}

async function refreshArtifactsFromR2(options: Options): Promise<Stats> {
  const client = await pool().connect();
  const stats: Stats = {
    pages: 0,
    listedObjects: 0,
    matchedObjects: 0,
    insertedTempRows: 0,
    availableRows: 0,
    unavailableRows: 0,
    totalCompressedBytes: 0,
  };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30min'");
    await createTempTable(client);
    const batch: Array<{
      legacy_project_id: string;
      artifact_key: string;
      artifact_bytes: number;
      etag?: string;
      last_modified?: string;
    }> = [];
    for await (const objects of listR2Objects(options)) {
      stats.pages += 1;
      stats.listedObjects += objects.length;
      for (const object of objects) {
        const legacyProjectId = legacyProjectIdFromKey(object.key, options);
        if (!legacyProjectId) continue;
        stats.matchedObjects += 1;
        stats.totalCompressedBytes += object.size;
        batch.push({
          legacy_project_id: legacyProjectId,
          artifact_key: object.key,
          artifact_bytes: object.size,
          etag: object.etag,
          last_modified: object.lastModified,
        });
        if (batch.length >= options.batchSize) {
          stats.insertedTempRows += await insertTempBatch({
            client,
            rows: batch,
          });
          batch.length = 0;
        }
      }
    }
    if (batch.length > 0) {
      stats.insertedTempRows += await insertTempBatch({ client, rows: batch });
    }
    const updated = await applyAvailabilityRefresh({ client, options });
    stats.availableRows = updated.availableRows;
    stats.unavailableRows = updated.unavailableRows;
    await client.query(options.dryRun ? "ROLLBACK" : "COMMIT");
    return stats;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `refreshing legacy artifacts from R2 ${options.bucket}/${options.prefix} (${options.suffix})${options.dryRun ? " [dry-run]" : ""}`,
  );
  const stats = await refreshArtifactsFromR2(options);
  console.log(`listed ${stats.listedObjects.toLocaleString()} object(s)`);
  console.log(`matched ${stats.matchedObjects.toLocaleString()} archive(s)`);
  console.log(`processed ${stats.pages.toLocaleString()} list page(s)`);
  console.log(
    `total compressed archive bytes: ${formatBytes(stats.totalCompressedBytes)}`,
  );
  console.log(
    `${options.dryRun ? "would mark" : "marked"} ${stats.availableRows.toLocaleString()} project(s) available`,
  );
  if (options.markMissingUnavailable) {
    console.log(
      `${options.dryRun ? "would mark" : "marked"} ${stats.unavailableRows.toLocaleString()} project(s) unavailable`,
    );
  } else {
    console.log("missing projects were not marked unavailable");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
  });
