/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  ensureProjectMaintenanceStatusTable,
  getProjectRecoveryAttemptHealth,
  getProjectRecoveryHealth,
  getProjectRecoveryRecentPayingCompletions,
  getProjectRecoveryStatusLocal,
  recordProjectMaintenanceStatus,
} from "./maintenance-status";
import {
  getProjectRecoveryServiceObjectives,
  recordProjectRecoveryCoverageSlot,
} from "./recovery-objectives";
import type { ProjectRecoveryHealth } from "./maintenance-status";

describe("project recovery capacity accounting", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureProjectMaintenanceStatusTable();
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("rejects reports after ownership moves to another bay", async () => {
    const host_id = uuid();
    const local_project_id = uuid();
    const legacy_project_id = uuid();
    const foreign_project_id = uuid();
    const bay_id = getConfiguredBayId();
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'local maintenance report', $5, $4, true),
              ($2, 'legacy maintenance report', NULL, $4, true),
              ($3, 'foreign maintenance report', $6, $4, true)`,
      [
        local_project_id,
        legacy_project_id,
        foreign_project_id,
        host_id,
        bay_id,
        `${bay_id}-foreign`,
      ],
    );
    for (const [project_id, accepted] of [
      [local_project_id, true],
      [legacy_project_id, true],
      [foreign_project_id, false],
    ] as const) {
      expect(
        await recordProjectMaintenanceStatus({
          project_id,
          host_id,
          kind: "snapshot",
          observed_at: new Date().toISOString(),
          outcome: "deferred",
          reason: "lifecycle_active",
        }),
      ).toBe(accepted);
    }
    await getPool().query(
      `UPDATE projects SET owning_bay_id=$2 WHERE project_id=$1`,
      [local_project_id, `${bay_id}-foreign`],
    );
    expect(
      await recordProjectMaintenanceStatus({
        project_id: local_project_id,
        host_id,
        kind: "snapshot",
        observed_at: new Date(Date.now() + 1000).toISOString(),
        outcome: "failed",
        reason: "stale report after rehome",
      }),
    ).toBe(false);
    const { rows } = await getPool().query<{ project_id: string }>(
      `SELECT project_id FROM project_maintenance_status
        WHERE project_id = ANY($1::uuid[])`,
      [[local_project_id, legacy_project_id, foreign_project_id]],
    );
    expect(rows.map(({ project_id }) => project_id).sort()).toEqual(
      [local_project_id, legacy_project_id].sort(),
    );
    const { rows: retained } = await getPool().query<{
      outcome: string;
      attempts: number;
    }>(
      `SELECT s.outcome,
              (SELECT COUNT(*)::int FROM project_maintenance_attempts a
                 WHERE a.project_id=s.project_id) AS attempts
         FROM project_maintenance_status s
        WHERE s.project_id=$1 AND s.kind='snapshot'`,
      [local_project_id],
    );
    expect(retained).toEqual([{ outcome: "deferred", attempts: 1 }]);
    await expect(
      getProjectRecoveryStatusLocal(local_project_id),
    ).rejects.toThrow("project not found");
    await expect(
      getProjectRecoveryStatusLocal(foreign_project_id),
    ).rejects.toThrow("project not found");
    expect(
      (await getProjectRecoveryStatusLocal(legacy_project_id)).project_id,
    ).toBe(legacy_project_id);
  });

  it("counts a retried due obligation once and sums its work and wait", async () => {
    const host_id = uuid();
    const project_id = uuid();
    const due = new Date(Date.now() - 120_000);
    for (const [seconds, outcome, duration, wait] of [
      [30, "failed", 3000, 1000],
      [10, "succeeded", 5000, 2000],
    ] as const) {
      await getPool().query(
        `INSERT INTO project_maintenance_attempts
           (project_id, kind, host_id, storage_service_class, observed_at,
            outcome, attempt_due_at, duration_ms, stage_durations_ms,
            bytes_uploaded)
         VALUES ($1, 'backup', $2, 'paying', $3, $4, $5, $6, $7, $8)`,
        [
          project_id,
          host_id,
          new Date(Date.now() - seconds * 1000),
          outcome,
          due,
          duration,
          { queue_wait: wait },
          outcome === "succeeded" ? 1024 : 0,
        ],
      );
    }
    const report = await getProjectRecoveryAttemptHealth();
    expect(report.by_host).toContainEqual(
      expect.objectContaining({
        host_id,
        storage_service_class: "paying",
        kind: "backup",
        succeeded: 1,
        failed: 1,
        due_obligations: 1,
        execution_seconds: 8,
        successful_execution_seconds: 5,
        queue_wait_seconds: 3,
        bytes_uploaded: 1024,
      }),
    );
  });

  it("shows a changed generation as a distinct deferral reason", async () => {
    const host_id = uuid();
    await getPool().query(
      `INSERT INTO project_maintenance_attempts
         (project_id, kind, host_id, storage_service_class, observed_at,
          outcome, reason)
       VALUES ($1, 'snapshot', $2, 'free', NOW(), 'deferred',
               'change_generation_changed')`,
      [uuid(), host_id],
    );
    const report = await getProjectRecoveryAttemptHealth();
    expect(report.reasons).toContainEqual({
      host_id,
      storage_service_class: "free",
      kind: "snapshot",
      outcome: "deferred",
      reason_code: "change_generation_changed",
      attempts: 1,
    });
  });

  it("reconciles the host's newer local snapshot without counting an interval wait as debt", async () => {
    const host_id = uuid();
    const project_id = uuid();
    const now = Date.now();
    const older = new Date(now - 20 * 60_000).toISOString();
    const newer = new Date(now - 5 * 60_000).toISOString();
    const changed = new Date(now - 60_000).toISOString();
    const due = new Date(now + 10 * 60_000).toISOString();
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned,
          last_edited, snapshots)
       VALUES ($1, 'snapshot interval test', 'bay-0', $2, true, $3, $4)`,
      [
        project_id,
        host_id,
        changed,
        { frequent: 1, daily: 0, weekly: 0, monthly: 0 },
      ],
    );
    expect(
      await recordProjectMaintenanceStatus({
        host_id,
        project_id,
        kind: "snapshot",
        observed_at: new Date(now - 2_000).toISOString(),
        outcome: "succeeded",
        latest_snapshot_at: older,
      }),
    ).toBe(true);
    expect(
      await recordProjectMaintenanceStatus({
        host_id,
        project_id,
        kind: "snapshot",
        observed_at: new Date(now - 1_000).toISOString(),
        outcome: "skipped",
        reason: "snapshot_interval_wait",
        latest_snapshot_at: newer,
        due_at: due,
      }),
    ).toBe(true);
    const { rows } = await getPool().query(
      `SELECT outcome, reason, latest_snapshot_at, due_at
         FROM project_maintenance_status
        WHERE project_id=$1 AND kind='snapshot'`,
      [project_id],
    );
    expect(rows[0]).toMatchObject({
      outcome: "skipped",
      reason: "snapshot_interval_wait",
      latest_snapshot_at: new Date(newer),
      due_at: new Date(due),
    });
    const status = await getProjectRecoveryStatusLocal(project_id);
    expect(status.snapshot?.latest_snapshot_at).toBe(newer);
    expect(status.snapshot?.outcome).toBe("skipped");
    expect(status.snapshot_due_at).toBe(due);
    const attempts = await getPool().query(
      `SELECT COUNT(*)::int AS deferred
         FROM project_maintenance_attempts
        WHERE project_id=$1 AND outcome='deferred'`,
      [project_id],
    );
    expect(attempts.rows[0].deferred).toBe(0);
  });

  it("uses lane-specific recent paying completion windows", async () => {
    const host_id = uuid();
    for (const [kind, serviceClass, outcome, minutesAgo] of [
      ["snapshot", "paying", "succeeded", 29],
      ["snapshot", "paying", "succeeded", 31],
      ["backup", "paying", "succeeded", 119],
      ["backup", "paying", "succeeded", 121],
      ["snapshot", "free", "succeeded", 1],
      ["backup", "paying", "failed", 1],
    ] as const) {
      await getPool().query(
        `INSERT INTO project_maintenance_attempts
           (project_id, kind, host_id, storage_service_class, observed_at,
            outcome)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuid(),
          kind,
          host_id,
          serviceClass,
          new Date(Date.now() - minutesAgo * 60_000),
          outcome,
        ],
      );
    }
    const rows = await getProjectRecoveryRecentPayingCompletions();
    expect(rows.filter((row) => row.host_id === host_id)).toEqual(
      expect.arrayContaining([
        { host_id, kind: "snapshot", succeeded: 1 },
        { host_id, kind: "backup", succeeded: 1 },
      ]),
    );
    expect(rows.filter((row) => row.host_id === host_id)).toHaveLength(2);
  });

  it("counts a due obligation once across retries and report replay", async () => {
    const host_id = uuid();
    const project_id = uuid();
    // The daily rollup is keyed by each due time's UTC date, so keep both
    // due times (firstDue and secondDue) on one UTC day.
    const threeHoursAgo = Date.now() - 3 * 60 * 60_000;
    const secondDueDay = new Date(threeHoursAgo + 60 * 60_000);
    secondDueDay.setUTCHours(0, 0, 0, 0);
    const firstDue = new Date(Math.max(threeHoursAgo, secondDueDay.getTime()));
    const firstFailure = new Date(firstDue.getTime() + 5 * 60_000);
    const firstSuccess = new Date(firstDue.getTime() + 20 * 60_000);
    const secondDue = new Date(firstDue.getTime() + 60 * 60_000);
    const secondSuccess = new Date(secondDue.getTime() + 35 * 60_000);
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'objective test', 'bay-0', $2, true)`,
      [project_id, host_id],
    );
    const report = async ({
      due,
      observed,
      outcome,
    }: {
      due: Date;
      observed: Date;
      outcome: "failed" | "succeeded";
    }) =>
      recordProjectMaintenanceStatus({
        host_id,
        project_id,
        kind: "snapshot",
        storage_service_class: "paying",
        observed_at: observed.toISOString(),
        due_at: due.toISOString(),
        attempt_due_at: due.toISOString(),
        outcome,
        latest_snapshot_at:
          outcome === "succeeded" ? observed.toISOString() : null,
      });
    expect(
      await report({
        due: firstDue,
        observed: firstFailure,
        outcome: "failed",
      }),
    ).toBe(true);
    expect(
      await report({
        due: firstDue,
        observed: firstSuccess,
        outcome: "succeeded",
      }),
    ).toBe(true);
    expect(
      await report({
        due: firstDue,
        observed: firstSuccess,
        outcome: "succeeded",
      }),
    ).toBe(true);
    expect(
      await report({
        due: secondDue,
        observed: secondSuccess,
        outcome: "succeeded",
      }),
    ).toBe(true);
    expect(
      await report({
        due: firstDue,
        observed: firstFailure,
        outcome: "failed",
      }),
    ).toBe(false);
    const { rows } = await getPool().query(
      `SELECT obligations, succeeded, on_time
         FROM project_recovery_objective_daily
        WHERE due_day=$1 AND storage_service_class='paying'
          AND kind='snapshot'`,
      [firstDue.toISOString().slice(0, 10)],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        obligations: "2",
        succeeded: "2",
        on_time: "1",
      }),
    ]);
  });

  it("counts queued backup debt before an attempt without inflating attempt history", async () => {
    const host_id = uuid();
    const project_id = uuid();
    const due = new Date(Date.now() - 10 * 60_000);
    // The inventory began just before this item became due.
    const queued = new Date(due.getTime() - 1000);
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'queued objective test', 'bay-0', $2, true)`,
      [project_id, host_id],
    );
    const base = {
      host_id,
      project_id,
      kind: "backup" as const,
      storage_service_class: "paying" as const,
      due_at: due.toISOString(),
      attempt_due_at: due.toISOString(),
    };
    expect(
      await recordProjectMaintenanceStatus({
        ...base,
        observed_at: queued.toISOString(),
        outcome: "deferred",
        reason: "queued",
      }),
    ).toBe(true);
    const daily = () =>
      getPool().query<{ obligations: string; succeeded: string }>(
        `SELECT obligations, succeeded
           FROM project_recovery_objective_daily
          WHERE due_day=$1 AND storage_service_class='paying'
            AND kind='backup'`,
        [due.toISOString().slice(0, 10)],
      );
    expect((await daily()).rows).toEqual([
      { obligations: "1", succeeded: "0" },
    ]);
    const attempts = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM project_maintenance_attempts
        WHERE project_id=$1`,
      [project_id],
    );
    expect(attempts.rows[0].count).toBe("0");
    await recordProjectMaintenanceStatus({
      ...base,
      observed_at: new Date(Date.now() - 1000).toISOString(),
      outcome: "succeeded",
      latest_backup_id: "queue-test-backup",
    });
    expect((await daily()).rows).toEqual([
      { obligations: "1", succeeded: "1" },
    ]);
  });

  it("removes provisional snapshot debt when host inventory finds no change", async () => {
    const host_id = uuid();
    const project_id = uuid();
    const due = new Date(Date.now() - 10 * 60_000);
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'queued snapshot objective test', 'bay-0', $2, true)`,
      [project_id, host_id],
    );
    const base = {
      host_id,
      project_id,
      kind: "snapshot" as const,
      storage_service_class: "free" as const,
      attempt_due_at: due.toISOString(),
    };
    await recordProjectMaintenanceStatus({
      ...base,
      observed_at: new Date(Date.now() - 5000).toISOString(),
      outcome: "deferred",
      reason: "queued",
      due_at: due.toISOString(),
    });
    await recordProjectMaintenanceStatus({
      ...base,
      observed_at: new Date(Date.now() - 3000).toISOString(),
      outcome: "skipped",
      reason: "no_content_change",
      due_at: null,
    });
    // A late report for the same provisional due must not recreate debt.
    await recordProjectMaintenanceStatus({
      ...base,
      observed_at: new Date(Date.now() - 1000).toISOString(),
      outcome: "deferred",
      reason: "queued",
      due_at: due.toISOString(),
    });
    const daily = await getPool().query<{ obligations: string }>(
      `SELECT obligations FROM project_recovery_objective_daily
        WHERE due_day=$1 AND storage_service_class='free'
          AND kind='snapshot'`,
      [due.toISOString().slice(0, 10)],
    );
    expect(daily.rows).toEqual([{ obligations: "0" }]);
  });

  it("reads a mature UTC due day from durable objective counters", async () => {
    await getPool().query(
      `INSERT INTO project_recovery_objective_daily
         (due_day, storage_service_class, kind, obligations, succeeded, on_time)
       VALUES ((NOW() AT TIME ZONE 'UTC')::date - INTERVAL '3 days',
               'free', 'backup', 3, 2, 1)`,
    );
    const report = await getProjectRecoveryServiceObjectives();
    expect(report.ready).toBe(false);
    expect(report.rows).toContainEqual({
      storage_service_class: "free",
      kind: "backup",
      obligations: 3,
      succeeded: 2,
      on_time: 1,
      target_seconds: 24 * 60 * 60,
    });
  });

  it("retains the worst inventory gap across repeated coverage samples", async () => {
    const checkedAt = new Date();
    const health: ProjectRecoveryHealth = {
      eligible_snapshot_projects: 2,
      eligible_backup_projects: 3,
      unaccounted_snapshot_due: 1,
      unaccounted_backup_due: 0,
      paying_snapshot_overdue: 0,
      paying_backup_overdue: 0,
      unclassified_snapshot_overdue: 0,
      unclassified_backup_overdue: 0,
      paying_snapshot_repeated_failures: 0,
      paying_backup_repeated_failures: 0,
      unknown_snapshot_status: 0,
      unknown_backup_status: 1,
      oldest_snapshot_delay_seconds: 0,
      oldest_backup_delay_seconds: 0,
      host_maintenance_blocks: [],
      by_host_class: [],
      oldest_debt: [],
    };
    const slot = await recordProjectRecoveryCoverageSlot({ health, checkedAt });
    await recordProjectRecoveryCoverageSlot({
      health: {
        ...health,
        eligible_snapshot_projects: 1,
        unaccounted_snapshot_due: 0,
        unknown_backup_status: 0,
      },
      checkedAt,
    });
    const { rows } = await getPool().query(
      `SELECT eligible_snapshots, unknown_backups, unaccounted_snapshot_due
         FROM project_recovery_coverage_slots WHERE slot_start=$1`,
      [slot],
    );
    expect(rows).toEqual([
      {
        eligible_snapshots: 2,
        unknown_backups: 1,
        unaccounted_snapshot_due: 1,
      },
    ]);
    const report = await getProjectRecoveryServiceObjectives();
    expect(report.ready).toBe(false);
    expect(report.coverage_slots_expected).toBe(2880);
  });

  it("qualifies a mature objective only with every clean coverage slot", async () => {
    const today = new Date();
    const utcDay = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    );
    const start = new Date(utcDay - 31 * 86_400_000);
    const end = new Date(utcDay - 86_400_000);
    const fixtureClass = `coverage-fixture-${uuid()}`;
    await getPool().query(
      `INSERT INTO project_recovery_objective_daily
         (due_day, storage_service_class, kind, obligations,
          first_recorded_at)
       VALUES ($1, $2, 'backup', 1, $3)`,
      [
        new Date(utcDay - 3 * 86_400_000),
        fixtureClass,
        new Date(utcDay - 33 * 86_400_000),
      ],
    );
    try {
      await getPool().query(
        `INSERT INTO project_recovery_coverage_slots
           (slot_start, eligible_snapshots, eligible_backups,
            unknown_snapshots, unknown_backups, unaccounted_snapshot_due,
            unaccounted_backup_due, blocked_hosts)
         SELECT slot, 1, 1, 0, 0, 0, 0, 0
           FROM generate_series($1::timestamptz,
             $2::timestamptz - INTERVAL '15 minutes',
             INTERVAL '15 minutes') AS slots(slot)`,
        [start, end],
      );
      const clean = await getProjectRecoveryServiceObjectives();
      expect(clean.coverage_slots_observed).toBe(2880);
      expect(clean.coverage_gap_slots).toBe(0);
      expect(clean.ready).toBe(true);

      await getPool().query(
        `UPDATE project_recovery_coverage_slots
            SET unknown_backups=1 WHERE slot_start=$1`,
        [start],
      );
      const gap = await getProjectRecoveryServiceObjectives();
      expect(gap.coverage_gap_slots).toBe(1);
      expect(gap.ready).toBe(false);
    } finally {
      await getPool().query(
        `DELETE FROM project_recovery_coverage_slots
          WHERE slot_start >= $1 AND slot_start < $2`,
        [start, end],
      );
      await getPool().query(
        `DELETE FROM project_recovery_objective_daily
          WHERE storage_service_class=$1`,
        [fixtureClass],
      );
    }
  });

  it("reclassifies an unresolved obligation when its storage payer becomes known", async () => {
    const host_id = uuid();
    const project_id = uuid();
    const due = new Date(Date.now() - 28 * 60 * 60_000);
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'objective payer test', 'bay-0', $2, true)`,
      [project_id, host_id],
    );
    for (const [minutes, outcome, serviceClass] of [
      [5, "failed", "unclassified"],
      [20, "succeeded", "paying"],
    ] as const) {
      const observed = new Date(due.getTime() + minutes * 60_000);
      expect(
        await recordProjectMaintenanceStatus({
          host_id,
          project_id,
          kind: "snapshot",
          storage_service_class: serviceClass,
          observed_at: observed.toISOString(),
          attempt_due_at: due.toISOString(),
          outcome,
          latest_snapshot_at:
            outcome === "succeeded" ? observed.toISOString() : null,
        }),
      ).toBe(true);
    }
    const { rows } = await getPool().query(
      `SELECT storage_service_class, obligations, succeeded, on_time
         FROM project_recovery_objective_daily
        WHERE due_day=$1 AND kind='snapshot'
          AND storage_service_class IN ('unclassified', 'paying')`,
      [due.toISOString().slice(0, 10)],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storage_service_class: "unclassified",
          obligations: "0",
          succeeded: "0",
          on_time: "0",
        }),
        expect.objectContaining({
          storage_service_class: "paying",
          obligations: "1",
          succeeded: "1",
          on_time: "1",
        }),
      ]),
    );
  });

  it("counts legacy local projects but excludes projects owned by another bay", async () => {
    const before = await getProjectRecoveryHealth();
    const host_id = uuid();
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned)
       VALUES ($1, 'legacy local recovery', NULL, $3, true),
              ($2, 'foreign recovery', 'another-bay', $3, true)`,
      [uuid(), uuid(), host_id],
    );
    const after = await getProjectRecoveryHealth();
    expect(after.eligible_snapshot_projects).toBe(
      before.eligible_snapshot_projects + 1,
    );
    expect(after.eligible_backup_projects).toBe(
      before.eligible_backup_projects + 1,
    );
  });
});
