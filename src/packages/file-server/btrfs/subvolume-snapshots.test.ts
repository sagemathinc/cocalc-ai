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
}));

import {
  QuotaReliefUnavailableError,
  SubvolumeSnapshots,
  withSubvolumeQuotaRelief,
} from "./subvolume-snapshots";

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
      stat: jest.fn(async () => ({ mode: 0o40700 })),
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
      stat: jest.fn(async () => ({ mode: 0o40700 })),
      readdir: jest.fn(async () => snapshotNames),
    },
  };
}

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

  // On prod, scheduled snapshots of projects at their quota failed with
  // "Disk quota exceeded" on every attempt (68 in a row for one project).
  const quotaError = (path = "/mnt/test/project-1/.snapshots/snap1") =>
    new Error(
      `command 'sudo' (args=-n /usr/local/sbin/cocalc-runtime-storage btrfs subvolume snapshot -r /mnt/test/project-1 ${path}) exited with nonzero code 1 -- stderr='ERROR: cannot snapshot '/mnt/test/project-1': Disk quota exceeded\n'`,
    );
  const relief = (subvolume: any) =>
    jest.fn(
      async <T>(run: () => Promise<T>) =>
        await withSubvolumeQuotaRelief({
          subvolume,
          operation: "test",
          run,
          reliefBytes: 7,
        }),
    );

  it("retries a snapshot at the quota once inside the caller's quota relief", async () => {
    btrfsMock.mockRejectedValueOnce(quotaError());
    const subvolume = createSubvolume() as any;
    const quotaRelief = relief(subvolume);
    const snapshots = new SubvolumeSnapshots(subvolume);

    await snapshots.create("snap1", { quotaRelief });

    expect(quotaRelief).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledTimes(2);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(1, 107);
    expect(subvolume.quota.set).toHaveBeenNthCalledWith(2, 100);
    const raiseOrder = subvolume.quota.set.mock.invocationCallOrder[0];
    const retryOrder = btrfsMock.mock.invocationCallOrder[1];
    const restoreOrder = subvolume.quota.set.mock.invocationCallOrder[1];
    expect(raiseOrder).toBeLessThan(retryOrder);
    expect(retryOrder).toBeLessThan(restoreOrder);
  });

  it("never raises the quota without a quota relief from the caller", async () => {
    btrfsMock.mockRejectedValueOnce(quotaError());
    const subvolume = createSubvolume() as any;
    const snapshots = new SubvolumeSnapshots(subvolume);

    await expect(snapshots.create("snap1")).rejects.toThrow(
      "Disk quota exceeded",
    );
    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(subvolume.quota.set).not.toHaveBeenCalled();
  });

  it("reports the quota error when the caller cannot give relief now", async () => {
    btrfsMock.mockRejectedValueOnce(quotaError());
    const snapshots = new SubvolumeSnapshots(createSubvolume() as any);
    const quotaRelief = jest.fn(async () => {
      throw new QuotaReliefUnavailableError("project is running");
    });

    await expect(
      snapshots.create("snap1", { quotaRelief: quotaRelief as any }),
    ).rejects.toThrow("Disk quota exceeded");
    expect(btrfsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another error", new Error("Permission denied")],
    [
      "a snapshot name that mentions the quota",
      new Error(
        "command 'sudo' (args=-n btrfs subvolume snapshot -r /mnt/test/project-1 /mnt/test/project-1/.snapshots/edquot-disk-quota-exceeded) exited with nonzero code 1 -- stderr='ERROR: target path already exists'",
      ),
    ],
  ])("does not retry or touch the quota for %s", async (_label, error) => {
    btrfsMock.mockRejectedValueOnce(error);
    const subvolume = createSubvolume() as any;
    const quotaRelief = relief(subvolume);
    const snapshots = new SubvolumeSnapshots(subvolume);

    await expect(snapshots.create("snap1", { quotaRelief })).rejects.toThrow(
      error.message,
    );
    expect(quotaRelief).not.toHaveBeenCalled();
    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(subvolume.quota.get).not.toHaveBeenCalled();
  });

  it("creates and restricts the snapshots directory with relief when needed", async () => {
    const subvolume = createSubvolume() as any;
    const quotaRelief = relief(subvolume);
    let created = false;
    subvolume.fs.exists = jest.fn(async () => created);
    subvolume.fs.mkdir = jest.fn(async () => {
      created = true;
    });
    subvolume.fs.stat = jest.fn(async () => ({ mode: 0o40755 }));
    // mkdir succeeded, then restricting it hit the quota.
    subvolume.fs.chmod = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("EDQUOT: disk quota exceeded, chmod"), {
          code: "EDQUOT",
        }),
      )
      .mockResolvedValue(undefined);
    const snapshots = new SubvolumeSnapshots(subvolume);

    await snapshots.create("snap1", { quotaRelief });

    expect(subvolume.fs.mkdir).toHaveBeenCalledTimes(1);
    expect(subvolume.fs.chmod).toHaveBeenCalledTimes(2);
    expect(subvolume.fs.chmod).toHaveBeenLastCalledWith(".snapshots", "0700");
    expect(quotaRelief).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledTimes(1);
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
