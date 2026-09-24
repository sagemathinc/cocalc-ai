/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import type { ProjectMaintenanceReport } from "@cocalc/conat/project-host/api";
import type { ProjectRecoveryStatus } from "@cocalc/conat/hub/api/projects";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  SNAPSHOT_INTERVALS_MS,
  type SnapshotCounts,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import {
  PAYING_BACKUP_INCIDENT_DELAY_MS,
  PAYING_BACKUP_OBJECTIVE_MS,
  PAYING_SNAPSHOT_INCIDENT_DELAY_MS,
  PAYING_SNAPSHOT_OBJECTIVE_MS,
  recoveryDelayExceeds,
} from "@cocalc/util/consts/project-recovery";
import { resolveRuntimeMembership } from "@cocalc/server/membership/runtime-resolution";
import {
  storageFundingAccountId,
  storageServiceClassFromMembership,
} from "@cocalc/server/membership/storage-service-class";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  cancelProjectRecoveryObjective,
  ensureProjectRecoveryObjectiveTables,
  recordProjectRecoveryObjective,
} from "./recovery-objectives";

const logger = getLogger("server:projects:maintenance-status");

export function projectRecoveryDueAt(
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
        storage_service_class TEXT NOT NULL DEFAULT 'unclassified',
        observed_at TIMESTAMP NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        due_at TIMESTAMP,
        latest_snapshot_at TIMESTAMP,
        latest_backup_id TEXT,
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
          latest_backup_id TEXT,
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
        `ALTER TABLE project_maintenance_attempts ADD COLUMN IF NOT EXISTS
           latest_backup_id TEXT`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS
          storage_service_class TEXT NOT NULL DEFAULT 'unclassified'`,
      );
      await getPool().query(
        `ALTER TABLE project_maintenance_status ALTER COLUMN storage_service_class
          SET DEFAULT 'unclassified'`,
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
      await getPool().query(
        `ALTER TABLE project_maintenance_status ADD COLUMN IF NOT EXISTS latest_backup_id TEXT`,
      );
      await ensureProjectRecoveryObjectiveTables();
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

function reportedServiceClass(
  report: ProjectMaintenanceReport,
): ProjectRecoveryStatus["storage_service_class"] {
  return report.storage_service_class === "paying" ||
    report.storage_service_class === "free"
    ? report.storage_service_class
    : "unclassified";
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
  const latestBackupId =
    report.kind === "backup" &&
    typeof report.latest_backup_id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(report.latest_backup_id)
      ? report.latest_backup_id
      : null;
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
  const queued = report.outcome === "deferred" && report.reason === "queued";
  await ensureProjectMaintenanceStatusTable();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO project_maintenance_status
       (project_id, kind, host_id, storage_service_class, observed_at, outcome,
        reason, due_at, latest_snapshot_at, latest_backup_id, reconciled_change_at,
        reconciled_schedule_revision,
        duration_ms, stage_durations_ms, bytes_scanned, bytes_uploaded,
        retry_at, consecutive_failures)
     SELECT p.project_id, $3, $2, $10, $4, $5, $6, $7, $8, $18, $13, $14, $9,
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
         WHEN excluded.outcome='skipped'
           AND excluded.reason='snapshot_interval_wait'
           AND excluded.latest_snapshot_at IS NOT NULL
           THEN excluded.latest_snapshot_at
         WHEN excluded.outcome='deferred'
           AND excluded.latest_snapshot_at IS NOT NULL
           THEN excluded.latest_snapshot_at
         WHEN project_maintenance_status.host_id=excluded.host_id
           THEN project_maintenance_status.latest_snapshot_at
         ELSE NULL END,
       latest_backup_id=CASE
         WHEN excluded.latest_backup_id IS NOT NULL
           OR excluded.outcome='succeeded'
           THEN excluded.latest_backup_id
         WHEN project_maintenance_status.host_id=excluded.host_id
           THEN project_maintenance_status.latest_backup_id
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
        reportedServiceClass(report),
        retryAt,
        Math.max(
          0,
          Math.min(1000, Math.floor(report.consecutive_failures ?? 0)),
        ),
        reconciledChange,
        scheduleRevision,
        stageDurations,
        bytesScanned,
        bytesUploaded,
        latestBackupId,
      ],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    if (!queued) {
      await client.query(
        `INSERT INTO project_maintenance_attempts
       (project_id, kind, host_id, storage_service_class, observed_at,
        outcome, reason, due_at, attempt_due_at, latest_backup_id, duration_ms,
        stage_durations_ms, bytes_scanned, bytes_uploaded, retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $15, $10, $11::jsonb,
             $12, $13, $14)
     ON CONFLICT (project_id, kind, observed_at) DO NOTHING`,
        [
          report.project_id,
          report.kind,
          report.host_id,
          reportedServiceClass(report),
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
          latestBackupId,
        ],
      );
    }
    await client.query(
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
    if (
      report.kind === "snapshot" &&
      report.outcome === "skipped" &&
      (report.reason === "no_content_change" ||
        report.reason === "snapshot_interval_wait")
    ) {
      await cancelProjectRecoveryObjective({
        db: client,
        projectId: report.project_id,
        kind: report.kind,
        serviceClass: reportedServiceClass(report),
        dueAt: attemptDueAt,
        observedAt,
      });
    } else {
      await recordProjectRecoveryObjective({
        db: client,
        projectId: report.project_id,
        kind: report.kind,
        serviceClass: reportedServiceClass(report),
        outcome: report.outcome,
        dueAt: attemptDueAt,
        observedAt: queued ? new Date() : observedAt,
      });
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function freshHostMaintenanceBlock(
  value: unknown,
  hostLastSeen: Date | null,
): ProjectRecoveryStatus["host_maintenance_block"] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const gate = value as Record<string, unknown>;
  if (
    gate.blocked_reason !== "available_memory" &&
    gate.blocked_reason !== "memory_pressure" &&
    gate.blocked_reason !== "memory_measurement_unavailable"
  ) {
    return undefined;
  }
  const checkedAt =
    typeof gate.checked_at === "string" ? Date.parse(gate.checked_at) : NaN;
  const now = Date.now();
  if (
    !Number.isFinite(checkedAt) ||
    checkedAt > now + 30_000 ||
    now - checkedAt > 2 * 60_000 ||
    hostLastSeen == null ||
    now - hostLastSeen.getTime() > 5 * 60_000
  ) {
    return undefined;
  }
  return {
    reason: gate.blocked_reason,
    checked_at: new Date(checkedAt).toISOString(),
    ...(typeof gate.memory_psi_full_avg10 === "number" &&
    Number.isFinite(gate.memory_psi_full_avg10)
      ? { memory_psi_full_avg10: gate.memory_psi_full_avg10 }
      : {}),
  };
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
    host_maintenance_gate: unknown;
    snapshots: SnapshotSchedule | null;
    backups: SnapshotSchedule | null;
    owner_account_id: string | null;
    usage_account_id: string | null;
    course: { type?: string; account_id?: string } | null;
    users: Record<string, { group?: string }> | null;
  }>(
    `SELECT p.project_id, p.host_id, p.last_backup,
            COALESCE((to_jsonb(p)->>'last_changed')::TIMESTAMP, p.last_edited)
              AS last_changed,
            h.last_seen AS host_last_seen,
            h.metadata #> '{metrics,current,snapshot_backup_maintenance_gate}'
              AS host_maintenance_gate,
            p.snapshots, p.backups,
            p.usage_account_id::text AS usage_account_id, p.course, p.users,
            (SELECT account_id_text::text
               FROM jsonb_each(COALESCE(p.users, '{}'::jsonb))
                    AS u(account_id_text, user_data)
              WHERE COALESCE(u.user_data->>'group', '')='owner'
              LIMIT 1) AS owner_account_id
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
    latest_backup_id: string | null;
    reconciled_change_at: Date | null;
    reconciled_schedule_revision: string | null;
  }>(
    `SELECT kind, host_id, observed_at, outcome, reason, due_at,
            latest_snapshot_at, latest_backup_id, reconciled_change_at,
            reconciled_schedule_revision
       FROM project_maintenance_status WHERE project_id=$1`,
    [project_id],
  );
  const status: ProjectRecoveryStatus = {
    project_id,
    storage_service_class: "unclassified",
    host_id: project.host_id,
    last_backup: project.last_backup?.toISOString() ?? null,
    last_changed: project.last_changed?.toISOString() ?? null,
    host_last_seen: project.host_last_seen?.toISOString() ?? null,
    snapshot_due_at: null,
    backup_due_at: null,
    snapshot_disabled: project.snapshots?.disabled === true,
    backup_disabled: project.backups?.disabled === true,
  };
  const hostMaintenanceBlock = freshHostMaintenanceBlock(
    project.host_maintenance_gate,
    project.host_last_seen,
  );
  if (hostMaintenanceBlock)
    status.host_maintenance_block = hostMaintenanceBlock;
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
      status.backup = {
        ...common,
        latest_backup_id: report.latest_backup_id ?? null,
      };
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
      status.snapshot_due_at = projectRecoveryDueAt(
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
    status.backup_due_at = projectRecoveryDueAt(
      project.last_changed,
      project.last_backup,
      { ...DEFAULT_BACKUP_COUNTS, ...project.backups },
      false,
    );
  }
  if (
    recoveryDelayExceeds(
      status.snapshot_due_at,
      PAYING_SNAPSHOT_OBJECTIVE_MS,
    ) ||
    recoveryDelayExceeds(status.backup_due_at, PAYING_BACKUP_OBJECTIVE_MS)
  ) {
    const payer = storageFundingAccountId(project);
    if (payer) {
      try {
        status.storage_service_class = storageServiceClassFromMembership(
          await resolveRuntimeMembership(payer),
        );
      } catch (err) {
        logger.warn("unable to classify recovery service funding", {
          project_id,
          err,
        });
      }
    }
  }
  return status;
}

