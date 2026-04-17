describe("rolling btrfs snapshots kill switch", () => {
  const previousEnv = process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS = "1";
  });

  afterAll(() => {
    if (previousEnv == null) {
      delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS = previousEnv;
    }
  });

  it("skips automatic rolling snapshot work when disabled", async () => {
    const snapshots = {
      subvolume: { name: "project-1" },
      hasUnsavedChanges: jest.fn(async () => true),
      readdir: jest.fn(async () => ["2026-01-01T00:00:00.000Z"]),
      create: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };

    const { updateRollingSnapshots } = await import("./snapshots");
    await updateRollingSnapshots({ snapshots: snapshots as any });

    expect(snapshots.hasUnsavedChanges).not.toHaveBeenCalled();
    expect(snapshots.readdir).not.toHaveBeenCalled();
    expect(snapshots.create).not.toHaveBeenCalled();
    expect(snapshots.delete).not.toHaveBeenCalled();
  });
});
