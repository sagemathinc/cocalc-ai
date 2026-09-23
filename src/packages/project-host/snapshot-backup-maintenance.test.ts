const listProjectMaintenanceSchedulesMock = jest.fn();
const confirmProjectMaintenanceAssignmentMock = jest.fn();
const getMasterConatClientMock = jest.fn();
const runScheduledSnapshotMaintenanceMock = jest.fn();
const runScheduledBackupMaintenanceMock = jest.fn();
const admitStorageOperationMock = jest.fn();
const getStorageAdmissionStatusMock = jest.fn();
const releaseStorageOperationMock = jest.fn();
const reportProjectMaintenanceMock = jest.fn();
const listPendingMaintenanceReportsMock = jest.fn();
const saveMaintenanceReportMock = jest.fn();
const markMaintenanceReportDeliveredMock = jest.fn();
const onProjectChangeReportedMock = jest.fn();

jest.mock("./sqlite/maintenance-ledger", () => ({
  listPendingMaintenanceReports: (...args: any[]) =>
    listPendingMaintenanceReportsMock(...args),
  saveMaintenanceReport: (...args: any[]) => saveMaintenanceReportMock(...args),
  markMaintenanceReportDelivered: (...args: any[]) =>
    markMaintenanceReportDeliveredMock(...args),
}));

jest.mock("./last-edited", () => ({
  onProjectChangeReported: (listener: (project_id: string) => void) =>
    onProjectChangeReportedMock(listener),
}));

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
    confirmProjectMaintenanceAssignment: (...args: any[]) =>
      confirmProjectMaintenanceAssignmentMock(...args),
    reportProjectMaintenance: (...args: any[]) =>
      reportProjectMaintenanceMock(...args),
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

jest.mock("./storage-admission", () => ({
  __esModule: true,
  admitStorageOperation: (...args: any[]) => admitStorageOperationMock(...args),
  getStorageAdmissionStatus: (...args: any[]) =>
    getStorageAdmissionStatusMock(...args),
}));

jest.mock("@cocalc/file-server/btrfs/operation-cache", () => ({
  __esModule: true,
  withBtrfsMutationContext: (_context: unknown, run: () => Promise<unknown>) =>
    run(),
}));

