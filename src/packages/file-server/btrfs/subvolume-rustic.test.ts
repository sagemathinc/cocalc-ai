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
      },
      {
        id: "snap-new",
        time: new Date("2026-04-30T21:00:00.000Z"),
        summary: { files_new: 2 },
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