export interface ProjectRecoveryHealth {
  eligible_snapshot_projects: number;
  eligible_backup_projects: number;
  unaccounted_snapshot_due: number;
  unaccounted_backup_due: number;
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
  host_maintenance_blocks: Array<{
    host_id: string;
    reason:
      | "available_memory"
      | "memory_pressure"
      | "memory_measurement_unavailable";
    checked_at: string;
    memory_psi_full_avg10?: number;
  }>;
  by_host_class: ProjectRecoveryDebtAggregate[];
  oldest_debt: ProjectRecoveryOldestDebt[];
}

export interface ProjectRecoveryOldestDebt {
  project_id: string;
  host_id: string;
  storage_service_class: "paying" | "free" | "unclassified";
  kind: "snapshot" | "backup";
  due_at: string;
  delay_seconds: number;
}

export interface ProjectRecoveryDebtAggregate {
  host_id: string;
  storage_service_class: "paying" | "free" | "unclassified";
  kind: "snapshot" | "backup";
  overdue_count: number;
  oldest_delay_seconds: number;
  unknown_count: number;
  repeated_failures: number;
}

export interface ProjectRecoveryAttemptAggregate {
  host_id: string;
  storage_service_class: ProjectRecoveryStatus["storage_service_class"];
  kind: "snapshot" | "backup";
  succeeded: number;
  deferred: number;
  failed: number;
  skipped: number;
  bytes_scanned: number;
  bytes_uploaded: number;
  due_obligations: number;
  execution_seconds: number;
  successful_execution_seconds: number;
  queue_wait_seconds: number;
}

