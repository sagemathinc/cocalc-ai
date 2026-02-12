export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/projects/collaborators", () => ({
  __esModule: true,
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  updateAuthorizedKeysOnHost: jest.fn(),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  __esModule: true,
  getProject: jest.fn(),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  updateLro: jest.fn(),
}));

jest.mock("@cocalc/conat/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn((op_id: string) => `stream:${op_id}`),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

describe("projects.copyPathBetweenProjects", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
  });

  it("requires a signed-in user", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await expect(
      copyPathBetweenProjects({
        src: { project_id: "src-project", path: "/root/a.txt" },
        dest: { project_id: "dest-project", path: "/root/b.txt" },
      } as any),
    ).rejects.toThrow("user must be signed in");
    expect(assertCollabMock).not.toHaveBeenCalled();
  });

  it("checks collaboration on both projects when copying across projects", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "dest-project", path: "/root/b.txt" },
    });

    expect(assertCollabMock).toHaveBeenCalledTimes(2);
    expect(assertCollabMock).toHaveBeenNthCalledWith(1, {
      account_id: "acct-1",
      project_id: "src-project",
    });
    expect(assertCollabMock).toHaveBeenNthCalledWith(2, {
      account_id: "acct-1",
      project_id: "dest-project",
    });
  });

  it("checks collaboration once when source and destination project are the same", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: "/root/a.txt" },
      dest: { project_id: "src-project", path: "/root/b.txt" },
    });
    expect(assertCollabMock).toHaveBeenCalledTimes(1);
  });

  it("creates and publishes an LRO and returns stream metadata", async () => {
    const { copyPathBetweenProjects } = await import("./projects");
    const result = await copyPathBetweenProjects({
      account_id: "acct-1",
      src: { project_id: "src-project", path: ["/root/a.txt", "/tmp/b.txt"] },
      dest: { project_id: "dest-project", path: "/root/out" },
      options: { force: true },
    });

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "copy-path-between-projects",
        scope_type: "project",
        scope_id: "src-project",
        created_by: "acct-1",
        routing: "hub",
        input: {
          src: { project_id: "src-project", path: ["/root/a.txt", "/tmp/b.txt"] },
          dests: [{ project_id: "dest-project", path: "/root/out" }],
          options: { force: true },
        },
        status: "queued",
      }),
    );
    expect(publishLroSummaryMock).toHaveBeenCalledTimes(1);
    expect(publishLroEventMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      op_id: "op-1",
      scope_type: "project",
      scope_id: "src-project",
      service: "persist-service",
      stream_name: "stream:op-1",
    });
  });
});
