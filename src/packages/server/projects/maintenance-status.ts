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
        retry_at TIMESTAMP,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, kind)
      )
    `,
    )
    .then(async () => {
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
  await ensureProjectMaintenanceStatusTable();
  const result = await getPool().query(
    `INSERT INTO project_maintenance_status
       (project_id, kind, host_id, storage_service_class, observed_at, outcome,
        reason, due_at, latest_snapshot_at, reconciled_change_at,
        reconciled_schedule_revision,
        duration_ms, retry_at, consecutive_failures)
     SELECT p.project_id, $3, $2, $10, $4, $5, $6, $7, $8, $13, $14, $9,
            $11, $12
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
         WHEN excluded.outcome='succeeded' THEN excluded.latest_snapshot_at
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
    ],
  );
  return !!result.rowCount;
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
  unknown_snapshot_status: number;
  unknown_backup_status: number;
  oldest_snapshot_delay_seconds: number;
  oldest_backup_delay_seconds: number;
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
    reconciled_change_at: Date | null;
    reconciled_schedule_revision: string | null;
    backup_observed_at: Date | null;
    backup_class: string | null;
  };
  const health: ProjectRecoveryHealth = {
    paying_snapshot_overdue: 0,
    paying_backup_overdue: 0,
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
              s.reconciled_change_at, s.reconciled_schedule_revision,
              b.observed_at AS backup_observed_at,
              b.storage_service_class AS backup_class
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
          }
        }
      }
      if (row.backups?.disabled !== true) {
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
          }
        }
      }
    }
    if (rows.length < 1000) break;
    cursor = rows.at(-1)!.project_id;
  }
  return health;
}
