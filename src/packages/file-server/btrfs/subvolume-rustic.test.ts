let btrfsMock: jest.Mock;
let sudoMock: jest.Mock;
let sandboxedFilesystemMock: jest.Mock;
let backupFsRusticMock: jest.Mock;
let rusticHostMock: jest.Mock;
let getGenerationMock: jest.Mock;

jest.mock("./subvolume-snapshots", () => ({
  getGeneration: (...args: any[]) => getGenerationMock(...args),
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
import { clearBtrfsOperationCachesForTest } from "./operation-cache";
import { RusticJobCleanupError } from "./rustic-job-errors";

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
  beforeEach(() => {
    clearBtrfsOperationCachesForTest();
    getGenerationMock = jest.fn(async () => 17);
    btrfsMock = jest.fn(async () => undefined);
    sudoMock = jest.fn(async () => undefined);
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

  it("captures source freshness before snapshot and never samples live edits after backup", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo" },
    } as any);
    const start = Date.now();
    const runner = jest.fn(async () => {
      getGenerationMock.mockResolvedValue(999);
      return { id: "new", time: new Date(), summary: {} };
    });
    const result = await rustic.backup({ runner });
    expect(result.source?.generation).toBe(17);
    expect(result.source!.captured_at.getTime()).toBeGreaterThanOrEqual(start);
    expect(result.source!.captured_at.getTime()).toBeLessThanOrEqual(
      result.time.getTime(),
    );
    expect(getGenerationMock).toHaveBeenCalledTimes(1);
    expect(getGenerationMock).toHaveBeenCalledWith("/mnt/test/project-1", {
      cache: false,
    });
    expect(getGenerationMock.mock.invocationCallOrder[0]).toBeLessThan(
      btrfsMock.mock.invocationCallOrder[0],
    );
    expect(btrfsMock.mock.invocationCallOrder[0]).toBeLessThan(
      runner.mock.invocationCallOrder[0],
    );
  });

  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not invent source generation from %s",
    async (generation) => {
      getGenerationMock.mockResolvedValue(generation);
      const rustic = new SubvolumeRustic({
        name: "project-1",
        path: "/mnt/test/project-1",
        filesystem: { opts: { mount: "/mnt/test" } },
        fs: { rusticRepo: "/repo" },
      } as any);
      expect((await rustic.backup()).source?.generation).toBeNull();
    },
  );

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

    await rustic.backup();

    expect(sudoMock).toHaveBeenCalledWith({
      command: "mkdir",
      args: ["-p", "/mnt/test/.rustic-backup-staging/project-1"],
    });
    expect(btrfsMock).toHaveBeenNthCalledWith(1, {
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
    expect(btrfsMock).toHaveBeenNthCalledWith(2, {
      args: [
        "subvolume",
        "delete",
        expect.stringMatching(
          /^\/mnt\/test\/\.rustic-backup-staging\/project-1\/temp-rustic-snapshot-/,
        ),
      ],
      err_on_exit: false,
      verbose: false,
    });
  });

  it.each([false, true])(
    "only cleans a failed backup snapshot when termination is verified (%s)",
    async (unsafe) => {
      const rustic = new SubvolumeRustic({
        name: "project-1",
        path: "/mnt/test/project-1",
        filesystem: { opts: { mount: "/mnt/test" } },
        fs: { rusticRepo: "/repo", rustic: jest.fn() },
      } as any);
      const error = unsafe
        ? new RusticJobCleanupError("unit is stopping")
        : new Error("job failed");
      await expect(
        rustic.backup({
          runner: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const deletes = btrfsMock.mock.calls.filter(
        ([opts]) => opts.args[1] === "delete",
      );
      expect(deletes).toHaveLength(unsafe ? 0 : 1);
    },
  );

  it.each([false, true])(
    "does not turn unhandled producer evidence into freshness (%s)",
    async (useRunner) => {
      const rustic = new SubvolumeRustic({
        name: "project-1",
        path: "/mnt/test/project-1",
        filesystem: { opts: { mount: "/mnt/test" } },
        fs: { rusticRepo: "/repo", rustic: jest.fn() },
      } as any);
      const result = {
        id: "snapshot",
        time: "2026-09-05T00:00:00.000Z",
        summary: {},
        cocalc_backup_evidence: { outcome: "partial_policy_exclusions" },
      };
      backupFsRusticMock.mockResolvedValue({
        stdout: Buffer.from(JSON.stringify(result)),
        stderr: Buffer.alloc(0),
        code: 0,
        truncated: false,
      });
      await expect(
        rustic.backup(useRunner ? { runner: async () => result } : {}),
      ).rejects.toThrow("durable host consumer");
      expect(
        btrfsMock.mock.calls.filter(([opts]) => opts.args[1] === "delete"),
      ).toHaveLength(1);
    },
  );

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

  it("forwards the managed runner through the rolling-snapshot create API", async () => {
    const rustic = new SubvolumeRustic({
      name: "project-1",
      path: "/mnt/test/project-1",
      filesystem: { opts: { mount: "/mnt/test" } },
      fs: { rusticRepo: "/repo", rustic: jest.fn() },
    } as any);
    const runner = jest.fn(async () => ({
      id: "managed",
      time: new Date("2026-09-05T00:00:00.000Z"),
      summary: {},
    }));
    await expect(rustic.create("hourly", { runner })).resolves.toMatchObject({
      id: "managed",
    });
    expect(runner).toHaveBeenCalledTimes(1);
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
    expect(btrfsMock).toHaveBeenCalledTimes(2);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(backupFsRusticMock).toHaveBeenCalledTimes(2);
    expect(btrfsMock).toHaveBeenCalledTimes(4);
  });
});
