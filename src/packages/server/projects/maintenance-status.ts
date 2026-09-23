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
  const retryAt = validDate(report.retry_at);
  const duration =
    report.duration_ms == null
      ? null
      : Math.max(0, Math.min(2_147_483_647, Math.floor(report.duration_ms)));
  await ensureProjectMaintenanceStatusTable();
  const result = await getPool().query(
    `INSERT INTO project_maintenance_status
       (project_id, kind, host_id, storage_service_class, observed_at, outcome,
        reason, due_at, latest_snapshot_at, duration_ms, retry_at,
        consecutive_failures)
     SELECT p.project_id, $3, $2, $10, $4, $5, $6, $7, $8, $9,
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
  }>(
    `SELECT kind, host_id, observed_at, outcome, reason, due_at,
            latest_snapshot_at
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
    status.snapshot_due_at = dueAt(
      project.last_changed,
      status.snapshot?.latest_snapshot_at
        ? new Date(status.snapshot.latest_snapshot_at)
        : null,
      { ...DEFAULT_SNAPSHOT_COUNTS, ...project.snapshots },
      true,
    );
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
  const { rows } = await getPool().query<{
    paying_snapshot_overdue: string;
    paying_backup_overdue: string;
    unknown_snapshot_status: string;
    unknown_backup_status: string;
    oldest_snapshot_delay_seconds: number | null;
    oldest_backup_delay_seconds: number | null;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE s.storage_service_class='paying'
        AND s.due_at < NOW() - INTERVAL '2 hours') AS paying_snapshot_overdue,
      COUNT(*) FILTER (WHERE b.storage_service_class='paying'
        AND b.due_at < NOW() - INTERVAL '12 hours') AS paying_backup_overdue,
      COUNT(*) FILTER (WHERE COALESCE(p.snapshots->>'disabled','false')<>'true'
        AND (s.project_id IS NULL OR s.observed_at < NOW() - INTERVAL '25 hours'
             OR h.last_seen IS NULL OR h.last_seen < NOW() - INTERVAL '5 minutes'))
        AS unknown_snapshot_status,
      COUNT(*) FILTER (WHERE COALESCE(p.backups->>'disabled','false')<>'true'
        AND (b.project_id IS NULL OR b.observed_at < NOW() - INTERVAL '25 hours'
             OR h.last_seen IS NULL OR h.last_seen < NOW() - INTERVAL '5 minutes'))
        AS unknown_backup_status,
      MAX(EXTRACT(EPOCH FROM NOW() - s.due_at))
        FILTER (WHERE s.due_at < NOW()) AS oldest_snapshot_delay_seconds,
      MAX(EXTRACT(EPOCH FROM NOW() - b.due_at))
        FILTER (WHERE b.due_at < NOW()) AS oldest_backup_delay_seconds
    FROM projects p
    LEFT JOIN project_hosts h ON h.id=p.host_id
    LEFT JOIN project_maintenance_status s ON s.project_id=p.project_id
      AND s.kind='snapshot' AND s.host_id=p.host_id
    LEFT JOIN project_maintenance_status b ON b.project_id=p.project_id
      AND b.kind='backup' AND b.host_id=p.host_id
    WHERE p.provisioned IS TRUE AND p.deleted IS NOT TRUE AND p.host_id IS NOT NULL
  `);
  const row = rows[0];
  return {
    paying_snapshot_overdue: Number(row?.paying_snapshot_overdue ?? 0),
    paying_backup_overdue: Number(row?.paying_backup_overdue ?? 0),
    unknown_snapshot_status: Number(row?.unknown_snapshot_status ?? 0),
    unknown_backup_status: Number(row?.unknown_backup_status ?? 0),
    oldest_snapshot_delay_seconds: Number(
      row?.oldest_snapshot_delay_seconds ?? 0,
    ),
    oldest_backup_delay_seconds: Number(row?.oldest_backup_delay_seconds ?? 0),
  };
}
