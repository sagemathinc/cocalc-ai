let btrfsMock: jest.Mock;
let sudoMock: jest.Mock;
let sandboxedFilesystemMock: jest.Mock;
let backupFsRusticMock: jest.Mock;
let rusticHostMock: jest.Mock;
let readdirMock: jest.Mock;

jest.mock("node:fs/promises", () => ({
  readdir: (...args: any[]) => readdirMock(...args),
}));

jest.mock("./util", () => ({
  btrfs: (...args: any[]) => btrfsMock(...args),
  sudo: (...args: any[]) => sudoMock(...args),
}));

jest.mock("@cocalc/backend/sandbox", () => ({
  SandboxedFilesystem: function (...args: any[]) {
    return sandboxedFilesystemMock(...args);
  },
}));

jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: (...args: any[]) => rusticHostMock(...args),
}));

import {
  parseRusticSnapshotsOutput,
  SubvolumeRustic,
} from "./subvolume-rustic";
import {
  clearBtrfsOperationCachesForTest,
  configureBtrfsBackgroundMutationGuard,
  withBtrfsMutationContext,
} from "./operation-cache";
import { TEMP_RUSTIC_SNAPSHOT_PREFIX } from "./snapshots";

describe("parseRusticSnapshotsOutput", () => {
  it("parses grouped rustic snapshot JSON", () => {
    expect(
      parseRusticSnapshotsOutput({
        stdout: JSON.stringify([
          {
            group_key: { hostname: "project-1" },
            snapshots: [
              {
                id: "snap-old",
                time: "2026-04-30T20:00:00.000Z",
                summary: { files_new: 1 },
              },
              {
                id: "snap-new",
                time: "2026-04-30T21:00:00.000Z",
                summary: { files_new: 2 },
              },
            ],
          },
        ]),
        host: "project-1",
      }),
    ).toEqual([
      {
        id: "snap-old",
        time: new Date("2026-04-30T20:00:00.000Z"),
        summary: { files_new: 1 },
        tags: [],
      },
      {
        id: "snap-new",
        time: new Date("2026-04-30T21:00:00.000Z"),
        summary: { files_new: 2 },
        tags: [],
      },
    ]);
  });

  it("throws a descriptive error for truncated output", () => {
    expect(() =>
      parseRusticSnapshotsOutput({
        stdout: '[{"group_key":',
        truncated: true,
        host: "project-1",
      }),
    ).toThrow(
      "rustic snapshots output truncated while listing backups for project-1",
    );
  });
});

