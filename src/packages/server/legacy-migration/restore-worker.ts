/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import { getAccountStorageRemainingBytes } from "@cocalc/server/membership/project-limits";
import { issueSignedObjectDownload } from "@cocalc/server/project-backup/r2";

import { isLegacyMigrationEnabled } from "./enabled";
import { legacyProjectArchiveUncompressedBytes } from "./index";

const logger = getLogger("server:legacy-migration:restore-worker");

const WORKER_ID = randomUUID();
const TICK_MS = 10_000;
const LEASE_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_PARALLEL = 1;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;
const DEFAULT_LEGACY_PROJECTS_BUCKET = "cocalc-projects";

let running = false;
let inFlight = 0;
let schemaReady: Promise<void> | undefined;

type LegacyRestoreRow = {
  legacy_project_id: string;
  project_id: string;
  owner_account_id: string;
  artifact_bucket: string | null;
  artifact_key: string;
  artifact_manifest: Record<string, any> | null;
};

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

async function ensureLegacyMigrationRestoreSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE legacy_migration_project_imports
        ADD COLUMN IF NOT EXISTS restore_attempts INTEGER,
        ADD COLUMN IF NOT EXISTS restore_mode VARCHAR(32),
        ADD COLUMN IF NOT EXISTS restore_worker_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS restore_claimed_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_started TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_finished TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_result JSONB
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS legacy_migration_project_imports_restore_claimed_until_idx
        ON legacy_migration_project_imports(restore_claimed_until)
    `);
  })();
  await schemaReady;
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function nestedValue(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function manifestNumber(
  manifest: Record<string, any> | null | undefined,
  paths: string[][],
): number | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  for (const path of paths) {
    const value = positiveInteger(nestedValue(manifest, path));
    if (value != null) return value;
  }
  return undefined;
}

function manifestCompressedBytes(
  manifest: Record<string, any> | null | undefined,
): number | undefined {
  return manifestNumber(manifest, [
    ["compressed_bytes"],
    ["compressed_size_bytes"],
    ["artifact_bytes"],
    ["object_bytes"],
    ["r2_bytes"],
    ["archive", "compressed_bytes"],
    ["archive", "object_bytes"],
    ["artifact", "bytes"],
  ]);
}

function manifestSha256(
  manifest: Record<string, any> | null | undefined,
): string | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["sha256"],
    ["content_sha256"],
    ["artifact_sha256"],
    ["compressed_sha256"],
    ["object_sha256"],
    ["archive", "sha256"],
    ["archive", "compressed_sha256"],
    ["artifact", "sha256"],
  ];
  for (const path of paths) {
    const value = clean(nestedValue(manifest, path));
    if (value) return value.toLowerCase();
  }
  return undefined;
}

async function getR2Credentials(): Promise<{
  endpoint: string;
  accessKey: string;
  secretKey: string;
}> {
  const settings = await getServerSettings();
  const accountId = clean((settings as any).r2_account_id);
  const accessKey = clean((settings as any).r2_access_key_id);
  const secretKey = clean((settings as any).r2_secret_access_key);
  const endpoint =
    clean(process.env.COCALC_LEGACY_PROJECTS_R2_ENDPOINT) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("missing R2 credentials for legacy project restore");
  }
  return { endpoint, accessKey, secretKey };
}

async function claimRestoreRows(limit: number): Promise<LegacyRestoreRow[]> {
  await ensureLegacyMigrationRestoreSchema();
  const { rows } = await getPool().query<LegacyRestoreRow>(
    `
    WITH next AS (
      SELECT i.legacy_project_id
        FROM legacy_migration_project_imports i
        JOIN legacy_migration_projects p
          ON p.legacy_project_id=i.legacy_project_id
       WHERE i.project_id IS NOT NULL
         AND i.owner_account_id IS NOT NULL
         AND COALESCE(i.restore_mode, 'full') = 'full'
         AND COALESCE(p.artifact_key, '') <> ''
         AND COALESCE(p.artifact_status, '') = 'available'
         AND (
           i.restore_status = 'pending'
           OR (
             i.restore_status = 'restoring'
             AND (
               i.restore_claimed_until IS NULL
               OR i.restore_claimed_until < NOW()
             )
           )
         )
       ORDER BY i.updated ASC NULLS FIRST, i.legacy_project_id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
    )
    UPDATE legacy_migration_project_imports i
       SET restore_status='restoring',
           restore_error=NULL,
           restore_attempts=COALESCE(i.restore_attempts, 0) + 1,
           restore_worker_id=$1,
           restore_claimed_until=NOW() + ($2::INT * INTERVAL '1 millisecond'),
           restore_started=NOW(),
           restore_finished=NULL,
           updated=NOW()
      FROM next
      JOIN legacy_migration_projects p
        ON p.legacy_project_id=next.legacy_project_id
     WHERE i.legacy_project_id=next.legacy_project_id
    RETURNING i.legacy_project_id,
              i.project_id,
              i.owner_account_id,
              p.artifact_bucket,
              p.artifact_key,
              p.artifact_manifest
    `,
    [WORKER_ID, LEASE_MS, limit],
  );
  return rows;
}

async function heartbeat(row: LegacyRestoreRow): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_claimed_until=NOW() + ($3::INT * INTERVAL '1 millisecond'),
           updated=NOW()
     WHERE legacy_project_id=$1
       AND restore_worker_id=$2
       AND restore_status='restoring'
    `,
    [row.legacy_project_id, WORKER_ID, LEASE_MS],
  );
}

