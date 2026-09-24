/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type { ProjectRecoveryStatus } from "@cocalc/conat/hub/api/projects";
import type { ProjectRecoveryHealth } from "./maintenance-status";

type Kind = "snapshot" | "backup";
type ServiceClass = ProjectRecoveryStatus["storage_service_class"];
type Outcome = "succeeded" | "deferred" | "failed" | "skipped";

const TARGET_MS: Record<"paying" | "free", Record<Kind, number>> = {
  paying: { snapshot: 30 * 60_000, backup: 6 * 60 * 60_000 },
  free: { snapshot: 4 * 60 * 60_000, backup: 24 * 60 * 60_000 },
};
const COVERAGE_SLOT_MS = 15 * 60_000;
const EXPECTED_COVERAGE_SLOTS = 30 * 24 * 4;

function withinTarget({
  serviceClass,
  kind,
  dueAt,
  succeededAt,
}: {
  serviceClass: ServiceClass;
  kind: Kind;
  dueAt: Date;
  succeededAt: Date | null;
}): number {
  if (!succeededAt || serviceClass === "unclassified") return 0;
  return succeededAt.getTime() - dueAt.getTime() <=
    TARGET_MS[serviceClass][kind]
    ? 1
    : 0;
}

let ensurePromise: Promise<void> | undefined;

export async function ensureProjectRecoveryObjectiveTables(): Promise<void> {
  ensurePromise ??= (async () => {
    await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_recovery_objective_state (
      project_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'backup')),
      due_at TIMESTAMPTZ NOT NULL,
      storage_service_class TEXT NOT NULL,
      succeeded_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      PRIMARY KEY (project_id, kind)
    )
  `);
    await getPool().query(`
      ALTER TABLE project_recovery_objective_state
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ
    `);
    await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_recovery_objective_daily (
      due_day DATE NOT NULL,
      storage_service_class TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'backup')),
      obligations BIGINT NOT NULL DEFAULT 0,
      succeeded BIGINT NOT NULL DEFAULT 0,
      on_time BIGINT NOT NULL DEFAULT 0,
      first_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (due_day, storage_service_class, kind)
    )
    `);
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS project_recovery_coverage_slots (
        slot_start TIMESTAMPTZ PRIMARY KEY,
        eligible_snapshots INTEGER NOT NULL,
        eligible_backups INTEGER NOT NULL,
        unknown_snapshots INTEGER NOT NULL,
        unknown_backups INTEGER NOT NULL,
        unaccounted_snapshot_due INTEGER NOT NULL,
        unaccounted_backup_due INTEGER NOT NULL,
        blocked_hosts INTEGER NOT NULL,
        first_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  })().catch((err) => {
    ensurePromise = undefined;
    throw err;
  });
  await ensurePromise;
}

/** Bay-owned inventory audit. Repeated samples retain the worst gap in a slot. */
export async function recordProjectRecoveryCoverageSlot({
  health,
  checkedAt = new Date(),
}: {
  health: ProjectRecoveryHealth;
  checkedAt?: Date;
}): Promise<string> {
  await ensureProjectRecoveryObjectiveTables();
  const slotStart = new Date(
    Math.floor(checkedAt.getTime() / COVERAGE_SLOT_MS) * COVERAGE_SLOT_MS,
  );
  if (!Number.isFinite(slotStart.getTime())) {
    throw new Error("invalid recovery coverage audit time");
  }
  await getPool().query(
    `INSERT INTO project_recovery_coverage_slots
       (slot_start, eligible_snapshots, eligible_backups,
        unknown_snapshots, unknown_backups, unaccounted_snapshot_due,
        unaccounted_backup_due, blocked_hosts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (slot_start) DO UPDATE SET
       eligible_snapshots=GREATEST(project_recovery_coverage_slots.eligible_snapshots, excluded.eligible_snapshots),
       eligible_backups=GREATEST(project_recovery_coverage_slots.eligible_backups, excluded.eligible_backups),
       unknown_snapshots=GREATEST(project_recovery_coverage_slots.unknown_snapshots, excluded.unknown_snapshots),
       unknown_backups=GREATEST(project_recovery_coverage_slots.unknown_backups, excluded.unknown_backups),
       unaccounted_snapshot_due=GREATEST(project_recovery_coverage_slots.unaccounted_snapshot_due, excluded.unaccounted_snapshot_due),
       unaccounted_backup_due=GREATEST(project_recovery_coverage_slots.unaccounted_backup_due, excluded.unaccounted_backup_due),
       blocked_hosts=GREATEST(project_recovery_coverage_slots.blocked_hosts, excluded.blocked_hosts),
       last_recorded_at=NOW()`,
    [
      slotStart,
      health.eligible_snapshot_projects,
      health.eligible_backup_projects,
      health.unknown_snapshot_status,
      health.unknown_backup_status,
      health.unaccounted_snapshot_due,
      health.unaccounted_backup_due,
      health.host_maintenance_blocks.length,
    ],
  );
  return slotStart.toISOString();
}