describe("snapshot-backup-maintenance", () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    process.env = { ...env };
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES =
      "0";
    getMasterConatClientMock.mockReturnValue({ id: "master-client" });
    confirmProjectMaintenanceAssignmentMock.mockResolvedValue({ valid: true });
    getStorageAdmissionStatusMock.mockReturnValue(undefined);
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 5 },
        backups: { disabled: true, weekly: 1 },
        max_snapshots_per_project: 8,
        max_backups_per_project: 5,
      },
      {
        project_id: "proj-2",
        last_edited: "2026-04-10T21:00:00.000Z",
        backup_due_since: "2026-04-10T21:00:00.000Z",
        snapshots: { disabled: true },
        backups: { frequent: 12 },
        max_snapshots_per_project: 8,
        max_backups_per_project: 5,
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue(undefined);
    runScheduledBackupMaintenanceMock.mockResolvedValue(undefined);
    reportProjectMaintenanceMock.mockResolvedValue(undefined);
    listPendingMaintenanceReportsMock.mockReturnValue([]);
    releaseStorageOperationMock.mockReset();
    onProjectChangeReportedMock.mockReset();
    onProjectChangeReportedMock.mockImplementation(() => jest.fn());
    admitStorageOperationMock.mockImplementation(
      ({ operation_kind, project_id, allow_starvation_override }) => ({
        admitted: true,
        would_defer: false,
        starvation_override: !!allow_starvation_override,
        operation_id: `${operation_kind}:${project_id}`,
        release: releaseStorageOperationMock,
      }),
    );
  });

  it("keeps emergency sweeps bounded and fail-closed", async () => {
    getStorageAdmissionStatusMock.mockReturnValue({
      mode: "enforce",
      lifecycle_active: 0,
      pressure_state: "emergency",
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith({
      host_id: "host-1",
      active_days: 2,
      limit: 250,
    });
    expect(admitStorageOperationMock).not.toHaveBeenCalled();
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
      limit: 250,
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
      limit: 8,
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
      limit: 5,
      knownLastBackupAt: undefined,
    });
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_snapshot",
      project_id: "proj-1",
      allow_starvation_override: false,
    });
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_backup",
      project_id: "proj-2",
      allow_starvation_override: true,
    });
    expect(releaseStorageOperationMock).toHaveBeenCalledTimes(2);
  });

  it("does not mutate a project after its host assignment changes", async () => {
    confirmProjectMaintenanceAssignmentMock.mockImplementation(
      async ({ project_id }: { project_id: string }) =>
        project_id === "proj-1"
          ? { valid: false, reason: "assignment_changed" }
          : { valid: true },
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "snapshot",
        outcome: "deferred",
        reason: "assignment_changed",
      }),
    );
  });

  it("fails closed when the owning bay cannot verify an assignment", async () => {
    confirmProjectMaintenanceAssignmentMock.mockRejectedValue(
      new Error("bay unavailable"),
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "snapshot",
        outcome: "deferred",
        reason: "assignment_unverified",
      }),
    );
  });

  it("does not report success if the schedule changes during a snapshot", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 5 },
        backups: { disabled: true },
      },
    ]);
    confirmProjectMaintenanceAssignmentMock.mockResolvedValueOnce({
      valid: true,
    });
    confirmProjectMaintenanceAssignmentMock.mockResolvedValueOnce({
      valid: false,
      reason: "schedule_changed",
    });
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: "2026-09-23T22:00:00.000Z",
      created_snapshot_at: "2026-09-23T22:00:00.000Z",
      changed: true,
      disabled: false,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "snapshot",
        outcome: "deferred",
        reason: "schedule_changed",
      }),
    );
  });

  it("does not claim a snapshot when the host finds no changed content", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-unchanged",
        last_changed: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: null,
      created_snapshot_at: null,
      changed: false,
      disabled: false,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-unchanged",
        kind: "snapshot",
        outcome: "skipped",
        reason: "no_content_change",
        due_at: null,
        reconciled_change_at: "2026-04-10T22:00:00.000Z",
      }),
    );
  });

  it("reports success only after the new snapshot is confirmed", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-created",
        last_changed: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: "2026-04-10T22:01:00.000Z",
      created_snapshot_at: "2026-04-10T22:01:00.000Z",
      changed: true,
      disabled: false,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-created",
        kind: "snapshot",
        outcome: "succeeded",
        latest_snapshot_at: "2026-04-10T22:01:00.000Z",
        reconciled_change_at: null,
      }),
    );
  });

  it("skips recently reconciled unchanged content until it changes again", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-unchanged",
        last_changed: "2026-04-10T22:00:00.000Z",
        snapshot_reconciled_change_at: "2026-04-10T22:00:00.000Z",
        snapshot_schedule_revision: "revision-1",
        snapshot_reconciled_schedule_revision: "revision-1",
        last_snapshot_observed_at: new Date().toISOString(),
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
  });

  it("rechecks content when the snapshot schedule changes", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-unchanged",
        last_changed: "2026-04-10T22:00:00.000Z",
        snapshot_reconciled_change_at: "2026-04-10T22:00:00.000Z",
        snapshot_schedule_revision: "revision-2",
        snapshot_reconciled_schedule_revision: "revision-1",
        last_snapshot_observed_at: new Date().toISOString(),
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
  });

  it("runs backup maintenance even when snapshot maintenance fails", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        backup_due_since: "2026-04-10T22:00:00.000Z",
        snapshots: {},
        backups: {},
        max_snapshots_per_project: 8,
        max_backups_per_project: 5,
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockRejectedValue(
      new Error("snapshot limit"),
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });

    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      counts: {
        frequent: 0,
        daily: 1,
        weekly: 3,
        monthly: 4,
      },
      limit: 5,
      knownLastBackupAt: undefined,
    });
  });

  it("reduces concurrency below preferred memory without starving maintenance", async () => {
    delete process.env
      .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
    const { _test, runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 4,
        meminfoText:
          "MemTotal:       65536000 kB\nMemAvailable:    6291456 kB\n",
        pressureText: "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      }),
    ).toMatchObject({
      skip: false,
      parallelism: 1,
      availableBytes: 6 * 1024 ** 3,
      preferredBytes: 16_777_216_000,
      hardMinBytes: 4 * 1024 ** 3,
    });
    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 4,
        meminfoText:
          "MemTotal:       65536000 kB\nMemAvailable:   20971520 kB\n",
        pressureText: "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      }),
    ).toMatchObject({
      skip: false,
      parallelism: 4,
      availableBytes: 20 * 1024 ** 3,
      preferredBytes: 16_777_216_000,
    });

    const readFileSyncSpy = jest
      .spyOn(require("node:fs"), "readFileSync")
      .mockImplementation((path: unknown) =>
        `${path}` === "/proc/pressure/memory"
          ? "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
          : "MemTotal:       65536000 kB\nMemAvailable:    6291456 kB\n",
      );
    try {
      await runProjectSnapshotBackupMaintenanceSweepOnce({
        hostId: "host-1",
      });
    } finally {
      readFileSyncSpy.mockRestore();
    }

    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalled();
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalled();
  });

  it("skips maintenance below the hard floor or under sustained memory pressure", async () => {
    delete process.env
      .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
    const { _test } = await import("./snapshot-backup-maintenance");

    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 4,
        meminfoText:
          "MemTotal:       65536000 kB\nMemAvailable:    3145728 kB\n",
        pressureText: "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      }),
    ).toMatchObject({
      skip: true,
      reason: "available_memory",
      hardMinBytes: 4 * 1024 ** 3,
    });
    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 4,
        meminfoText:
          "MemTotal:       65536000 kB\nMemAvailable:   20971520 kB\n",
        pressureText: "full avg10=7.50 avg60=3.00 avg300=1.00 total=1\n",
      }),
    ).toMatchObject({
      skip: true,
      reason: "memory_pressure",
      pressureFullAvg10: 7.5,
    });
  });

  it("starts a repeating timer and can be stopped", () => {
    jest.useFakeTimers();
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS = "60000";
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    const {
      startProjectSnapshotBackupMaintenance,
    } = require("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    jest.runOnlyPendingTimers();
    jest.advanceTimersByTime(60_000);
    stop();
    jest.advanceTimersByTime(60_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalled();
  });

  it("defers the first sweep until the configured delay", () => {
    jest.useFakeTimers();
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "30000";
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS = "60000";
    const {
      startProjectSnapshotBackupMaintenance,
    } = require("./snapshot-backup-maintenance");

    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(29_999);
    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it("can disable maintenance entirely", () => {
    jest.useFakeTimers();
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_DISABLE = "true";
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    const {
      startProjectSnapshotBackupMaintenance,
    } = require("./snapshot-backup-maintenance");

    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    jest.runOnlyPendingTimers();
    jest.advanceTimersByTime(5 * 60_000);
    stop();

    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
  });

  it("dispatches confirmed project changes in bounded event batches", async () => {
    jest.useFakeTimers();
    listProjectMaintenanceSchedulesMock.mockResolvedValue([]);
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    const notifyChanged = onProjectChangeReportedMock.mock.calls[0][0];
    for (let i = 0; i < 60; i++) notifyChanged(`project-${i}`);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        host_id: "host-1",
        limit: 50,
        project_ids: Array.from({ length: 50 }, (_, i) => `project-${i}`),
      }),
    );

    await jest.advanceTimersByTimeAsync(15_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(2);
    expect(
      listProjectMaintenanceSchedulesMock.mock.calls[1][0].project_ids,
    ).toEqual(Array.from({ length: 10 }, (_, i) => `project-${i + 50}`));
    stop();
  });

  it("dispatches a known future due time before the reconciliation timer", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-10T22:00:00.000Z"));
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-future",
        last_changed: "2026-04-10T22:00:00.000Z",
        last_snapshot: "2026-04-10T21:50:00.000Z",
        last_snapshot_observed_at: "2026-04-10T22:00:00.000Z",
        snapshots: { frequent: 1, daily: 0, weekly: 0, monthly: 0 },
        backups: { disabled: true },
      },
    ]);
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });

    await jest.advanceTimersByTimeAsync(0);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBeGreaterThan(1);

    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(2);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "proj-future" }),
    );
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_ids: ["proj-future"] }),
    );
    stop();
  });

  it("reevaluates admission before snapshot and backup work", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        snapshots: {},
        backups: {},
        backup_due_since: "2026-04-10T22:00:00.000Z",
      },
    ]);
    admitStorageOperationMock.mockImplementation(({ operation_kind }) => ({
      admitted: operation_kind !== "scheduled_snapshot",
      would_defer: operation_kind === "scheduled_snapshot",
      reason:
        operation_kind === "scheduled_snapshot"
          ? "lifecycle_active"
          : undefined,
      operation_id: operation_kind,
      release: releaseStorageOperationMock,
    }));
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(admitStorageOperationMock).toHaveBeenCalledTimes(2);
    expect(releaseStorageOperationMock).toHaveBeenCalledTimes(1);
  });

  it("admits only one overdue backup during a lifecycle-restricted sweep", async () => {
    getStorageAdmissionStatusMock.mockReturnValue({
      mode: "enforce",
      lifecycle_active: 1,
      pressure_state: "normal",
    });
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "old-1",
        backup_due_since: "2026-04-01T00:00:00.000Z",
        snapshots: {},
        backups: {},
      },
      {
        project_id: "old-2",
        backup_due_since: "2026-04-02T00:00:00.000Z",
        snapshots: {},
        backups: {},
      },
      {
        project_id: "recent",
        backup_due_since: new Date().toISOString(),
        snapshots: {},
        backups: {},
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "old-1" }),
    );
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_backup",
      project_id: "old-1",
      allow_starvation_override: true,
    });
  });

  it("does not overlap sweeps", async () => {
    let releaseRows!: (rows: any[]) => void;
    listProjectMaintenanceSchedulesMock.mockReturnValue(
      new Promise<any[]>((resolve) => {
        releaseRows = resolve;
      }),
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    const first = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });
    const second = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);

    releaseRows([]);
    await Promise.all([first, second]);
  });

  it("walks past two full pages and reaches the final project", async () => {
    const rows = Array.from({ length: 1003 }, (_, index) => ({
      project_id: `project-${String(index).padStart(4, "0")}`,
      last_changed: "2026-04-01T00:00:00.000Z",
      snapshots: { daily: 1 },
      backups: { disabled: true },
    }));
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ cursor_project_id, limit }) => {
        const start = cursor_project_id
          ? rows.findIndex((row) => row.project_id === cursor_project_id) + 1
          : 0;
        return rows.slice(start, start + limit);
      },
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(5);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1003);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "project-1002" }),
    );
  });

  it("starts a newly due snapshot while a previous backup is still running", async () => {
    let finishBackup!: (value: boolean) => void;
    const backupRunning = new Promise<boolean>((resolve) => {
      finishBackup = resolve;
    });
    listProjectMaintenanceSchedulesMock
      .mockResolvedValueOnce([
        {
          project_id: "backup-project",
          backup_due_since: "2026-04-01T00:00:00.000Z",
          snapshots: { disabled: true },
          backups: { daily: 1 },
        },
      ])
      .mockResolvedValueOnce([
        {
          project_id: "snapshot-project",
          last_changed: "2026-04-01T00:00:00.000Z",
          snapshots: { daily: 1 },
          backups: { disabled: true },
        },
      ]);
    runScheduledBackupMaintenanceMock.mockReturnValue(backupRunning);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    const first = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "snapshot-project" }),
    );
    finishBackup(true);
    await first;
  });
});
