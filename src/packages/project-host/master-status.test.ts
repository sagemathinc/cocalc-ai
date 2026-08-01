const reportHostProvisionedInventoryMock = jest.fn();
const reportProjectStateMock = jest.fn();
const markProjectStateReportedMock = jest.fn();

const loggerFactory = jest.fn(() => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: loggerFactory,
  getLogger: loggerFactory,
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostStatusClient: jest.fn(() => ({
    reportProjectState: (...args: any[]) => reportProjectStateMock(...args),
    reportHostProvisionedInventory: (...args: any[]) =>
      reportHostProvisionedInventoryMock(...args),
  })),
}));

jest.mock("@cocalc/lite/hub/acp", () => ({
  __esModule: true,
  clearLocalAcpAutomationsForProject: jest.fn(),
}));

jest.mock("./sqlite/projects", () => ({
  __esModule: true,
  listUnreportedProjects: jest.fn(() => []),
  markProjectStateReported: (...args: any[]) =>
    markProjectStateReportedMock(...args),
  deleteProjectLocal: jest.fn(),
}));

jest.mock("./sqlite/provisioning", () => ({
  __esModule: true,
  listUnreportedProvisioning: jest.fn(() => []),
  markProjectProvisionedReported: jest.fn(),
  setProjectProvisioned: jest.fn(() => true),
  deleteProjectProvisioning: jest.fn(),
}));

jest.mock("./sqlite/account-revocations", () => ({
  __esModule: true,
  getRevocationSyncCursor: jest.fn(() => ({ updated_ms: 0, account_id: "" })),
  setRevocationSyncCursor: jest.fn(),
  upsertAccountRevocation: jest.fn(),
}));

jest.mock("./last-edited", () => ({
  __esModule: true,
  reportPendingProjectTouches: jest.fn(async () => undefined),
}));

jest.mock("./file-server", () => ({
  __esModule: true,
  deleteVolume: jest.fn(async () => undefined),
}));

jest.mock("./rpc-traffic-audit", () => ({
  __esModule: true,
  recordProjectHostRpcTraffic: jest.fn(),
}));

describe("master-status provisioned inventory", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    reportHostProvisionedInventoryMock.mockResolvedValue({
      delete_project_ids: [],
    });
    reportProjectStateMock.mockResolvedValue(undefined);
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
  });

  afterEach(async () => {
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
    jest.useRealTimers();
  });

  it("reports legacy inventory once and runs only bounded audits periodically", async () => {
    jest.useFakeTimers();
    const { setMasterStatusClient, startProvisionedInventoryReporter } =
      await import("./master-status");
    setMasterStatusClient({
      client: {} as any,
      host_id: "host-1",
    });
    const bootstrapProjectIds = jest.fn(async () => [
      "project-1",
      "project-1",
      "project-2",
      "",
    ]);
    const verifyBatch = jest.fn(async () => undefined);

    const stop = startProvisionedInventoryReporter({
      bootstrapProjectIds,
      verifyBatch,
      intervalMs: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(reportHostProvisionedInventoryMock).toHaveBeenCalledTimes(1);
    expect(reportHostProvisionedInventoryMock).toHaveBeenCalledWith({
      host_id: "host-1",
      host: undefined,
      project_ids: ["project-1", "project-2"],
      checked_at: expect.any(Number),
    });

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(reportHostProvisionedInventoryMock).toHaveBeenCalledTimes(1);
    expect(verifyBatch).toHaveBeenCalledTimes(1);

    stop();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(reportHostProvisionedInventoryMock).toHaveBeenCalledTimes(1);
    expect(verifyBatch).toHaveBeenCalledTimes(1);
  });

  it("does not report an empty inventory when listing provisioned projects fails", async () => {
    const { setMasterStatusClient, startProvisionedInventoryReporter } =
      await import("./master-status");
    setMasterStatusClient({
      client: {} as any,
      host_id: "host-1",
    });
    const stop = startProvisionedInventoryReporter({
      bootstrapProjectIds: async () => {
        throw new Error("btrfs list failed");
      },
      intervalMs: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();

    expect(reportHostProvisionedInventoryMock).not.toHaveBeenCalled();
  });
});

describe("master-status project state reporting", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    reportProjectStateMock.mockResolvedValue(undefined);
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
  });

  afterEach(async () => {
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
    jest.useRealTimers();
  });

  it("serializes starting and running reports for one project", async () => {
    let acceptStarting!: () => void;
    reportProjectStateMock.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          acceptStarting = resolve;
        }),
    );
    const { reportProjectStateToMaster, setMasterStatusClient } =
      await import("./master-status");
    setMasterStatusClient({ client: {} as any, host_id: "host-1" });

    const starting = reportProjectStateToMaster("project-1", {
      state: "starting",
      time: new Date("2026-07-31T01:00:00.000Z"),
    });
    await Promise.resolve();
    const running = reportProjectStateToMaster("project-1", {
      state: "running",
      time: new Date("2026-07-31T01:00:01.000Z"),
    });

    expect(reportProjectStateMock).toHaveBeenCalledTimes(1);
    acceptStarting();
    await Promise.all([starting, running]);

    expect(reportProjectStateMock).toHaveBeenCalledTimes(2);
    expect(
      reportProjectStateMock.mock.calls.map(([request]) => request.state.state),
    ).toEqual(["starting", "running"]);
    expect(
      markProjectStateReportedMock.mock.calls.map((call) => call[1]),
    ).toEqual(["starting", "running"]);
  });

  it("supersedes a failed state immediately when a newer state arrives", async () => {
    jest.useFakeTimers();
    reportProjectStateMock.mockRejectedValueOnce(new Error("disconnected"));
    const { reportProjectStateToMaster, setMasterStatusClient } =
      await import("./master-status");
    setMasterStatusClient({ client: {} as any, host_id: "host-1" });

    const starting = reportProjectStateToMaster("project-1", "starting");
    await Promise.resolve();
    await Promise.resolve();
    const running = reportProjectStateToMaster("project-1", "running");
    await Promise.all([starting, running]);

    expect(reportProjectStateMock).toHaveBeenCalledTimes(2);
    expect(
      reportProjectStateMock.mock.calls.map(([request]) => request.state.state),
    ).toEqual(["starting", "running"]);
    expect(jest.getTimerCount()).toBe(1);
  });

  it("retries a transient failure before the 15-second reconciliation", async () => {
    jest.useFakeTimers();
    reportProjectStateMock
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(undefined);
    const { reportProjectStateToMaster, setMasterStatusClient } =
      await import("./master-status");
    setMasterStatusClient({ client: {} as any, host_id: "host-1" });

    const report = reportProjectStateToMaster("project-1", "running");
    await Promise.resolve();
    await Promise.resolve();
    expect(reportProjectStateMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    await report;

    expect(reportProjectStateMock).toHaveBeenCalledTimes(2);
    expect(markProjectStateReportedMock).toHaveBeenCalledWith(
      "project-1",
      "running",
      undefined,
    );
  });
});
