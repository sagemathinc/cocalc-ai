/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import getLogger from "@cocalc/backend/logger";
import { currentProjectVolumeQuotaEpoch } from "./filesystem-quota-state";

export type ProjectVolumeKind = "home" | "scratch";
export type ProjectVolumeQuotaState =
  | "pending"
  | "applying"
  | "applied"
  | "blocked"
  | "failed"
  | "missing";

export interface ProjectVolumeQuotaRow {
  project_id: string;
  volume_kind: ProjectVolumeKind;
  desired_bytes: number;
  desired_revision: number;
  applied_bytes?: number | null;
  applied_revision?: number | null;
  applied_epoch?: string | null;
  volume_identity?: string | null;
  state: ProjectVolumeQuotaState;
  reset_required: boolean;
  last_error?: string | null;
  desired_updated_at: number;
  apply_started_at?: number | null;
  applied_at?: number | null;
  next_audit_at?: number | null;
  updated_at: number;
}

export type DesiredQuotaAcceptance =
  | { status: "accepted" | "unchanged"; row: ProjectVolumeQuotaRow }
  | { status: "stale"; row: ProjectVolumeQuotaRow };

const TABLE = "project_volume_quotas";
const DEFAULT_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const logger = getLogger("project-host:sqlite:volume-quotas");
let initialized = false;

function positiveDurationMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stableAuditJitterMs(
  project_id: string,
  volume_kind: ProjectVolumeKind,
  intervalMs: number,
): number {
  let hash = volume_kind === "home" ? 17 : 31;
  for (const char of project_id) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return Math.floor((hash / 0xffffffff) * Math.max(1, intervalMs / 4));
}

export { currentProjectVolumeQuotaEpoch };

function ensureTable(): void {
  if (initialized) {
    const tableStillExists = getDatabase()
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(TABLE);
    if (tableStillExists) return;
    initialized = false;
  }
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      project_id TEXT NOT NULL,
      volume_kind TEXT NOT NULL,
      desired_bytes INTEGER NOT NULL,
      desired_revision INTEGER NOT NULL,
      applied_bytes INTEGER,
      applied_revision INTEGER,
      applied_epoch TEXT,
      volume_identity TEXT,
      state TEXT NOT NULL,
      reset_required INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      desired_updated_at INTEGER NOT NULL,
      apply_started_at INTEGER,
      applied_at INTEGER,
      next_audit_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, volume_kind)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_state_updated_idx ON ${TABLE}(state, updated_at)`,
  );
  try {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN next_audit_at INTEGER`);
  } catch {}
  try {
    db.exec(
      `ALTER TABLE ${TABLE} ADD COLUMN reset_required INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {}
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_audit_idx ON ${TABLE}(state, next_audit_at, updated_at)`,
  );
  initialized = true;
}

function parseRow(row: any): ProjectVolumeQuotaRow {
  return {
    project_id: `${row.project_id}`,
    volume_kind: row.volume_kind as ProjectVolumeKind,
    desired_bytes: Number(row.desired_bytes),
    desired_revision: Number(row.desired_revision),
    applied_bytes: row.applied_bytes == null ? null : Number(row.applied_bytes),
    applied_revision:
      row.applied_revision == null ? null : Number(row.applied_revision),
    applied_epoch: row.applied_epoch == null ? null : `${row.applied_epoch}`,
    volume_identity:
      row.volume_identity == null ? null : `${row.volume_identity}`,
    state: row.state as ProjectVolumeQuotaState,
    reset_required: row.reset_required === 1,
    last_error: row.last_error == null ? null : `${row.last_error}`,
    desired_updated_at: Number(row.desired_updated_at),
    apply_started_at:
      row.apply_started_at == null ? null : Number(row.apply_started_at),
    applied_at: row.applied_at == null ? null : Number(row.applied_at),
    next_audit_at: row.next_audit_at == null ? null : Number(row.next_audit_at),
    updated_at: Number(row.updated_at),
  };
}

