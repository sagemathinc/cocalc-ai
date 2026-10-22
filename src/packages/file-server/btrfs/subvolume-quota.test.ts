const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));
const queueSetSubvolumeQuotaMock = jest.fn(async (_opts?: any) => undefined);

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
}));

jest.mock("./quota-queue", () => ({
  queueSetSubvolumeQuota: (opts: any) => queueSetSubvolumeQuotaMock(opts),
}));

import { SubvolumeQuota } from "./subvolume-quota";
import { clearBtrfsOperationCachesForTest } from "./operation-cache";

describe("SubvolumeQuota kill switch", () => {
  const previousEnv = process.env.COCALC_DISABLE_BTRFS_QUOTAS;

  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
    btrfsMock.mockClear();
    queueSetSubvolumeQuotaMock.mockClear();
    process.env.COCALC_DISABLE_BTRFS_QUOTAS = "1";
  });

  afterAll(() => {
    if (previousEnv == null) {
      delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_QUOTAS = previousEnv;
    }
  });

  function createQuota() {
    return new SubvolumeQuota({
      path: "/mnt/test/project-1",
      filesystem: {
        opts: {
          mount: "/mnt/test",
        },
      },
    } as any);
  }

  it("returns a disabled warning and skips qgroup operations", async () => {
    const quota = createQuota();

    await expect(quota.get()).resolves.toEqual({
      size: 0,
      used: 0,
      warning:
        "Btrfs quota operations are disabled by configuration on this host.",
    });

    await quota.set("10M");

    expect(queueSetSubvolumeQuotaMock).not.toHaveBeenCalled();
    expect(btrfsMock).not.toHaveBeenCalled();
  });

  it("ignores even zero or missing quota writes when disabled", async () => {
    const quota = createQuota();

    await expect(quota.set(0 as any)).resolves.toBeUndefined();
    await expect(quota.set(undefined as any)).resolves.toBeUndefined();

    expect(queueSetSubvolumeQuotaMock).not.toHaveBeenCalled();
    expect(btrfsMock).not.toHaveBeenCalled();
  });
});

describe("SubvolumeQuota.get", () => {
  const previousEnv = process.env.COCALC_DISABLE_BTRFS_QUOTAS;

  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
    btrfsMock.mockClear();
    queueSetSubvolumeQuotaMock.mockClear();
    delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
  });

  afterAll(() => {
    if (previousEnv == null) {
      delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    } else {
      process.env.COCALC_DISABLE_BTRFS_QUOTAS = previousEnv;
    }
  });

  // what `btrfs qgroup show -prc --raw <mount>` prints
  const SCAN = `
Qgroupid Referenced Exclusive Max referenced Parent Child Path
-------- ---------- --------- -------------- ------ ----- ----
0/5      16384      16384     none           -      -     <toplevel>
0/123    456        456       1000           -      -     project-1
0/124    789        789       2000           -      -     project-2
0/125    1          1         none           -      -     project-3
`;

  function quotaFor(n: number) {
    return new SubvolumeQuota({
      path: `/mnt/test/project-${n}`,
      getSubvolumeId: async () => 122 + n,
      filesystem: { opts: { mount: "/mnt/test" } },
    } as any);
  }

  it("warns when btrfs reports no enforced limit", async () => {
    btrfsMock.mockResolvedValueOnce({ stdout: SCAN, stderr: "" });
    await expect(quotaFor(3).get()).resolves.toEqual({
      size: 0,
      used: 1,
      qgroupid: "0/125",
      scope: "subvolume",
      warning: "No btrfs quota limit is currently enforced on this subvolume.",
    });
  });

  it("reads the filesystem's quotas once for all its subvolumes", async () => {
    btrfsMock.mockResolvedValue({ stdout: SCAN, stderr: "" });
    await expect(
      Promise.all([quotaFor(1).get(), quotaFor(2).get()]),
    ).resolves.toEqual([
      { size: 1000, used: 456, qgroupid: "0/123", scope: "subvolume" },
      { size: 2000, used: 789, qgroupid: "0/124", scope: "subvolume" },
    ]);
    // and again, later
    await quotaFor(1).get();
    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledWith({
      verbose: false,
      args: ["qgroup", "show", "-prc", "--raw", "/mnt/test"],
    });
  });

  it("passes on what btrfs says about its accounting", async () => {
    btrfsMock.mockResolvedValueOnce({
      stdout: SCAN,
      stderr: "WARNING: qgroup data inconsistent, rescan recommended",
    });
    expect((await quotaFor(1).get()).warning).toMatch(/inconsistent/);
  });
});
