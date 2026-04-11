const listProjectMaintenanceSchedulesMock = jest.fn();
const getMasterConatClientMock = jest.fn();
const runScheduledSnapshotMaintenanceMock = jest.fn();
const runScheduledBackupMaintenanceMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostStatusClient: jest.fn(() => ({
    listProjectMaintenanceSchedules: (...args: any[]) =>
      listProjectMaintenanceSchedulesMock(...args),
  })),
}));

jest.mock("./master-status", () => ({
  __esModule: true,
  getMasterConatClient: (...args: any[]) => getMasterConatClientMock(...args),
}));

jest.mock("./file-server", () => ({
  __esModule: true,
  runScheduledSnapshotMaintenance: (...args: any[]) =>
    runScheduledSnapshotMaintenanceMock(...args),
  runScheduledBackupMaintenance: (...args: any[]) =>
    runScheduledBackupMaintenanceMock(...args),
}));

describe("snapshot-backup-maintenance", () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    process.env = { ...env };
    getMasterConatClientMock.mockReturnValue({ id: "master-client" });
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 5 },
        backups: { disabled: true, weekly: 1 },
      },
      {
        project_id: "proj-2",
        last_edited: "2026-04-10T21:00:00.000Z",
        snapshots: { disabled: true },
        backups: null,
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue(undefined);
    runScheduledBackupMaintenanceMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = env;
  });

  it("runs host-owned maintenance with merged defaults and skips disabled schedules", async () => {
    process.env.COCALC_PROJECT_HOST_MAINTENANCE_ACTIVE_DAYS = "2";
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_PARALLELISM = "2";
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });

    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith({
      host_id: "host-1",
      active_days: 2,
    });
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      counts: {
        frequent: 4,
        daily: 5,
        weekly: 4,
        monthly: 2,
      },
    });
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledWith({
      project_id: "proj-2",
      counts: {
        frequent: 0,
        daily: 1,
        weekly: 3,
        monthly: 4,
      },
    });
  });

  it("starts a repeating timer and can be stopped", () => {
    jest.useFakeTimers();
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS = "60000";
    const {
      startProjectSnapshotBackupMaintenance,
    } = require("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    jest.advanceTimersByTime(60_000);
    stop();
    jest.advanceTimersByTime(60_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalled();
  });
});
