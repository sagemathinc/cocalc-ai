describe("btrfs simple-quota queue", () => {
  const originalSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;
  const originalDisableQuotas = process.env.COCALC_DISABLE_BTRFS_QUOTAS;
  const originalQuotaMode = process.env.COCALC_BTRFS_QUOTA_MODE;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    delete process.env.COCALC_BTRFS_QUOTA_MODE;
  });

  afterAll(() => {
    if (originalSqlite == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = originalSqlite;
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

  it("sets a simple-mode subvolume limit directly on the path", async () => {
    process.env.COCALC_BTRFS_QUOTA_MODE = "simple";

    const info = jest.fn();
    const warn = jest.fn();
    const debug = jest.fn();
    const error = jest.fn();
    const readFileMock = jest.fn(async (path: string) => {
      if (path.endsWith("/enabled")) {
        return "1\n";
      }
      if (path.endsWith("/mode")) {
        return "simple\n";
      }
      throw new Error(`unexpected readFile path: ${path}`);
    });
    const btrfsMock = jest.fn(async ({ args }: { args: string[] }) => {
      if (args.join(" ") === "filesystem show /mnt/test") {
        return {
          exit_code: 0,
          stdout: "Label: none  uuid: 11111111-2222-4333-8444-555555555555\n",
          stderr: "",
        };
      }
      if (args.join(" ") === "qgroup limit 10M /mnt/test/project-1") {
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
    jest.doMock("node:fs/promises", () => ({
      readFile: (path: string, encoding: string) =>
        readFileMock(path, encoding),
    }));
    jest.doMock("@cocalc/backend/misc/async-utils-node", () => ({
      exists: async () => true,
    }));

    const { queueSetSubvolumeQuota, getBtrfsQuotaQueueStatus } =
      await import("./quota-queue");
    await queueSetSubvolumeQuota({
      mount: "/mnt/test",
      path: "/mnt/test/project-1",
      size: "10M",
      wait: true,
    });

    expect(btrfsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["qgroup", "limit", "10M", "/mnt/test/project-1"],
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

  it("treats the old qgroup mode env as simple quotas", async () => {
    process.env.COCALC_BTRFS_QUOTA_MODE = "qgroup";
    const { btrfsQuotaMode } = await import("./config");
    expect(btrfsQuotaMode()).toBe("simple");
  });
});
