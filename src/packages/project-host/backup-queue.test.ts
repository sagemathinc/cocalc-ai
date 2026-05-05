export {};

jest.mock("./backup-execution-limit", () => ({
  getBackupExecutionLimit: jest.fn(async () => ({
    max_parallel: 1,
    config_source: "env-legacy",
  })),
  getCachedBackupExecutionLimit: jest.fn(() => ({
    max_parallel: 1,
    config_source: "env-legacy",
  })),
}));

async function flushEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("backup queue", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("queues same-project backup work by default", async () => {
    const { resetBackupQueueForTest, withBackupParallelLimit } =
      await import("./backup-queue");

    resetBackupQueueForTest();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = withBackupParallelLimit({
      project_id: "project-1",
      op: "first",
      run: async () => {
        order.push("first:start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first:end");
        return "first";
      },
    });

    await flushEventLoop();

    const second = withBackupParallelLimit({
      project_id: "project-1",
      op: "second",
      run: async () => {
        order.push("second:start");
        return "second";
      },
    });

    await flushEventLoop();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("skips same-project maintenance when backup work is already queued", async () => {
    const { resetBackupQueueForTest, withBackupParallelLimit } =
      await import("./backup-queue");

    resetBackupQueueForTest();
    let releaseFirst: (() => void) | undefined;

    const first = withBackupParallelLimit({
      project_id: "project-1",
      op: "createBackup",
      run: async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    });

    await flushEventLoop();

    await expect(
      withBackupParallelLimit({
        project_id: "project-1",
        op: "runScheduledBackupMaintenance",
        queue_if_busy: false,
        run: async () => "unexpected",
      }),
    ).resolves.toBeUndefined();

    releaseFirst?.();
    await first;
  });
});
