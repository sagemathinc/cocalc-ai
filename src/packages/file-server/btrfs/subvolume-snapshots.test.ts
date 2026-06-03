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
    const snapshots = new SubvolumeSnapshots(
      createSubvolumeWithSnapshots(["snap1", "snap2"]) as any,
    );
    await expect(
      snapshots.prunePath({
        path: "large/data",
        snapshots: ["snap1", "snap2"],
      }),
    ).resolves.toEqual({
      path: "large/data",
      snapshots: ["snap1", "snap2"],
    });

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

  it("rejects pruning the snapshots directory", async () => {
    const snapshots = new SubvolumeSnapshots(
      createSubvolumeWithSnapshots(["snap1"]) as any,
    );
    await expect(
      snapshots.prunePath({ path: ".snapshots/snap1/file.txt" }),
    ).rejects.toThrow("cannot prune the snapshots directory from snapshots");
  });
});