export function getProjectVolumeQuota(
  project_id: string,
  volume_kind: ProjectVolumeKind,
): ProjectVolumeQuotaRow | undefined {
  ensureTable();
  const row = getDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE project_id=? AND volume_kind=?`)
    .get(project_id, volume_kind);
  return row ? parseRow(row) : undefined;
}

export function acceptProjectVolumeQuotaDesired({
  project_id,
  volume_kind,
  desired_bytes,
  desired_revision,
  repair_same_revision = false,
}: {
  project_id: string;
  volume_kind: ProjectVolumeKind;
  desired_bytes: number;
  desired_revision?: number;
  repair_same_revision?: boolean;
}): DesiredQuotaAcceptance {
  ensureTable();
  const bytes = Math.max(0, Math.floor(desired_bytes));
  const existing = getProjectVolumeQuota(project_id, volume_kind);
  const revision =
    desired_revision == null
      ? 0
      : Math.max(0, Math.floor(Number(desired_revision)));
  if (existing) {
    if (desired_revision == null && existing.desired_revision > 0) {
      return { status: "stale", row: existing };
    }
    if (revision < existing.desired_revision) {
      return { status: "stale", row: existing };
    }
    if (
      desired_revision != null &&
      revision === existing.desired_revision &&
      bytes !== existing.desired_bytes
    ) {
      if (!repair_same_revision) {
        throw new Error(
          `conflicting ${volume_kind} quota for project ${project_id} at revision ${revision}`,
        );
      }
      logger.warn("repairing conflicting versioned project volume quota", {
        project_id,
        volume_kind,
        desired_revision: revision,
        previous_desired_bytes: existing.desired_bytes,
        desired_bytes: bytes,
      });
    }
    if (
      desired_revision != null &&
      revision === existing.desired_revision &&
      bytes === existing.desired_bytes
    ) {
      return { status: "unchanged", row: existing };
    }
  }

  const now = Date.now();
  const preserveApplied =
    existing?.applied_revision === revision &&
    existing?.applied_bytes === bytes;
  getDatabase()
    .prepare(
      `
        INSERT INTO ${TABLE} (
          project_id, volume_kind, desired_bytes, desired_revision,
          applied_bytes, applied_revision, applied_epoch, volume_identity,
          state, reset_required, last_error, desired_updated_at,
          apply_started_at, applied_at, next_audit_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, volume_kind) DO UPDATE SET
          desired_bytes=excluded.desired_bytes,
          desired_revision=excluded.desired_revision,
          state=excluded.state,
          reset_required=excluded.reset_required,
          last_error=NULL,
          desired_updated_at=excluded.desired_updated_at,
          next_audit_at=excluded.next_audit_at,
          updated_at=excluded.updated_at
      `,
    )
    .run(
      project_id,
      volume_kind,
      bytes,
      revision,
      existing?.applied_bytes ?? null,
      existing?.applied_revision ?? null,
      existing?.applied_epoch ?? null,
      existing?.volume_identity ?? null,
      preserveApplied ? (existing?.state ?? "applied") : "pending",
      existing?.reset_required ? 1 : 0,
      now,
      existing?.apply_started_at ?? null,
      existing?.applied_at ?? null,
      preserveApplied ? (existing?.next_audit_at ?? now) : now,
      now,
    );
  return {
    status: "accepted",
    row: getProjectVolumeQuota(project_id, volume_kind)!,
  };
}

export function projectVolumeQuotaIsApplied(
  row: ProjectVolumeQuotaRow,
  {
    volume_identity,
    epoch = currentProjectVolumeQuotaEpoch(),
  }: { volume_identity?: string; epoch?: string } = {},
): boolean {
  return (
    epoch != null &&
    volume_identity != null &&
    !row.reset_required &&
    row.state === "applied" &&
    row.applied_bytes === row.desired_bytes &&
    row.applied_revision === row.desired_revision &&
    row.applied_epoch === epoch &&
    (volume_identity == null || row.volume_identity === volume_identity)
  );
}

export function markProjectVolumeQuotaApplying({
  project_id,
  volume_kind,
}: {
  project_id: string;
  volume_kind: ProjectVolumeKind;
}): void {
  ensureTable();
  const now = Date.now();
  getDatabase()
    .prepare(
      `UPDATE ${TABLE}
          SET state='applying', apply_started_at=?, last_error=NULL, updated_at=?
        WHERE project_id=? AND volume_kind=?`,
    )
    .run(now, now, project_id, volume_kind);
}

export function markProjectVolumeQuotaApplied({
  project_id,
  volume_kind,
  desired_bytes,
  desired_revision,
  volume_identity,
  epoch = currentProjectVolumeQuotaEpoch(),
}: {
  project_id: string;
  volume_kind: ProjectVolumeKind;
  desired_bytes: number;
  desired_revision: number;
  volume_identity?: string;
  epoch?: string;
}): boolean {
  if (!epoch) {
    throw new Error("project filesystem quota state is not initialized");
  }
  if (!volume_identity) {
    throw new Error("project volume identity is required");
  }
  ensureTable();
  const now = Date.now();
  const auditIntervalMs = positiveDurationMs(
    "COCALC_PROJECT_QUOTA_AUDIT_INTERVAL_MS",
    DEFAULT_AUDIT_INTERVAL_MS,
  );
  const nextAuditAt =
    now +
    auditIntervalMs +
    stableAuditJitterMs(project_id, volume_kind, auditIntervalMs);
  const result = getDatabase()
    .prepare(
      `
        UPDATE ${TABLE}
        SET applied_bytes=?,
            applied_revision=?,
            applied_epoch=?,
            volume_identity=?,
            state='applied',
            last_error=NULL,
            applied_at=?,
            next_audit_at=?,
            updated_at=?
        WHERE project_id=?
          AND volume_kind=?
          AND desired_bytes=?
          AND desired_revision=?
      `,
    )
    .run(
      desired_bytes,
      desired_revision,
      epoch,
      volume_identity,
      now,
      nextAuditAt,
      now,
      project_id,
      volume_kind,
      desired_bytes,
      desired_revision,
    );
  return Number(result.changes) === 1;
}

export function markProjectVolumeQuotaResetComplete({
  project_id,
  desired_revision,
}: {
  project_id: string;
  desired_revision: number;
}): boolean {
  ensureTable();
  const result = getDatabase()
    .prepare(
      `UPDATE ${TABLE}
          SET reset_required=0, updated_at=?
        WHERE project_id=?
          AND volume_kind='scratch'
          AND desired_revision=?
          AND state='applied'`,
    )
    .run(Date.now(), project_id, desired_revision);
  return Number(result.changes) === 1;
}

export function markProjectVolumeQuotaFailed({
  project_id,
  volume_kind,
  state = "failed",
  error,
}: {
  project_id: string;
  volume_kind: ProjectVolumeKind;
  state?: Extract<ProjectVolumeQuotaState, "blocked" | "failed" | "missing">;
  error: unknown;
}): void {
  ensureTable();
  const retryAt =
    Date.now() +
    positiveDurationMs(
      "COCALC_PROJECT_QUOTA_AUDIT_RETRY_MS",
      DEFAULT_RETRY_INTERVAL_MS,
    );
  getDatabase()
    .prepare(
      `UPDATE ${TABLE}
          SET state=?, last_error=?, next_audit_at=?, updated_at=?
        WHERE project_id=? AND volume_kind=?`,
    )
    .run(state, `${error}`, retryAt, Date.now(), project_id, volume_kind);
}

export function invalidateProjectVolumeQuota({
  project_id,
  volume_kind,
  reason,
  retry_at = Date.now(),
  reset_required,
}: {
  project_id: string;
  volume_kind: ProjectVolumeKind;
  reason?: string;
  retry_at?: number;
  reset_required?: boolean;
}): void {
  ensureTable();
  getDatabase()
    .prepare(
      `UPDATE ${TABLE}
          SET state='pending', applied_epoch=NULL, volume_identity=NULL,
              reset_required=CASE WHEN ? IS NULL THEN reset_required ELSE ? END,
              last_error=?, next_audit_at=?, updated_at=?
        WHERE project_id=? AND volume_kind=?`,
    )
    .run(
      reset_required == null ? null : reset_required ? 1 : 0,
      reset_required ? 1 : 0,
      reason ?? null,
      retry_at,
      Date.now(),
      project_id,
      volume_kind,
    );
}

export function bootstrapProjectVolumeQuotaLedger(): number {
  ensureTable();
  const db = getDatabase();
  const projectsTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'",
    )
    .get();
  if (!projectsTable) return 0;
  const now = Date.now();
  const bootstrapKind = (
    volume_kind: ProjectVolumeKind,
    legacyDesiredSql: string,
  ): number => {
    // A versioned run_quota is authoritative. Legacy disk/scratch columns can
    // lag it across upgrades, and assigning their bytes the newer revision
    // creates an impossible same-revision conflict that blocks project start.
    const desiredBytesSql = `CASE
      WHEN COALESCE(run_quota_revision, 0) > 0
       AND CASE WHEN json_valid(run_quota) THEN
         json_type(run_quota, '$.disk_quota') IN ('integer', 'real')
         AND CAST(json_extract(run_quota, '$.disk_quota') AS REAL) > 0
       ELSE FALSE END
      THEN CAST(
        CAST(json_extract(run_quota, '$.disk_quota') AS REAL) * 1000000
        AS INTEGER
      )
      ELSE CAST(${legacyDesiredSql} AS INTEGER)
    END`;
    return Number(
      db
        .prepare(
          `WITH desired AS (
             SELECT project_id,
                    ${desiredBytesSql} AS desired_bytes,
                    MAX(0, COALESCE(run_quota_revision, 0)) AS desired_revision
               FROM projects
           )
           INSERT INTO ${TABLE} (
             project_id, volume_kind, desired_bytes, desired_revision,
             state, desired_updated_at, next_audit_at, updated_at
           )
           SELECT project_id, ?, desired_bytes, desired_revision,
                  'pending', ?, ?, ?
             FROM desired
            WHERE desired_bytes > 0
           ON CONFLICT(project_id, volume_kind) DO UPDATE SET
             desired_bytes=excluded.desired_bytes,
             desired_revision=excluded.desired_revision,
             state=CASE
               WHEN ${TABLE}.applied_revision=excluded.desired_revision
                AND ${TABLE}.applied_bytes=excluded.desired_bytes
               THEN ${TABLE}.state
               ELSE 'pending'
             END,
             last_error=NULL,
             desired_updated_at=excluded.desired_updated_at,
             next_audit_at=excluded.next_audit_at,
             updated_at=excluded.updated_at
           WHERE excluded.desired_revision > ${TABLE}.desired_revision`,
        )
        .run(volume_kind, now, now, now).changes,
    );
  };
  return (
    bootstrapKind("home", "disk") +
    bootstrapKind("scratch", "COALESCE(scratch, disk)")
  );
}

export function listProjectVolumeQuotaAuditBatch({
  limit = 32,
  now = Date.now(),
  epoch = currentProjectVolumeQuotaEpoch(),
}: {
  limit?: number;
  now?: number;
  epoch?: string;
} = {}): ProjectVolumeQuotaRow[] {
  ensureTable();
  const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
  return (
    getDatabase()
      .prepare(
        `SELECT * FROM ${TABLE}
          WHERE (
               state IN ('pending', 'applying')
               AND reset_required=0
               AND (next_audit_at IS NULL OR next_audit_at <= ?)
             )
             OR (
               state = 'applied'
               AND reset_required=0
               AND (
                 applied_bytes IS NULL
                 OR applied_bytes != desired_bytes
                 OR applied_revision IS NULL
                 OR applied_revision != desired_revision
                 OR applied_epoch IS NULL
                 OR applied_epoch != ?
                 OR next_audit_at IS NULL
                 OR next_audit_at <= ?
               )
             )
             OR (
               state IN ('blocked', 'failed', 'missing')
               AND reset_required=0
               AND (next_audit_at IS NULL OR next_audit_at <= ?)
             )
          ORDER BY
            CASE state
              WHEN 'pending' THEN 0
              WHEN 'applying' THEN 1
              WHEN 'applied' THEN 2
              ELSE 3
            END,
            COALESCE(next_audit_at, 0), updated_at,
            project_id, volume_kind
          LIMIT ?`,
      )
      .all(now, epoch ?? "", now, now, boundedLimit) as any[]
  ).map(parseRow);
}

// How many applied quotas were applied in an earlier quota epoch (e.g., all
// of them, right after the quota layout changed): the audit applies them
// again.
export function countProjectVolumeQuotaEpochBacklog({
  epoch = currentProjectVolumeQuotaEpoch(),
}: { epoch?: string } = {}): number {
  ensureTable();
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLE}
        WHERE state = 'applied'
          AND reset_required=0
          AND (applied_epoch IS NULL OR applied_epoch != ?)`,
    )
    .get(epoch ?? "") as { n: number };
  return Number(row?.n ?? 0);
}