function objectiveCoversDue({
  due,
  objectiveDueAt,
  objectiveSucceededAt,
  objectiveCancelledAt,
}: {
  due: string;
  objectiveDueAt: Date | null;
  objectiveSucceededAt: Date | null;
  objectiveCancelledAt: Date | null;
}): boolean {
  const dueTime = Date.parse(due);
  return (
    objectiveCancelledAt == null &&
    objectiveDueAt != null &&
    objectiveDueAt.getTime() <= dueTime &&
    (objectiveSucceededAt == null || objectiveSucceededAt.getTime() >= dueTime)
  );
}

export interface ProjectRecoveryStageAggregate {
  storage_service_class: ProjectRecoveryStatus["storage_service_class"];
  kind: "snapshot" | "backup";
  stage: string;
  samples: number;
  p95_ms: number;
  p99_ms: number;
}

export interface ProjectRecoveryDelayAggregate {
  storage_service_class: ProjectRecoveryStatus["storage_service_class"];
  kind: "snapshot" | "backup";
  samples: number;
  p95_seconds: number;
  p99_seconds: number;
}

export interface ProjectRecoveryReasonAggregate {
  host_id: string;
  storage_service_class: ProjectRecoveryStatus["storage_service_class"];
  kind: "snapshot" | "backup";
  outcome: "deferred" | "failed";
  reason_code: string;
  attempts: number;
}

