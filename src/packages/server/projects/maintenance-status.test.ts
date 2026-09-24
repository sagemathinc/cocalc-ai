/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
}));

describe("project recovery status after unchanged-content reconciliation", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
  });

  async function statusFor({
    changedAt,
    reconciledAt,
    scheduleChanged = false,
  }: {
    changedAt: string;
    reconciledAt: string;
    scheduleChanged?: boolean;
  }) {
    const { snapshotScheduleRevision } = await import("./maintenance-status");
    const schedule = { frequent: 0, daily: 1, weekly: 0, monthly: 0 };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects p LEFT JOIN project_hosts")) {
        return {
          rows: [
            {
              project_id: "project-1",
              host_id: "host-1",
              last_backup: null,
              last_changed: new Date(changedAt),
              host_last_seen: new Date("2026-04-11T00:00:00.000Z"),
              snapshots: schedule,
              backups: { disabled: true },
            },
          ],
        };
      }
      if (sql.includes("FROM project_maintenance_status WHERE")) {
        return {
          rows: [
            {
              kind: "snapshot",
              host_id: "host-1",
              observed_at: new Date("2026-04-11T00:00:00.000Z"),
              outcome: "skipped",
              reason: "no_content_change",
              due_at: null,
              latest_snapshot_at: new Date("2026-04-09T00:00:00.000Z"),
              reconciled_change_at: new Date(reconciledAt),
              reconciled_schedule_revision: scheduleChanged
                ? "previous-revision"
                : snapshotScheduleRevision(schedule),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { getProjectRecoveryStatusLocal } =
      await import("./maintenance-status");
    return await getProjectRecoveryStatusLocal("project-1");
  }

  it("does not show unchanged content as overdue", async () => {
    const status = await statusFor({
      changedAt: "2026-04-10T00:00:00.000Z",
      reconciledAt: "2026-04-10T00:00:00.000Z",
    });
    expect(status.snapshot_due_at).toBeNull();
    expect(status.snapshot?.reason).toBe("no_content_change");
  });

  it("makes a later change due again", async () => {
    const status = await statusFor({
      changedAt: "2026-04-11T00:00:00.000Z",
      reconciledAt: "2026-04-10T00:00:00.000Z",
    });
    expect(status.snapshot_due_at).toBe("2026-04-11T00:00:00.000Z");
  });

  it("makes a changed snapshot schedule due again", async () => {
    const status = await statusFor({
      changedAt: "2026-04-10T00:00:00.000Z",
      reconciledAt: "2026-04-10T00:00:00.000Z",
      scheduleChanged: true,
    });
    expect(status.snapshot_due_at).toBe("2026-04-10T00:00:00.000Z");
  });

  it("rejects a snapshot success report without a recovery point", async () => {
    const { recordProjectMaintenanceStatus } =
      await import("./maintenance-status");
    await expect(
      recordProjectMaintenanceStatus({
        host_id: "host-1",
        project_id: "project-1",
        kind: "snapshot",
        observed_at: new Date().toISOString(),
        outcome: "succeeded",
        latest_snapshot_at: null,
      }),
    ).rejects.toThrow("snapshot success requires a confirmed snapshot time");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("replaces a stale latest snapshot after confirmed empty inventory", async () => {
    const { recordProjectMaintenanceStatus } =
      await import("./maintenance-status");
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    await recordProjectMaintenanceStatus({
      host_id: "host-1",
      project_id: "project-1",
      kind: "snapshot",
      observed_at: new Date().toISOString(),
      outcome: "skipped",
      reason: "no_content_change",
      latest_snapshot_at: null,
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_maintenance_status"),
    );
    expect(insert?.[0]).toContain(
      "excluded.outcome='skipped' AND excluded.reason='no_content_change'",
    );
    expect(insert?.[1][7]).toBeNull();
  });

  it("bounds stage timing labels and backup byte counts in the bay projection", async () => {
    const { recordProjectMaintenanceStatus } =
      await import("./maintenance-status");
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    await recordProjectMaintenanceStatus({
      host_id: "host-1",
      project_id: "project-1",
      kind: "backup",
      observed_at: new Date().toISOString(),
      outcome: "succeeded",
      stage_durations_ms: {
        inventory: 12.7,
        create: 50,
        arbitrary_project_label: 100,
      },
      bytes_scanned: 1024,
      bytes_uploaded: 256,
      latest_backup_id: "a".repeat(64),
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_maintenance_status"),
    );
    expect(insert?.[1].slice(14, 18)).toEqual([
      { inventory: 12, create: 50 },
      1024,
      256,
      "a".repeat(64),
    ]);
    const attempt = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_maintenance_attempts"),
    );
    expect(attempt?.[1].slice(10, 15)).toEqual([
      { inventory: 12, create: 50 },
      1024,
      256,
      null,
      "a".repeat(64),
    ]);
  });

  it("does not record an attempt from a stale project host", async () => {
    const { recordProjectMaintenanceStatus } =
      await import("./maintenance-status");
    queryMock.mockImplementation(async (sql: string) => ({
      rows: [],
      rowCount: sql.includes("INSERT INTO project_maintenance_status") ? 0 : 1,
    }));
    expect(
      await recordProjectMaintenanceStatus({
        host_id: "old-host",
        project_id: "project-1",
        kind: "backup",
        observed_at: new Date().toISOString(),
        outcome: "failed",
      }),
    ).toBe(false);
    expect(
      queryMock.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO project_maintenance_attempts"),
      ),
    ).toBe(false);
  });

  it("summarizes attempts and bounded stages for operator health", async () => {
    const { getProjectRecoveryAttemptHealth } =
      await import("./maintenance-status");
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*) FILTER (WHERE outcome='succeeded')")) {
        return {
          rows: [
            {
              host_id: "host-1",
              storage_service_class: "paying",
              kind: "backup",
              succeeded: 2,
              deferred: 1,
              failed: 0,
              skipped: 0,
              bytes_scanned: "1024",
              bytes_uploaded: "128",
            },
          ],
        };
      }
      if (sql.includes("percentile_cont(0.95)")) {
        if (sql.includes("attempt_due_at")) {
          return {
            rows: [
              {
                storage_service_class: "paying",
                kind: "backup",
                samples: 2,
                p95_seconds: 120,
                p99_seconds: 140,
              },
            ],
          };
        }
        return {
          rows: [
            {
              storage_service_class: "paying",
              kind: "backup",
              stage: "create",
              samples: 3,
              p95_ms: 900,
              p99_ms: 950,
            },
          ],
        };
      }
      if (sql.includes("AS reason_code")) {
        return {
          rows: [
            {
              host_id: "host-1",
              storage_service_class: "paying",
              kind: "backup",
              outcome: "deferred",
              reason_code: "backup_capacity_busy",
              attempts: 1,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    expect(await getProjectRecoveryAttemptHealth()).toEqual({
      by_host: [
        {
          host_id: "host-1",
          storage_service_class: "paying",
          kind: "backup",
          succeeded: 2,
          deferred: 1,
          failed: 0,
          skipped: 0,
          bytes_scanned: 1024,
          bytes_uploaded: 128,
        },
      ],
      stages: [
        {
          storage_service_class: "paying",
          kind: "backup",
          stage: "create",
          samples: 3,
          p95_ms: 900,
          p99_ms: 950,
        },
      ],
      due_to_success: [
        {
          storage_service_class: "paying",
          kind: "backup",
          samples: 2,
          p95_seconds: 120,
          p99_seconds: 140,
        },
      ],
      reasons: [
        {
          host_id: "host-1",
          storage_service_class: "paying",
          kind: "backup",
          outcome: "deferred",
          reason_code: "backup_capacity_busy",
          attempts: 1,
        },
      ],
    });
  });

  it("counts new changes after an unchanged-content report in health", async () => {
    const { getProjectRecoveryHealth, snapshotScheduleRevision } =
      await import("./maintenance-status");
    const schedule = { frequent: 0, daily: 1, weekly: 0, monthly: 0 };
    const old = new Date(Date.now() - 4 * 60 * 60_000);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects p") && sql.includes("LIMIT 1000")) {
        return {
          rows: [
            {
              project_id: "project-1",
              host_id: "host-1",
              last_changed: old,
              last_backup: null,
              host_last_seen: new Date(),
              snapshots: schedule,
              backups: { disabled: true },
              snapshot_at: null,
              snapshot_observed_at: new Date(),
              snapshot_class: "paying",
              reconciled_change_at: new Date(old.getTime() - 60_000),
              reconciled_schedule_revision: snapshotScheduleRevision(schedule),
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const health = await getProjectRecoveryHealth();
    expect(health.paying_snapshot_overdue).toBe(1);
    expect(health.oldest_snapshot_delay_seconds).toBeGreaterThan(2 * 3600);
    expect(health.unknown_snapshot_status).toBe(0);
    expect(health.by_host_class).toEqual([
      expect.objectContaining({
        host_id: "host-1",
        storage_service_class: "paying",
        kind: "snapshot",
        overdue_count: 1,
        unknown_count: 0,
        repeated_failures: 0,
      }),
    ]);
  });

  it("keeps an overdue project with missing host classification visible", async () => {
    const { getProjectRecoveryHealth } = await import("./maintenance-status");
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects p") && sql.includes("LIMIT 1000")) {
        return {
          rows: [
            {
              project_id: "project-1",
              host_id: "host-1",
              last_changed: new Date(Date.now() - 3 * 60 * 60_000),
              last_backup: null,
              host_last_seen: null,
              snapshots: { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
              backups: { disabled: true },
              snapshot_at: null,
              snapshot_observed_at: null,
              snapshot_class: null,
              reconciled_change_at: null,
              reconciled_schedule_revision: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const health = await getProjectRecoveryHealth();
    expect(health.unclassified_snapshot_overdue).toBe(1);
    expect(health.unknown_snapshot_status).toBe(1);
    expect(health.by_host_class).toEqual([
      expect.objectContaining({
        host_id: "host-1",
        storage_service_class: "unclassified",
        kind: "snapshot",
        overdue_count: 1,
        unknown_count: 1,
      }),
    ]);
  });

  it("counts repeated paid failures before the due-age incident threshold", async () => {
    const { getProjectRecoveryHealth } = await import("./maintenance-status");
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects p") && sql.includes("LIMIT 1000")) {
        return {
          rows: [
            {
              project_id: "project-1",
              host_id: "host-1",
              last_changed: new Date(Date.now() - 60_000),
              last_backup: null,
              host_last_seen: new Date(),
              snapshots: { disabled: true },
              backups: { daily: 1 },
              backup_observed_at: new Date(),
              backup_class: "paying",
              backup_outcome: "failed",
              backup_failures: 3,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const health = await getProjectRecoveryHealth();
    expect(health.paying_backup_repeated_failures).toBe(1);
    expect(health.paying_backup_overdue).toBe(0);
    expect(health.by_host_class).toEqual([
      expect.objectContaining({
        host_id: "host-1",
        storage_service_class: "paying",
        kind: "backup",
        repeated_failures: 1,
      }),
    ]);
  });
});
