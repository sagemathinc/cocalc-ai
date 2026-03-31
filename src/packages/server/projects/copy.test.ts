export {};

let queryMock: jest.Mock;
let cpMock: jest.Mock;
let getBackupFilesMock: jest.Mock;
let deleteBackupMock: jest.Mock;
let upsertMock: jest.Mock;
let insertMock: jest.Mock;
let createBackupMock: jest.Mock;
let waitLroMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let applyPendingCopiesMock: jest.Mock;
let createHostControlClientMock: jest.Mock;

type ProjectMeta = {
  host_id?: string | null;
  last_edited?: Date | null;
  last_backup?: Date | null;
};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/api/project-backups", () => ({
  __esModule: true,
  createBackup: (...args: any[]) => createBackupMock(...args),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  waitForCompletion: (...args: any[]) => waitLroMock(...args),
}));

jest.mock("./copy-db", () => ({
  __esModule: true,
  upsertCopyRow: (...args: any[]) => upsertMock(...args),
  insertCopyRowIfMissing: (...args: any[]) => insertMock(...args),
}));

function makeProjectQuery(projects: Record<string, ProjectMeta | string>) {
  return jest.fn(async (sql: string, params: any[]) => {
    if (!sql.includes("FROM projects")) {
      throw new Error(`unexpected query: ${sql}`);
    }
    if (sql.includes("WHERE project_id = ANY($1)")) {
      const projectIds: string[] = params[0];
      return {
        rows: projectIds.map((project_id) => {
          const meta = projects[project_id];
          const host_id =
            typeof meta === "string" ? meta : (meta?.host_id ?? null);
          return {
            project_id,
            host_id,
          };
        }),
      };
    }
    if (sql.includes("WHERE project_id = $1")) {
      const project_id: string = params[0];
      const meta = projects[project_id];
      if (!meta || typeof meta === "string") {
        return { rows: [] };
      }
      return {
        rows: [
          {
            last_edited: meta.last_edited ?? null,
            last_backup: meta.last_backup ?? null,
          },
        ],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe("projects.copyProjectFiles", () => {
  beforeEach(() => {
    jest.resetModules();
    cpMock = jest.fn(async () => undefined);
    getBackupFilesMock = jest.fn(async () => []);
    deleteBackupMock = jest.fn(async () => undefined);
    const getBackupsMock = jest.fn(async () => []);
    getProjectFileServerClientMock = jest.fn(async () => ({
      cp: (...args: any[]) => cpMock(...args),
      getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
      deleteBackup: (...args: any[]) => deleteBackupMock(...args),
      getBackups: getBackupsMock,
    }));
    upsertMock = jest.fn(async () => true);
    insertMock = jest.fn(async () => true);
    createBackupMock = jest.fn(async () => ({
      op_id: "op",
      scope_type: "project",
      scope_id: "p1",
    }));
    applyPendingCopiesMock = jest.fn(async () => ({ claimed: 1 }));
    createHostControlClientMock = jest.fn(() => ({
      applyPendingCopies: (...args: any[]) => applyPendingCopiesMock(...args),
    }));
    waitLroMock = jest.fn(async () => ({
      status: "succeeded",
      result: { id: "snap-1" },
    }));
    queryMock = makeProjectQuery({});
  });

  it("copies same-host absolute path via local cp", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h1" });
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
    });

    expect(result).toEqual({ queued: 0, local: 1, snapshot_id: undefined });
    expect(cpMock).toHaveBeenCalledTimes(1);
    expect(cpMock).toHaveBeenCalledWith({
      src: { project_id: "src", path: "/root/a.txt" },
      dest: { project_id: "dest", path: "/root/b.txt" },
      options: undefined,
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("rejects cross-host copies from /scratch with clear error", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    const { copyProjectFiles } = await import("./copy");
    await expect(
      copyProjectFiles({
        account_id: "acct",
        timeout_ms: 0,
        src: { project_id: "src", path: "/scratch/data.bin" },
        dests: [{ project_id: "dest", path: "/root/data.bin" }],
      }),
    ).rejects.toThrow(
      "copying from /scratch across hosts is not supported because /scratch is not backed up",
    );

    expect(cpMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("queues cross-host absolute copy rows with backup-relative source paths", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-existing",
    });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_project_id: "src",
        src_path: "a.txt",
        dest_project_id: "dest",
        dest_path: "/root/b.txt",
        snapshot_id: "snap-existing",
      }),
    );
    expect(createHostControlClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "h2",
      }),
    );
    expect(applyPendingCopiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
      }),
    );
    expect(cpMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("treats destination project root as a directory target for remote single-file copies", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-existing",
    });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_path: "a.txt",
        dest_path: "/root/a.txt",
      }),
    );
    expect(applyPendingCopiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
      }),
    );
  });

  it("expands multi-source queue destinations using source basenames", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([
      { name: "a.txt" },
      { name: "b.txt" },
    ]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: ["/root/a.txt", "/tmp/b.txt"] },
      dests: [{ project_id: "dest", path: "/root/target" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({
      queued: 2,
      local: 0,
      snapshot_id: "snap-existing",
    });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        src_path: "a.txt",
        dest_path: "/root/target/a.txt",
      }),
    );
    expect(upsertMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        src_path: "tmp/b.txt",
        dest_path: "/root/target/b.txt",
      }),
    );
  });

  it("uses src_home to normalize absolute source paths instead of hardcoding /root", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "x.py" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/home/wstein/work/x.py" },
      src_home: "/home/wstein/work",
      dests: [{ project_id: "dest", path: "/root/out" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-existing",
    });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_path: "x.py",
        dest_path: "/root/out",
      }),
    );
  });

  it("reuses the latest indexed backup when it is newer than last_edited", async () => {
    const lastBackup = new Date("2026-03-31T19:59:55.000Z");
    queryMock = makeProjectQuery({
      src: {
        host_id: "h1",
        last_backup: lastBackup,
        last_edited: new Date("2026-03-31T19:59:53.000Z"),
      },
      dest: "h2",
    });
    getProjectFileServerClientMock = jest.fn(async () => ({
      cp: (...args: any[]) => cpMock(...args),
      getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
      deleteBackup: (...args: any[]) => deleteBackupMock(...args),
      getBackups: jest.fn(async () => [
        {
          id: "snap-reuse",
          time: new Date("2026-03-31T19:59:56.000Z"),
          summary: {},
        },
      ]),
    }));
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);

    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-reuse",
    });
    expect(createBackupMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot_id: "snap-reuse",
      }),
    );
  });

  it("falls back to creating a new backup when the reused snapshot lacks the requested path", async () => {
    const lastBackup = new Date("2026-03-31T19:59:55.000Z");
    queryMock = makeProjectQuery({
      src: {
        host_id: "h1",
        last_backup: lastBackup,
        last_edited: new Date("2026-03-31T19:59:53.000Z"),
      },
      dest: "h2",
    });
    const getBackupsMock = jest.fn(async () => [
      {
        id: "snap-reuse",
        time: new Date("2026-03-31T19:59:56.000Z"),
        summary: {},
      },
    ]);
    getProjectFileServerClientMock = jest.fn(async () => ({
      cp: (...args: any[]) => cpMock(...args),
      getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
      deleteBackup: (...args: any[]) => deleteBackupMock(...args),
      getBackups: getBackupsMock,
    }));
    getBackupFilesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "a.txt" }]);
    waitLroMock = jest.fn(async () => ({
      status: "succeeded",
      result: { id: "snap-new" },
    }));

    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-new",
    });
    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot_id: "snap-new",
      }),
    );
  });
});