export async function getProjectRecoveryRecentPayingCompletions(): Promise<
  Array<{ host_id: string; kind: "snapshot" | "backup"; succeeded: number }>
> {
  await ensureProjectMaintenanceStatusTable();
  const { rows } = await getPool().query<{
    host_id: string;
    kind: "snapshot" | "backup";
    succeeded: number;
  }>(
    `SELECT host_id, kind, COUNT(*)::int AS succeeded
       FROM project_maintenance_attempts
      WHERE storage_service_class='paying' AND outcome='succeeded'
        AND ((kind='snapshot' AND observed_at >= NOW() - INTERVAL '30 minutes')
          OR (kind='backup' AND observed_at >= NOW() - INTERVAL '2 hours'))
      GROUP BY host_id, kind`,
  );
  return rows;
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
      storage_service_class: ProjectRecoveryStatus["storage_service_class"];
      kind: "snapshot" | "backup";
      succeeded: number;
      deferred: number;
      failed: number;
      skipped: number;
      bytes_scanned: string;
      bytes_uploaded: string;
      due_obligations: number;
      execution_seconds: string;
      successful_execution_seconds: string;
      queue_wait_seconds: string;
    }>(
      `SELECT host_id, storage_service_class, kind,
              COUNT(*) FILTER (WHERE outcome='succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE outcome='deferred')::int AS deferred,
              COUNT(*) FILTER (WHERE outcome='failed')::int AS failed,
              COUNT(*) FILTER (WHERE outcome='skipped')::int AS skipped,
              COALESCE(SUM(bytes_scanned), 0)::text AS bytes_scanned,
              COALESCE(SUM(bytes_uploaded), 0)::text AS bytes_uploaded,
              COUNT(DISTINCT (project_id, COALESCE(attempt_due_at, due_at)))
                FILTER (WHERE COALESCE(attempt_due_at, due_at) IS NOT NULL)::int
                AS due_obligations,
              (COALESCE(SUM(duration_ms) FILTER
                (WHERE outcome IN ('succeeded', 'failed', 'deferred')), 0)
                / 1000.0)::text AS execution_seconds,
              (COALESCE(SUM(duration_ms) FILTER
                (WHERE outcome='succeeded'), 0)
                / 1000.0)::text AS successful_execution_seconds,
              (COALESCE(SUM((stage_durations_ms->>'queue_wait')::bigint)
                FILTER (WHERE stage_durations_ms ? 'queue_wait'), 0)
                / 1000.0)::text AS queue_wait_seconds
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
                  'backup_not_created', 'replacement_capacity_blocked',
                  'snapshot_maintenance_disabled',
                  'legacy_restore_active', 'memory_pressure',
                  'available_memory', 'memory_measurement_unavailable',
                  'io_pressure', 'lifecycle_active',
                  'lifecycle_settle', 'change_generation_changed'
                ) THEN reason
                WHEN left(reason, 12) = 'io_pressure_' THEN 'io_pressure'
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
      execution_seconds: Number(row.execution_seconds),
      successful_execution_seconds: Number(row.successful_execution_seconds),
      queue_wait_seconds: Number(row.queue_wait_seconds),
    })),
    stages: stages.rows,
    due_to_success: delays.rows,
    reasons: reasons.rows,
  };
}

// Health is queried by several operator paths. Share short-lived payer lookups
// across them while bounding both the number of account-home RPCs and memory.
const HEALTH_PAYER_CLASS_TTL_MS = 5 * 60_000;
const HEALTH_PAYER_CLASS_CACHE_LIMIT = 10_000;
const healthPayerClassCache = new Map<
  string,
  {
    serviceClass: ProjectRecoveryStatus["storage_service_class"];
    expiresAt: number;
  }
>();
const healthPayerClassPending = new Map<
  string,
  Promise<ProjectRecoveryStatus["storage_service_class"]>
>();

async function currentHealthPayerClass(
  accountId: string,
): Promise<ProjectRecoveryStatus["storage_service_class"]> {
  const cached = healthPayerClassCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.serviceClass;
  const pending = healthPayerClassPending.get(accountId);
  if (pending) return pending;
  const lookup = (async () => {
    try {
      const serviceClass = storageServiceClassFromMembership(
        await resolveRuntimeMembership(accountId),
      );
      healthPayerClassCache.delete(accountId);
      healthPayerClassCache.set(accountId, {
        serviceClass,
        expiresAt: Date.now() + HEALTH_PAYER_CLASS_TTL_MS,
      });
      if (healthPayerClassCache.size > HEALTH_PAYER_CLASS_CACHE_LIMIT) {
        healthPayerClassCache.delete(
          healthPayerClassCache.keys().next().value!,
        );
      }
      return serviceClass;
    } catch (err) {
      logger.warn("unable to classify recovery health funding", {
        account_id: accountId,
        err,
      });
      return "unclassified" as const;
    } finally {
      healthPayerClassPending.delete(accountId);
    }
  })();
  healthPayerClassPending.set(accountId, lookup);
  return lookup;
}

export async function getProjectRecoveryHealth(): Promise<ProjectRecoveryHealth> {
  await ensureProjectMaintenanceStatusTable();
  type HealthRow = {
    project_id: string;
    host_id: string;
    last_changed: Date | null;
    last_backup: Date | null;
    host_last_seen: Date | null;
    snapshots: SnapshotSchedule | null;
    backups: SnapshotSchedule | null;
    owner_account_id: string | null;
    usage_account_id: string | null;
    course: { type?: string; account_id?: string } | null;
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
    snapshot_objective_due_at: Date | null;
    snapshot_objective_succeeded_at: Date | null;
    snapshot_objective_cancelled_at: Date | null;
    backup_objective_due_at: Date | null;
    backup_objective_succeeded_at: Date | null;
    backup_objective_cancelled_at: Date | null;
  };
  const health: ProjectRecoveryHealth = {
    eligible_snapshot_projects: 0,
    eligible_backup_projects: 0,
    unaccounted_snapshot_due: 0,
    unaccounted_backup_due: 0,
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
    host_maintenance_blocks: [],
    by_host_class: [],
    oldest_debt: [],
  };
  const oldestByClassKind = new Map<string, ProjectRecoveryOldestDebt[]>();
  const recordOldestDebt = (
    row: HealthRow,
    serviceClass: string | null,
    kind: "snapshot" | "backup",
    due: string,
    delaySeconds: number,
  ) => {
    if (delaySeconds <= 0) return;
    const storage_service_class =
      serviceClass === "paying" || serviceClass === "free"
        ? serviceClass
        : "unclassified";
    const key = `${storage_service_class}:${kind}`;
    const entries = oldestByClassKind.get(key) ?? [];
    entries.push({
      project_id: row.project_id,
      host_id: row.host_id,
      storage_service_class,
      kind,
      due_at: due,
      delay_seconds: delaySeconds,
    });
    entries.sort(
      (a, b) =>
        b.delay_seconds - a.delay_seconds ||
        a.project_id.localeCompare(b.project_id),
    );
    entries.length = Math.min(entries.length, 5);
    oldestByClassKind.set(key, entries);
  };
  const debtByHostClass = new Map<string, ProjectRecoveryDebtAggregate>();
  const debtGroup = (
    host_id: string,
    service_class: string | null,
    kind: "snapshot" | "backup",
  ): ProjectRecoveryDebtAggregate => {
    const storage_service_class =
      service_class === "paying" || service_class === "free"
        ? service_class
        : "unclassified";
    const key = `${host_id}:${storage_service_class}:${kind}`;
    let group = debtByHostClass.get(key);
    if (!group) {
      group = {
        host_id,
        storage_service_class,
        kind,
        overdue_count: 0,
        oldest_delay_seconds: 0,
        unknown_count: 0,
        repeated_failures: 0,
      };
      debtByHostClass.set(key, group);
    }
    return group;
  };
  const now = Date.now();
  let cursor: string | null = null;
  while (true) {
    const { rows } = await getPool().query<HealthRow>(
      `SELECT p.project_id, p.host_id,
              COALESCE((to_jsonb(p)->>'last_changed')::TIMESTAMP, p.last_edited)
                AS last_changed,
              p.last_backup, h.last_seen AS host_last_seen,
              p.snapshots, p.backups, p.usage_account_id::text AS usage_account_id,
              p.course,
              (SELECT account_id_text::text
                 FROM jsonb_each(COALESCE(p.users, '{}'::jsonb))
                      AS u(account_id_text, user_data)
                WHERE COALESCE(u.user_data->>'group', '')='owner'
                LIMIT 1) AS owner_account_id,
              s.latest_snapshot_at AS snapshot_at,
              s.observed_at AS snapshot_observed_at,
              s.storage_service_class AS snapshot_class,
              s.outcome AS snapshot_outcome,
              s.consecutive_failures AS snapshot_failures,
              s.reconciled_change_at, s.reconciled_schedule_revision,
              b.observed_at AS backup_observed_at,
              b.storage_service_class AS backup_class,
              b.outcome AS backup_outcome,
              b.consecutive_failures AS backup_failures,
              so.due_at AS snapshot_objective_due_at,
              so.succeeded_at AS snapshot_objective_succeeded_at,
              so.cancelled_at AS snapshot_objective_cancelled_at,
              bo.due_at AS backup_objective_due_at,
              bo.succeeded_at AS backup_objective_succeeded_at,
              bo.cancelled_at AS backup_objective_cancelled_at
         FROM projects p
         LEFT JOIN project_hosts h ON h.id=p.host_id
         LEFT JOIN project_maintenance_status s ON s.project_id=p.project_id
           AND s.kind='snapshot' AND s.host_id=p.host_id
         LEFT JOIN project_maintenance_status b ON b.project_id=p.project_id
           AND b.kind='backup' AND b.host_id=p.host_id
         LEFT JOIN project_recovery_objective_state so
           ON so.project_id=p.project_id AND so.kind='snapshot'
         LEFT JOIN project_recovery_objective_state bo
           ON bo.project_id=p.project_id AND bo.kind='backup'
        WHERE p.provisioned IS TRUE AND p.deleted IS NOT TRUE
          AND p.host_id IS NOT NULL
          AND COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), $2) = $2
          AND ($1::uuid IS NULL OR p.project_id > $1::uuid)
        ORDER BY p.project_id LIMIT 1000`,
      [cursor, getConfiguredBayId()],
    );
    const currentClassByProject = new Map<
      string,
      ProjectRecoveryStatus["storage_service_class"]
    >();
    const payersByProject = new Map<string, string>();
    for (const row of rows) {
      const snapshotDue =
        row.snapshots?.disabled === true ||
        (row.last_changed != null &&
          row.reconciled_change_at != null &&
          row.last_changed <= row.reconciled_change_at &&
          row.reconciled_schedule_revision ===
            snapshotScheduleRevision(row.snapshots))
          ? null
          : projectRecoveryDueAt(
              row.last_changed,
              row.snapshot_at,
              { ...DEFAULT_SNAPSHOT_COUNTS, ...row.snapshots },
              true,
            );
      const backupDue =
        row.backups?.disabled === true
          ? null
          : projectRecoveryDueAt(
              row.last_changed,
              row.last_backup,
              { ...DEFAULT_BACKUP_COUNTS, ...row.backups },
              false,
            );
      const overdue =
        (snapshotDue != null && Date.parse(snapshotDue) < now) ||
        (backupDue != null && Date.parse(backupDue) < now);
      const repeatedFailure =
        (row.snapshots?.disabled !== true &&
          row.snapshot_outcome === "failed" &&
          (row.snapshot_failures ?? 0) >= 3) ||
        (row.backups?.disabled !== true &&
          row.backup_outcome === "failed" &&
          (row.backup_failures ?? 0) >= 3);
      if (!overdue && !repeatedFailure) continue;
      const payer = storageFundingAccountId(row);
      if (payer) payersByProject.set(row.project_id, payer);
      else currentClassByProject.set(row.project_id, "unclassified");
    }
    const uniquePayers = [...new Set(payersByProject.values())];
    const classesByPayer = new Map<
      string,
      ProjectRecoveryStatus["storage_service_class"]
    >();
    for (let offset = 0; offset < uniquePayers.length; offset += 16) {
      await Promise.all(
        uniquePayers.slice(offset, offset + 16).map(async (accountId) => {
          classesByPayer.set(
            accountId,
            await currentHealthPayerClass(accountId),
          );
        }),
      );
    }
    for (const [projectId, payer] of payersByProject) {
      currentClassByProject.set(projectId, classesByPayer.get(payer)!);
    }
    for (const row of rows) {
      const snapshotClass =
        currentClassByProject.get(row.project_id) ?? row.snapshot_class;
      const backupClass =
        currentClassByProject.get(row.project_id) ?? row.backup_class;
      const hostUnknown =
        row.host_last_seen == null ||
        now - row.host_last_seen.getTime() > 5 * 60_000;
      if (row.snapshots?.disabled !== true) {
        health.eligible_snapshot_projects++;
        const group = debtGroup(row.host_id, snapshotClass, "snapshot");
        if (
          row.snapshot_outcome === "failed" &&
          (row.snapshot_failures ?? 0) >= 3
        ) {
          if (snapshotClass === "paying") {
            health.paying_snapshot_repeated_failures++;
          }
          group.repeated_failures++;
        }
        if (
          hostUnknown ||
          row.snapshot_observed_at == null ||
          now - row.snapshot_observed_at.getTime() > 25 * 60 * 60_000
        ) {
          health.unknown_snapshot_status++;
          group.unknown_count++;
        }
        const reconciled =
          row.last_changed != null &&
          row.reconciled_change_at != null &&
          row.last_changed <= row.reconciled_change_at &&
          row.reconciled_schedule_revision ===
            snapshotScheduleRevision(row.snapshots);
        const due = reconciled
          ? null
          : projectRecoveryDueAt(
              row.last_changed,
              row.snapshot_at,
              { ...DEFAULT_SNAPSHOT_COUNTS, ...row.snapshots },
              true,
            );
        if (due != null) {
          const delaySeconds = Math.max(0, (now - Date.parse(due)) / 1000);
          // A full host reconciliation may take an hour. After that, missing
          // objective state means the due work was absent from the historical
          // denominator even if live debt remains visible.
          if (
            delaySeconds > 3600 &&
            !objectiveCoversDue({
              due,
              objectiveDueAt: row.snapshot_objective_due_at,
              objectiveSucceededAt: row.snapshot_objective_succeeded_at,
              objectiveCancelledAt: row.snapshot_objective_cancelled_at,
            })
          ) {
            health.unaccounted_snapshot_due++;
          }
          if (delaySeconds > 0) {
            group.overdue_count++;
            recordOldestDebt(row, snapshotClass, "snapshot", due, delaySeconds);
            group.oldest_delay_seconds = Math.max(
              group.oldest_delay_seconds,
              delaySeconds,
            );
          }
          health.oldest_snapshot_delay_seconds = Math.max(
            health.oldest_snapshot_delay_seconds,
            delaySeconds,
          );
          if (
            snapshotClass === "paying" &&
            delaySeconds > PAYING_SNAPSHOT_INCIDENT_DELAY_MS / 1000
          ) {
            health.paying_snapshot_overdue++;
          } else if (
            snapshotClass !== "paying" &&
            snapshotClass !== "free" &&
            delaySeconds > PAYING_SNAPSHOT_INCIDENT_DELAY_MS / 1000
          ) {
            health.unclassified_snapshot_overdue++;
          }
        }
      }
      if (row.backups?.disabled !== true) {
        health.eligible_backup_projects++;
        const group = debtGroup(row.host_id, backupClass, "backup");
        if (
          row.backup_outcome === "failed" &&
          (row.backup_failures ?? 0) >= 3
        ) {
          if (backupClass === "paying") {
            health.paying_backup_repeated_failures++;
          }
          group.repeated_failures++;
        }
        if (
          hostUnknown ||
          row.backup_observed_at == null ||
          now - row.backup_observed_at.getTime() > 25 * 60 * 60_000
        ) {
          health.unknown_backup_status++;
          group.unknown_count++;
        }
        const due = projectRecoveryDueAt(
          row.last_changed,
          row.last_backup,
          { ...DEFAULT_BACKUP_COUNTS, ...row.backups },
          false,
        );
        if (due != null) {
          const delaySeconds = Math.max(0, (now - Date.parse(due)) / 1000);
          if (
            delaySeconds > 3600 &&
            !objectiveCoversDue({
              due,
              objectiveDueAt: row.backup_objective_due_at,
              objectiveSucceededAt: row.backup_objective_succeeded_at,
              objectiveCancelledAt: row.backup_objective_cancelled_at,
            })
          ) {
            health.unaccounted_backup_due++;
          }
          if (delaySeconds > 0) {
            group.overdue_count++;
            recordOldestDebt(row, backupClass, "backup", due, delaySeconds);
            group.oldest_delay_seconds = Math.max(
              group.oldest_delay_seconds,
              delaySeconds,
            );
          }
          health.oldest_backup_delay_seconds = Math.max(
            health.oldest_backup_delay_seconds,
            delaySeconds,
          );
          if (
            backupClass === "paying" &&
            delaySeconds > PAYING_BACKUP_INCIDENT_DELAY_MS / 1000
          ) {
            health.paying_backup_overdue++;
          } else if (
            backupClass !== "paying" &&
            backupClass !== "free" &&
            delaySeconds > PAYING_BACKUP_INCIDENT_DELAY_MS / 1000
          ) {
            health.unclassified_backup_overdue++;
          }
        }
      }
    }
    if (rows.length < 1000) break;
    cursor = rows.at(-1)!.project_id;
  }
  health.by_host_class = [...debtByHostClass.values()]
    .filter(
      (group) =>
        group.overdue_count > 0 ||
        group.unknown_count > 0 ||
        group.repeated_failures > 0,
    )
    .sort(
      (a, b) =>
        b.oldest_delay_seconds - a.oldest_delay_seconds ||
        b.overdue_count - a.overdue_count ||
        a.host_id.localeCompare(b.host_id) ||
        a.kind.localeCompare(b.kind) ||
        a.storage_service_class.localeCompare(b.storage_service_class),
    );
  health.oldest_debt = [...oldestByClassKind.values()]
    .flat()
    .sort(
      (a, b) =>
        b.delay_seconds - a.delay_seconds ||
        a.project_id.localeCompare(b.project_id),
    );
  const { rows: hostGates } = await getPool().query<{
    host_id: string;
    host_last_seen: Date | null;
    gate: unknown;
  }>(
    `SELECT h.id AS host_id, h.last_seen AS host_last_seen,
            h.metadata #> '{metrics,current,snapshot_backup_maintenance_gate}'
              AS gate
       FROM project_hosts h
      WHERE h.deleted IS NULL
        AND EXISTS (
          SELECT 1 FROM projects p
           WHERE p.host_id=h.id AND p.provisioned IS TRUE
             AND p.deleted IS NOT TRUE
        )`,
  );
  health.host_maintenance_blocks = hostGates.flatMap((host) => {
    const block = freshHostMaintenanceBlock(host.gate, host.host_last_seen);
    return block ? [{ host_id: host.host_id, ...block }] : [];
  });
  return health;
}
