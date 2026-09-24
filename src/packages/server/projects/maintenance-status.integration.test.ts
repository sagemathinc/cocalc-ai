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
