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

describe("rolling btrfs snapshot retention", () => {
  const previousEnv = process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-04-22T12:00:00.000Z");

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    jest.spyOn(Date, "now").mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousEnv == null) {
      delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS = previousEnv;
    }
  });

  function snapshotAtAgeDays(days: number): string {
    return new Date(now - days * day).toISOString();
  }

  it("keeps older snapshots long enough to become weekly/monthly entries", async () => {
    const { snapshotsToDelete } = await import("./snapshots");
    const snapshots = Array.from({ length: 9 }, (_, days) =>
      snapshotAtAgeDays(days),
    );

    const toDelete = snapshotsToDelete({
      now,
      snapshots,
      counts: {
        frequent: 0,
        daily: 5,
        weekly: 3,
        monthly: 0,
      },
    });

    expect(toDelete).not.toContain(snapshotAtAgeDays(6));
    expect(toDelete).not.toContain(snapshotAtAgeDays(8));
    expect(toDelete).toContain(snapshotAtAgeDays(5));
  });

  it("deletes stale temp-rustic btrfs snapshots left by failed backups", async () => {
    const { TEMP_RUSTIC_SNAPSHOT_PREFIX, updateRollingSnapshots } =
      await import("./snapshots");
    const stale = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 25 * 60 * 60 * 1000).toString(36)}-stale`;
    const fresh = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 60 * 1000).toString(36)}-fresh`;
    const snapshots = {
      subvolume: { name: "project-1" },
      hasUnsavedChanges: jest.fn(async () => false),
      readdir: jest.fn(async () => [stale, fresh, "manual"]),
      create: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };

    await updateRollingSnapshots({
      snapshots: snapshots as any,
      counts: {
        frequent: 0,
        daily: 0,
        weekly: 0,
        monthly: 0,
      },
    });

    expect(snapshots.delete).toHaveBeenCalledTimes(1);
    expect(snapshots.delete).toHaveBeenCalledWith(stale);
  });
});
