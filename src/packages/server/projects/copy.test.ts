export {};

let queryMock: jest.Mock;
let cpMock: jest.Mock;
let getBackupFilesMock: jest.Mock;
let deleteBackupMock: jest.Mock;
let upsertMock: jest.Mock;
let insertMock: jest.Mock;
let createBackupMock: jest.Mock;
let waitLroMock: jest.Mock;
let getLroMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let applyPendingCopiesMock: jest.Mock;
let getRoutedHostControlClientMock: jest.Mock;
let getExplicitProjectRoutedClientMock: jest.Mock;
let statMock: jest.Mock;

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

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

jest.mock("@cocalc/server/conat/api/project-backups", () => ({
  __esModule: true,
  createBackup: (...args: any[]) => createBackupMock(...args),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  waitForCompletion: (...args: any[]) => waitLroMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  getLro: (...args: any[]) => getLroMock(...args),
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
    statMock = jest.fn(async () => ({
      size: 12,
      mtimeMs: Date.parse("2026-03-31T19:59:56.000Z"),
      isFile: () => true,
    }));
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
    getRoutedHostControlClientMock = jest.fn(async () => ({
      applyPendingCopies: (...args: any[]) => applyPendingCopiesMock(...args),
    }));
    getExplicitProjectRoutedClientMock = jest.fn(async () => ({
      fs: jest.fn(() => ({
        stat: (...args: any[]) => statMock(...args),
      })),
    }));
    waitLroMock = jest.fn(async () => ({
      status: "succeeded",
      result: { id: "snap-1" },
    }));
    getLroMock = jest.fn(async () => undefined);
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
      dest: { project_id: "dest", path: "b.txt" },
      options: undefined,
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("rejects cross-host copies from /tmp with clear error", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    const { copyProjectFiles } = await import("./copy");
    await expect(
      copyProjectFiles({
        account_id: "acct",
        timeout_ms: 0,
        src: { project_id: "src", path: "/tmp/data.bin" },
        dests: [{ project_id: "dest", path: "/root/data.bin" }],
      }),
    ).rejects.toThrow(
      "copying from /tmp across hosts is not supported because /tmp is not backed up",
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
        dest_path: "b.txt",
        snapshot_id: "snap-existing",
      }),
    );
    expect(getRoutedHostControlClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "h2",
        timeout: 5000,
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
        dest_path: "a.txt",
      }),
    );
    expect(applyPendingCopiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
      }),
    );
  });

  it("treats /home/user as the project root for remote single-file copies", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "bar.txt" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/home/user/bar.txt" },
      dests: [{ project_id: "dest", path: "/home/user" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({
      queued: 1,
      local: 0,
      snapshot_id: "snap-existing",
    });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_path: "bar.txt",
        dest_path: "bar.txt",
      }),
    );
  });

  it("uses a bounded archive fast path for small cross-host copies", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    const archive = {
      format: "cocalc-path-copy-tar-gzip-v1",
      archive: Buffer.from("tar"),
      sha256: "sha",
      bytes: 3,
      uncompressed_bytes: 12,
      file_count: 1,
      roots: [{ archive_path: "a.txt", source_path: "a.txt" }],
    };
    const createPathCopyArchiveMock = jest.fn(async () => archive);
    const applyPathCopyArchiveMock = jest.fn(async () => ({ applied: 1 }));
    getProjectFileServerClientMock = jest.fn(async ({ project_id }) => {
      if (project_id === "src") {
        return {
          cp: (...args: any[]) => cpMock(...args),
          createPathCopyArchive: (...args: any[]) =>
            createPathCopyArchiveMock(...args),
          getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
          deleteBackup: (...args: any[]) => deleteBackupMock(...args),
          getBackups: jest.fn(async () => []),
        };
      }
      return {
        applyPathCopyArchive: (...args: any[]) =>
          applyPathCopyArchiveMock(...args),
      };
    });

    const progress = jest.fn();
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      progress,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
    });

    expect(result).toEqual({
      queued: 0,
      local: 0,
      fast_remote: 1,
      snapshot_id: undefined,
    });
    expect(createPathCopyArchiveMock).toHaveBeenCalledWith({
      project_id: "src",
      roots: [{ archive_path: "a.txt", source_path: "a.txt" }],
      options: undefined,
      max_archive_bytes: 64 * 1024 * 1024,
      max_uncompressed_bytes: 256 * 1024 * 1024,
      max_files: 20_000,
    });
    expect(applyPathCopyArchiveMock).toHaveBeenCalledWith({
      archive,
      dests: [
        {
          project_id: "dest",
          roots: [{ archive_path: "a.txt", dest_path: "b.txt" }],
        },
      ],
      options: undefined,
    });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ step: "archive" }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ step: "copy-remote" }),
    );
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("falls back to the queued backup path when the bounded archive is too large", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);
    const createPathCopyArchiveMock = jest.fn(async () => {
      throw new Error("PATH_COPY_ARCHIVE_LIMIT: compressed archive too large");
    });
    getProjectFileServerClientMock = jest.fn(async ({ project_id }) => {
      if (project_id === "src") {
        return {
          cp: (...args: any[]) => cpMock(...args),
          createPathCopyArchive: (...args: any[]) =>
            createPathCopyArchiveMock(...args),
          getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
          deleteBackup: (...args: any[]) => deleteBackupMock(...args),
          getBackups: jest.fn(async () => []),
        };
      }
      return {
        applyPathCopyArchive: jest.fn(async () => ({ applied: 1 })),
      };
    });

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
      snapshot_id: "snap-1",
    });
    expect(createPathCopyArchiveMock).toHaveBeenCalledTimes(1);
    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_path: "a.txt",
        dest_path: "b.txt",
        snapshot_id: "snap-1",
      }),
    );
  });

  it("falls back before archiving when the destination host lacks the archive RPC", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);
    const createPathCopyArchiveMock = jest.fn(async () => ({
      format: "cocalc-path-copy-tar-gzip-v1",
      archive: Buffer.from("tar"),
      sha256: "sha",
      bytes: 3,
      uncompressed_bytes: 12,
      file_count: 1,
      roots: [{ archive_path: "a.txt", source_path: "a.txt" }],
    }));
    const applyPathCopyArchiveMock = jest.fn(async () => {
      throw new Error(
        "calling remote function 'applyPathCopyArchive': unknown service method 'applyPathCopyArchive'",
      );
    });
    getProjectFileServerClientMock = jest.fn(async ({ project_id }) => {
      if (project_id === "src") {
        return {
          cp: (...args: any[]) => cpMock(...args),
          createPathCopyArchive: (...args: any[]) =>
            createPathCopyArchiveMock(...args),
          getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
          deleteBackup: (...args: any[]) => deleteBackupMock(...args),
          getBackups: jest.fn(async () => []),
        };
      }
      return {
        applyPathCopyArchive: (...args: any[]) =>
          applyPathCopyArchiveMock(...args),
      };
    });

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
      snapshot_id: "snap-1",
    });
    expect(applyPathCopyArchiveMock).toHaveBeenCalledTimes(1);
    expect(createPathCopyArchiveMock).not.toHaveBeenCalled();
    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_path: "a.txt",
        dest_path: "b.txt",
        snapshot_id: "snap-1",
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
      src: { project_id: "src", path: ["/root/a.txt", "/root/b.txt"] },
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
        dest_path: "target/a.txt",
      }),
    );
    expect(upsertMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        src_path: "b.txt",
        dest_path: "target/b.txt",
      }),
    );
  });

  it("queues base-relative cross-host destinations without flattening nested paths", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([
      { name: "lesson.ipynb" },
      { name: "data.csv" },
    ]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: {
        project_id: "src",
        base_path: "/root/assignments/hw1/student",
        path: [
          "/root/assignments/hw1/student/lesson.ipynb",
          "/root/assignments/hw1/student/data/data.csv",
        ],
      },
      dests: [{ project_id: "dest", path: "/root/hw1" }],
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
        src_path: "assignments/hw1/student/lesson.ipynb",
        dest_path: "hw1/lesson.ipynb",
      }),
    );
    expect(upsertMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        src_path: "assignments/hw1/student/data/data.csv",
        dest_path: "hw1/data/data.csv",
      }),
    );
  });

  it("copies base-relative same-host destinations without flattening nested paths", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h1" });
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: {
        project_id: "src",
        base_path: "/root/hw1",
        path: ["/root/hw1/a.txt", "/root/hw1/nested/b.txt"],
      },
      dests: [{ project_id: "dest", path: "/root/submitted" }],
      options: { recursive: true, force: false },
    });

    expect(result).toEqual({ queued: 0, local: 2, snapshot_id: undefined });
    expect(cpMock).toHaveBeenCalledTimes(2);
    expect(cpMock).toHaveBeenNthCalledWith(1, {
      src: { project_id: "src", path: "/root/hw1/a.txt" },
      dest: { project_id: "dest", path: "submitted/a.txt" },
      options: { recursive: true, force: false },
    });
    expect(cpMock).toHaveBeenNthCalledWith(2, {
      src: { project_id: "src", path: "/root/hw1/nested/b.txt" },
      dest: { project_id: "dest", path: "submitted/nested/b.txt" },
      options: { recursive: true, force: false },
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("rejects base-relative copies outside the declared base path", async () => {
    queryMock = makeProjectQuery({ src: "h1", dest: "h2" });
    const { copyProjectFiles } = await import("./copy");
    await expect(
      copyProjectFiles({
        account_id: "acct",
        timeout_ms: 0,
        src: {
          project_id: "src",
          base_path: "/root/hw1",
          path: ["/root/hw2/a.txt"],
        },
        dests: [{ project_id: "dest", path: "/root/out" }],
      }),
    ).rejects.toThrow("src.path must be inside src.base_path");

    expect(cpMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
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
        dest_path: "out",
      }),
    );
  });

  it("reuses the latest indexed backup when the source file matches the indexed backup", async () => {
    const lastBackup = new Date("2026-03-31T19:59:55.000Z");
    queryMock = makeProjectQuery({
      src: {
        host_id: "h1",
        last_backup: lastBackup,
        last_edited: new Date("2026-03-31T20:01:53.000Z"),
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
    getBackupFilesMock.mockResolvedValue([
      {
        name: "a.txt",
        isDir: false,
        size: 12,
        mtime: Date.parse("2026-03-31T19:59:56.000Z"),
      },
    ]);

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

  it("creates a fresh backup when the source file changed since the indexed backup", async () => {
    queryMock = makeProjectQuery({
      src: {
        host_id: "h1",
        last_backup: new Date("2026-03-31T19:59:55.000Z"),
        last_edited: new Date("2026-03-31T20:01:53.000Z"),
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
    statMock = jest.fn(async () => ({
      size: 99,
      mtimeMs: Date.parse("2026-03-31T20:01:56.000Z"),
      isFile: () => true,
    }));
    getBackupFilesMock.mockResolvedValue([
      {
        name: "a.txt",
        isDir: false,
        size: 12,
        mtime: Date.parse("2026-03-31T19:59:56.000Z"),
      },
    ]);
    getLroMock = jest.fn(async () => ({
      op_id: "op",
      scope_type: "project",
      scope_id: "p1",
      status: "succeeded",
      result: { id: "snap-new" },
    }));
    waitLroMock = jest.fn(async ({ getSummary }) => {
      expect(typeof getSummary).toBe("function");
      return await getSummary();
    });

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
    expect(waitLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op",
        scope_type: "project",
        scope_id: "p1",
        timeout_ms: 30 * 60 * 1000,
        getSummary: expect.any(Function),
      }),
    );
    expect(getLroMock).toHaveBeenCalledWith("op");
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
