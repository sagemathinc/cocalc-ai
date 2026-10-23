const reportHostProvisionedInventoryMock = jest.fn();
const reportProjectProvisionedMock = jest.fn();
const reportProjectStateMock = jest.fn();
const markProjectStateReportedMock = jest.fn();
const syncAccountRevocationsMock = jest.fn();
const upsertAccountRevocationMock = jest.fn();
const deleteVolumeMock = jest.fn(async (..._args: any[]): Promise<any> => ({}));
const defaultLocalProject = {
  project_bundle_version: "1791099701123",
  tools_version: "1791099787193",
};
let localProject: any = defaultLocalProject;
let localProvisioning: any = undefined;

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
    reportProjectProvisioned: (...args: any[]) =>
      reportProjectProvisionedMock(...args),
    syncAccountRevocations: (...args: any[]) =>
      syncAccountRevocationsMock(...args),
  })),
}));

jest.mock("./sqlite/projects", () => ({
  __esModule: true,
  listUnreportedProjects: jest.fn(() => []),
  markProjectStateReported: (...args: any[]) =>
    markProjectStateReportedMock(...args),
  deleteProjectLocal: jest.fn(),
  getProject: () => localProject,
}));

jest.mock("./sqlite/provisioning", () => ({
  __esModule: true,
  listUnreportedProvisioning: jest.fn(() => []),
  markProjectProvisionedReported: jest.fn(),
  setProjectProvisioned: jest.fn(() => true),
  getProjectProvisioning: () => localProvisioning,
  deleteProjectProvisioning: jest.fn(),
}));

jest.mock("./sqlite/account-revocations", () => ({
  __esModule: true,
  getRevocationSyncCursor: jest.fn(() => ({ updated_ms: 0, account_id: "" })),
  setRevocationSyncCursor: jest.fn(),
  upsertAccountRevocation: (...args: any[]) =>
    upsertAccountRevocationMock(...args),
}));

jest.mock("./last-edited", () => ({
  __esModule: true,
  reportPendingProjectTouches: jest.fn(async () => undefined),
}));

jest.mock("./file-server", () => ({
  __esModule: true,
  deleteVolume: (...args: any[]) => deleteVolumeMock(...args),
}));

