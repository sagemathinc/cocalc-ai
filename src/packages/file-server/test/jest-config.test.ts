describe("file-server jest host-dependent btrfs gating", () => {
  const {
    hasBtrfsFilesystemSupport,
    shouldRunHostDependentBtrfsTests,
    HOST_DEPENDENT_BTRFS_TESTS,
  } = require("../jest.helpers.js");

  const originalSkip = process.env.COCALC_SKIP_BTRFS_TESTS;
  const originalForce = process.env.COCALC_FORCE_BTRFS_TESTS;

  afterEach(() => {
    if (originalSkip == null) {
      delete process.env.COCALC_SKIP_BTRFS_TESTS;
    } else {
      process.env.COCALC_SKIP_BTRFS_TESTS = originalSkip;
    }
    if (originalForce == null) {
      delete process.env.COCALC_FORCE_BTRFS_TESTS;
    } else {
      process.env.COCALC_FORCE_BTRFS_TESTS = originalForce;
    }
  });

  it("detects missing btrfs filesystem support", () => {
    expect(
      hasBtrfsFilesystemSupport({
        platform: "linux",
        readFileSyncImpl: () => "nodev\tsysfs\n",
      }),
    ).toBe(false);
  });

  it("skips host-dependent btrfs tests when linux lacks btrfs support", () => {
    expect(
      shouldRunHostDependentBtrfsTests({
        platform: "linux",
        readdirSyncImpl: () => ["loop0"],
        readFileSyncImpl: () => "nodev\tsysfs\n",
      }),
    ).toBe(false);
  });

  it("allows host-dependent btrfs tests when linux has loopback devices and btrfs support", () => {
    expect(
      shouldRunHostDependentBtrfsTests({
        platform: "linux",
        readdirSyncImpl: () => ["loop0"],
        readFileSyncImpl: () => "nodev\tsysfs\nbtrfs\n",
      }),
    ).toBe(true);
    expect(HOST_DEPENDENT_BTRFS_TESTS).toContain("rustic-progress");
  });

  it("honors explicit skip/force overrides", () => {
    process.env.COCALC_SKIP_BTRFS_TESTS = "1";
    process.env.COCALC_FORCE_BTRFS_TESTS = "1";
    expect(shouldRunHostDependentBtrfsTests({ platform: "linux" })).toBe(false);
    delete process.env.COCALC_SKIP_BTRFS_TESTS;
    expect(shouldRunHostDependentBtrfsTests({ platform: "darwin" })).toBe(true);
  });
});
