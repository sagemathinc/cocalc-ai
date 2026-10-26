import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = jest.fn(() => {
  const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
  child.stderr = new PassThrough();
  process.nextTick(() => child.emit("close", 0, null));
  return child;
});

jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  spawn: (...args: any[]) => spawnMock(...args),
}));

const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
  sudo: async () => ({ stdout: "", stderr: "" }),
}));

import { SubvolumeSnapshots } from "./subvolume-snapshots";
import { setSnapshotPreparer } from "./snapshot-preparer";

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

describe("SubvolumeSnapshots of a project's home", () => {
  let capture: jest.Mock;

  beforeEach(() => {
    btrfsMock.mockClear();
    btrfsMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));
    capture = jest.fn(async () => ({
      addTo: async () => undefined,
      release: async () => undefined,
    }));
    setSnapshotPreparer({ appliesTo: () => true, capture });
  });

  afterEach(() => {
    setSnapshotPreparer(undefined);
  });

  it("takes the files only, read-only, without the edit history (backups have it)", async () => {
    await new SubvolumeSnapshots(createSubvolume() as any).create("snap1");
    expect(capture).not.toHaveBeenCalled();
    expect(btrfsMock.mock.calls.map(([{ args }]) => args)).toEqual([
      [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        `/mnt/test/project-1/${SNAPSHOTS}/snap1`,
      ],
    ]);
  });
});