let homeInstalledAt: number | undefined;
jest.mock("./persist-volume", () => ({
  __esModule: true,
  projectHomeInstalledAt: () => homeInstalledAt,
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
    reportProjectProvisionedMock.mockResolvedValue({});
    reportProjectStateMock.mockResolvedValue(undefined);
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
  });

  afterEach(async () => {
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
    jest.useRealTimers();
  });

  it("notifies the maintenance scheduler only after a provisioned report is accepted", async () => {
    const {
      onProjectProvisionedReported,
      queueProjectProvisioned,
      setMasterStatusClient,
    } = await import("./master-status");
    const listener = jest.fn();
    const unsubscribe = onProjectProvisionedReported(listener);
    setMasterStatusClient({ client: {} as any, host_id: "host-1" });

    queueProjectProvisioned("project-1", true);
    await new Promise(setImmediate);
    expect(listener).toHaveBeenCalledWith("project-1");

    reportProjectProvisionedMock.mockRejectedValueOnce(
      new Error("bay offline"),
    );
    queueProjectProvisioned("project-2", true);
    await new Promise(setImmediate);
    queueProjectProvisioned("project-3", false);
    await new Promise(setImmediate);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
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

describe("master-status stale project data deletion", () => {
  const deferred = () =>
    new Error("BtrfsMutationDeferredError: background btrfs mutation deferred");
  // deleteVolume: deferred the first time, then as the real one (asks
  // `superseded` under the project's lifecycle lock)
  const deleted: string[] = [];
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useRealTimers();
    deleted.length = 0;
    reportProjectProvisionedMock.mockReset();
    reportProjectProvisionedMock.mockResolvedValue({});
    localProject = undefined;
    localProvisioning = undefined;
    // (a deferral a previous test never used must not carry over)
    deleteVolumeMock.mockReset();
    deleteVolumeMock.mockImplementation(async (project_id, opts) => {
      const superseded = opts?.superseded?.();
      if (superseded != null) return { superseded };
      deleted.push(project_id);
      return {};
    });
    deleteVolumeMock.mockRejectedValueOnce(deferred());
    const { resetMasterStatusForTests, setMasterStatusClient } =
      await import("./master-status");
    resetMasterStatusForTests();
    setMasterStatusClient({ client: {} as any, host_id: "dest" });
  });

  afterEach(async () => {
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
    localProject = defaultLocalProject;
    localProvisioning = undefined;
  });

  // the first attempt is deferred; the retry comes 250 ms later
  const retry = () => new Promise((resolve) => setTimeout(resolve, 600));

  it("deletes the data of a project that is still stale here", async () => {
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", true);
    await retry();
    expect(deleteVolumeMock).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual(["p"]);
  });

  it("does not delete a project started here after the deletion was requested", async () => {
    // a move's destination: the master asked for the deletion before the
    // placement switched, then the move restored and started it here
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", false);
    await new Promise(setImmediate);
    localProject = { state: "starting", state_updated_at: Date.now() };
    await retry();
    // (dropped before even trying again)
    expect(deleteVolumeMock).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([]);

    // and not later either, once it is no longer starting
    localProject = { state: "opened", state_updated_at: Date.now() };
    await retry();
    expect(deleted).toEqual([]);
  });

  it("does not delete a project provisioned here after the deletion was requested", async () => {
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", false);
    await new Promise(setImmediate);
    localProvisioning = {
      project_id: "p",
      provisioned: true,
      updated_at: Date.now() + 1,
    };
    await retry();
    expect(deleted).toEqual([]);
  });

  it("does not delete a home restored here after the deletion was requested", async () => {
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", false);
    await new Promise(setImmediate);
    homeInstalledAt = Date.now() + 1;
    await retry();
    expect(deleted).toEqual([]);
    homeInstalledAt = undefined;
  });

  it("does not delete a project restored here while the inventory was being taken", async () => {
    const { startProvisionedInventoryReporter } =
      await import("./master-status");
    let finishScan: (project_ids: string[]) => void = () => {};
    reportHostProvisionedInventoryMock.mockResolvedValueOnce({
      delete_project_ids: ["p"],
    });
    const stop = startProvisionedInventoryReporter({
      bootstrapProjectIds: () =>
        new Promise<string[]>((resolve) => (finishScan = resolve)),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // restored and stopped again here while the volumes were listed
    localProject = { state: "opened", state_updated_at: Date.now() };
    await new Promise((resolve) => setTimeout(resolve, 5));
    finishScan(["p"]);
    await retry();
    stop();
    expect(deleted).toEqual([]);
  });

  it("keeps a deletion requested after a provisioned report the master answered late", async () => {
    const { queueProjectProvisioned, startProvisionedInventoryReporter } =
      await import("./master-status");
    let answer: (value: any) => void = () => {};
    reportProjectProvisionedMock.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    queueProjectProvisioned("p", true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // a newer verdict: the project is not ours (e.g. it moved away)
    reportHostProvisionedInventoryMock.mockResolvedValueOnce({
      delete_project_ids: ["p"],
    });
    const stop = startProvisionedInventoryReporter({
      bootstrapProjectIds: () => ["p"],
    });
    await new Promise(setImmediate);
    // the old report's answer arrives only now
    answer({});
    await retry();
    stop();
    expect(deleted).toEqual(["p"]);
  });

  it("keeps a newer deletion verdict for a project already queued", async () => {
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", true);
    await new Promise(setImmediate);
    // (the first attempt was deferred) a restore here, then the master
    // still says it is not ours
    homeInstalledAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", true);
    await retry();
    homeInstalledAt = undefined;
    expect(deleted).toEqual(["p"]);
  });

  it("dates a deletion from its request, not from a late answer", async () => {
    // an old "not provisioned" report is answered (delete) only after a
    // restore here was reported and accepted
    const { queueProjectProvisioned } = await import("./master-status");
    let answer: (value: any) => void = () => {};
    reportProjectProvisionedMock.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    queueProjectProvisioned("p", false);
    await new Promise(setImmediate);
    // restored, started and stopped here meanwhile
    await new Promise((resolve) => setTimeout(resolve, 5));
    localProject = { state: "opened", state_updated_at: Date.now() };
    answer({ action: "delete" });
    await retry();
    expect(deleted).toEqual([]);
  });

  it("drops a pending deletion once the master accepts the project as provisioned here", async () => {
    const { queueProjectProvisioned } = await import("./master-status");
    reportProjectProvisionedMock.mockResolvedValueOnce({ action: "delete" });
    queueProjectProvisioned("p", false);
    await new Promise(setImmediate);
    expect(deleteVolumeMock).toHaveBeenCalledTimes(1);
    // the master now says it is ours
    reportProjectProvisionedMock.mockResolvedValueOnce({});
    queueProjectProvisioned("p", true);
    await retry();
    expect(deleteVolumeMock).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([]);
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
    // Running reports say what the project started with; others do not.
    expect(
      reportProjectStateMock.mock.calls.map(([request]) => [
        request.state.project_bundle_version,
        request.state.tools_version,
      ]),
    ).toEqual([
      [undefined, undefined],
      ["1791099701123", "1791099787193"],
    ]);
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

describe("master-status account revocations", () => {
  afterEach(async () => {
    const { resetMasterStatusForTests } = await import("./master-status");
    resetMasterStatusForTests();
  });

  it("stores every cutoff the hub sends, the browser one included", async () => {
    const { setMasterStatusClient, syncAccountRevocationsFromMaster } =
      await import("./master-status");
    setMasterStatusClient({ client: {} as any, host_id: "host-1" });
    const row = {
      account_id: "00000000-0000-4000-8000-000000000001",
      revoked_before_ms: 0,
      content_revoked_before_ms: 5000,
      browser_revoked_before_ms: 5000,
      updated_ms: 9,
    };
    syncAccountRevocationsMock.mockResolvedValueOnce({
      rows: [row],
      next_cursor_updated_ms: 9,
      next_cursor_account_id: row.account_id,
    });
    await syncAccountRevocationsFromMaster();
    expect(upsertAccountRevocationMock).toHaveBeenCalledWith(row);
  });
});
