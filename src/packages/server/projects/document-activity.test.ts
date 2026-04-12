export {};

let listProjectedProjectsForAccountMock: jest.Mock;
let conatWithProjectRoutingMock: jest.Mock;
let listRecentMock: jest.Mock;

jest.mock("@cocalc/database/postgres/account-project-index", () => ({
  __esModule: true,
  listProjectedProjectsForAccount: (...args: any[]) =>
    listProjectedProjectsForAccountMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  conatWithProjectRouting: (...args: any[]) =>
    conatWithProjectRoutingMock(...args),
}));

jest.mock("@cocalc/conat/project/document-activity", () => ({
  __esModule: true,
  listRecent: (...args: any[]) => listRecentMock(...args),
}));

describe("project document activity http compatibility helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  beforeEach(() => {
    jest.resetModules();
    listProjectedProjectsForAccountMock = jest.fn(async () => []);
    conatWithProjectRoutingMock = jest.fn(() => ({ kind: "routed-client" }));
    listRecentMock = jest.fn(async () => []);
  });

  it("lists recent file access via projected projects and skips unreachable hosts", async () => {
    listProjectedProjectsForAccountMock.mockResolvedValue([
      { project_id: PROJECT_A, title: "Alpha" },
      { project_id: PROJECT_B, title: "Beta" },
    ]);
    listRecentMock.mockImplementation(async ({ project_id }) => {
      if (project_id === PROJECT_A) {
        return [
          { project_id: PROJECT_A, path: "src/a.txt" },
          { project_id: PROJECT_A, path: "src/b.txt" },
          { project_id: PROJECT_A, path: "src/a.txt" },
        ];
      }
      throw new Error("host unavailable");
    });

    const { fileAccess } = await import("./document-activity");
    await expect(
      fileAccess({ account_id: ACCOUNT_ID, interval: "2 days" }),
    ).resolves.toEqual([
      { project_id: PROJECT_A, title: "Alpha", path: "src/a.txt" },
      { project_id: PROJECT_A, title: "Alpha", path: "src/b.txt" },
    ]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 50,
      include_hidden: false,
    });
    expect(conatWithProjectRoutingMock).toHaveBeenCalledTimes(1);
    expect(listRecentMock).toHaveBeenCalledWith({
      client: { kind: "routed-client" },
      account_id: ACCOUNT_ID,
      project_id: PROJECT_A,
      limit: 500,
      max_age_s: 2 * 24 * 60 * 60,
      search: undefined,
      timeout: 5000,
    });
  });

  it("searches recent filenames by latest access time across projects", async () => {
    listProjectedProjectsForAccountMock.mockResolvedValue([
      { project_id: PROJECT_A, title: "Alpha" },
      { project_id: PROJECT_B, title: "Beta" },
    ]);
    listRecentMock.mockImplementation(async ({ project_id }) => {
      if (project_id === PROJECT_A) {
        return [
          {
            project_id: PROJECT_A,
            path: "notes/todo.txt",
            last_accessed: "2026-04-11T12:00:00.000Z",
          },
        ];
      }
      return [
        {
          project_id: PROJECT_B,
          path: "notes/todo.txt",
          last_accessed: "2026-04-11T13:00:00.000Z",
        },
        {
          project_id: PROJECT_B,
          path: "logs/today.txt",
          last_accessed: "2026-04-11T11:00:00.000Z",
        },
      ];
    });

    const { filenameSearch } = await import("./document-activity");
    await expect(
      filenameSearch({ account_id: ACCOUNT_ID, search: "%txt%" }),
    ).resolves.toEqual([
      {
        project_id: PROJECT_B,
        filename: "notes/todo.txt",
        time: new Date("2026-04-11T13:00:00.000Z"),
      },
      {
        project_id: PROJECT_B,
        filename: "logs/today.txt",
        time: new Date("2026-04-11T11:00:00.000Z"),
      },
    ]);
  });
});