describe("SubvolumeSnapshots simple-quota snapshot policy", () => {
  beforeEach(() => {
    btrfsMock.mockClear();
    spawnMock.mockClear();
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

  it.each(["../project-2", "nested/name", ".hidden", ""])(
    "rejects unsafe snapshot names before invoking btrfs: %s",
    async (name) => {
      const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
      await expect(snapshots.create(name)).rejects.toThrow(
        /snapshot name|invalid snapshot/,
      );
      await expect(snapshots.delete(name)).rejects.toThrow(
        /snapshot name|invalid snapshot/,
      );
      expect(() => snapshots.path(name)).toThrow(
        /snapshot name|invalid snapshot/,
      );
      expect(btrfsMock).not.toHaveBeenCalled();
    },
  );

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
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "sudo",
      [
        "-n",
        "/usr/local/sbin/cocalc-runtime-storage",
        "sandbox-rm",
        "/mnt/test/project-1",
        ".snapshots/snap1/large/data",
        "--recursive",
        "--force",
      ],
      { cwd: "/", stdio: ["ignore", "ignore", "pipe"] },
    );
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

  it("delegates temporary quota relief to a managed override hook", async () => {
    const subvolume = createSubvolumeWithSnapshots(["snap1"]) as any;
    const withTemporaryQuotaOverride = jest.fn(
      async ({ run }: { run: () => Promise<void> }) => await run(),
    );
    subvolume.filesystem.opts.withTemporaryQuotaOverride =
      withTemporaryQuotaOverride;
    const snapshots = new SubvolumeSnapshots(subvolume);

    await snapshots.delete("snap1");

    expect(withTemporaryQuotaOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        subvolume_name: "project-1",
        operation: "delete-snapshot",
        minimum_bytes: 150,
        current_size: 100,
        current_used: 100,
      }),
    );
    expect(subvolume.quota.set).not.toHaveBeenCalled();
    expect(btrfsMock).toHaveBeenCalledWith({
      args: ["subvolume", "delete", "/mnt/test/project-1/.snapshots/snap1"],
    });
  });

  it("restores project quota when snapshot deletion fails", async () => {
    btrfsMock.mockRejectedValueOnce(new Error("delete failed"));
    const subvolume = createSubvolumeWithSnapshots(["snap1"]) as any;
    const snapshots = new SubvolumeSnapshots(subvolume);

    await expect(snapshots.delete("snap1")).rejects.toThrow("delete failed");
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(1, 150);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(2, 100);
  });

  it("creates a replacement before pruning at a one-snapshot limit", async () => {
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const names = [old];
    const operations: string[] = [];
    snapshots.readdir = jest.fn(async () => [...names]);
    snapshots.hasUnsavedChanges = jest.fn(async () => true);
    snapshots.create = jest.fn(async (name?: string) => {
      operations.push("create");
      names.push(name!);
    });
    snapshots.delete = jest.fn(async (name: string) => {
      operations.push("delete");
      names.splice(names.indexOf(name), 1);
    });

    await snapshots.update({ daily: 1 }, { limit: 1 });

    expect(operations).toEqual(["create", "delete"]);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(old);
    expect(snapshots.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 2 }),
    );
  });

  describe("the snapshot limit and the prune gate", () => {
    const day = 24 * 60 * 60_000;
    // retention (daily: 5) keeps more than the limit (2): only the limit
    // prune deletes
    function atLimit() {
      const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
      const names = [
        new Date(Date.now() - 2 * day).toISOString(),
        new Date(Date.now() - 1 * day).toISOString(),
      ];
      snapshots.readdir = jest.fn(async () => [...names]);
      snapshots.hasUnsavedChanges = jest.fn(async () => true);
      snapshots.create = jest.fn(async (name?: string) => {
        names.push(name!);
      });
      snapshots.delete = jest.fn(async (name: string) => {
        names.splice(names.indexOf(name), 1);
      });
      return { snapshots, names };
    }

    it("asks the gate before freeing the replacement slot, and keeps it when declined", async () => {
      const { snapshots, names } = atLimit();
      const oldest = names[0];
      const beforePrune = jest.fn(() => false);
      const result = await snapshots.update(
        { daily: 5 },
        { limit: 2, beforePrune },
      );
      expect(beforePrune).toHaveBeenCalledWith([oldest]);
      expect(snapshots.delete).not.toHaveBeenCalled();
      // one over the limit, reported as a limit deferral (not rolling)
      expect(names).toHaveLength(3);
      expect(result.limitPruneDeferred).toBe(1);
      expect(result.pruneDeferred).toBeUndefined();
    });

    it("frees the slot when the gate allows it", async () => {
      const { snapshots, names } = atLimit();
      const oldest = names[0];
      const result = await snapshots.update(
        { daily: 5 },
        { limit: 2, beforePrune: () => true },
      );
      expect(snapshots.delete).toHaveBeenCalledWith(oldest);
      expect(names).toHaveLength(2);
      expect(result.limitPruneDeferred).toBeUndefined();
    });

    it("while still busy, the next update neither deletes nor creates; once allowed it makes room and creates", async () => {
      const { snapshots, names } = atLimit();
      let busy = true;
      const beforePrune = jest.fn(() => !busy);
      await snapshots.update({ daily: 5 }, { limit: 2, beforePrune });
      expect(names).toHaveLength(3);
      const afterFirst = [...names];
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 2 * day);
      try {
        const waiting = await snapshots.update(
          { daily: 5 },
          { limit: 2, beforePrune },
        );
        expect(waiting).toMatchObject({
          createDeferred: true,
          createdName: null,
        });
        expect(waiting.limitPruneDeferred).toBe(1);
        expect(names).toEqual(afterFirst);
        expect(snapshots.create).toHaveBeenCalledTimes(1);
        expect(snapshots.delete).not.toHaveBeenCalled();

        busy = false;
        const done = await snapshots.update(
          { daily: 5 },
          { limit: 2, beforePrune },
        );
        expect(done.createDeferred).toBeUndefined();
        expect(done.createdName).not.toBeNull();
        expect(snapshots.create).toHaveBeenCalledTimes(2);
        expect(names).toHaveLength(2);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it("a limit reduction with several victims waits the same way", async () => {
      const { snapshots, names } = atLimit();
      names.push(new Date(Date.now() - 0.5 * day).toISOString());
      const beforePrune = jest.fn(() => false);
      const result = await snapshots.update(
        { daily: 5 },
        { limit: 1, beforePrune },
      );
      expect(beforePrune).toHaveBeenCalledWith(names.slice(0, 2));
      expect(result).toMatchObject({
        createDeferred: true,
        limitPruneDeferred: 2,
      });
      expect(snapshots.delete).not.toHaveBeenCalled();
      expect(snapshots.create).not.toHaveBeenCalled();
    });
  });

  it("preserves the old snapshot when replacement creation fails", async () => {
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    snapshots.readdir = jest.fn(async () => [old]);
    snapshots.hasUnsavedChanges = jest.fn(async () => true);
    snapshots.create = jest.fn(async () => {
      throw new Error("quota blocked");
    });
    snapshots.delete = jest.fn();

    await expect(snapshots.update({ daily: 1 }, { limit: 1 })).rejects.toThrow(
      "quota blocked",
    );
    expect(snapshots.delete).not.toHaveBeenCalled();
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

describe("snapshot usage", () => {
  beforeEach(() => {
    btrfsMock.mockReset();
    require("./qgroup-scan").resetQgroupScansForTest();
  });

  it("reads the filesystem's quotas once for all of a project's snapshots", async () => {
    const names = [
      "2026-10-20T00:00:00.000Z",
      "2026-10-21T00:00:00.000Z",
      "2026-10-22T00:00:00.000Z",
    ];
    const scan = [
      "Qgroupid Referenced Exclusive Max referenced Parent Child Path",
      "-------- ---------- --------- -------------- ------ ----- ----",
      "0/300 1000 900 5000 - - project-1",
      ...names.map(
        (name, i) =>
          `0/${400 + i} ${100 + i} ${10 + i} none - - project-1/${SNAPSHOTS}/${name}`,
      ),
    ].join("\n");
    btrfsMock.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "subvolume" && args[1] === "show") {
        const i = names.findIndex((name) => args[2].endsWith(`/${name}`));
        return { stdout: `Subvolume ID:\t${400 + i}\n`, stderr: "" };
      }
      return { stdout: scan, stderr: "" };
    });
    const snapshots = new SubvolumeSnapshots(
      createSubvolumeWithSnapshots(names) as any,
    );
    await expect(
      Promise.all(names.map(async (name) => await snapshots.usage(name))),
    ).resolves.toEqual(
      names.map((name, i) => ({
        name,
        used: 100 + i,
        exclusive: 10 + i,
        quota: 0,
      })),
    );
    // (one read of the quotas, by each snapshot's id)
    expect(
      btrfsMock.mock.calls.filter(([opts]) => opts.args[0] === "qgroup"),
    ).toEqual([
      [
        {
          verbose: false,
          args: ["qgroup", "show", "-prc", "--raw", "/mnt/test"],
        },
      ],
    ]);
  });
});