async function markRestored({
  row,
  result,
}: {
  row: LegacyRestoreRow;
  result: Record<string, any>;
}): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status='restored',
           restore_error=NULL,
           restore_claimed_until=NULL,
           restore_worker_id=$2,
           restore_finished=NOW(),
           restore_result=$3::JSONB,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [row.legacy_project_id, WORKER_ID, JSON.stringify(result)],
  );
}

async function markFailed({
  row,
  err,
}: {
  row: LegacyRestoreRow;
  err: unknown;
}): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status='failed',
           restore_error=$3,
           restore_claimed_until=NULL,
           restore_worker_id=$2,
           restore_finished=NOW(),
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [row.legacy_project_id, WORKER_ID, `${err}`.slice(0, 4000)],
  );
}

async function accountStorageRestoreLimitBytes(
  row: LegacyRestoreRow,
): Promise<number | undefined> {
  const remaining = await getAccountStorageRemainingBytes({
    account_id: row.owner_account_id,
    fresh: true,
  });
  if (remaining == null) return undefined;
  return Math.max(0, Math.floor(remaining));
}

async function assertKnownArchiveFitsLimit({
  row,
  max_uncompressed_bytes,
}: {
  row: LegacyRestoreRow;
  max_uncompressed_bytes?: number;
}): Promise<void> {
  if (max_uncompressed_bytes == null) return;
  const archiveBytes = legacyProjectArchiveUncompressedBytes(
    row.artifact_manifest,
  );
  if (archiveBytes == null) return;
  if (archiveBytes > max_uncompressed_bytes) {
    throw new Error(
      `legacy project archive is too large for current storage quota (${archiveBytes} > ${max_uncompressed_bytes} bytes)`,
    );
  }
}

async function restoreOne(row: LegacyRestoreRow): Promise<void> {
  const heartbeatTimer = setInterval(() => {
    void heartbeat(row).catch((err) => {
      logger.warn("legacy migration restore heartbeat failed", {
        legacy_project_id: row.legacy_project_id,
        project_id: row.project_id,
        err: `${err}`,
      });
    });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
  try {
    const bucket =
      clean(row.artifact_bucket) ??
      clean(process.env.COCALC_LEGACY_PROJECTS_BUCKET) ??
      DEFAULT_LEGACY_PROJECTS_BUCKET;
    const key = clean(row.artifact_key);
    if (!key) {
      throw new Error("legacy project archive key is missing");
    }
    const max_uncompressed_bytes = await accountStorageRestoreLimitBytes(row);
    await assertKnownArchiveFitsLimit({ row, max_uncompressed_bytes });
    const { endpoint, accessKey, secretKey } = await getR2Credentials();
    const signed = issueSignedObjectDownload({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      key,
    });
    const client = await getProjectFileServerClient({
      project_id: row.project_id,
      account_id: row.owner_account_id,
      timeout: RESTORE_TIMEOUT_MS,
    });
    await ensureProjectFileServerClientReady({
      project_id: row.project_id,
      client,
      maxWait: FILE_SERVER_READY_TIMEOUT_MS,
    });
    const result = await client.restoreProjectArchive({
      project_id: row.project_id,
      download: {
        ...signed,
        bucket,
        key,
        bytes: manifestCompressedBytes(row.artifact_manifest),
        sha256: manifestSha256(row.artifact_manifest),
      },
      max_uncompressed_bytes,
    });
    await markRestored({
      row,
      result: {
        ...result,
        artifact_bucket: bucket,
        artifact_key: key,
        restored_at: new Date().toISOString(),
        worker_id: WORKER_ID,
      },
    });
  } catch (err) {
    await markFailed({ row, err });
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function triggerLegacyMigrationProjectRestoreWorker({
  maxParallel = DEFAULT_MAX_PARALLEL,
}: {
  maxParallel?: number;
} = {}): Promise<void> {
  if (!(await isLegacyMigrationEnabled())) return;
  if (inFlight >= maxParallel) return;
  let rows: LegacyRestoreRow[] = [];
  try {
    rows = await claimRestoreRows(Math.max(1, maxParallel - inFlight));
  } catch (err) {
    logger.warn("legacy migration restore claim failed", { err: `${err}` });
    return;
  }
  for (const row of rows) {
    inFlight += 1;
    void restoreOne(row)
      .catch((err) => {
        logger.warn("legacy migration project restore failed", {
          legacy_project_id: row.legacy_project_id,
          project_id: row.project_id,
          err: `${err}`,
        });
      })
      .finally(() => {
        inFlight = Math.max(0, inFlight - 1);
      });
  }
}

export function startLegacyMigrationProjectRestoreWorker({
  intervalMs = TICK_MS,
  maxParallel = DEFAULT_MAX_PARALLEL,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting legacy migration project restore worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel,
  });
  const tick = () => {
    void triggerLegacyMigrationProjectRestoreWorker({ maxParallel });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    running = false;
    clearInterval(timer);
  };
}