describe("fresh snapshot inventory after concurrent retention", () => {
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const now = new Date("2026-09-28T09:25:00.000Z");
  const oldEnv = process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;

  const output = (
    stdout: string,
    stderr = "",
    code = 0,
    truncated = false,
  ) => ({
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
    truncated,
  });
  const inventory = (ids: string[]) =>
    output(
      JSON.stringify([
        {
          snapshots: ids.map((id) => ({
            id,
            time: id === oldId ? "2026-09-20T00:00:00.000Z" : now.toISOString(),
            tags: ["cocalc-automatic"],
            summary: {},
          })),
        },
      ]),
    );
  const missing = (path = `snapshots/${oldId}`, code = "NoSuchKey") =>
    output(
      "[]",
      `[WARN] service=s3 name=test path=${path}: read failed NotFound (persistent) at read, context: { service: s3, path: ${path} } => S3Error { code: "${code}", message: "The specified key does not exist." }\n` +
        "error: `rustic_core` experienced an error related to `the backend`.\n" +
        `Reading file \`${path}\` failed in the backend. Please check if the given path is correct.\n`,
      1,
    );
  const volume = () =>
    new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

  beforeEach(() => {
    jest.useFakeTimers({ now });
    rusticHostMock = jest.fn();
    delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (oldEnv == null)
      delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    else process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS = oldEnv;
  });

  it("restarts the inventory command and caches only a complete successful read", async () => {
    rusticHostMock
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(inventory([newId]));
    const rustic = volume();
    const result = expect(rustic.snapshots()).resolves.toEqual([
      expect.objectContaining({ id: newId }),
    ]);
    await Promise.all([result, jest.runAllTimersAsync()]);

    await expect(rustic.snapshots()).resolves.toHaveLength(1);
    expect(rusticHostMock).toHaveBeenCalledTimes(3);
    for (const [args, opts] of rusticHostMock.mock.calls) {
      expect(args).toEqual(["snapshots", "--json"]);
      expect(opts.host).toBe("project-1");
    }
    expect(Date.now() - now.valueOf()).toBe(1250);
  });

  it("fails after two retries rather than treating an unreadable inventory as empty", async () => {
    rusticHostMock.mockResolvedValue(missing());
    const rustic = volume();
    const result = expect(rustic.snapshots()).rejects.toThrow("NoSuchKey");
    await Promise.all([result, jest.runAllTimersAsync()]);
    expect(rusticHostMock).toHaveBeenCalledTimes(3);
    rusticHostMock.mockResolvedValue(inventory([newId]));
    await expect(rustic.snapshots()).resolves.toHaveLength(1);
    expect(rusticHostMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing index", missing(`index/${oldId}`)],
    ["missing pack", missing(`data/aa/${oldId}`)],
    ["authentication", missing(`snapshots/${oldId}`, "AccessDenied")],
    [
      "unspecified missing key",
      output("[]", 'S3Error { code: "NoSuchKey" }', 1),
    ],
    ["short object id", missing("snapshots/abcdef")],
    [
      "different object in the final error",
      {
        ...missing(),
        stderr: Buffer.from(
          missing()
            .stderr.toString()
            .replace(
              "Reading file `snapshots/" + oldId,
              "Reading file `snapshots/" + newId,
            ),
        ),
      },
    ],
    ["truncated failure", { ...missing(), truncated: true }],
    ["malformed JSON", output("not json")],
    ["truncated JSON", output("[]", "", 0, true)],
  ])("does not retry %s", async (_name, failure) => {
    rusticHostMock
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(inventory([newId]));
    await expect(volume().snapshots()).rejects.toThrow();
    expect(rusticHostMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately if a retry encounters a different failure", async () => {
    rusticHostMock
      .mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(output("[]", "AccessDenied", 1))
      .mockResolvedValue(inventory([newId]));
    const result = expect(volume().snapshots()).rejects.toThrow("AccessDenied");
    await Promise.all([result, jest.runAllTimersAsync()]);
    expect(rusticHostMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an older cached inventory when checking archive safety", async () => {
    rusticHostMock
      .mockResolvedValueOnce(inventory([oldId]))
      .mockResolvedValue(missing());
    const rustic = volume();
    await rustic.snapshots();
    const result = expect(rustic.snapshotExists({ id: oldId })).rejects.toThrow(
      "NoSuchKey",
    );
    await Promise.all([result, jest.runAllTimersAsync()]);
    expect(rusticHostMock).toHaveBeenCalledTimes(4);
  });

  it("checks existence against the successful retry, including an empty inventory", async () => {
    rusticHostMock
      .mockResolvedValueOnce(missing())
      .mockResolvedValue(inventory([]));
    const result = expect(volume().snapshotExists({ id: oldId })).resolves.toBe(
      false,
    );
    await Promise.all([result, jest.runAllTimersAsync()]);
    expect(rusticHostMock).toHaveBeenCalledTimes(2);
  });

  it("keeps retries within the original inventory timeout", async () => {
    rusticHostMock
      .mockImplementationOnce(async () => {
        jest.setSystemTime(now.valueOf() + 59000);
        return missing();
      })
      .mockResolvedValue(missing());
    const result = expect(volume().snapshots()).rejects.toThrow("NoSuchKey");
    await Promise.all([result, jest.runAllTimersAsync()]);
    expect(rusticHostMock).toHaveBeenCalledTimes(2);
    expect(rusticHostMock.mock.calls[0][1].timeout).toBe(60000);
    expect(rusticHostMock.mock.calls[1][1].timeout).toBe(750);
  });

  it.each([
    ["completes", 2],
    ["fails closed", Infinity],
  ])(
    "%s retention after forgetting an old backup without repeating mutations",
    async (_name, failures) => {
      const ids = [oldId];
      let missingReads = 0;
      const afterCreate = jest.fn();
      rusticHostMock.mockImplementation(async ([command, id]) => {
        if (command === "forget") {
          expect(afterCreate).toHaveBeenCalledTimes(1);
          expect(id).toBe(oldId);
          ids.splice(ids.indexOf(id), 1);
          missingReads = failures;
          return output("");
        }
        expect(command).toBe("snapshots");
        if (missingReads-- > 0) return missing();
        return inventory(ids);
      });
      const rustic = volume();
      const backup = jest
        .spyOn(rustic, "backup")
        .mockImplementation(async () => {
          ids.push(newId);
          return {
            id: newId,
            time: now,
            tags: ["cocalc-automatic"],
            summary: {},
            snapshotGeneration: 1,
          };
        });
      const update = rustic.update(
        { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
        { limit: 1, afterCreate },
      );
      const result = Number.isFinite(failures)
        ? expect(update).resolves.toBeUndefined()
        : expect(update).rejects.toThrow("NoSuchKey");
      await Promise.all([result, jest.runAllTimersAsync()]);
      expect(ids).toEqual([newId]);
      expect(backup).toHaveBeenCalledTimes(1);
      expect(
        rusticHostMock.mock.calls.filter(([args]) => args[0] === "forget"),
      ).toHaveLength(1);
    },
  );
});

describe("scheduled backup replacement", () => {
  const oldEnv = process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;

  afterEach(() => {
    jest.restoreAllMocks();
    if (oldEnv == null)
      delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    else process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS = oldEnv;
  });

  function volume() {
    delete process.env.COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS;
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);
    const snapshots: any[] = [
      {
        id: "old",
        time: new Date("2026-09-20T00:00:00.000Z"),
        tags: [],
        summary: {},
      },
    ];
    (rustic as any).snapshots = jest.fn(async () => snapshots);
    (rustic as any).listSnapshotsFresh = jest.fn(async () => snapshots);
    (rustic as any).snapshotExists = jest.fn(async ({ id }) =>
      snapshots.some((item) => item.id === id),
    );
    (rustic as any).forget = jest.fn(async ({ id }) => {
      const index = snapshots.findIndex((item) => item.id === id);
      if (index >= 0) snapshots.splice(index, 1);
    });
    return { rustic, snapshots };
  }

  it("confirms a new backup before removing the old copy at limit one", async () => {
    const { rustic, snapshots } = volume();
    const backup = jest.fn(async ({ limit, tags }) => {
      expect(limit).toBe(2);
      expect(tags).toEqual(["cocalc-automatic"]);
      expect(snapshots.map((item) => item.id)).toEqual(["old"]);
      const created = {
        id: "new",
        time: new Date("2026-09-23T00:00:00.000Z"),
        tags,
        summary: {},
        snapshotGeneration: 1,
      };
      snapshots.push(created);
      return created;
    });
    (rustic as any).backup = backup;
    await rustic.update(
      { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
      { limit: 1 },
    );
    expect(snapshots.map((item) => item.id)).toEqual(["new"]);
  });

  it("passes a scheduled backup's runner through to the backup", async () => {
    const { rustic, snapshots } = volume();
    const runner = jest.fn();
    const backup = jest.fn(async (opts) => {
      expect(opts.runner).toBe(runner);
      const created = {
        id: "new",
        time: new Date("2026-09-23T00:00:00.000Z"),
        tags: opts.tags,
        summary: {},
        snapshotGeneration: 1,
      };
      snapshots.push(created);
      return created;
    });
    (rustic as any).backup = backup;
    await rustic.update(
      { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
      { limit: 1, runner },
    );
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it("uses the normal limit when no replacement slot is needed", async () => {
    const { rustic, snapshots } = volume();
    snapshots.pop();
    (rustic as any).backup = jest.fn(async ({ limit, tags }) => {
      expect(limit).toBe(1);
      const created = {
        id: "first",
        time: new Date(),
        tags,
        summary: {},
        snapshotGeneration: 1,
      };
      snapshots.push(created);
      return created;
    });
    await rustic.update(
      { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
      { limit: 1 },
    );
    expect(snapshots.map((item) => item.id)).toEqual(["first"]);
  });

  it("retains the old copy when uploading the replacement fails", async () => {
    const { rustic, snapshots } = volume();
    (rustic as any).backup = jest.fn(async () => {
      throw new Error("upload failed");
    });
    await expect(
      rustic.update(
        { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
        { limit: 1 },
      ),
    ).rejects.toThrow("upload failed");
    expect(snapshots.map((item) => item.id)).toEqual(["old"]);
  });

  it("reports repository capacity blocking replacement and preserves the old copy", async () => {
    const { rustic, snapshots } = volume();
    (rustic as any).backup = jest.fn(async () => {
      throw new Error("rustic s3 repository: QuotaExceeded");
    });
    await expect(
      rustic.update(
        { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ message: "replacement_capacity_blocked" });
    expect(snapshots.map((item) => item.id)).toEqual(["old"]);
  });

  it("rejects a replacement if repository inventory changes before upload", async () => {
    const { rustic, snapshots } = volume();
    (rustic as any).listSnapshotsFresh = jest.fn(async () => {
      snapshots.push({
        id: "competing",
        time: new Date(),
        tags: [],
        summary: {},
      });
      return snapshots;
    });
    (rustic as any).backup = jest.fn();
    await expect(
      rustic.update(
        { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
        { limit: 1 },
      ),
    ).rejects.toThrow("backup repository inventory changed before replacement");
    expect(rustic.backup).not.toHaveBeenCalled();
    expect(snapshots.map((item) => item.id)).toContain("old");
  });

  it("keeps tagged manual backups while replacing at a four-backup limit", async () => {
    const { rustic, snapshots } = volume();
    snapshots.push(
      {
        id: "older",
        time: new Date("2026-09-19T00:00:00.000Z"),
        tags: [],
        summary: {},
      },
      {
        id: "manual",
        time: new Date("2026-09-21T00:00:00.000Z"),
        tags: ["cocalc-manual"],
        summary: {},
      },
      {
        id: "recent",
        time: new Date("2026-09-22T00:00:00.000Z"),
        tags: [],
        summary: {},
      },
    );
    (rustic as any).backup = jest.fn(async ({ limit, tags }) => {
      expect(limit).toBe(5);
      const created = {
        id: "new",
        time: new Date(),
        tags,
        summary: {},
        snapshotGeneration: 2,
      };
      snapshots.push(created);
      return created;
    });

    await rustic.update(
      { frequent: 0, daily: 1, weekly: 0, monthly: 0 },
      { limit: 4 },
    );

    expect(snapshots.length).toBeLessThanOrEqual(4);
    expect(snapshots.map(({ id }) => id)).toContain("manual");
    expect(snapshots.map(({ id }) => id)).toContain("new");
  });

  it("does not create or prune backups at a zero-backup entitlement", async () => {
    const { rustic, snapshots } = volume();
    (rustic as any).backup = jest.fn();

    await expect(rustic.update(undefined, { limit: 0 })).rejects.toMatchObject({
      code: 507,
    });
    expect(snapshots.map(({ id }) => id)).toEqual(["old"]);
    expect(rustic.backup).not.toHaveBeenCalled();
  });

  it("retries pruning without another upload after replacement succeeds", async () => {
    const { rustic, snapshots } = volume();
    let pruneBlocked = true;
    (rustic as any).forget = jest.fn(async ({ id }) => {
      if (pruneBlocked) throw new Error("prune blocked");
      const index = snapshots.findIndex((item) => item.id === id);
      if (index >= 0) snapshots.splice(index, 1);
    });
    const backup = jest.fn(async ({ tags }) => {
      const created = {
        id: "new",
        time: new Date(),
        tags,
        summary: {},
        snapshotGeneration: 2,
      };
      snapshots.push(created);
      return created;
    });
    (rustic as any).backup = backup;
    const schedule = { frequent: 0, daily: 1, weekly: 0, monthly: 0 };

    await expect(rustic.update(schedule, { limit: 1 })).rejects.toThrow(
      "prune blocked",
    );
    expect(snapshots.map(({ id }) => id)).toEqual(["old", "new"]);
    pruneBlocked = false;
    await rustic.update(schedule, { limit: 1 });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(snapshots.map(({ id }) => id)).toEqual(["new"]);
  });
});

describe("SubvolumeRustic.backup", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
    btrfsMock = jest.fn(async ({ args }) =>
      args?.[0] === "subvolume" && args?.[1] === "show"
        ? { stdout: "Generation: 42\n" }
        : undefined,
    );
    sudoMock = jest.fn(async () => undefined);
    readdirMock = jest.fn(async () => []);
    rusticHostMock = jest.fn();
    backupFsRusticMock = jest.fn(async (_args, _opts) => {
      return {
        stdout: Buffer.from(
          JSON.stringify({
            time: "2026-04-30T21:00:00.000Z",
            id: "snap-1",
            summary: { files_new: 1 },
          }),
        ),
        stderr: Buffer.alloc(0),
        code: 0,
        truncated: false,
      };
    });
    sandboxedFilesystemMock = jest.fn((_path, _opts) => ({
      rustic: backupFsRusticMock,
    }));
  });

  it("uses a larger output budget when listing rustic snapshots", async () => {
    rusticHostMock.mockResolvedValue({
      stdout: Buffer.from(
        JSON.stringify([
          {
            group_key: { hostname: "project-1" },
            snapshots: [
              {
                id: "snap-1",
                time: "2026-04-30T21:00:00.000Z",
                summary: {},
              },
            ],
          },
        ]),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
      truncated: false,
    });
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rusticRepo: "/repo",
        rustic: jest.fn(),
      },
    } as any);

    await rustic.snapshots();

    expect(rusticHostMock).toHaveBeenCalledWith(
      ["snapshots", "--json"],
      expect.objectContaining({
        timeout: 60000,
        maxSize: expect.any(Number),
      }),
    );
    expect(rusticHostMock.mock.calls[0][1].maxSize).toBeGreaterThan(10_000_000);
  });

  it("checks archive snapshot existence without trusting the list cache", async () => {
    const groupedSnapshots = (ids: string[]) => ({
      stdout: Buffer.from(
        JSON.stringify([
          {
            group_key: { hostname: "project-1" },
            snapshots: ids.map((id) => ({
              id,
              time: "2026-04-30T21:00:00.000Z",
              summary: {},
            })),
          },
        ]),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
      truncated: false,
    });
    rusticHostMock
      .mockResolvedValueOnce(groupedSnapshots(["archive-backup"]))
      .mockResolvedValueOnce(groupedSnapshots([]));
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await expect(rustic.snapshots()).resolves.toHaveLength(1);
    await expect(rustic.snapshotExists({ id: "archive-backup" })).resolves.toBe(
      false,
    );

    expect(rusticHostMock).toHaveBeenCalledTimes(2);
  });

  it("excludes .snapshots from future backups", async () => {
    const subvolumeFsRusticMock = jest.fn();
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rusticRepo: "/repo",
        rustic: subvolumeFsRusticMock,
      },
    } as any);

    await expect(rustic.backup()).resolves.toEqual(
      expect.objectContaining({ snapshotGeneration: 42 }),
    );

    expect(sudoMock).toHaveBeenCalledWith({
      command: "mkdir",
      args: ["-p", "/mnt/test/.rustic-backup-staging/project-1"],
    });
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "snapshot",
        "-r",
        "/mnt/test/project-1",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
    });
    expect(sandboxedFilesystemMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
      ),
      { host: "project-1", rusticRepo: "/repo" },
    );
    expect(backupFsRusticMock).toHaveBeenCalledWith(
      [
        "backup",
        "-x",
        "--json",
        "--glob",
        "!.snapshots",
        "--glob",
        "!.snapshots/**",
        ".",
      ],
      {
        timeout: 1800000,
        cwd: ".",
        env: undefined,
        onStderrLine: undefined,
      },
    );
    expect(subvolumeFsRusticMock).not.toHaveBeenCalled();
    expect(backupFsRusticMock.mock.calls[0][1].cwd).toBe(".");
    expect(backupFsRusticMock.mock.calls[0][1].cwd).not.toMatch(
      /^\/mnt\/test\/\.rustic-backup-staging\//,
    );
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "delete",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
      verbose: false,
    });
  });

  it("does not defer required cleanup after a scheduled backup", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);
    let lifecycleActive = false;
    configureBtrfsBackgroundMutationGuard(() =>
      lifecycleActive ? "lifecycle_active" : undefined,
    );
    backupFsRusticMock.mockImplementationOnce(async () => {
      lifecycleActive = true;
      return {
        stdout: Buffer.from(
          JSON.stringify({
            time: "2026-04-30T21:00:00.000Z",
            id: "snap-1",
            summary: { files_new: 1 },
          }),
        ),
        stderr: Buffer.alloc(0),
        code: 0,
        truncated: false,
      };
    });

    await withBtrfsMutationContext({ priority: "scheduled" }, async () => {
      await rustic.backup();
    });

    expect(btrfsMock).toHaveBeenLastCalledWith({
      args: [
        "subvolume",
        "delete",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
      verbose: false,
    });
  });

  it("removes stale crash leftovers before creating a backup", async () => {
    const now = new Date("2026-05-02T21:00:00.000Z").valueOf();
    const stale = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 25 * 60 * 60 * 1000).toString(36)}-stale123`;
    const fresh = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 60 * 1000).toString(36)}-fresh123`;
    jest.spyOn(Date, "now").mockReturnValue(now);
    readdirMock.mockResolvedValueOnce([
      { name: stale, isDirectory: () => true },
      { name: fresh, isDirectory: () => true },
      { name: "unrelated", isDirectory: () => true },
    ]);
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await rustic.backup();

    expect(btrfsMock).toHaveBeenNthCalledWith(1, {
      args: [
        "subvolume",
        "delete",
        `/mnt/test/.rustic-backup-staging/project-1/${stale}`,
      ],
      verbose: false,
    });
    expect(
      btrfsMock.mock.calls.some(([opts]) =>
        opts.args?.at(-1)?.endsWith(`/${fresh}`),
      ),
    ).toBe(false);
  });

  it("removes stale crash leftovers even when the backup limit is reached", async () => {
    const now = new Date("2026-05-02T21:00:00.000Z").valueOf();
    const stale = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 25 * 60 * 60 * 1000).toString(36)}-atlimit`;
    jest.spyOn(Date, "now").mockReturnValue(now);
    readdirMock.mockResolvedValueOnce([
      { name: stale, isDirectory: () => true },
    ]);
    rusticHostMock.mockResolvedValue({
      stdout: Buffer.from(
        JSON.stringify([
          {
            group_key: { hostname: "project-1" },
            snapshots: [
              {
                id: "existing",
                time: "2026-04-30T21:00:00.000Z",
                summary: {},
              },
            ],
          },
        ]),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
      truncated: false,
    });
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await expect(rustic.backup({ limit: 1 })).rejects.toMatchObject({
      code: 507,
    });
    expect(btrfsMock).toHaveBeenCalledWith({
      args: [
        "subvolume",
        "delete",
        `/mnt/test/.rustic-backup-staging/project-1/${stale}`,
      ],
      verbose: false,
    });
  });

  it("defers stale scavenging during a scheduled lifecycle conflict", async () => {
    const now = new Date("2026-05-02T21:00:00.000Z").valueOf();
    const stale = `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(now - 25 * 60 * 60 * 1000).toString(36)}-deferred`;
    jest.spyOn(Date, "now").mockReturnValue(now);
    readdirMock.mockResolvedValueOnce([
      { name: stale, isDirectory: () => true },
    ]);
    configureBtrfsBackgroundMutationGuard(() => "lifecycle_active");
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await expect(
      withBtrfsMutationContext({ priority: "scheduled" }, async () => {
        await rustic.backup();
      }),
    ).rejects.toThrow("background btrfs mutation deferred: lifecycle_active");
    expect(
      btrfsMock.mock.calls.some(
        ([opts]) =>
          opts.args?.[1] === "delete" && opts.args?.[2]?.endsWith(`/${stale}`),
      ),
    ).toBe(false);
  });

  it("bounds stale crash cleanup per backup", async () => {
    const now = new Date("2026-05-02T21:00:00.000Z").valueOf();
    const stale = Array.from(
      { length: 33 },
      (_, index) =>
        `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${(
          now -
          (25 * 60 * 60 * 1000 + index)
        ).toString(36)}-stale${index.toString(36)}`,
    );
    jest.spyOn(Date, "now").mockReturnValue(now);
    readdirMock.mockResolvedValueOnce(
      stale.map((name) => ({ name, isDirectory: () => true })),
    );
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await rustic.backup();

    const staleDeletes = btrfsMock.mock.calls.filter(
      ([opts]) =>
        opts.args?.[1] === "delete" &&
        stale.some((name) => opts.args?.[2]?.endsWith(`/${name}`)),
    );
    expect(staleDeletes).toHaveLength(32);
  });

  it("passes an explicit parent snapshot to rustic backup", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rusticRepo: "/repo",
        rustic: jest.fn(),
      },
    } as any);

    await rustic.backup({ parent: "snap-parent" });

    expect(backupFsRusticMock).toHaveBeenCalledWith(
      expect.arrayContaining(["--parent", "snap-parent"]),
      expect.any(Object),
    );
  });

  it("backs up through the runner when one is given", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);
    const oversized_files = {
      max_file_bytes: 1_000_000_000,
      count: 1,
      files: [{ path: "huge.img", size: 2_000_000_000_000 }],
    };
    const runner = jest.fn(async () => ({
      time: "2026-04-30T21:00:00.000Z",
      id: "snap-runner",
      summary: {},
      oversized_files,
    }));

    const created = await rustic.backup({ runner, tags: ["cocalc-automatic"] });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "project-1",
        tags: ["cocalc-automatic"],
      }),
    );
    expect(backupFsRusticMock).not.toHaveBeenCalled();
    expect(created).toEqual(
      expect.objectContaining({ id: "snap-runner", oversized_files }),
    );
  });

  it("backs up unprivileged when the runner is unavailable", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);
    const runner = jest.fn(async () => null);

    const created = await rustic.backup({ runner });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(backupFsRusticMock).toHaveBeenCalledWith(
      expect.arrayContaining(["backup"]),
      expect.any(Object),
    );
    expect(created.id).toBe("snap-1");
  });

  it("deletes the temporary snapshot if its generation cannot be read", async () => {
    btrfsMock.mockImplementation(async ({ args }) =>
      args?.[0] === "subvolume" && args?.[1] === "show"
        ? { stdout: "Generation: unknown\n" }
        : undefined,
    );
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);

    await expect(rustic.backup()).rejects.toThrow(
      "unable to read temporary backup snapshot generation",
    );
    expect(btrfsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "subvolume",
          "delete",
          expect.stringMatching(/temp-rustic-snapshot-/),
        ],
      }),
    );
    expect(backupFsRusticMock).not.toHaveBeenCalled();
  });

  it("serializes snapshot mutations but allows concurrent rustic transfers", async () => {
    let releaseFirst!: () => void;
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    const wait = new Promise<void>((release) => {
      releaseFirst = release;
    });
    let backupCall = 0;
    backupFsRusticMock = jest.fn(async () => {
      backupCall += 1;
      if (backupCall === 1) {
        resolveFirstStarted();
        await wait;
        return {
          stdout: Buffer.from(
            JSON.stringify({
              time: "2026-04-30T21:00:00.000Z",
              id: "snap-1",
              summary: { files_new: 1 },
            }),
          ),
          stderr: Buffer.alloc(0),
          code: 0,
          truncated: false,
        };
      }
      resolveSecondStarted();
      return {
        stdout: Buffer.from(
          JSON.stringify({
            time: "2026-04-30T22:00:00.000Z",
            id: "snap-2",
            summary: { files_new: 2 },
          }),
        ),
        stderr: Buffer.alloc(0),
        code: 0,
        truncated: false,
      };
    });
    sandboxedFilesystemMock = jest.fn((_path, _opts) => ({
      rustic: backupFsRusticMock,
    }));

    const rustic1 = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rusticRepo: "/repo",
        rustic: jest.fn(),
      },
    } as any);
    const rustic2 = new SubvolumeRustic({
      name: "project-2",
      path: "/mnt/test/project-2",
      filesystem: {
        opts: { mount: "/mnt/test" },
      },
      fs: {
        rusticRepo: "/repo",
        rustic: jest.fn(),
      },
    } as any);

    const first = rustic1.backup();
    await firstStarted;
    const second = rustic2.backup();
    await secondStarted;

    expect(backupFsRusticMock).toHaveBeenCalledTimes(2);
    expect(btrfsMock).toHaveBeenCalledTimes(4);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(backupFsRusticMock).toHaveBeenCalledTimes(2);
    expect(btrfsMock).toHaveBeenCalledTimes(6);
  });
});
