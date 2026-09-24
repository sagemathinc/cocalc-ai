/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { ProjectMaintenanceReport } from "@cocalc/conat/project-host/api";
import type { ProjectRecoveryStatus } from "@cocalc/conat/hub/api/projects";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  SNAPSHOT_INTERVALS_MS,
  type SnapshotCounts,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";

function dueAt(
  changed: Date | null,
  lastSuccess: Date | null,
  schedule: SnapshotSchedule,
  allowFrequent: boolean,
): string | null {
  if (!changed || (lastSuccess && changed <= lastSuccess)) return null;
  const intervals = (
    Object.keys(SNAPSHOT_INTERVALS_MS) as Array<keyof SnapshotCounts>
  )
    .filter((key) => (allowFrequent || key !== "frequent") && schedule[key] > 0)
    .map((key) => SNAPSHOT_INTERVALS_MS[key]);
  if (!intervals.length) return null;
  return new Date(
    Math.max(
      changed.getTime(),
      lastSuccess == null ? 0 : lastSuccess.getTime() + Math.min(...intervals),
    ),
  ).toISOString();
}

export function snapshotScheduleRevision(
  schedule: SnapshotSchedule | null | undefined,
): string {
  const normalized = { ...DEFAULT_SNAPSHOT_COUNTS, ...(schedule ?? {}) };
  return JSON.stringify(
    Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)),
  );
}

let ensurePromise: Promise<void> | undefined;

export async function ensureProjectMaintenanceStatusTable(): Promise<void> {
  ensurePromise ??= getPool()
    .query(
      `
      CREATE TABLE IF NOT EXISTS project_maintenance_status (
        project_id UUID NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'backup')),
        host_id UUID NOT NULL,
        storage_service_class TEXT NOT NULL DEFAULT 'free',
        observed_at TIMESTAMP NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        due_at TIMESTAMP,
        latest_snapshot_at TIMESTAMP,
        reconciled_change_at TIMESTAMP,
        reconciled_schedule_revision TEXT,
        duration_ms INTEGER,
        stage_durations_ms JSONB,
        bytes_scanned BIGINT,
        bytes_uploaded BIGINT,
        retry_at TIMESTAMP,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, kind)
      )
    `,
    )
    .then(async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS project_maintenance_attempts (
          project_id UUID NOT NULL,
          kind TEXT NOT NULL,
          host_id UUID NOT NULL,
          storage_service_class TEXT NOT NULL,
          observed_at TIMESTAMP NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          due_at TIMESTAMP,
          attempt_due_at TIMESTAMP,
          duration_ms INTEGER,
          stage_durations_ms JSONB,
          bytes_scanned BIGINT,
          bytes_uploaded BIGINT,
          retry_at TIMESTAMP,
          PRIMARY KEY (project_id, kind, observed_at)
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS project_maintenance_attempts_observed_idx
           ON project_maintenance_attempts(observed_at)`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_attempts ADD COLUMN IF NOT EXISTS
           attempt_due_at TIMESTAMP`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS
          storage_service_class TEXT NOT NULL DEFAULT 'free'`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS retry_at TIMESTAMP`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS reconciled_change_at TIMESTAMP`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS reconciled_schedule_revision TEXT`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS
          consecutive_failures INTEGER NOT NULL DEFAULT 0`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS stage_durations_ms JSONB`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS bytes_scanned BIGINT`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS bytes_uploaded BIGINT`,
      );
    })
    .catch((err) => {
      ensurePromise = undefined;
      throw err;
    });
  await ensurePromise;
}

function validDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("invalid maintenance date");
  return date;
}

const MAINTENANCE_STAGES = new Set([
  "candidate_discovery",
  "queue_wait",
  "inventory",
  "change_detection",
  "create",
  "prune",
  "confirmation",
  "reporting",
]);

function boundedStageDurations(
  value: Record<string, number> | undefined,
): Record<string, number> | null {
  if (!value) return null;
  const stages: Record<string, number> = {};
  for (const [stage, duration] of Object.entries(value)) {
    if (!MAINTENANCE_STAGES.has(stage)) continue;
    if (!Number.isFinite(duration) || duration < 0) continue;
    stages[stage] = Math.min(24 * 60 * 60_000, Math.floor(duration));
  }
  return Object.keys(stages).length ? stages : null;
}

