const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));
const queueSetSubvolumeQuotaMock = jest.fn(async (_opts?: any) => undefined);

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
}));

jest.mock("./quota-queue", () => ({
  queueSetSubvolumeQuota: (opts: any) => queueSetSubvolumeQuotaMock(opts),
}));

import { SubvolumeQuota } from "./subvolume-quota";

describe("SubvolumeQuota kill switch", () => {
  const previousEnv = process.env.COCALC_DISABLE_BTRFS_QUOTAS;

  beforeEach(() => {
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
