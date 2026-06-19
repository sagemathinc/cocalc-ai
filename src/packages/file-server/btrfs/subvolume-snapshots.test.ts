import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
}));

import { SubvolumeSnapshots } from "./subvolume-snapshots";

function createSubvolume() {
  return {
    name: "project-1",
    path: "/mnt/test/project-1",
    filesystem: {
      opts: {
        mount: "/mnt/test",
      },
    },
    fs: {
      exists: jest.fn(async (value: string) => value === SNAPSHOTS),
      mkdir: jest.fn(async () => undefined),
      chmod: jest.fn(async () => undefined),
      readdir: jest.fn(async () => []),
    },
    quota: {
      get: jest.fn(async () => ({ size: 100, used: 100 })),
      set: jest.fn(async () => undefined),
    },
  };
}

function createSubvolumeWithSnapshots(snapshotNames: string[]) {
  const existing = new Set<string>([
    SNAPSHOTS,
    ...snapshotNames.map((name) => `${SNAPSHOTS}/${name}`),
  ]);
  return {
    ...createSubvolume(),
    fs: {
      exists: jest.fn(async (value: string) => existing.has(value)),
      mkdir: jest.fn(async () => undefined),
      chmod: jest.fn(async () => undefined),
      readdir: jest.fn(async () => snapshotNames),
    },
  };
}

describe("SubvolumeSnapshots simple-quota snapshot policy", () => {
  beforeEach(() => {
    btrfsMock.mockClear();
    process.env.COCALC_BTRFS_SNAPSHOT_CLEANUP_QUOTA_RELIEF_BYTES = "50";
  });

  afterEach(() => {
    delete process.env.COCALC_BTRFS_SNAPSHOT_CLEANUP_QUOTA_RELIEF_BYTES;
  });

  it("creates snapshots without any tracking-qgroup follow-up work", async () => {
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    await snapshots.create("snap1", { quotaMode: "async" });

    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        "/mnt/test/project-1/.snapshots/snap1",
      ],
    });
  });

  it("still does no extra quota work for sync quotaMode", async () => {
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    await snapshots.create("snap2", { quotaMode: "sync" });

    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        "/mnt/test/project-1/.snapshots/snap2",
      ],
    });
  });

  it("temporarily makes snapshots writable while pruning a path", async () => {
    const subvolume = createSubvolumeWithSnapshots(["snap1", "snap2"]) as any;
    const snapshots = new SubvolumeSnapshots(subvolume);
    await expect(
      snapshots.prunePath({
        path: "large/data",
        snapshots: ["snap1", "snap2"],
      }),
    ).resolves.toEqual({
      path: "large/data",
      snapshots: ["snap1", "snap2"],
    });

    expect(subvolume.quota.set).toHaveBeenNthCalledWith(1, 150);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(2, 100);
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "property",
        "set",
        "-ts",
        "/mnt/test/project-1/.snapshots/snap1",
        "ro",
        "false",
      ],
    });
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "property",
        "set",
        "-ts",
        "/mnt/test/project-1/.snapshots/snap1",
        "ro",
        "true",
      ],
    });
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "property",
        "set",
        "-ts",
        "/mnt/test/project-1/.snapshots/snap2",
        "ro",
        "false",
      ],
    });
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "property",
        "set",
        "-ts",
        "/mnt/test/project-1/.snapshots/snap2",
        "ro",
        "true",
      ],
    });
  });

  it("temporarily raises project quota while deleting a snapshot", async () => {
    const subvolume = createSubvolumeWithSnapshots(["snap1"]) as any;
    const snapshots = new SubvolumeSnapshots(subvolume);
    await snapshots.delete("snap1");

    expect(subvolume.quota.set).toHaveBeenNthCalledWith(1, 150);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(2, 100);
    expect(btrfsMock).toHaveBeenCalledWith({
      args: ["subvolume", "delete", "/mnt/test/project-1/.snapshots/snap1"],
    });

    const raiseOrder = subvolume.quota.set.mock.invocationCallOrder[0];
    const deleteOrder = btrfsMock.mock.invocationCallOrder[0];
    const restoreOrder = subvolume.quota.set.mock.invocationCallOrder[1];
    expect(raiseOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(restoreOrder);
  });

  it("restores project quota when snapshot deletion fails", async () => {
    btrfsMock.mockRejectedValueOnce(new Error("delete failed"));
    const subvolume = createSubvolumeWithSnapshots(["snap1"]) as any;
    const snapshots = new SubvolumeSnapshots(subvolume);

    await expect(snapshots.delete("snap1")).rejects.toThrow("delete failed");
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(1, 150);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(2, 100);
  });

  it("rejects pruning the snapshots directory", async () => {
    const snapshots = new SubvolumeSnapshots(
      createSubvolumeWithSnapshots(["snap1"]) as any,
    );
    await expect(
      snapshots.prunePath({ path: ".snapshots/snap1/file.txt" }),
    ).rejects.toThrow("cannot prune the snapshots directory from snapshots");
  });
});