async function addDailyObjectiveCounts({
  db,
  dueAt,
  serviceClass,
  kind,
  obligation,
  success,
  onTime,
}: {
  db: PoolClient;
  dueAt: Date;
  serviceClass: ServiceClass;
  kind: Kind;
  obligation: number;
  success: number;
  onTime: number;
}): Promise<void> {
  await db.query(
    `INSERT INTO project_recovery_objective_daily
       (due_day, storage_service_class, kind, obligations, succeeded, on_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (due_day, storage_service_class, kind) DO UPDATE SET
       obligations=project_recovery_objective_daily.obligations+excluded.obligations,
       succeeded=project_recovery_objective_daily.succeeded+excluded.succeeded,
       on_time=project_recovery_objective_daily.on_time+excluded.on_time,
       last_recorded_at=NOW()`,
    [
      dueAt.toISOString().slice(0, 10),
      serviceClass,
      kind,
      obligation,
      success,
      onTime,
    ],
  );
}

/**
 * Keep one deduplication row per project/lane and a few daily counters. Both
 * writes participate in the caller's maintenance-report transaction, so a
 * replay or a failed report cannot double-count an obligation.
 */
export async function recordProjectRecoveryObjective({
  db,
  projectId,
  kind,
  serviceClass,
  outcome,
  dueAt,
  observedAt,
}: {
  db: PoolClient;
  projectId: string;
  kind: Kind;
  serviceClass: ServiceClass;
  outcome: Outcome;
  dueAt: Date | null;
  observedAt: Date;
}): Promise<void> {
  if (!dueAt || dueAt > observedAt || outcome === "skipped") return;
  const succeededAt = outcome === "succeeded" ? observedAt : null;
  const inserted = await db.query(
    `INSERT INTO project_recovery_objective_state
       (project_id, kind, due_at, storage_service_class, succeeded_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, kind) DO NOTHING`,
    [projectId, kind, dueAt, serviceClass, succeededAt],
  );
  let pinnedClass = serviceClass;
  let obligation = 0;
  let success = 0;
  if (inserted.rowCount) {
    obligation = 1;
    success = succeededAt ? 1 : 0;
  } else {
    const { rows } = await db.query<{
      due_at: Date;
      storage_service_class: ServiceClass;
      succeeded_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `SELECT due_at, storage_service_class, succeeded_at, cancelled_at
         FROM project_recovery_objective_state
        WHERE project_id=$1 AND kind=$2 FOR UPDATE`,
      [projectId, kind],
    );
    const current = rows[0];
    if (!current) throw new Error("recovery objective state disappeared");
    if (current.due_at < dueAt) {
      await db.query(
        `UPDATE project_recovery_objective_state
            SET due_at=$3, storage_service_class=$4, succeeded_at=$5,
                cancelled_at=NULL
          WHERE project_id=$1 AND kind=$2`,
        [projectId, kind, dueAt, serviceClass, succeededAt],
      );
      obligation = 1;
      success = succeededAt ? 1 : 0;
    } else if (current.due_at.getTime() === dueAt.getTime()) {
      if (current.cancelled_at) return;
      pinnedClass = current.storage_service_class;
      if (pinnedClass === "unclassified" && serviceClass !== "unclassified") {
        await db.query(
          `UPDATE project_recovery_objective_state
              SET storage_service_class=$3
            WHERE project_id=$1 AND kind=$2`,
          [projectId, kind, serviceClass],
        );
        await addDailyObjectiveCounts({
          db,
          dueAt,
          serviceClass: pinnedClass,
          kind,
          obligation: -1,
          success: current.succeeded_at ? -1 : 0,
          onTime: -withinTarget({
            serviceClass: pinnedClass,
            kind,
            dueAt,
            succeededAt: current.succeeded_at,
          }),
        });
        await addDailyObjectiveCounts({
          db,
          dueAt,
          serviceClass,
          kind,
          obligation: 1,
          success: current.succeeded_at ? 1 : 0,
          onTime: withinTarget({
            serviceClass,
            kind,
            dueAt,
            succeededAt: current.succeeded_at,
          }),
        });
        pinnedClass = serviceClass;
      }
      if (succeededAt && !current.succeeded_at) {
        await db.query(
          `UPDATE project_recovery_objective_state SET succeeded_at=$3
            WHERE project_id=$1 AND kind=$2`,
          [projectId, kind, succeededAt],
        );
        success = 1;
      }
    }
  }
  if (!obligation && !success) return;
  await addDailyObjectiveCounts({
    db,
    dueAt,
    serviceClass: pinnedClass,
    kind,
    obligation,
    success,
    onTime: success
      ? withinTarget({ serviceClass: pinnedClass, kind, dueAt, succeededAt })
      : 0,
  });
}

/**
 * Inventory can prove that a provisional snapshot due time had no changed
 * content, or that the host had a newer snapshot and the interval is still
 * open. Keep a tombstone so a delayed queue report cannot recreate false debt.
 */
