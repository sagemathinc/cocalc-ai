export {};

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: {
    system: {
      getProjectHostParallelOpsLimit: jest.fn(),
    },
  },
}));

jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: jest.fn(() => "host-1"),
}));

describe("backup execution limit", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("uses a project-host override when available", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    (
      hubApi.system.getProjectHostParallelOpsLimit as jest.Mock
    ).mockResolvedValue({
      worker_kind: "project-host-backup-execution",
      scope_type: "project_host",
      scope_id: "host-1",
      default_limit: 10,
      configured_limit: 14,
      effective_limit: 14,
      config_source: "db-override",
    });
    const {
      getBackupExecutionLimit,
      getCachedBackupExecutionLimit,
      resetBackupExecutionLimitForTest,
    } = await import("./backup-execution-limit");

    resetBackupExecutionLimitForTest();
    await expect(getBackupExecutionLimit({ force: true })).resolves.toEqual({
      max_parallel: 14,
      config_source: "db-override",
    });
    expect(getCachedBackupExecutionLimit()).toEqual({
      max_parallel: 14,
      config_source: "db-override",
    });
  });

  it("falls back to the env-backed default on lookup failure", async () => {
    const { hubApi } = await import("@cocalc/lite/hub/api");
    (
      hubApi.system.getProjectHostParallelOpsLimit as jest.Mock
    ).mockRejectedValue(new Error("boom"));
    const {
      DEFAULT_BACKUP_MAX_PARALLEL,
      getBackupExecutionLimit,
      resetBackupExecutionLimitForTest,
    } = await import("./backup-execution-limit");

    resetBackupExecutionLimitForTest();
    await expect(getBackupExecutionLimit({ force: true })).resolves.toEqual({
      max_parallel: DEFAULT_BACKUP_MAX_PARALLEL,
      config_source: "env-legacy",
    });
  });
});
