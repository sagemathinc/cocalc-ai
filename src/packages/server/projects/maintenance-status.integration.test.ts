/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import {
  ensureProjectMaintenanceStatusTable,
  getProjectRecoveryAttemptHealth,
  getProjectRecoveryRecentPayingCompletions,
  getProjectRecoveryStatusLocal,
  recordProjectMaintenanceStatus,
} from "./maintenance-status";

describe("project recovery capacity accounting", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureProjectMaintenanceStatusTable();
  }, 15000);

  afterAll(async () => {
    await getPool().end();
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
});
