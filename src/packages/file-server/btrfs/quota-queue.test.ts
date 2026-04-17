describe("btrfs quota queue rescan logging", () => {
  const originalSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;
  const originalLogMs = process.env.COCALC_BTRFS_QUOTA_RESCAN_LOG_MS;
  const originalWarnMs = process.env.COCALC_BTRFS_QUOTA_RESCAN_WARN_MS;
  const originalDisableQuotas = process.env.COCALC_DISABLE_BTRFS_QUOTAS;
  const originalQuotaMode = process.env.COCALC_BTRFS_QUOTA_MODE;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    process.env.COCALC_BTRFS_QUOTA_RESCAN_LOG_MS = "0";
    process.env.COCALC_BTRFS_QUOTA_RESCAN_WARN_MS = "100000";
    delete process.env.COCALC_BTRFS_QUOTA_MODE;
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
  });

  afterAll(() => {
    if (originalSqlite == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = originalSqlite;
    }
    if (originalLogMs == null) {
      delete process.env.COCALC_BTRFS_QUOTA_RESCAN_LOG_MS;
    } else {
      process.env.COCALC_BTRFS_QUOTA_RESCAN_LOG_MS = originalLogMs;
    }
    if (originalWarnMs == null) {
      delete process.env.COCALC_BTRFS_QUOTA_RESCAN_WARN_MS;
    } else {
      process.env.COCALC_BTRFS_QUOTA_RESCAN_WARN_MS = originalWarnMs;
    }
    if (originalDisableQuotas == null) {
      delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_QUOTAS = originalDisableQuotas;
    }
    if (originalQuotaMode == null) {
      delete process.env.COCALC_BTRFS_QUOTA_MODE;
    } else {
      process.env.COCALC_BTRFS_QUOTA_MODE = originalQuotaMode;
    }
  });

  it("logs rescan duration with queue context", async () => {
    const info = jest.fn();
    const warn = jest.fn();
    const debug = jest.fn();
    const error = jest.fn();
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === "quota" && args[1] === "rescan") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "subvolume" && args[1] === "show") {
        return { stdout: "Subvolume ID:         123\n", stderr: "" };
      }
      if (args[0] === "qgroup" && args[1] === "create") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected btrfs args: ${args.join(" ")}`);
    });

    jest.doMock("@cocalc/backend/logger", () => ({
      __esModule: true,
      default: () => ({ info, warn, debug, error }),
    }));
    jest.doMock("./util", () => ({
      btrfs: (opts: { args: string[] }) => btrfsMock(opts),
    }));
    jest.doMock("@cocalc/backend/misc/async-utils-node", () => ({
      exists: async () => true,
    }));

    const { queueCreateSubvolumeQgroup } = await import("./quota-queue");
    await queueCreateSubvolumeQgroup({
      mount: "/mnt/test",
      path: "/mnt/test/project-1",
      wait: true,
    });

    expect(info).toHaveBeenCalledWith(
      "btrfs quota rescan completed",
      expect.objectContaining({
        mount: "/mnt/test",
        kind: "create_qgroup",
        path: "/mnt/test/project-1",
        phase: "before",
        queue_id: expect.any(String),
        elapsed_ms: expect.any(Number),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "btrfs quota rescan completed",
      expect.objectContaining({
        mount: "/mnt/test",
        kind: "create_qgroup",
        path: "/mnt/test/project-1",
        phase: "after",
        queue_id: expect.any(String),
        elapsed_ms: expect.any(Number),
      }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      "btrfs quota rescan completed",
      expect.anything(),
    );
  });

  it("returns a disabled status and no-ops when quotas are disabled", async () => {
    process.env.COCALC_DISABLE_BTRFS_QUOTAS = "1";

    const {
      startBtrfsQuotaQueue,
      queueSetSubvolumeQuota,
      getBtrfsQuotaQueueStatus,
    } = await import("./quota-queue");

    startBtrfsQuotaQueue();
    await queueSetSubvolumeQuota({
      mount: "/mnt/test",
      path: "/mnt/test/project-1",
      size: "10M",
      wait: true,
    });

    expect(getBtrfsQuotaQueueStatus("/mnt/test")).toEqual({
      enabled: false,
      mode: "disabled",
      queued_count: 0,
      running_count: 0,
      failed_count: 0,
      retrying_count: 0,
      oldest_queued_ms: null,
      oldest_failed_ms: null,
    });
  });

  it("re-enables quotas in simple mode without quota rescans", async () => {
    process.env.COCALC_BTRFS_QUOTA_MODE = "simple";

    const info = jest.fn();
    const warn = jest.fn();
    const debug = jest.fn();
    const error = jest.fn();
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === "subvolume" && args[1] === "show") {
        return { stdout: "Subvolume ID:         123\n", stderr: "" };
      }
      if (args[0] === "qgroup" && args[1] === "create") {
        const count = btrfsMock.mock.calls.filter(
          ([call]) => call.args[0] === "qgroup" && call.args[1] === "create",
        ).length;
        if (count === 1) {
          const err = new Error("quota not enabled");
          (err as any).stderr = "ERROR: quotas not enabled";
          throw err;
        }
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args.join(" ") === "quota status /mnt/test") {
        const count = btrfsMock.mock.calls.filter(
          ([call]) => call.args.join(" ") === "quota status /mnt/test",
        ).length;
        if (count === 1) {
          return {
            exit_code: 1,
            stdout: "",
            stderr: "ERROR: quotas not enabled",
          };
        }
        return {
          exit_code: 0,
          stdout: `
Quotas on /mnt/test:
  Enabled:                 yes
  Mode:                    squota (simple accounting)
`,
          stderr: "",
        };
      }
      if (args.join(" ") === "quota enable --simple /mnt/test") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "quota" && args[1] === "rescan") {
        throw new Error("quota rescan should not run in simple mode");
      }
      throw new Error(`unexpected btrfs args: ${args.join(" ")}`);
    });

    jest.doMock("@cocalc/backend/logger", () => ({
      __esModule: true,
      default: () => ({ info, warn, debug, error }),
    }));
    jest.doMock("./util", () => ({
      btrfs: (opts: { args: string[] }) => btrfsMock(opts),
    }));
    jest.doMock("@cocalc/backend/misc/async-utils-node", () => ({
      exists: async () => true,
    }));

    const { queueCreateSubvolumeQgroup, getBtrfsQuotaQueueStatus } =
      await import("./quota-queue");
    await queueCreateSubvolumeQgroup({
      mount: "/mnt/test",
      path: "/mnt/test/project-1",
      wait: true,
    });

    expect(btrfsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["quota", "enable", "--simple", "/mnt/test"],
      }),
    );
    expect(getBtrfsQuotaQueueStatus("/mnt/test")).toEqual({
      enabled: true,
      mode: "simple",
      queued_count: 0,
      running_count: 0,
      failed_count: 0,
      retrying_count: 0,
      oldest_queued_ms: null,
      oldest_failed_ms: null,
    });
  });
});
