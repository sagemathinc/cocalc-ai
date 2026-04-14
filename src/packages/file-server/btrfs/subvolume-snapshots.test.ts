import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));
const queueAssignSnapshotQgroupMock = jest.fn(async (_opts?: any) => undefined);

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
}));

jest.mock("./quota-queue", () => ({
  queueAssignSnapshotQgroup: (opts: any) => queueAssignSnapshotQgroupMock(opts),
}));

import { SubvolumeSnapshots } from "./subvolume-snapshots";

const SNAPSHOT_QGROUP_ASSIGN_ENV = "COCALC_BTRFS_ENABLE_SNAPSHOT_QGROUP_ASSIGN";

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

describe("SubvolumeSnapshots qgroup assignment policy", () => {
  const previousEnv = process.env[SNAPSHOT_QGROUP_ASSIGN_ENV];

  beforeEach(() => {
    btrfsMock.mockClear();
    queueAssignSnapshotQgroupMock.mockClear();
    delete process.env[SNAPSHOT_QGROUP_ASSIGN_ENV];
  });

  afterAll(() => {
    if (previousEnv == null) {
      delete process.env[SNAPSHOT_QGROUP_ASSIGN_ENV];
    } else {
      process.env[SNAPSHOT_QGROUP_ASSIGN_ENV] = previousEnv;
    }
  });

  it("skips snapshot qgroup assignment by default", async () => {
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    await snapshots.create("snap1", { quotaMode: "async" });

    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        "/mnt/test/project-1/.snapshots/snap1",
      ],
    });
    expect(queueAssignSnapshotQgroupMock).not.toHaveBeenCalled();
  });

  it("assigns snapshot qgroups when explicitly enabled", async () => {
    process.env[SNAPSHOT_QGROUP_ASSIGN_ENV] = "1";
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    await snapshots.create("snap2", { quotaMode: "sync" });

    expect(queueAssignSnapshotQgroupMock).toHaveBeenCalledWith({
      mount: "/mnt/test",
      snapshotPath: "/mnt/test/project-1/.snapshots/snap2",
      subvolumePath: "/mnt/test/project-1",
      wait: true,
    });
  });
});