export function listStoppedScratchVolumePreparationBatch({
  limit = 8,
  now = Date.now(),
}: {
  limit?: number;
  now?: number;
} = {}): ProjectVolumeQuotaRow[] {
  ensureTable();
  const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit)));
  return (
    getDatabase()
      .prepare(
        `SELECT q.* FROM ${TABLE} q
          JOIN projects p ON p.project_id=q.project_id
         WHERE q.volume_kind='scratch'
           AND q.reset_required=1
           AND (q.next_audit_at IS NULL OR q.next_audit_at <= ?)
           AND p.state='opened'
         ORDER BY COALESCE(q.next_audit_at, 0), q.updated_at, q.project_id
         LIMIT ?`,
      )
      .all(now, boundedLimit) as any[]
  ).map(parseRow);
}

export function claimStoppedScratchVolumePreparations(): number {
  ensureTable();
  const now = Date.now();
  const result = getDatabase()
    .prepare(
      `UPDATE ${TABLE} AS q
          SET reset_required=1,
              next_audit_at=MIN(COALESCE(next_audit_at, ?), ?),
              updated_at=?
        WHERE q.volume_kind='scratch'
          AND q.reset_required=0
          AND q.state!='applied'
          AND EXISTS (
            SELECT 1 FROM projects p
             WHERE p.project_id=q.project_id AND p.state='opened'
          )`,
    )
    .run(now, now, now);
  return Number(result.changes);
}

export function deleteProjectVolumeQuotas(project_id: string): void {
  ensureTable();
  getDatabase()
    .prepare(`DELETE FROM ${TABLE} WHERE project_id=?`)
    .run(project_id);
}
