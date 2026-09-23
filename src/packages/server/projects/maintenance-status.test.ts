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
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_maintenance_status"),
    );
    expect(insert?.[1].slice(14)).toEqual([
      { inventory: 12, create: 50 },
      1024,
      256,
    ]);
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
  });
});
