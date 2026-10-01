const listProjectMaintenanceSchedulesMock = jest.fn();
const confirmProjectMaintenanceAssignmentMock = jest.fn();
const getMasterConatClientMock = jest.fn();
const runScheduledSnapshotMaintenanceMock = jest.fn();
const runScheduledBackupMaintenanceMock = jest.fn();
const getBackupsMock = jest.fn();
const admitStorageOperationMock = jest.fn();
const getStorageAdmissionStatusMock = jest.fn();
const releaseStorageOperationMock = jest.fn();
const reportProjectMaintenanceMock = jest.fn();
const listPendingMaintenanceReportsMock = jest.fn();
const listLeasedMaintenanceSchedulesMock = jest.fn();
const saveValidatedMaintenanceSchedulesMock = jest.fn();
const saveMaintenanceReportMock = jest.fn();
const markMaintenanceReportDeliveredMock = jest.fn();
const onProjectChangeReportedMock = jest.fn();
const onProjectProvisionedReportedMock = jest.fn();
const loggerInfoMock = jest.fn();
const mutationContextMock = jest.fn();

jest.mock("./sqlite/maintenance-ledger", () => ({
  listLeasedMaintenanceSchedules: (...args: any[]) =>
    listLeasedMaintenanceSchedulesMock(...args),
  saveValidatedMaintenanceSchedules: (...args: any[]) =>
    saveValidatedMaintenanceSchedulesMock(...args),
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
    info: (...args: any[]) => loggerInfoMock(...args),
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
  onProjectProvisionedReported: (listener: (project_id: string) => void) =>
    onProjectProvisionedReportedMock(listener),
}));

jest.mock("./file-server", () => ({
  __esModule: true,
  getBackups: (...args: any[]) => getBackupsMock(...args),
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
  BtrfsMutationDeferredError: class extends Error {},
  withBtrfsMutationContext: (context: unknown, run: () => Promise<unknown>) => {
    mutationContextMock(context);
    return run();
  },
}));

