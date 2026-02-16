export {};

let queryMock: jest.Mock;
let cpMock: jest.Mock;
let getBackupFilesMock: jest.Mock;
let deleteBackupMock: jest.Mock;
let upsertMock: jest.Mock;
let insertMock: jest.Mock;
let createBackupMock: jest.Mock;
let waitLroMock: jest.Mock;
let fileServerClientMock: jest.Mock;
let conatCallMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: (...args: any[]) => fileServerClientMock(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({
    call: (...args: any[]) => conatCallMock(...args),
  })),
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

function makeHostQuery(hostByProject: Record<string, string>) {
  return jest.fn(async (sql: string, params: any[]) => {
    if (!sql.includes("FROM projects")) {
      throw new Error(`unexpected query: ${sql}`);
    }
    const projectIds: string[] = params[0];
    return {
      rows: projectIds.map((project_id) => ({
        project_id,
        host_id: hostByProject[project_id] ?? null,
      })),
    };
  });
}

describe("projects.copyProjectFiles", () => {
  beforeEach(() => {
    jest.resetModules();
    cpMock = jest.fn(async () => undefined);
    getBackupFilesMock = jest.fn(async () => []);
    deleteBackupMock = jest.fn(async () => undefined);
    fileServerClientMock = jest.fn(() => ({
      cp: (...args: any[]) => cpMock(...args),
      getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
      deleteBackup: (...args: any[]) => deleteBackupMock(...args),
    }));
    conatCallMock = jest.fn(() => ({
      cp: (...args: any[]) => cpMock(...args),
      getBackupFiles: (...args: any[]) => getBackupFilesMock(...args),
      deleteBackup: (...args: any[]) => deleteBackupMock(...args),
    }));
    upsertMock = jest.fn(async () => true);
    insertMock = jest.fn(async () => true);
    createBackupMock = jest.fn(async () => ({
      op_id: "op",
      scope_type: "project",
      scope_id: "p1",
    }));
    waitLroMock = jest.fn(async () => ({
      status: "succeeded",
      result: { id: "snap-1" },
    }));
    queryMock = makeHostQuery({});
  });

  it("copies same-host absolute path via local cp", async () => {
    queryMock = makeHostQuery({ src: "h1", dest: "h1" });
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
    queryMock = makeHostQuery({ src: "h1", dest: "h2" });
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

  it("queues cross-host absolute copy rows when snapshot_id is provided", async () => {
    queryMock = makeHostQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: "/root/a.txt" },
      dests: [{ project_id: "dest", path: "/root/b.txt" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({ queued: 1, local: 0, snapshot_id: "snap-existing" });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src_project_id: "src",
        src_path: "/root/a.txt",
        dest_project_id: "dest",
        dest_path: "/root/b.txt",
        snapshot_id: "snap-existing",
      }),
    );
    expect(cpMock).not.toHaveBeenCalled();
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("expands multi-source queue destinations using source basenames", async () => {
    queryMock = makeHostQuery({ src: "h1", dest: "h2" });
    getBackupFilesMock.mockResolvedValue([{ name: "a.txt" }, { name: "b.txt" }]);
    const { copyProjectFiles } = await import("./copy");
    const result = await copyProjectFiles({
      account_id: "acct",
      timeout_ms: 0,
      src: { project_id: "src", path: ["/root/a.txt", "/tmp/b.txt"] },
      dests: [{ project_id: "dest", path: "/root/target" }],
      snapshot_id: "snap-existing",
    });

    expect(result).toEqual({ queued: 2, local: 0, snapshot_id: "snap-existing" });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        src_path: "/root/a.txt",
        dest_path: "/root/target/a.txt",
      }),
    );
    expect(upsertMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        src_path: "/tmp/b.txt",
        dest_path: "/root/target/b.txt",
      }),
    );
  });
});