export async function cancelProjectRecoveryObjective({
  db,
  projectId,
  kind,
  serviceClass,
  dueAt,
  observedAt,
}: {
  db: PoolClient;
  projectId: string;
  kind: Kind;
  serviceClass: ServiceClass;
  dueAt: Date | null;
  observedAt: Date;
}): Promise<void> {
  if (!dueAt || dueAt > observedAt) return;
  const { rows } = await db.query<{
    due_at: Date;
    storage_service_class: ServiceClass;
    succeeded_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `SELECT due_at, storage_service_class, succeeded_at, cancelled_at
       FROM project_recovery_objective_state
      WHERE project_id=$1 AND kind=$2 FOR UPDATE`,
    [projectId, kind],
  );
  const current = rows[0];
  if (current && current.due_at > dueAt) return;
  if (current && !current.cancelled_at && !current.succeeded_at) {
    await addDailyObjectiveCounts({
      db,
      dueAt: current.due_at,
      serviceClass: current.storage_service_class,
      kind,
      obligation: -1,
      success: 0,
      onTime: 0,
    });
  }
  if (current) {
    if (current.due_at.getTime() === dueAt.getTime() && current.succeeded_at) {
      return;
    }
    await db.query(
      `UPDATE project_recovery_objective_state
          SET due_at=$3, storage_service_class=$4, succeeded_at=NULL,
              cancelled_at=$5
        WHERE project_id=$1 AND kind=$2`,
      [projectId, kind, dueAt, serviceClass, observedAt],
    );
  } else {
    await db.query(
      `INSERT INTO project_recovery_objective_state
         (project_id, kind, due_at, storage_service_class, cancelled_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, kind, dueAt, serviceClass, observedAt],
    );
  }
}

export interface ProjectRecoveryServiceObjective {
  storage_service_class: ServiceClass;
  kind: Kind;
  obligations: number;
  succeeded: number;
  on_time: number;
  target_seconds: number | null;
}

/** A mature 30-UTC-day window; two recent days are excluded for the 24h target. */
export async function getProjectRecoveryServiceObjectives(): Promise<{
  collecting_since: string | null;
  window_start: string;
  window_end: string;
  ready: boolean;
  coverage_slots_observed: number;
  coverage_slots_expected: number;
  coverage_gap_slots: number;
  rows: ProjectRecoveryServiceObjective[];
}> {
  await ensureProjectRecoveryObjectiveTables();
  const { rows } = await getPool().query<{
    storage_service_class: ServiceClass;
    kind: Kind;
    obligations: string;
    succeeded: string;
    on_time: string;
  }>(
    `SELECT storage_service_class, kind,
            SUM(obligations)::text AS obligations,
            SUM(succeeded)::text AS succeeded,
            SUM(on_time)::text AS on_time
       FROM project_recovery_objective_daily
      WHERE due_day >= (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '31 days'
        AND due_day < (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '1 day'
      GROUP BY storage_service_class, kind
      ORDER BY storage_service_class, kind`,
  );
  const first = await getPool().query<{ first_recorded_at: Date | null }>(
    `SELECT MIN(first_recorded_at) AS first_recorded_at
       FROM project_recovery_objective_daily`,
  );
  const collectingSince = first.rows[0]?.first_recorded_at ?? null;
  const today = new Date();
  const day = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const windowStart = new Date(day - 31 * 86_400_000);
  const windowExclusiveEnd = new Date(day - 86_400_000);
  const coverage = await getPool().query<{
    observed: string;
    gaps: string;
  }>(
    `SELECT COUNT(*)::text AS observed,
            COUNT(*) FILTER (WHERE unknown_snapshots > 0 OR unknown_backups > 0
              OR unaccounted_snapshot_due > 0 OR unaccounted_backup_due > 0
              OR blocked_hosts > 0)::text AS gaps
       FROM project_recovery_coverage_slots
      WHERE slot_start >= $1 AND slot_start < $2`,
    [windowStart, windowExclusiveEnd],
  );
  const observedSlots = Number(coverage.rows[0]?.observed ?? 0);
  const gapSlots = Number(coverage.rows[0]?.gaps ?? 0);
  return {
    collecting_since: collectingSince?.toISOString() ?? null,
    window_start: windowStart.toISOString().slice(0, 10),
    window_end: new Date(day - 2 * 86_400_000).toISOString().slice(0, 10),
    ready:
      collectingSince != null &&
      Date.now() - collectingSince.getTime() >= 32 * 86_400_000 &&
      observedSlots === EXPECTED_COVERAGE_SLOTS &&
      gapSlots === 0,
    coverage_slots_observed: observedSlots,
    coverage_slots_expected: EXPECTED_COVERAGE_SLOTS,
    coverage_gap_slots: gapSlots,
    rows: rows.map((row) => ({
      storage_service_class: row.storage_service_class,
      kind: row.kind,
      obligations: Number(row.obligations),
      succeeded: Number(row.succeeded),
      on_time: Number(row.on_time),
      target_seconds:
        row.storage_service_class === "paying" ||
        row.storage_service_class === "free"
          ? TARGET_MS[row.storage_service_class][row.kind] / 1000
          : null,
    })),
  };
}
