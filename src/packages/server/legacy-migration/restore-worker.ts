/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import { envToInt } from "@cocalc/backend/misc/env-to-number";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import { materializeRemoteProjectHostTarget } from "@cocalc/server/conat/route-project";
import { issueSignedObjectDownload } from "@cocalc/server/project-backup/r2";
import { createLro, touchLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { setProjectLabels } from "@cocalc/server/projects/labels";
import { upsertLegacyMigrationProjectDiskQuotaOverride } from "@cocalc/server/membership/project-entitlement-overrides";
import {
  LEGACY_PROJECT_RESTORE_LRO_KIND,
  LEGACY_RESTORE_ERROR_LABEL,
  LEGACY_RESTORE_LRO_LABEL,
  LEGACY_RESTORE_STATUS_LABEL,
} from "@cocalc/util/legacy-migration";

import { isLegacyMigrationEnabled } from "./enabled";

const logger = getLogger("server:legacy-migration:restore-worker");

const WORKER_ID = randomUUID();
const TICK_MS = 10_000;
const LEASE_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const PRE_START_STALE_MS = Math.max(
  60_000,
  envToInt("COCALC_LEGACY_PROJECT_RESTORE_PRE_START_STALE_MS", 2 * 60 * 1000),
);
const ABANDONED_HEARTBEAT_MS = Math.max(
  HEARTBEAT_MS * 2,
  envToInt(
    "COCALC_LEGACY_PROJECT_RESTORE_ABANDONED_HEARTBEAT_MS",
    2 * 60 * 1000,
  ),
);
const ABANDONED_CLAIM_THRESHOLD_MS = Math.max(
  1,
  LEASE_MS - ABANDONED_HEARTBEAT_MS,
);
const DEFAULT_MAX_PARALLEL_TOTAL = Math.max(
  1,
  envToInt(
    "COCALC_LEGACY_PROJECT_RESTORE_MAX_PARALLEL_TOTAL",
    envToInt("COCALC_LEGACY_PROJECT_RESTORE_MAX_PARALLEL", 30),
  ),
);
const DEFAULT_MAX_PARALLEL_PER_HOST = Math.max(
  1,
  envToInt("COCALC_LEGACY_PROJECT_RESTORE_MAX_PARALLEL_PER_HOST", 3),
);
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const PROJECT_HOST_RESTORE_RPC_TIMEOUT_MS = Math.max(
  5 * 60 * 1000,
  envToInt("COCALC_LEGACY_PROJECT_RESTORE_HOST_RPC_TIMEOUT_MS", 30 * 60 * 1000),
);
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;
const DEFAULT_LEGACY_PROJECTS_BUCKET = "cocalc-projects";
const RESTORED_PROJECT_QUOTA_HEADROOM_MB = Math.max(
  0,
  envToInt("COCALC_LEGACY_PROJECT_RESTORE_QUOTA_HEADROOM_MB", 1024),
);

let running = false;
let inFlight = 0;
let schemaReady: Promise<void> | undefined;

type LegacyRestoreRow = {
  legacy_project_id: string;
  project_id: string;
  owner_account_id: string;
  host_id: string;
  artifact_bucket: string | null;
  artifact_key: string;
  artifact_manifest: Record<string, any> | null;
  restore_lro_op_id: string | null;
};

type RestoreCandidateRow = {
  legacy_project_id: string;
  project_id: string;
  owner_account_id: string;
};

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

function withTimeout<T>({
  promise,
  timeoutMs,
  message,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  message: string;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function ensureLegacyMigrationRestoreSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE legacy_migration_project_imports
        ADD COLUMN IF NOT EXISTS restore_attempts INTEGER,
        ADD COLUMN IF NOT EXISTS restore_mode VARCHAR(32),
        ADD COLUMN IF NOT EXISTS restore_worker_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS restore_host_id UUID,
        ADD COLUMN IF NOT EXISTS restore_claimed_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_started TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_finished TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_lro_op_id UUID,
        ADD COLUMN IF NOT EXISTS restore_progress JSONB,
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

function restoredProjectDiskQuotaMb(
  restored_bytes: unknown,
): number | undefined {
  const bytes = positiveInteger(restored_bytes);
  if (bytes == null) return;
  return Math.ceil(bytes / 1_000_000) + RESTORED_PROJECT_QUOTA_HEADROOM_MB;
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

async function claimRestoreRows({
  maxParallelTotal,
  maxParallelPerHost,
}: {
  maxParallelTotal: number;
  maxParallelPerHost: number;
}): Promise<LegacyRestoreRow[]> {
  await ensureLegacyMigrationRestoreSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('legacy-migration-project-restore-claim'))",
    );

    const activeByHost = new Map<string, number>();
    const active = await client.query<{
      host_id: string;
      active: string;
    }>(
      `
      SELECT i.restore_host_id::TEXT AS host_id,
             COUNT(*)::TEXT AS active
        FROM legacy_migration_project_imports i
       WHERE i.restore_status='restoring'
         AND i.restore_claimed_until IS NOT NULL
         AND i.restore_claimed_until >= NOW()
         AND i.restore_host_id IS NOT NULL
         AND NOT (
           COALESCE(i.restore_progress->>'phase', '') = 'queued'
           AND i.restore_started IS NOT NULL
           AND i.restore_started < NOW() - ($1::INT * INTERVAL '1 millisecond')
         )
         AND NOT (
           i.restore_claimed_until < NOW() + ($2::INT * INTERVAL '1 millisecond')
         )
       GROUP BY i.restore_host_id
    `,
      [PRE_START_STALE_MS, ABANDONED_CLAIM_THRESHOLD_MS],
    );
    let activeTotal = 0;
    for (const row of active.rows) {
      const count = Math.max(0, Number(row.active) || 0);
      activeByHost.set(row.host_id, count);
      activeTotal += count;
    }
    const remainingTotal = Math.max(0, maxParallelTotal - activeTotal);
    if (remainingTotal <= 0) {
      await client.query("COMMIT");
      return [];
    }

    const candidateWindow = Math.max(1000, remainingTotal * 20);
    const candidates = await client.query<RestoreCandidateRow>(
      `
      SELECT i.legacy_project_id,
             i.project_id::TEXT AS project_id,
             i.owner_account_id::TEXT AS owner_account_id
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
               OR (
                 COALESCE(i.restore_progress->>'phase', '') = 'queued'
                 AND i.restore_started IS NOT NULL
                 AND i.restore_started < NOW() - ($2::INT * INTERVAL '1 millisecond')
               )
               OR (
                 i.restore_claimed_until IS NOT NULL
                 AND i.restore_claimed_until < NOW() + ($3::INT * INTERVAL '1 millisecond')
               )
             )
           )
         )
       ORDER BY i.updated ASC NULLS FIRST, i.legacy_project_id
       LIMIT $1
      `,
      [candidateWindow, PRE_START_STALE_MS, ABANDONED_CLAIM_THRESHOLD_MS],
    );

    const claimed: LegacyRestoreRow[] = [];
    for (const candidate of candidates.rows) {
      if (claimed.length >= remainingTotal) break;
      let target:
        | Awaited<ReturnType<typeof materializeRemoteProjectHostTarget>>
        | undefined;
      try {
        target = await materializeRemoteProjectHostTarget({
          account_id: candidate.owner_account_id,
          project_id: candidate.project_id,
        });
      } catch (err) {
        logger.warn("legacy migration restore candidate route failed", {
          legacy_project_id: candidate.legacy_project_id,
          project_id: candidate.project_id,
          err: `${err}`,
        });
        continue;
      }
      const hostId = `${target?.host_id ?? ""}`.trim();
      if (!hostId) {
        logger.debug("legacy migration restore candidate has no routed host", {
          legacy_project_id: candidate.legacy_project_id,
          project_id: candidate.project_id,
        });
        continue;
      }
      const activeForHost = activeByHost.get(hostId) ?? 0;
      if (activeForHost >= maxParallelPerHost) continue;

      const updated = await client.query<LegacyRestoreRow>(
        `
        UPDATE legacy_migration_project_imports i
           SET restore_status='restoring',
               restore_error=NULL,
               restore_attempts=COALESCE(i.restore_attempts, 0) + 1,
               restore_worker_id=$1,
               restore_host_id=$4::UUID,
               restore_claimed_until=NOW() + ($2::INT * INTERVAL '1 millisecond'),
               restore_started=NOW(),
               restore_finished=NULL,
               updated=NOW()
          FROM legacy_migration_projects p
         WHERE i.legacy_project_id=$3
           AND p.legacy_project_id=i.legacy_project_id
           AND i.project_id IS NOT NULL
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
                 OR (
                   COALESCE(i.restore_progress->>'phase', '') = 'queued'
                   AND i.restore_started IS NOT NULL
                   AND i.restore_started < NOW() - ($5::INT * INTERVAL '1 millisecond')
                 )
                 OR (
                   i.restore_claimed_until IS NOT NULL
                   AND i.restore_claimed_until < NOW() + ($6::INT * INTERVAL '1 millisecond')
                 )
               )
             )
           )
        RETURNING i.legacy_project_id,
                  i.project_id,
                  i.owner_account_id,
                  $4::TEXT AS host_id,
                  p.artifact_bucket,
                  p.artifact_key,
                  p.artifact_manifest,
                  i.restore_lro_op_id
        `,
        [
          WORKER_ID,
          LEASE_MS,
          candidate.legacy_project_id,
          hostId,
          PRE_START_STALE_MS,
          ABANDONED_CLAIM_THRESHOLD_MS,
        ],
      );
      const row = updated.rows[0];
      if (!row) continue;
      claimed.push(row);
      activeByHost.set(hostId, activeForHost + 1);
    }

    await client.query("COMMIT");
    return claimed;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function progressSummary({
  phase,
  message,
  progress,
  detail,
}: {
  phase: string;
  message: string;
  progress: number;
  detail?: any;
}): Record<string, any> {
  return {
    phase,
    message,
    progress,
    ...(detail == null ? {} : { detail }),
    updated_at: new Date().toISOString(),
  };
}

function labelValue(value: unknown): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  return text.length > 512 ? text.slice(0, 512) : text;
}

async function setRestoreLabels({
  row,
  restore_status,
  restore_error,
}: {
  row: LegacyRestoreRow;
  restore_status: string;
  restore_error?: string | null;
}): Promise<void> {
  await setProjectLabels({
    project_id: row.project_id,
    account_id: row.owner_account_id,
    labels: {
      [LEGACY_RESTORE_STATUS_LABEL]: labelValue(restore_status),
      [LEGACY_RESTORE_LRO_LABEL]: labelValue(row.restore_lro_op_id),
      [LEGACY_RESTORE_ERROR_LABEL]: labelValue(restore_error),
    },
  }).catch((err) => {
    logger.warn("legacy migration restore label update failed", {
      legacy_project_id: row.legacy_project_id,
      project_id: row.project_id,
      restore_status,
      err: `${err}`,
    });
  });
}

async function ensureRestoreLro(row: LegacyRestoreRow): Promise<string> {
  if (row.restore_lro_op_id) return row.restore_lro_op_id;
  const op = await createLro({
    kind: LEGACY_PROJECT_RESTORE_LRO_KIND,
    scope_type: "project",
    scope_id: row.project_id,
    created_by: row.owner_account_id,
    owner_type: "hub",
    input: {
      legacy_project_id: row.legacy_project_id,
      project_id: row.project_id,
    },
    dedupe_key: `legacy-project-restore:${row.legacy_project_id}`,
    expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
  });
  row.restore_lro_op_id = op.op_id;
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_lro_op_id=$2,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [row.legacy_project_id, op.op_id],
  );
  return op.op_id;
}

async function publishRestoreProgress({
  row,
  phase,
  message,
  progress,
  detail,
}: {
  row: LegacyRestoreRow;
  phase: string;
  message: string;
  progress: number;
  detail?: any;
}): Promise<void> {
  const op_id = await ensureRestoreLro(row);
  const summary = progressSummary({ phase, message, progress, detail });
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_progress=$2::JSONB,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [row.legacy_project_id, JSON.stringify(summary)],
  );
  const updated = await updateLro({
    op_id,
    status: "running",
    progress_summary: summary,
    error: null,
  });
  if (updated) {
    await publishRestoreLroSummary({
      row,
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
  await publishRestoreLroEvent({
    row,
    scope_type: "project",
    scope_id: row.project_id,
    op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase,
      message,
      progress,
      detail,
    },
  });
}

async function publishRestoreLroSummary({
  row,
  scope_type,
  scope_id,
  summary,
}: {
  row: LegacyRestoreRow;
  scope_type: Parameters<typeof publishLroSummary>[0]["scope_type"];
  scope_id: string;
  summary: Parameters<typeof publishLroSummary>[0]["summary"];
}): Promise<void> {
  await publishLroSummary({ scope_type, scope_id, summary }).catch((err) => {
    logger.debug("legacy migration restore LRO summary publish failed", {
      legacy_project_id: row.legacy_project_id,
      project_id: row.project_id,
      op_id: summary.op_id,
      scope_type,
      scope_id,
      err: `${err}`,
    });
  });
}

async function publishRestoreLroEvent({
  row,
  scope_type,
  scope_id,
  op_id,
  event,
}: {
  row: LegacyRestoreRow;
  scope_type: Parameters<typeof publishLroEvent>[0]["scope_type"];
  scope_id: string;
  op_id: string;
  event: Parameters<typeof publishLroEvent>[0]["event"];
}): Promise<void> {
  await publishLroEvent({ scope_type, scope_id, op_id, event }).catch((err) => {
    logger.debug("legacy migration restore LRO event publish failed", {
      legacy_project_id: row.legacy_project_id,
      project_id: row.project_id,
      op_id,
      scope_type,
      scope_id,
      err: `${err}`,
    });
  });
}

async function heartbeat(row: LegacyRestoreRow): Promise<void> {
  const op_id = row.restore_lro_op_id;
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
  if (op_id) {
    await touchLro({
      op_id,
      owner_type: "hub",
      owner_id: WORKER_ID,
    }).catch(() => {});
  }
}

async function markRestored({
  row,
  result,
}: {
  row: LegacyRestoreRow;
  result: Record<string, any>;
}): Promise<void> {
  const op_id = await ensureRestoreLro(row);
  const summary = progressSummary({
    phase: "done",
    message: "restore complete",
    progress: 100,
    detail: result,
  });
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status='restored',
           restore_error=NULL,
           restore_claimed_until=NULL,
           restore_worker_id=$2,
           restore_finished=NOW(),
           restore_lro_op_id=$4,
           restore_progress=$5::JSONB,
           restore_result=$3::JSONB,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [
      row.legacy_project_id,
      WORKER_ID,
      JSON.stringify(result),
      op_id,
      JSON.stringify(summary),
    ],
  );
  const updated = await updateLro({
    op_id,
    status: "succeeded",
    result,
    progress_summary: summary,
    error: null,
  });
  if (updated) {
    await publishRestoreLroSummary({
      row,
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
  await setRestoreLabels({ row, restore_status: "restored" });
}

async function ensureRestoredProjectDiskQuota({
  row,
  result,
}: {
  row: LegacyRestoreRow;
  result: Record<string, any>;
}): Promise<number | undefined> {
  const quotaUsedBytes = positiveInteger(result.quota_used_bytes);
  const uncompressedBytes = positiveInteger(result.uncompressed_bytes);
  const desired = restoredProjectDiskQuotaMb(
    Math.max(quotaUsedBytes ?? 0, uncompressedBytes ?? 0),
  );
  if (desired == null) return;
  await upsertLegacyMigrationProjectDiskQuotaOverride({
    project_id: row.project_id,
    legacy_project_id: row.legacy_project_id,
    disk_quota_mb: desired,
    restored_used_bytes: quotaUsedBytes ?? uncompressedBytes,
    headroom_mb: RESTORED_PROJECT_QUOTA_HEADROOM_MB,
  });
  return desired;
}

async function markFailed({
  row,
  err,
}: {
  row: LegacyRestoreRow;
  err: unknown;
}): Promise<void> {
  const op_id = await ensureRestoreLro(row);
  const error = `${err}`.slice(0, 4000);
  const summary = progressSummary({
    phase: "failed",
    message: "restore failed",
    progress: 100,
    detail: { error },
  });
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status='failed',
           restore_error=$3,
           restore_claimed_until=NULL,
           restore_worker_id=$2,
           restore_finished=NOW(),
           restore_lro_op_id=$4,
           restore_progress=$5::JSONB,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [row.legacy_project_id, WORKER_ID, error, op_id, JSON.stringify(summary)],
  );
  const updated = await updateLro({
    op_id,
    status: "failed",
    error,
    progress_summary: summary,
  });
  if (updated) {
    await publishRestoreLroSummary({
      row,
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      summary: updated,
    });
  }
  await setRestoreLabels({
    row,
    restore_status: "failed",
    restore_error: error,
  });
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
    const op_id = await ensureRestoreLro(row);
    await setRestoreLabels({ row, restore_status: "restoring" });
    await publishRestoreProgress({
      row,
      phase: "validate",
      message: "validating restore request",
      progress: 5,
      detail: {
        legacy_project_id: row.legacy_project_id,
        project_id: row.project_id,
      },
    });
    const bucket =
      clean(row.artifact_bucket) ??
      clean(process.env.COCALC_LEGACY_PROJECTS_BUCKET) ??
      DEFAULT_LEGACY_PROJECTS_BUCKET;
    const key = clean(row.artifact_key);
    if (!key) {
      throw new Error("legacy project archive key is missing");
    }
    await publishRestoreProgress({
      row,
      phase: "authorize",
      message: "creating signed archive download",
      progress: 10,
      detail: { bucket, key },
    });
    const { endpoint, accessKey, secretKey } = await getR2Credentials();
    const signed = issueSignedObjectDownload({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      key,
    });
    await publishRestoreProgress({
      row,
      phase: "connect",
      message: "connecting to project host",
      progress: 15,
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
    await publishRestoreProgress({
      row,
      phase: "restore",
      message: "restoring archive on project host",
      progress: 20,
      detail: {
        artifact_bytes: manifestCompressedBytes(row.artifact_manifest),
        temporary_quota_grace: true,
      },
    });
    const result = await withTimeout({
      timeoutMs: PROJECT_HOST_RESTORE_RPC_TIMEOUT_MS,
      message: `project-host restore RPC timed out after ${PROJECT_HOST_RESTORE_RPC_TIMEOUT_MS}ms`,
      promise: client.restoreProjectArchive({
        project_id: row.project_id,
        download: {
          ...signed,
          bucket,
          key,
          bytes: manifestCompressedBytes(row.artifact_manifest),
          sha256: manifestSha256(row.artifact_manifest),
        },
        temporary_quota_grace: true,
        lro: { op_id, scope_type: "project", scope_id: row.project_id },
      }),
    });
    const restoredResult = {
      ...result,
      artifact_bucket: bucket,
      artifact_key: key,
      restored_at: new Date().toISOString(),
      worker_id: WORKER_ID,
    };
    const diskQuotaMb = await ensureRestoredProjectDiskQuota({
      row,
      result: restoredResult,
    });
    await markRestored({
      row,
      result: {
        ...restoredResult,
        ...(diskQuotaMb == null
          ? {}
          : { restored_project_disk_quota_mb: diskQuotaMb }),
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
  maxParallelTotal = DEFAULT_MAX_PARALLEL_TOTAL,
  maxParallelPerHost = DEFAULT_MAX_PARALLEL_PER_HOST,
}: {
  maxParallelTotal?: number;
  maxParallelPerHost?: number;
} = {}): Promise<void> {
  if (!(await isLegacyMigrationEnabled())) return;
  if (inFlight >= maxParallelTotal) return;
  let rows: LegacyRestoreRow[] = [];
  try {
    rows = await claimRestoreRows({
      maxParallelTotal,
      maxParallelPerHost,
    });
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
        void triggerLegacyMigrationProjectRestoreWorker({
          maxParallelTotal,
          maxParallelPerHost,
        }).catch((err) => {
          logger.warn("legacy migration restore follow-up trigger failed", {
            err: `${err}`,
          });
        });
      });
  }
}

export function startLegacyMigrationProjectRestoreWorker({
  intervalMs = TICK_MS,
  maxParallelTotal = DEFAULT_MAX_PARALLEL_TOTAL,
  maxParallelPerHost = DEFAULT_MAX_PARALLEL_PER_HOST,
}: {
  intervalMs?: number;
  maxParallelTotal?: number;
  maxParallelPerHost?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting legacy migration project restore worker", {
    worker_id: WORKER_ID,
    max_parallel_total: maxParallelTotal,
    max_parallel_per_host: maxParallelPerHost,
  });
  const tick = () => {
    void triggerLegacyMigrationProjectRestoreWorker({
      maxParallelTotal,
      maxParallelPerHost,
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    running = false;
    clearInterval(timer);
  };
}