function boundedBytes(value: number | undefined): number | null {
  return value != null && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export async function recordProjectMaintenanceStatus(
  report: ProjectMaintenanceReport,
): Promise<boolean> {
  if (
    !report.project_id ||
    !report.host_id ||
    !["snapshot", "backup"].includes(report.kind) ||
    !["succeeded", "deferred", "failed", "skipped"].includes(report.outcome)
  ) {
    throw new Error("invalid project maintenance report");
  }
  const observedAt = validDate(report.observed_at);
  if (!observedAt || observedAt.getTime() > Date.now() + 60_000) {
    throw new Error("invalid maintenance observation time");
  }
  const dueAt = validDate(report.due_at);
  const attemptDueAt = validDate(report.attempt_due_at);
  const latestSnapshot = validDate(report.latest_snapshot_at);
  if (
    report.kind === "snapshot" &&
    report.outcome === "succeeded" &&
    latestSnapshot == null
  ) {
    throw new Error("snapshot success requires a confirmed snapshot time");
  }
  const reconciledChange = validDate(report.reconciled_change_at);
  const scheduleRevision =
    typeof report.schedule_revision === "string" &&
    report.schedule_revision.length <= 256
      ? report.schedule_revision
      : null;
  const retryAt = validDate(report.retry_at);
  const duration =
    report.duration_ms == null
      ? null
      : Math.max(0, Math.min(2_147_483_647, Math.floor(report.duration_ms)));
  const stageDurations = boundedStageDurations(report.stage_durations_ms);
  const bytesScanned = boundedBytes(report.bytes_scanned);
  const bytesUploaded = boundedBytes(report.bytes_uploaded);
  await ensureProjectMaintenanceStatusTable();
  const result = await getPool().query(
    `INSERT INTO project_maintenance_status
       (project_id, kind, host_id, storage_service_class, observed_at, outcome,
        reason, due_at, latest_snapshot_at, reconciled_change_at,
        reconciled_schedule_revision,
        duration_ms, stage_durations_ms, bytes_scanned, bytes_uploaded,
        retry_at, consecutive_failures)
     SELECT p.project_id, $3, $2, $10, $4, $5, $6, $7, $8, $13, $14, $9,
            $15::jsonb, $16, $17, $11, $12
       FROM projects p
      WHERE p.project_id=$1 AND p.host_id=$2
        AND p.provisioned IS TRUE AND p.deleted IS NOT TRUE
     ON CONFLICT (project_id, kind) DO UPDATE SET
       host_id=excluded.host_id,
       storage_service_class=excluded.storage_service_class,
       observed_at=excluded.observed_at,
       outcome=excluded.outcome,
       reason=excluded.reason,
       due_at=excluded.due_at,
       latest_snapshot_at=CASE
         WHEN excluded.outcome='succeeded'
           OR (excluded.outcome='skipped' AND excluded.reason='no_content_change')
           THEN excluded.latest_snapshot_at
         WHEN project_maintenance_status.host_id=excluded.host_id
           THEN project_maintenance_status.latest_snapshot_at
         ELSE NULL END,
       reconciled_change_at=CASE
         WHEN excluded.outcome='skipped' AND excluded.reason='no_content_change'
           THEN excluded.reconciled_change_at
         WHEN excluded.outcome='succeeded'
           OR project_maintenance_status.host_id<>excluded.host_id THEN NULL
         ELSE project_maintenance_status.reconciled_change_at END,
       reconciled_schedule_revision=CASE
         WHEN excluded.outcome='skipped' AND excluded.reason='no_content_change'
           THEN excluded.reconciled_schedule_revision
         WHEN excluded.outcome='succeeded'
           OR project_maintenance_status.host_id<>excluded.host_id THEN NULL
         ELSE project_maintenance_status.reconciled_schedule_revision END,
       duration_ms=excluded.duration_ms,
       stage_durations_ms=excluded.stage_durations_ms,
       bytes_scanned=excluded.bytes_scanned,
       bytes_uploaded=excluded.bytes_uploaded,
       retry_at=excluded.retry_at,
       consecutive_failures=excluded.consecutive_failures
     WHERE project_maintenance_status.observed_at <= excluded.observed_at`,
    [
      report.project_id,
      report.host_id,
      report.kind,
      observedAt,
      report.outcome,
      report.reason?.slice(0, 500) ?? null,
      dueAt,
      latestSnapshot,
      duration,
      report.storage_service_class === "paying" ? "paying" : "free",
      retryAt,
      Math.max(0, Math.min(1000, Math.floor(report.consecutive_failures ?? 0))),
      reconciledChange,
      scheduleRevision,
      stageDurations,
      bytesScanned,
      bytesUploaded,
    ],
  );
  if (!result.rowCount) return false;
  await getPool().query(
    `INSERT INTO project_maintenance_attempts
       (project_id, kind, host_id, storage_service_class, observed_at,
        outcome, reason, due_at, attempt_due_at, duration_ms,
        stage_durations_ms, bytes_scanned, bytes_uploaded, retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             $12, $13, $14)
     ON CONFLICT (project_id, kind, observed_at) DO NOTHING`,
    [
      report.project_id,
      report.kind,
      report.host_id,
      report.storage_service_class === "paying" ? "paying" : "free",
      observedAt,
      report.outcome,
      report.reason?.slice(0, 500) ?? null,
      dueAt,
      attemptDueAt,
      duration,
      stageDurations,
      bytesScanned,
      bytesUploaded,
      retryAt,
    ],
  );
  await getPool().query(
    `DELETE FROM project_maintenance_attempts
      WHERE project_id=$1 AND kind=$2
        AND (observed_at < NOW() - INTERVAL '30 days'
          OR ctid IN (
            SELECT ctid FROM project_maintenance_attempts
            WHERE project_id=$1 AND kind=$2
            ORDER BY observed_at DESC OFFSET 128
          ))`,
    [report.project_id, report.kind],
  );
  return true;
}

export async function getProjectRecoveryStatusLocal(
  project_id: string,
): Promise<ProjectRecoveryStatus> {
  await ensureProjectMaintenanceStatusTable();
  const { rows } = await getPool().query<{
    project_id: string;
    host_id: string | null;
    last_backup: Date | null;
    last_changed: Date | null;
    host_last_seen: Date | null;
    snapshots: SnapshotSchedule | null;
    backups: SnapshotSchedule | null;
  }>(
    `SELECT p.project_id, p.host_id, p.last_backup,
            COALESCE((to_jsonb(p)->>'last_changed')::TIMESTAMP, p.last_edited)
              AS last_changed,
            h.last_seen AS host_last_seen, p.snapshots, p.backups
       FROM projects p LEFT JOIN project_hosts h ON h.id=p.host_id
      WHERE p.project_id=$1 AND p.deleted IS NOT TRUE`,
    [project_id],
  );
  if (!rows[0]) throw new Error("project not found");
  const project = rows[0];
  const { rows: reports } = await getPool().query<{
    kind: "snapshot" | "backup";
    host_id: string;
    observed_at: Date;
    outcome: string;
    reason: string | null;
    due_at: Date | null;
    latest_snapshot_at: Date | null;
    reconciled_change_at: Date | null;
    reconciled_schedule_revision: string | null;
  }>(
    `SELECT kind, host_id, observed_at, outcome, reason, due_at,
            latest_snapshot_at, reconciled_change_at,
            reconciled_schedule_revision
       FROM project_maintenance_status WHERE project_id=$1`,
    [project_id],
  );
  const status: ProjectRecoveryStatus = {
    project_id,
    host_id: project.host_id,
    last_backup: project.last_backup?.toISOString() ?? null,
    last_changed: project.last_changed?.toISOString() ?? null,
    host_last_seen: project.host_last_seen?.toISOString() ?? null,
    snapshot_due_at: null,
    backup_due_at: null,
    snapshot_disabled: project.snapshots?.disabled === true,
    backup_disabled: project.backups?.disabled === true,
  };
  for (const report of reports) {
    if (report.host_id !== project.host_id) continue;
    const common = {
      observed_at: report.observed_at.toISOString(),
      outcome: report.outcome,
      reason: report.reason,
      due_at: report.due_at?.toISOString() ?? null,
    };
    if (report.kind === "snapshot") {
      status.snapshot = {
        ...common,
        latest_snapshot_at: report.latest_snapshot_at?.toISOString() ?? null,
      };
    } else {
      status.backup = common;
    }
  }
  if (!status.snapshot_disabled) {
    const report = reports.find(
      (entry) => entry.kind === "snapshot" && entry.host_id === project.host_id,
    );
    if (
      !project.last_changed ||
      !report?.reconciled_change_at ||
      project.last_changed > report.reconciled_change_at ||
      report.reconciled_schedule_revision !==
        snapshotScheduleRevision(project.snapshots)
    ) {
      status.snapshot_due_at = dueAt(
        project.last_changed,
        status.snapshot?.latest_snapshot_at
          ? new Date(status.snapshot.latest_snapshot_at)
          : null,
        { ...DEFAULT_SNAPSHOT_COUNTS, ...project.snapshots },
        true,
      );
    }
  }
  if (!status.backup_disabled) {
    status.backup_due_at = dueAt(
      project.last_changed,
      project.last_backup,
      { ...DEFAULT_BACKUP_COUNTS, ...project.backups },
      false,
    );
  }
  return status;
}

export interface ProjectRecoveryHealth {
  paying_snapshot_overdue: number;
  paying_backup_overdue: number;
  unclassified_snapshot_overdue: number;
  unclassified_backup_overdue: number;
  paying_snapshot_repeated_failures: number;
  paying_backup_repeated_failures: number;
  unknown_snapshot_status: number;
  unknown_backup_status: number;
  oldest_snapshot_delay_seconds: number;
  oldest_backup_delay_seconds: number;
}

export interface ProjectRecoveryAttemptAggregate {
  host_id: string;
  storage_service_class: "paying" | "free";
  kind: "snapshot" | "backup";
  succeeded: number;
  deferred: number;
  failed: number;
  skipped: number;
  bytes_scanned: number;
  bytes_uploaded: number;
}

export interface ProjectRecoveryStageAggregate {
  storage_service_class: "paying" | "free";
  kind: "snapshot" | "backup";
  stage: string;
  samples: number;
  p95_ms: number;
  p99_ms: number;
}

export interface ProjectRecoveryDelayAggregate {
  storage_service_class: "paying" | "free";
  kind: "snapshot" | "backup";
  samples: number;
  p95_seconds: number;
  p99_seconds: number;
}

export interface ProjectRecoveryReasonAggregate {
  host_id: string;
  storage_service_class: "paying" | "free";
  kind: "snapshot" | "backup";
  outcome: "deferred" | "failed";
  reason_code: string;
  attempts: number;
}

export async function getProjectRecoveryAttemptHealth(): Promise<{
  by_host: ProjectRecoveryAttemptAggregate[];
  stages: ProjectRecoveryStageAggregate[];
  due_to_success: ProjectRecoveryDelayAggregate[];
  reasons: ProjectRecoveryReasonAggregate[];
}> {
  await ensureProjectMaintenanceStatusTable();
  const [outcomes, stages, delays, reasons] = await Promise.all([
    getPool().query<{
      host_id: string;
      storage_service_class: "paying" | "free";
      kind: "snapshot" | "backup";
      succeeded: number;
      deferred: number;
      failed: number;
      skipped: number;
      bytes_scanned: string;
      bytes_uploaded: string;
    }>(
      `SELECT host_id, storage_service_class, kind,
              COUNT(*) FILTER (WHERE outcome='succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE outcome='deferred')::int AS deferred,
              COUNT(*) FILTER (WHERE outcome='failed')::int AS failed,
              COUNT(*) FILTER (WHERE outcome='skipped')::int AS skipped,
              COALESCE(SUM(bytes_scanned), 0)::text AS bytes_scanned,
              COALESCE(SUM(bytes_uploaded), 0)::text AS bytes_uploaded
         FROM project_maintenance_attempts
        WHERE observed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY host_id, storage_service_class, kind
        ORDER BY host_id, storage_service_class, kind`,
    ),
    getPool().query<ProjectRecoveryStageAggregate>(
      `SELECT storage_service_class, kind, stage.key AS stage,
              COUNT(*)::int AS samples,
              percentile_cont(0.95) WITHIN GROUP
                (ORDER BY stage.value::double precision) AS p95_ms,
              percentile_cont(0.99) WITHIN GROUP
                (ORDER BY stage.value::double precision) AS p99_ms
         FROM project_maintenance_attempts,
              LATERAL jsonb_each_text(stage_durations_ms) AS stage(key, value)
        WHERE observed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY storage_service_class, kind, stage.key
        ORDER BY storage_service_class, kind, stage.key`,
    ),
    getPool().query<ProjectRecoveryDelayAggregate>(
      `SELECT storage_service_class, kind, COUNT(*)::int AS samples,
              percentile_cont(0.95) WITHIN GROUP
                (ORDER BY EXTRACT(EPOCH FROM (observed_at-attempt_due_at)))
                AS p95_seconds,
              percentile_cont(0.99) WITHIN GROUP
                (ORDER BY EXTRACT(EPOCH FROM (observed_at-attempt_due_at)))
                AS p99_seconds
         FROM project_maintenance_attempts
        WHERE observed_at >= NOW() - INTERVAL '24 hours'
          AND outcome='succeeded' AND attempt_due_at IS NOT NULL
          AND observed_at >= attempt_due_at
        GROUP BY storage_service_class, kind
        ORDER BY storage_service_class, kind`,
    ),
    getPool().query<ProjectRecoveryReasonAggregate>(
      `SELECT host_id, storage_service_class, kind, outcome,
              CASE
                WHEN reason IN (
                  'assignment_changed', 'assignment_unverified',
                  'schedule_changed', 'observed_change_changed',
                  'project_volume_unavailable', 'project_volume_archiving',
                  'project_volume_lifecycle_changed',
                  'backup_capacity_busy', 'snapshot_not_created',
                  'backup_not_created', 'snapshot_maintenance_disabled',
                  'legacy_restore_active', 'memory_pressure',
                  'available_memory', 'io_pressure', 'lifecycle_active'
                ) THEN reason
                WHEN lower(reason) LIKE '%quota%' THEN 'quota'
                WHEN lower(reason) LIKE '%retention%' THEN 'retention'
                WHEN lower(reason) LIKE '%egress%' THEN 'egress'
                WHEN lower(reason) LIKE '%repository%' THEN 'repository'
                ELSE 'other'
              END AS reason_code,
              COUNT(*)::int AS attempts
         FROM project_maintenance_attempts
        WHERE observed_at >= NOW() - INTERVAL '24 hours'
          AND outcome IN ('deferred', 'failed')
        GROUP BY host_id, storage_service_class, kind, outcome, reason_code
        ORDER BY attempts DESC, host_id, kind, reason_code`,
    ),
  ]);
  return {
    by_host: outcomes.rows.map((row) => ({
      ...row,
      bytes_scanned: Number(row.bytes_scanned),
      bytes_uploaded: Number(row.bytes_uploaded),
    })),
    stages: stages.rows,
    due_to_success: delays.rows,
    reasons: reasons.rows,
  };
}

export async function getProjectRecoveryHealth(): Promise<ProjectRecoveryHealth> {
  await ensureProjectMaintenanceStatusTable();
  type HealthRow = {
    project_id: string;
    last_changed: Date | null;
    last_backup: Date | null;
    host_last_seen: Date | null;
    snapshots: SnapshotSchedule | null;
    backups: SnapshotSchedule | null;
    snapshot_at: Date | null;
    snapshot_observed_at: Date | null;
    snapshot_class: string | null;
    snapshot_outcome: string | null;
    snapshot_failures: number | null;
    reconciled_change_at: Date | null;
    reconciled_schedule_revision: string | null;
    backup_observed_at: Date | null;
    backup_class: string | null;
    backup_outcome: string | null;
    backup_failures: number | null;
  };
  const health: ProjectRecoveryHealth = {
    paying_snapshot_overdue: 0,
    paying_backup_overdue: 0,
    unclassified_snapshot_overdue: 0,
    unclassified_backup_overdue: 0,
    paying_snapshot_repeated_failures: 0,
    paying_backup_repeated_failures: 0,
    unknown_snapshot_status: 0,
    unknown_backup_status: 0,
    oldest_snapshot_delay_seconds: 0,
    oldest_backup_delay_seconds: 0,
  };
  const now = Date.now();
  let cursor: string | null = null;
  while (true) {
    const { rows } = await getPool().query<HealthRow>(
      `SELECT p.project_id,
              COALESCE((to_jsonb(p)->>'last_changed')::TIMESTAMP, p.last_edited)
                AS last_changed,
              p.last_backup, h.last_seen AS host_last_seen,
              p.snapshots, p.backups,
              s.latest_snapshot_at AS snapshot_at,
              s.observed_at AS snapshot_observed_at,
              s.storage_service_class AS snapshot_class,
              s.outcome AS snapshot_outcome,
              s.consecutive_failures AS snapshot_failures,
              s.reconciled_change_at, s.reconciled_schedule_revision,
              b.observed_at AS backup_observed_at,
              b.storage_service_class AS backup_class,
              b.outcome AS backup_outcome,
              b.consecutive_failures AS backup_failures
         FROM projects p
         LEFT JOIN project_hosts h ON h.id=p.host_id
         LEFT JOIN project_maintenance_status s ON s.project_id=p.project_id
           AND s.kind='snapshot' AND s.host_id=p.host_id
         LEFT JOIN project_maintenance_status b ON b.project_id=p.project_id
           AND b.kind='backup' AND b.host_id=p.host_id
        WHERE p.provisioned IS TRUE AND p.deleted IS NOT TRUE
          AND p.host_id IS NOT NULL
          AND ($1::uuid IS NULL OR p.project_id > $1::uuid)
        ORDER BY p.project_id LIMIT 1000`,
      [cursor],
    );
    for (const row of rows) {
      const hostUnknown =
        row.host_last_seen == null ||
        now - row.host_last_seen.getTime() > 5 * 60_000;
      if (row.snapshots?.disabled !== true) {
        if (
          row.snapshot_class === "paying" &&
          row.snapshot_outcome === "failed" &&
          (row.snapshot_failures ?? 0) >= 3
        ) {
          health.paying_snapshot_repeated_failures++;
        }
        if (
          hostUnknown ||
          row.snapshot_observed_at == null ||
          now - row.snapshot_observed_at.getTime() > 25 * 60 * 60_000
        ) {
          health.unknown_snapshot_status++;
        }
        const reconciled =
          row.last_changed != null &&
          row.reconciled_change_at != null &&
          row.last_changed <= row.reconciled_change_at &&
          row.reconciled_schedule_revision ===
            snapshotScheduleRevision(row.snapshots);
        const due = reconciled
          ? null
          : dueAt(
              row.last_changed,
              row.snapshot_at,
              { ...DEFAULT_SNAPSHOT_COUNTS, ...row.snapshots },
              true,
            );
        if (due != null) {
          const delaySeconds = Math.max(0, (now - Date.parse(due)) / 1000);
          health.oldest_snapshot_delay_seconds = Math.max(
            health.oldest_snapshot_delay_seconds,
            delaySeconds,
          );
          if (row.snapshot_class === "paying" && delaySeconds > 2 * 3600) {
            health.paying_snapshot_overdue++;
          } else if (row.snapshot_class == null && delaySeconds > 2 * 3600) {
            health.unclassified_snapshot_overdue++;
          }
        }
      }
      if (row.backups?.disabled !== true) {
        if (
          row.backup_class === "paying" &&
          row.backup_outcome === "failed" &&
          (row.backup_failures ?? 0) >= 3
        ) {
          health.paying_backup_repeated_failures++;
        }
        if (
          hostUnknown ||
          row.backup_observed_at == null ||
          now - row.backup_observed_at.getTime() > 25 * 60 * 60_000
        ) {
          health.unknown_backup_status++;
        }
        const due = dueAt(
          row.last_changed,
          row.last_backup,
          { ...DEFAULT_BACKUP_COUNTS, ...row.backups },
          false,
        );
        if (due != null) {
          const delaySeconds = Math.max(0, (now - Date.parse(due)) / 1000);
          health.oldest_backup_delay_seconds = Math.max(
            health.oldest_backup_delay_seconds,
            delaySeconds,
          );
          if (row.backup_class === "paying" && delaySeconds > 12 * 3600) {
            health.paying_backup_overdue++;
          } else if (row.backup_class == null && delaySeconds > 12 * 3600) {
            health.unclassified_backup_overdue++;
          }
        }
      }
    }
    if (rows.length < 1000) break;
    cursor = rows.at(-1)!.project_id;
  }
  return health;
}
