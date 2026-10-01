import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";
import { MaintenanceScheduleRefresh } from "./maintenance-schedule-refresh";

function row(project_id: string): HostProjectMaintenanceSchedule {
  return { project_id, snapshots: {}, backups: {} };
}

describe("maintenance schedule refresh", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
  });

  afterEach(() => jest.useRealTimers());

  it("batches at most 100 stale candidates and shares the budget across callers", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const rows = Array.from({ length: 500 }, (_, i) => row(`project-${i}`));
    refresh.observe({ rows, version: 1, at: Date.now() });
    jest.setSystemTime(Date.now() + 60_001);
    let finish!: (rows: HostProjectMaintenanceSchedule[]) => void;
    const list = jest.fn(
      (_projectIds: string[]) =>
        new Promise<HostProjectMaintenanceSchedule[]>((resolve) => {
          finish = resolve;
        }),
    );
    const options = {
      pendingProjectIds: () => rows.map((r) => r.project_id),
      list,
      onError: jest.fn(),
    };
    const first = refresh.get({ row: rows[0], ...options });
    const overlapping = refresh.get({ row: rows[1], ...options });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toHaveLength(100);
    finish(rows.slice(0, 100));
    await Promise.all([first, overlapping]);
    for (const candidate of rows)
      await refresh.get({ row: candidate, ...options });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shares a refreshed row and removed-row tombstone across both lanes", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const rows = [row("a"), row("b")];
    refresh.observe({ rows, version: 1, at: Date.now() });
    jest.setSystemTime(Date.now() + 60_001);
    const fresh = { ...rows[0], last_changed: new Date().toISOString() };
    const list = jest.fn(async () => [fresh]);
    const options = {
      pendingProjectIds: () => ["a", "b"],
      list,
      onError: jest.fn(),
    };
    expect(await refresh.get({ row: rows[0], ...options })).toEqual(fresh);
    expect(await refresh.get({ row: rows[1], ...options })).toBeUndefined();
    expect(await refresh.get({ row: rows[0], ...options })).toEqual(fresh);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a newer inventory with an older refresh completion", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const original = row("a");
    refresh.observe({ rows: [original], version: 1, at: Date.now() });
    jest.setSystemTime(Date.now() + 60_001);
    let finish!: (rows: HostProjectMaintenanceSchedule[]) => void;
    const list = jest.fn(
      () =>
        new Promise<HostProjectMaintenanceSchedule[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = refresh.get({
      row: original,
      pendingProjectIds: () => [],
      list,
      onError: jest.fn(),
    });
    const newer = { ...original, last_changed: new Date().toISOString() };
    refresh.observe({
      rows: [newer],
      version: 2,
      at: Date.now(),
      projectIds: ["a"],
    });
    finish([]);
    expect(await pending).toEqual(newer);
    refresh.observe({
      rows: [original],
      version: 1,
      at: Date.now(),
      projectIds: ["a"],
    });
    expect(
      await refresh.get({
        row: original,
        pendingProjectIds: () => [],
        list,
        onError: jest.fn(),
      }),
    ).toEqual(newer);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a newer removal with a stale successful refresh", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const original = row("a");
    refresh.observe({ rows: [original], version: 1, at: Date.now() });
    jest.setSystemTime(Date.now() + 60_001);
    let finish!: (rows: HostProjectMaintenanceSchedule[]) => void;
    const list = () =>
      new Promise<HostProjectMaintenanceSchedule[]>((resolve) => {
        finish = resolve;
      });
    const pending = refresh.get({
      row: original,
      pendingProjectIds: () => [],
      list,
      onError: jest.fn(),
    });
    refresh.observe({
      rows: [],
      version: 2,
      at: Date.now(),
      projectIds: ["a"],
    });
    finish([original]);
    expect(await pending).toBeUndefined();
  });

  it("charges failed refreshes against the budget and permits a later retry", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const rows = [row("a"), row("b")];
    refresh.observe({ rows, version: 1, at: Date.now() });
    jest.setSystemTime(Date.now() + 60_001);
    const list = jest
      .fn()
      .mockRejectedValueOnce(new Error("bay unavailable"))
      .mockResolvedValue(rows);
    const onError = jest.fn();
    const options = { pendingProjectIds: () => ["b"], list, onError };
    expect(await refresh.get({ row: rows[0], ...options })).toEqual(rows[0]);
    expect(await refresh.get({ row: rows[1], ...options })).toEqual(rows[1]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 60_000);
    await refresh.get({ row: rows[0], ...options });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("prunes departed projects at full inventory without reviving older observations", async () => {
    const refresh = new MaintenanceScheduleRefresh();
    const original = row("a");
    refresh.observe({ rows: [original], version: 1, at: Date.now() });
    refresh.observe({ rows: [], version: 3, at: Date.now() });
    refresh.observe({
      rows: [original],
      version: 2,
      at: Date.now(),
      projectIds: ["a"],
    });
    const list = jest.fn();
    expect(
      await refresh.get({
        row: original,
        pendingProjectIds: () => [],
        list,
        onError: jest.fn(),
      }),
    ).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    refresh.observe({
      rows: [original],
      version: 4,
      at: Date.now(),
      projectIds: ["a"],
    });
    expect(
      await refresh.get({
        row: original,
        pendingProjectIds: () => [],
        list,
        onError: jest.fn(),
      }),
    ).toEqual(original);
  });
});