describe("snapshot-backup-maintenance", () => {
  const env = process.env;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    const { _test } = await import("./snapshot-backup-maintenance");
    _test.resetStarvationQueue();
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
    getBackupsMock.mockResolvedValue([]);
    reportProjectMaintenanceMock.mockResolvedValue(undefined);
    listPendingMaintenanceReportsMock.mockReturnValue([]);
    listLeasedMaintenanceSchedulesMock.mockReturnValue([]);
    releaseStorageOperationMock.mockReset();
    onProjectChangeReportedMock.mockReset();
    onProjectChangeReportedMock.mockImplementation(() => jest.fn());
    onProjectProvisionedReportedMock.mockReset();
    onProjectProvisionedReportedMock.mockImplementation(() => jest.fn());
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

  it("records due work deferred by emergency pressure without running it", async () => {
    getStorageAdmissionStatusMock.mockReturnValue({
      mode: "enforce",
      lifecycle_active: 0,
      pressure_state: "emergency",
    });
    admitStorageOperationMock.mockImplementation(({ operation_kind }) => ({
      admitted: false,
      would_defer: true,
      starvation_override: false,
      reason: "io_pressure_emergency",
      operation_id: operation_kind,
      release: releaseStorageOperationMock,
    }));
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith({
      host_id: "host-1",
      active_days: 2,
      limit: 250,
    });
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "snapshot",
        outcome: "deferred",
        reason: "io_pressure_emergency",
      }),
    );
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-2",
        kind: "backup",
        outcome: "deferred",
        reason: "io_pressure_emergency",
      }),
    );
  });

  it("publishes queued debt before starting a slow backup", async () => {
    const order: string[] = [];
    reportProjectMaintenanceMock.mockImplementation(async (report) => {
      if (report.project_id === "proj-2") {
        order.push(`report:${report.reason ?? report.outcome}`);
      }
    });
    runScheduledBackupMaintenanceMock.mockImplementation(async () => {
      order.push("backup:start");
      return { created: true, latest_backup_id: "confirmed-backup" };
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(order[0]).toBe("report:queued");
    expect(order).toContain("backup:start");
    expect(order.indexOf("backup:start")).toBeGreaterThan(0);
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
      stage_durations_ms: {},
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
      stage_durations_ms: {},
    });
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_snapshot",
      project_id: "proj-1",
      allow_starvation_override: false,
    });
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_backup",
      project_id: "proj-2",
      allow_starvation_override: false,
    });
    expect(releaseStorageOperationMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the original due time on a successful backup attempt", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T21:00:00.000Z",
        backup_due_since: "2026-04-10T21:00:00.000Z",
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    runScheduledBackupMaintenanceMock.mockResolvedValue({
      created: true,
      latest_backup_id: "a".repeat(64),
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "backup",
        outcome: "succeeded",
        latest_backup_id: "a".repeat(64),
        due_at: null,
        attempt_due_at: "2026-04-10T21:00:00.000Z",
      }),
    );
  });

  it("keeps the first missed due time after later project edits", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-12T00:00:00.000Z"));
    const originalDue = "2026-04-10T21:00:00.000Z";
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "snapshot-project",
        last_edited: originalDue,
        last_changed: "2026-04-11T21:00:00.000Z",
        snapshot_status_outcome: "deferred",
        snapshot_status_due_at: originalDue,
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
      {
        project_id: "backup-project",
        last_edited: originalDue,
        backup_due_since: "2026-04-11T21:00:00.000Z",
        backup_status_outcome: "failed",
        backup_status_due_at: originalDue,
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    for (const [project_id, kind] of [
      ["snapshot-project", "snapshot"],
      ["backup-project", "backup"],
    ]) {
      expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id,
          kind,
          due_at: originalDue,
          attempt_due_at: originalDue,
        }),
      );
    }
  });

  it("does not retain debt after a newer recovery point covers it", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-13T23:00:00.000Z"));
    const oldDue = "2026-04-10T21:00:00.000Z";
    const recoveredAt = "2026-04-11T23:00:00.000Z";
    const newDue = "2026-04-12T23:00:00.000Z";
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: recoveredAt,
      changed: true,
    });
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "snapshot-project",
        last_edited: oldDue,
        last_changed: "2026-04-12T22:00:00.000Z",
        last_snapshot: recoveredAt,
        snapshot_status_outcome: "deferred",
        snapshot_status_due_at: oldDue,
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
      {
        project_id: "backup-project",
        last_edited: oldDue,
        backup_due_since: "2026-04-12T22:00:00.000Z",
        last_backup: recoveredAt,
        backup_status_outcome: "failed",
        backup_status_due_at: oldDue,
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    for (const [project_id, kind, expectedDue] of [
      ["snapshot-project", "snapshot", "2026-04-12T22:00:00.000Z"],
      ["backup-project", "backup", newDue],
    ]) {
      expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id,
          kind,
          attempt_due_at: expectedDue,
        }),
      );
    }
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

  it("uses a persisted short lease when the bay is briefly unavailable", async () => {
    const cached = {
      project_id: "proj-1",
      last_edited: "2026-04-10T22:00:00.000Z",
      snapshots: { daily: 5 },
      backups: { disabled: true },
    };
    listProjectMaintenanceSchedulesMock.mockRejectedValue(
      new Error("bay unavailable"),
    );
    confirmProjectMaintenanceAssignmentMock.mockRejectedValue(
      new Error("bay unavailable"),
    );
    listLeasedMaintenanceSchedulesMock.mockImplementation(
      ({ projectIds }: { projectIds?: string[] }) =>
        !projectIds || projectIds.includes(cached.project_id) ? [cached] : [],
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(saveValidatedMaintenanceSchedulesMock).not.toHaveBeenCalled();
  });

  it("rejects an offline lease for a different schedule revision", async () => {
    confirmProjectMaintenanceAssignmentMock.mockRejectedValue(
      new Error("bay unavailable"),
    );
    listLeasedMaintenanceSchedulesMock.mockReturnValue([
      {
        project_id: "proj-1",
        last_edited: "2026-04-10T22:00:00.000Z",
        snapshots: { daily: 1 },
        backups: { disabled: true },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "snapshot",
        reason: "assignment_unverified",
      }),
    );
  });

  it("retains backup debt and retries when backup capacity is busy", async () => {
    runScheduledBackupMaintenanceMock.mockResolvedValue({
      created: false,
      deferred_reason: "backup_capacity_busy",
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-2",
        kind: "backup",
        outcome: "deferred",
        reason: "backup_capacity_busy",
        retry_at: expect.any(String),
      }),
    );
  });

  it("reports a classified repository failure without sending its raw error", async () => {
    runScheduledBackupMaintenanceMock.mockRejectedValue(
      new Error("rustic s3: InvalidAccessKeyId secret=do-not-report"),
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-2",
        kind: "backup",
        outcome: "failed",
        reason: "repository_credentials_invalid",
        retry_at: expect.any(String),
      }),
    );
  });

  it("keeps backup due after its assignment changes during upload", async () => {
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-2",
        last_edited: "2026-04-10T21:00:00.000Z",
        backup_due_since: "2026-04-10T21:00:00.000Z",
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    confirmProjectMaintenanceAssignmentMock
      .mockResolvedValueOnce({ valid: true })
      .mockResolvedValueOnce({ valid: false, reason: "assignment_changed" });
    runScheduledBackupMaintenanceMock.mockResolvedValue({
      created: true,
      stage_durations_ms: { inventory: 40, create: 200 },
      bytes_scanned: 1024,
      bytes_uploaded: 256,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-2",
        kind: "backup",
        outcome: "deferred",
        reason: "assignment_changed",
        due_at: "2026-04-10T21:00:00.000Z",
        stage_durations_ms: expect.objectContaining({
          inventory: 40,
          create: 200,
        }),
        bytes_scanned: 1024,
        bytes_uploaded: 256,
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
      stage_durations_ms: { inventory: 12, create: 3 },
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
        stage_durations_ms: expect.objectContaining({
          inventory: 12,
          create: 3,
          queue_wait: expect.any(Number),
        }),
      }),
    );
  });

  it("reconciles a verified local snapshot and wakes when its next interval is due", async () => {
    const latest = new Date(Date.now() - 5 * 60_000).toISOString();
    const changed = new Date(Date.now() - 60_000).toISOString();
    const onFutureDue = jest.fn();
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-reconcile",
        last_changed: changed,
        last_snapshot: null,
        snapshots: { frequent: 1, daily: 0, weekly: 0, monthly: 0 },
        backups: { disabled: true },
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: latest,
      created_snapshot_at: null,
      changed: true,
      disabled: false,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
      onFutureDue,
    });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-reconcile",
        kind: "snapshot",
        outcome: "skipped",
        reason: "snapshot_interval_wait",
        latest_snapshot_at: latest,
        due_at: new Date(Date.parse(latest) + 15 * 60_000).toISOString(),
        retry_at: null,
      }),
    );
    expect(onFutureDue).toHaveBeenCalledWith(
      "proj-reconcile",
      Date.parse(latest) + 15 * 60_000,
    );
  });

  it("keeps snapshot debt visible when the host has no new snapshot after the interval", async () => {
    const latest = new Date(Date.now() - 20 * 60_000).toISOString();
    const changed = new Date(Date.now() - 60_000).toISOString();
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-still-due",
        last_changed: changed,
        last_snapshot: null,
        snapshots: { frequent: 1, daily: 0, weekly: 0, monthly: 0 },
        backups: { disabled: true },
      },
    ]);
    runScheduledSnapshotMaintenanceMock.mockResolvedValue({
      latest_snapshot_at: latest,
      created_snapshot_at: null,
      changed: true,
      disabled: false,
    });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });

    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-still-due",
        kind: "snapshot",
        outcome: "deferred",
        reason: "snapshot_not_created",
        latest_snapshot_at: latest,
        due_at: changed,
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
      stage_durations_ms: {},
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

    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    const { getSnapshotBackupMaintenanceGate } =
      await import("./snapshot-backup-gate");
    const readFileSyncSpy = jest
      .spyOn(require("node:fs"), "readFileSync")
      .mockImplementation((path: unknown) =>
        `${path}` === "/proc/pressure/memory"
          ? "full avg10=7.50 avg60=3.00 avg300=1.00 total=1\n"
          : "MemTotal:       65536000 kB\nMemAvailable:   20971520 kB\n",
      );
    try {
      expect(
        await runProjectSnapshotBackupMaintenanceSweepOnce({
          hostId: "host-1",
        }),
      ).toBe(false);
      expect(getSnapshotBackupMaintenanceGate()).toMatchObject({
        blocked_reason: "memory_pressure",
        memory_psi_full_avg10: 7.5,
      });
      expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();

      readFileSyncSpy.mockImplementation((path: unknown) =>
        `${path}` === "/proc/pressure/memory"
          ? "full avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
          : "MemTotal:       65536000 kB\nMemAvailable:   20971520 kB\n",
      );
      await runProjectSnapshotBackupMaintenanceSweepOnce({
        hostId: "host-1",
      });
      expect(
        getSnapshotBackupMaintenanceGate()?.blocked_reason,
      ).toBeUndefined();
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it("admits one maintenance worker when global memory PSI is confined to capped Bees", async () => {
    delete process.env
      .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
    const { _test } = await import("./snapshot-backup-maintenance");
    const input = {
      configuredParallelism: 4,
      meminfoText: "MemTotal:       8388608 kB\nMemAvailable:    5242880 kB\n",
      pressureText: "full avg10=50.00 avg60=40.00 avg300=20.00 total=1\n",
      cgroupPressure: {
        beesFullAvg10: 49.8,
        beesCurrentBytes: 1088 * 1024 ** 2,
        beesHighBytes: 1024 ** 3,
        otherMaxFullAvg10: 0.1,
      },
    };
    expect(_test.maintenanceMemoryDecision(input)).toMatchObject({
      skip: false,
      parallelism: 1,
      isolatedBeesPressure: true,
      pressureFullAvg10: 50,
    });
    expect(
      _test.maintenanceMemoryDecision({
        ...input,
        cgroupPressure: { ...input.cgroupPressure, otherMaxFullAvg10: 3 },
      }),
    ).toMatchObject({ skip: true, reason: "memory_pressure" });
    expect(
      _test.maintenanceMemoryDecision({
        ...input,
        cgroupPressure: {
          ...input.cgroupPressure,
          beesCurrentBytes: 900 * 1024 ** 2,
        },
      }),
    ).toMatchObject({ skip: true, reason: "memory_pressure" });
    expect(
      _test.maintenanceMemoryDecision({
        ...input,
        meminfoText:
          "MemTotal:       8388608 kB\nMemAvailable:    1572864 kB\n",
      }),
    ).toMatchObject({ skip: true, reason: "memory_pressure" });
  });

  it("attributes the host's high PSI to an isolated Bees cgroup", async () => {
    delete process.env
      .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
    const fsModule = require("node:fs");
    const dirs = [
      "cocalc-bees",
      "cocalc-host-services",
      "cocalc-project-pool",
      "cocalc-maintenance",
      "system.slice",
    ].map((name) => ({ name, isDirectory: () => true }));
    const readdirSpy = jest
      .spyOn(fsModule, "readdirSync")
      .mockReturnValue(dirs as any);
    const readSpy = jest
      .spyOn(fsModule, "readFileSync")
      .mockImplementation((path: unknown) => {
        const name = String(path);
        if (name === "/proc/meminfo")
          return "MemTotal:       8388608 kB\nMemAvailable:    5242880 kB\n";
        if (name === "/proc/pressure/memory")
          return "full avg10=50.00 avg60=40.00 avg300=20.00 total=1\n";
        if (name === "/sys/fs/cgroup/cocalc-bees/memory.current")
          return `${1088 * 1024 ** 2}\n`;
        if (name === "/sys/fs/cgroup/cocalc-bees/memory.high")
          return `${1024 ** 3}\n`;
        if (name === "/sys/fs/cgroup/cocalc-bees/memory.pressure")
          return "full avg10=49.80 avg60=40.00 avg300=20.00 total=1\n";
        if (name.endsWith("/memory.pressure"))
          return "full avg10=0.10 avg60=0.10 avg300=0.10 total=1\n";
        throw new Error(`unexpected file: ${name}`);
      });
    try {
      const { runProjectSnapshotBackupMaintenanceSweepOnce } =
        await import("./snapshot-backup-maintenance");
      const { getSnapshotBackupMaintenanceGate } =
        await import("./snapshot-backup-gate");
      await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
      expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalled();
      expect(getSnapshotBackupMaintenanceGate()).toMatchObject({
        memory_psi_full_avg10: 50,
        pressure_attribution: "bees_cgroup",
      });
      expect(
        getSnapshotBackupMaintenanceGate()?.blocked_reason,
      ).toBeUndefined();
    } finally {
      readSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it("blocks risky maintenance when host memory measurements are missing", async () => {
    delete process.env
      .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
    const { _test } = await import("./snapshot-backup-maintenance");
    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 2,
        meminfoText: "",
        pressureText: "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      }),
    ).toMatchObject({
      skip: true,
      reason: "memory_measurement_unavailable",
    });
    expect(
      _test.maintenanceMemoryDecision({
        configuredParallelism: 2,
        meminfoText:
          "MemTotal:       65536000 kB\nMemAvailable:   20971520 kB\n",
        pressureText: "",
      }),
    ).toMatchObject({
      skip: true,
      reason: "memory_measurement_unavailable",
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

  it("reconciles soon after startup with a stable per-host delay", async () => {
    jest.useFakeTimers();
    delete process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS;
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });

    await jest.advanceTimersByTimeAsync(59_999);
    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_001);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);

    stop();
  });

  it("retries a skipped full reconciliation before the next sweep", async () => {
    jest.useFakeTimers();
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    getMasterConatClientMock.mockReturnValue(undefined);
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });

    await jest.advanceTimersByTimeAsync(0);
    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(listProjectMaintenanceSchedulesMock).not.toHaveBeenCalled();

    getMasterConatClientMock.mockReturnValue({ id: "master-client" });
    await jest.advanceTimersByTimeAsync(1);
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

  it("calculates shadow due and priority without mutating or publishing status", async () => {
    const changed = "2026-04-01T00:00:00.000Z";
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "paid-project",
        storage_account_id: "paid-account",
        storage_service_class: "paying",
        last_changed: changed,
        backup_due_since: changed,
        snapshots: { daily: 1 },
        backups: { daily: 1 },
      },
      {
        project_id: "free-project",
        storage_account_id: "free-account",
        storage_service_class: "free",
        last_changed: changed,
        backup_due_since: changed,
        snapshots: { daily: 1 },
        backups: { daily: 1 },
      },
      {
        project_id: "unclassified-project",
        storage_account_id: "unclassified-account",
        last_changed: changed,
        backup_due_since: changed,
        snapshots: { daily: 1 },
        backups: { daily: 1 },
      },
    ]);
    listPendingMaintenanceReportsMock.mockReturnValue([
      { project_id: "previous-report" },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    expect(
      await runProjectSnapshotBackupMaintenanceSweepOnce({
        hostId: "host-1",
        shadow: true,
      }),
    ).toBe(true);
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "snapshot/backup shadow reconciliation",
      expect.objectContaining({
        inventory_count: 3,
        snapshot: expect.objectContaining({
          due_count: 3,
          paying_due: 1,
          free_due: 1,
          unclassified_due: 1,
          first_ten_classes: ["paying", "free", "unclassified"],
        }),
        backup: expect.objectContaining({
          due_count: 3,
          paying_due: 1,
          free_due: 1,
          unclassified_due: 1,
          first_ten_classes: ["paying", "free", "unclassified"],
        }),
      }),
    );
  });

  it("uses shadow mode for timed host reconciliation when configured", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-10T22:00:00.000Z"));
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SHADOW = "true";
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });

    await jest.advanceTimersByTimeAsync(0);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(1);
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "snapshot/backup maintenance scheduled",
      expect.objectContaining({ mode: "shadow" }),
    );
    stop();
  });

  it("reconciles a failed acknowledgement only after the backup is still in the repository", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));
    const backupTime = "2026-04-10T21:01:00.000Z";
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        storage_service_class: "free",
        last_edited: "2026-04-10T21:05:00.000Z",
        last_backup: backupTime,
        backup_due_since: "2026-04-10T21:05:00.000Z",
        backup_status_outcome: "failed",
        backup_status_reason: "timeout - hosts.recordProjectBackup",
        backup_status_due_at: "2026-04-10T21:00:00.000Z",
        last_backup_observed_at: "2026-04-10T21:02:00.000Z",
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(getBackupsMock).toHaveBeenCalledWith({ project_id: "proj-1" });
    expect(reportProjectMaintenanceMock).not.toHaveBeenCalled();

    getBackupsMock.mockResolvedValue([
      { id: "confirmed-id", time: new Date(backupTime) },
    ]);
    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "backup",
        outcome: "succeeded",
        reason: "confirmed_backup_after_failed_report",
        latest_backup_id: "confirmed-id",
        attempt_due_at: "2026-04-10T21:00:00.000Z",
        due_at: "2026-04-11T21:01:00.000Z",
      }),
    );
  });

  it("clears a deferred post-upload generation change only after repository confirmation", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));
    const backupTime = "2026-04-10T21:01:00.000Z";
    listProjectMaintenanceSchedulesMock.mockResolvedValue([
      {
        project_id: "proj-1",
        storage_service_class: "free",
        last_edited: "2026-04-10T21:01:10.000Z",
        last_backup: backupTime,
        backup_due_since: "2026-04-10T21:01:10.000Z",
        backup_status_outcome: "deferred",
        backup_status_reason: "change_generation_changed",
        backup_status_due_at: "2026-04-10T21:00:00.000Z",
        last_backup_observed_at: "2026-04-10T21:02:00.000Z",
        snapshots: { disabled: true },
        backups: { daily: 1 },
      },
    ]);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(reportProjectMaintenanceMock).not.toHaveBeenCalled();

    getBackupsMock.mockResolvedValue([
      { id: "confirmed-id", time: new Date(backupTime) },
    ]);
    await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" });
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "proj-1",
        kind: "backup",
        outcome: "succeeded",
        reason: "confirmed_backup_after_changed_generation",
        latest_backup_id: "confirmed-id",
        attempt_due_at: "2026-04-10T21:00:00.000Z",
        due_at: "2026-04-11T21:01:00.000Z",
      }),
    );
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

  it("dispatches a newly provisioned project after bay acknowledgement", async () => {
    jest.useFakeTimers();
    listProjectMaintenanceSchedulesMock.mockResolvedValue([]);
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
    const notifyProvisioned = onProjectProvisionedReportedMock.mock.calls[0][0];
    notifyProvisioned("project-new");

    await jest.advanceTimersByTimeAsync(15_000);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        project_ids: ["project-new"],
      }),
    );
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

  it("rebuilds a future due timer after scheduler restart", async () => {
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
    const stopBeforeRestart = startProjectSnapshotBackupMaintenance({
      hostId: "host-1",
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    stopBeforeRestart();

    const stopAfterRestart = startProjectSnapshotBackupMaintenance({
      hostId: "host-1",
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(2);
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "proj-future" }),
    );
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_ids: ["proj-future"] }),
    );
    stopAfterRestart();
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

  it("does not request starvation escapes during lifecycle work", async () => {
    getStorageAdmissionStatusMock.mockReturnValue({
      mode: "enforce",
      lifecycle_active: 1,
      pressure_state: "normal",
    });
    admitStorageOperationMock.mockImplementation(
      ({ operation_kind, allow_starvation_override }) => ({
        admitted:
          operation_kind === "scheduled_backup" && !!allow_starvation_override,
        would_defer: true,
        starvation_override: !!allow_starvation_override,
        reason: "lifecycle_active",
        operation_id: operation_kind,
        release: releaseStorageOperationMock,
      }),
    );
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
    expect(runScheduledBackupMaintenanceMock).not.toHaveBeenCalled();
    expect(admitStorageOperationMock).toHaveBeenCalledWith({
      operation_kind: "scheduled_backup",
      project_id: "old-1",
      allow_starvation_override: false,
    });
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "old-2",
        kind: "backup",
        outcome: "deferred",
        reason: "lifecycle_active",
      }),
    );
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

  describe("paced starvation progress", () => {
    const interval = 5 * 60_000;
    let attempts: string[];
    let attemptTimes: number[];
    let rows: any[];
    let full: number;
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-09-27T12:00:00Z"));
      attempts = [];
      attemptTimes = [];
      rows = ["a", "b"].map((project_id) => ({
        project_id,
        last_changed: "2026-09-27T10:00:00Z",
        backup_due_since: "2026-09-27T10:00:00Z",
        snapshots: {},
        backups: {},
        storage_service_class: project_id === "a" ? "paying" : "free",
      }));
      listProjectMaintenanceSchedulesMock.mockImplementation(
        async ({ project_ids }) =>
          rows.filter(
            (row) => !project_ids || project_ids.includes(row.project_id),
          ),
      );
      const { createStorageAdmissionController } = jest.requireActual(
        "./storage-admission",
      );
      full = 10;
      const controller = createStorageAdmissionController({
        mode: "enforce",
        readInputs: () => ({
          sampled_at_ms: Date.now(),
          host_io_full_avg10: full,
          starting_projects: 0,
          stopping_projects: 0,
          btrfs_mutation_locks: 0,
          btrfs_mutation_waiters: 0,
        }),
      });
      full = 2.3;
      controller.sample();
      getStorageAdmissionStatusMock.mockImplementation(() =>
        controller.getStatus(),
      );
      admitStorageOperationMock.mockImplementation((request) =>
        controller.admit(request),
      );
      runScheduledSnapshotMaintenanceMock.mockImplementation(
        async ({ project_id }) => {
          attempts.push(`snapshot:${project_id}`);
          attemptTimes.push(Date.now());
          // Failing oldest work must not monopolize later sweeps.
          throw new Error("snapshot failed");
        },
      );
      runScheduledBackupMaintenanceMock.mockImplementation(
        async ({ project_id }) => {
          attempts.push(`backup:${project_id}`);
          attemptTimes.push(Date.now());
          return { created: false, deferred_reason: "disk_pressure" };
        },
      );
    });

    it("makes fair bounded progress for both kinds under sustained moderate pressure", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      for (let i = 0; i < 8; i++) {
        await sweep({ hostId: "host-1" });
        expect(attempts).toHaveLength(i + 1);
        await jest.advanceTimersByTimeAsync(interval - 1);
        await sweep({ hostId: "host-1" });
        expect(attempts).toHaveLength(i + 1);
        await jest.advanceTimersByTimeAsync(1);
      }
      expect(attempts).toEqual([
        "snapshot:a",
        "backup:a",
        "snapshot:b",
        "backup:b",
        "snapshot:a",
        "backup:a",
        "snapshot:b",
        "backup:b",
      ]);
      expect(getStorageAdmissionStatusMock().pressure_state).toBe("recovery");
      for (const operation_class of [
        "scheduled_snapshot",
        "scheduled_backup",
      ]) {
        expect(mutationContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            operation_class,
            starvation_override: true,
            priority: "scheduled",
            cgroup_path: "/sys/fs/cgroup/cocalc-maintenance",
          }),
        );
      }
      expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "backup",
          outcome: "deferred",
          reason: "disk_pressure",
        }),
      );
    });

    it("fails closed on fresh emergency samples without consuming the fair slot", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      // The sweep's cached status is still recovery; admission must resample.
      full = 10;
      for (let i = 0; i < 3; i++) {
        await sweep({ hostId: "host-1" });
        await jest.advanceTimersByTimeAsync(interval);
      }
      expect(attempts).toEqual([]);
      full = 2.3;
      await sweep({ hostId: "host-1" });
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual(["snapshot:a"]);
    });

    it("makes paced progress through timer-driven retries between full sweeps", async () => {
      process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
      process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS = `${24 * 60 * 60_000}`;
      const { startProjectSnapshotBackupMaintenance } =
        await import("./snapshot-backup-maintenance");
      const stop = startProjectSnapshotBackupMaintenance({ hostId: "host-1" });
      try {
        await jest.advanceTimersByTimeAsync(0);
        expect(attempts).toEqual(["snapshot:a"]);
        // Existing jittered retries and event batches can add latency, but
        // cannot shorten cooldown or require another full inventory sweep.
        await jest.advanceTimersByTimeAsync(4 * interval - 1);
        expect(attempts.slice(0, 4)).toEqual([
          "snapshot:a",
          "backup:a",
          "snapshot:b",
          "backup:b",
        ]);
        expect(attempts).toHaveLength(4);
        for (let i = 1; i < attemptTimes.length; i++) {
          expect(attemptTimes[i] - attemptTimes[i - 1]).toBeGreaterThanOrEqual(
            interval,
          );
        }
        expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
          expect.objectContaining({ project_ids: expect.any(Array) }),
        );
      } finally {
        stop();
      }
    });

    it("rechecks memory after listing and charges a deferred escape attempt", async () => {
      delete process.env
        .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES;
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      let pressure = 0;
      const fs = require("node:fs");
      const originalRead = fs.readFileSync;
      const read = jest
        .spyOn(fs, "readFileSync")
        .mockImplementation((path: unknown, ...args: unknown[]) => {
          if (`${path}` === "/proc/pressure/memory")
            return `full avg10=${pressure} avg60=0 avg300=0 total=0\n`;
          if (`${path}` === "/proc/meminfo")
            return "MemTotal: 65536000 kB\nMemAvailable: 20971520 kB\n";
          return originalRead(path, ...args);
        });
      listProjectMaintenanceSchedulesMock.mockImplementation(async () => {
        pressure = 7.5;
        return rows;
      });
      try {
        await sweep({ hostId: "host-1" });
        expect(attempts).toEqual([]);
        expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "snapshot",
            outcome: "deferred",
            reason: "memory_pressure",
          }),
        );
        pressure = 0;
        listProjectMaintenanceSchedulesMock.mockResolvedValue(rows);
        await sweep({ hostId: "host-1" });
        expect(attempts).toEqual([]);
        await jest.advanceTimersByTimeAsync(interval);
        await sweep({ hostId: "host-1" });
        expect(attempts).toEqual(["backup:a"]);
      } finally {
        read.mockRestore();
      }
    });

    it("publishes successful protection and removes satisfied debt from rotation", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      runScheduledSnapshotMaintenanceMock.mockImplementation(
        async ({ project_id }) => {
          attempts.push(`snapshot:${project_id}`);
          return {
            created_snapshot_at: new Date().toISOString(),
            latest_snapshot_at: new Date().toISOString(),
            changed: true,
          };
        },
      );
      runScheduledBackupMaintenanceMock.mockImplementation(
        async ({ project_id }) => {
          attempts.push(`backup:${project_id}`);
          return { created: true, latest_backup_id: `backup-${project_id}` };
        },
      );
      reportProjectMaintenanceMock.mockImplementation(async (report) => {
        if (report.outcome !== "succeeded") return;
        rows = rows.map((row) =>
          row.project_id !== report.project_id
            ? row
            : {
                ...row,
                ...(report.kind === "snapshot"
                  ? { last_snapshot: report.latest_snapshot_at }
                  : { backup_due_since: null }),
              },
        );
      });
      for (let i = 0; i < 6; i++) {
        await sweep({ hostId: "host-1" });
        await jest.advanceTimersByTimeAsync(interval);
      }
      expect(attempts).toEqual([
        "snapshot:a",
        "backup:a",
        "snapshot:b",
        "backup:b",
      ]);
      for (const kind of ["snapshot", "backup"]) {
        expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
          expect.objectContaining({ kind, outcome: "succeeded" }),
        );
      }
    });

    it("does not let repeated event batches steal the globally fair slot", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      await sweep({ hostId: "host-1" });
      await jest.advanceTimersByTimeAsync(interval);
      await sweep({ hostId: "host-1", projectIds: ["a"] });
      await jest.advanceTimersByTimeAsync(interval);
      const onFutureDue = jest.fn();
      for (let i = 0; i < 3; i++) {
        await sweep({ hostId: "host-1", projectIds: ["a"], onFutureDue });
      }
      expect(attempts).toEqual(["snapshot:a", "backup:a"]);
      expect(onFutureDue).toHaveBeenCalledWith("b", expect.any(Number));
      await sweep({ hostId: "host-1", projectIds: ["b"] });
      expect(attempts).toEqual(["snapshot:a", "backup:a", "snapshot:b"]);
    });

    it("keeps one escape in flight and waits five minutes after it finishes", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      let finish!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      runScheduledSnapshotMaintenanceMock.mockImplementation(
        async ({ project_id }) => {
          attempts.push(`snapshot:${project_id}`);
          started();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      );
      const first = sweep({ hostId: "host-1" });
      await running;
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      const second = sweep({ hostId: "host-1", projectIds: ["b"] });
      await jest.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["snapshot:a"]);
      finish();
      await Promise.all([first, second]);
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual(["snapshot:a"]);
      await jest.advanceTimersByTimeAsync(interval);
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual(["snapshot:a", "backup:a"]);
    });

    it("requires an hour of actual overdue debt and honors disabled schedules and retries", async () => {
      const { runProjectSnapshotBackupMaintenanceSweepOnce: sweep } =
        await import("./snapshot-backup-maintenance");
      rows = [
        {
          ...rows[0],
          last_changed: "2026-09-27T11:00:00.001Z",
          backup_due_since: "2026-09-26T10:00:00Z",
          last_backup: "2026-09-26T11:30:00Z",
        },
      ];
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual(["snapshot:a"]);
      rows[0].snapshots = { disabled: true };
      rows[0].backup_retry_at = "2026-09-27T14:00:00Z";
      await jest.advanceTimersByTimeAsync(60 * 60_000);
      await sweep({ hostId: "host-1" });
      expect(attempts).toEqual(["snapshot:a"]);
    });
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

  it("walks past an unresolved owner's disabled row on a later page and runs both lanes", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      project_id: `project-${String(index).padStart(4, "0")}`,
      last_changed: "2026-04-01T00:00:00.000Z",
      backup_due_since: "2026-04-01T00:00:00.000Z",
      snapshots: { daily: 1, disabled: index === 499 },
      backups: { daily: 1, disabled: index === 499 },
      max_snapshots_per_project: index === 499 ? null : 8,
      max_backups_per_project: index === 499 ? null : 4,
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
    await expect(
      runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" }),
    ).resolves.toBe(true);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(3);
    for (const operation of [
      runScheduledSnapshotMaintenanceMock,
      runScheduledBackupMaintenanceMock,
    ]) {
      expect(operation).toHaveBeenCalledTimes(500);
      expect(operation).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: "project-0500" }),
      );
      expect(operation).not.toHaveBeenCalledWith(
        expect.objectContaining({ project_id: "project-0499" }),
      );
    }
    expect(reportProjectMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "project-0499" }),
    );
  });

  it("starts a newly due snapshot while a previous backup is still running", async () => {
    let finishBackup!: (value: { created: boolean }) => void;
    const backupRunning = new Promise<{ created: boolean }>((resolve) => {
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
    expect(
      await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId: "host-1" }),
    ).toBe(true);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "snapshot-project" }),
    );
    finishBackup({ created: true });
    await first;
  });

  it("admits a future-due paying snapshot before a long free tail drains", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    let releaseFirst!: () => void;
    let releaseTail!: () => void;
    const heldFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const heldTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const free = ["free-a", "free-b", "free-c"].map((project_id) => ({
      project_id,
      storage_service_class: "free",
      last_changed: "2026-09-30T14:00:00Z",
      snapshots: { frequent: 1, daily: 0, weekly: 0, monthly: 0 },
      backups: { disabled: true },
    }));
    const paid = {
      ...free[0],
      project_id: "paid",
      storage_service_class: "paying",
      last_changed: "2026-09-30T16:00:00Z",
      last_snapshot: "2026-09-30T15:46:00Z",
      last_snapshot_observed_at: "2026-09-30T16:00:00Z",
    };
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids }) => {
        const rows = [...free, paid];
        return project_ids
          ? rows.filter((row) => project_ids.includes(row.project_id))
          : rows;
      },
    );
    const order: string[] = [];
    runScheduledSnapshotMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        order.push(project_id);
        if (project_id === "free-a") await heldFirst;
        if (project_id === "free-b") await heldTail;
        return {
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
          changed: true,
        };
      },
    );
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({
      hostId: "dynamic-future-host",
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["free-a"]);
      await jest.advanceTimersByTimeAsync(60_001);
      expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
        expect.objectContaining({ project_ids: ["paid"] }),
      );
      releaseFirst();
      await jest.advanceTimersByTimeAsync(0);
      expect(order.slice(0, 2)).toEqual(["free-a", "paid"]);
      expect(order).toContain("free-b");
      expect(order).not.toContain("free-c");
    } finally {
      stop();
      releaseFirst();
      releaseTail();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  it("refreshes an old queued generation before the final assignment check", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    const original = ["a", "b"].map((project_id) => ({
      project_id,
      storage_service_class: "free",
      last_changed: "2026-09-30T14:00:00Z",
      snapshots: { daily: 1 },
      backups: { disabled: true },
    }));
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids }) =>
        project_ids
          ? [{ ...original[1], last_changed: "2026-09-30T15:59:00Z" }]
          : original,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runScheduledSnapshotMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        if (project_id === "a") await held;
        return {
          changed: true,
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
        };
      },
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    const sweep = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "refresh-host",
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(60_001);
    release();
    await sweep;
    expect(confirmProjectMaintenanceAssignmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "b",
        observed_change_at: "2026-09-30T15:59:00Z",
      }),
    );
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(2);
  });

  it.each(["snapshot", "backup"])(
    "rearms %s work postponed by a queued schedule refresh",
    async (kind) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
      const original = ["a", "b"].map((project_id) => ({
        project_id,
        storage_service_class: "free",
        last_changed: "2026-09-29T14:00:00Z",
        backup_due_since: "2026-09-29T14:00:00Z",
        snapshots:
          kind === "snapshot" ? { frequent: 0, daily: 1 } : { disabled: true },
        backups: kind === "backup" ? { daily: 1 } : { disabled: true },
        last_snapshot_observed_at: new Date().toISOString(),
        last_backup_observed_at: new Date().toISOString(),
      }));
      const latest = "2026-09-30T15:00:00Z";
      listProjectMaintenanceSchedulesMock.mockImplementation(
        async ({ project_ids }) =>
          project_ids
            ? [
                {
                  ...original[1],
                  last_snapshot: latest,
                  last_backup: latest,
                  last_changed: "2026-09-30T15:30:00Z",
                  backup_due_since: "2026-09-30T15:30:00Z",
                },
              ]
            : original,
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run =
        kind === "snapshot"
          ? runScheduledSnapshotMaintenanceMock
          : runScheduledBackupMaintenanceMock;
      run.mockImplementation(async ({ project_id }) => {
        if (project_id === "a") await held;
        return {
          created: true,
          changed: true,
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
        };
      });
      const { runProjectSnapshotBackupMaintenanceSweepOnce } =
        await import("./snapshot-backup-maintenance");
      const onFutureDue = jest.fn();
      const sweep = runProjectSnapshotBackupMaintenanceSweepOnce({
        hostId: `postponed-${kind}-host`,
        onFutureDue,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_001);
      release();
      await sweep;
      expect(run).toHaveBeenCalledTimes(1);
      expect(onFutureDue).toHaveBeenCalledWith(
        "b",
        Date.parse(latest) + 24 * 60 * 60_000,
      );
    },
  );

  it("bounds refresh RPCs across a large stale backlog and leaves non-due inventory out of both queues", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    const observedAt = new Date().toISOString();
    const due = Array.from({ length: 600 }, (_, i) => ({
      project_id: `due-${String(i).padStart(4, "0")}`,
      storage_service_class: "free",
      last_changed: "2026-09-29T14:00:00Z",
      backup_due_since: "2026-09-29T14:00:00Z",
      snapshots: { daily: 1 },
      backups: { daily: 1 },
      last_snapshot_observed_at: observedAt,
      last_backup_observed_at: observedAt,
    }));
    const future = Array.from({ length: 600 }, (_, i) => ({
      ...due[0],
      project_id: `future-${String(i).padStart(4, "0")}`,
      last_snapshot: observedAt,
      last_backup: observedAt,
      backup_due_since: observedAt,
    }));
    const rows = [...due, ...future];
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids, cursor_project_id, limit }) =>
        rows
          .filter((row) =>
            project_ids
              ? project_ids.includes(row.project_id)
              : !cursor_project_id || row.project_id > cursor_project_id,
          )
          .slice(0, limit),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runScheduledSnapshotMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        if (project_id === due[0].project_id) await held;
        return {
          changed: true,
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
        };
      },
    );
    runScheduledBackupMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        if (project_id === due[0].project_id) await held;
        return { created: true };
      },
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    const onFutureDue = jest.fn();
    const sweep = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "large-backlog-host",
      onFutureDue,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 85 * 60_000);
    release();
    await sweep;
    const refreshCalls = listProjectMaintenanceSchedulesMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.project_ids);
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(6);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].project_ids).toHaveLength(100);
    expect(
      refreshCalls[0].project_ids.every((id: string) => id.startsWith("due-")),
    ).toBe(true);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(
      due.length,
    );
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(due.length);
    expect(onFutureDue).toHaveBeenCalledTimes(future.length);
    expect(onFutureDue).toHaveBeenCalledWith(
      future[0].project_id,
      Date.parse(observedAt) + 24 * 60 * 60_000,
    );
  });

  it("keeps assignment fencing for stale candidates outside the refresh budget", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    const rows = Array.from({ length: 201 }, (_, i) => ({
      project_id: `fenced-${String(i).padStart(4, "0")}`,
      last_changed: "2026-09-29T14:00:00Z",
      snapshots: { daily: 1 },
      backups: { disabled: true },
    }));
    const changedAt = "2026-09-30T15:59:00Z";
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids }) =>
        project_ids
          ? rows
              .filter((row) => project_ids.includes(row.project_id))
              .map((row) => ({ ...row, last_changed: changedAt }))
          : rows,
    );
    confirmProjectMaintenanceAssignmentMock.mockImplementation(
      async ({ project_id, observed_change_at }) =>
        project_id === rows[0].project_id || observed_change_at === changedAt
          ? { valid: true }
          : { valid: false, reason: "change_generation_changed" },
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runScheduledSnapshotMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        if (project_id === rows[0].project_id) await held;
        return {
          changed: true,
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
        };
      },
    );
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    const sweep = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "refresh-budget-fence-host",
    });
    await jest.advanceTimersByTimeAsync(0);
    jest.setSystemTime(Date.now() + 60_001);
    release();
    await sweep;
    expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledTimes(2);
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(101);
    expect(runScheduledSnapshotMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ project_id: rows[200].project_id }),
    );
    expect(reportProjectMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: rows[200].project_id,
        outcome: "deferred",
        reason: "change_generation_changed",
      }),
    );
  });

  it("continues discovering changed projects while an earlier event batch waits", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS = "0";
    const rows = ["free-a", "free-b", "free-c", "paid"].map((project_id) => ({
      project_id,
      storage_service_class: project_id === "paid" ? "paying" : "free",
      last_changed: "2026-09-30T14:00:00Z",
      snapshots: { daily: 1 },
      backups: { disabled: true },
    }));
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids }) =>
        project_ids
          ? rows.filter((row) => project_ids.includes(row.project_id))
          : rows.slice(0, 3),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    runScheduledSnapshotMaintenanceMock.mockImplementation(
      async ({ project_id }) => {
        order.push(project_id);
        if (project_id === "free-a") await held;
        return {
          changed: true,
          created_snapshot_at: new Date().toISOString(),
          latest_snapshot_at: new Date().toISOString(),
        };
      },
    );
    const { startProjectSnapshotBackupMaintenance } =
      await import("./snapshot-backup-maintenance");
    const stop = startProjectSnapshotBackupMaintenance({
      hostId: "events-host",
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      const notify = onProjectChangeReportedMock.mock.calls.at(-1)![0];
      notify("free-b");
      await jest.advanceTimersByTimeAsync(15_001);
      notify("paid");
      await jest.advanceTimersByTimeAsync(15_001);
      expect(listProjectMaintenanceSchedulesMock).toHaveBeenCalledWith(
        expect.objectContaining({ project_ids: ["paid"] }),
      );
      expect(order).toEqual(["free-a"]);
      release();
      await jest.advanceTimersByTimeAsync(0);
      expect(order.slice(0, 2)).toEqual(["free-a", "paid"]);
      expect(order.filter((id) => id === "free-b")).toHaveLength(1);
    } finally {
      stop();
      release();
      await jest.advanceTimersByTimeAsync(0);
    }
  });

  it("does not mutate an old candidate that disappears during queued refresh", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-30T16:00:00Z"));
    const rows = ["a", "b"].map((project_id) => ({
      project_id,
      last_changed: "2026-09-30T14:00:00Z",
      snapshots: { daily: 1 },
      backups: { disabled: true },
    }));
    listProjectMaintenanceSchedulesMock.mockImplementation(
      async ({ project_ids }) => (project_ids ? [] : rows),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runScheduledSnapshotMaintenanceMock.mockImplementation(async () => held);
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");
    const sweep = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "removed-host",
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(60_001);
    release();
    await sweep;
    expect(runScheduledSnapshotMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(confirmProjectMaintenanceAssignmentMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "b" }),
    );
  });

  it("queues paid backup work behind an active free operation without another sweep", async () => {
    let finishFreeBackup!: (value: { created: boolean }) => void;
    const freeBackupRunning = new Promise<{ created: boolean }>((resolve) => {
      finishFreeBackup = resolve;
    });
    const freeRow = {
      project_id: "free-project",
      storage_service_class: "free",
      storage_account_id: "free-account",
      backup_due_since: "2026-04-01T00:00:00.000Z",
      snapshots: { disabled: true },
      backups: { daily: 1 },
    };
    const paidRow = {
      ...freeRow,
      project_id: "paid-project",
      storage_service_class: "paying",
      storage_account_id: "paid-account",
    };
    listProjectMaintenanceSchedulesMock
      .mockResolvedValueOnce([freeRow])
      .mockResolvedValue([paidRow]);
    runScheduledBackupMaintenanceMock
      .mockReturnValueOnce(freeBackupRunning)
      .mockResolvedValue({ created: true });
    const { runProjectSnapshotBackupMaintenanceSweepOnce } =
      await import("./snapshot-backup-maintenance");

    const running = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "free-project" }),
    );

    const paid = runProjectSnapshotBackupMaintenanceSweepOnce({
      hostId: "host-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledTimes(1);

    finishFreeBackup({ created: true });
    await running;
    expect(await paid).toBe(true);
    expect(runScheduledBackupMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "paid-project" }),
    );
  });
});
