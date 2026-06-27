export {};

let isAdminMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let getProjectFsClientMock: jest.Mock;
let getDirectorySummaryMock: jest.Mock;

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
  getProjectFsClient: (...args: any[]) => getProjectFsClientMock(...args),
}));

describe("getAdminProjectDirectorySummary", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => true);
    getDirectorySummaryMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      root: "/home/user",
      max_depth: 2,
      limit: 80,
      truncated: false,
      entries: [
        {
          path: "/home/user/a.sage",
          type: "file",
          size: 12,
          mtime: "2026-06-27T00:00:00.000Z",
        },
      ],
    }));
    getProjectFileServerClientMock = jest.fn(async () => ({
      getDirectorySummary: getDirectorySummaryMock,
    }));
    getProjectFsClientMock = jest.fn();
  });

  it("uses the admin project-host file-server route", async () => {
    const { getAdminProjectDirectorySummary } = await import("./projects");

    await expect(
      getAdminProjectDirectorySummary({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        path: "/home/user",
        max_depth: 1,
        limit: 20,
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      root: "/home/user",
      max_depth: 2,
      limit: 80,
      truncated: false,
      entries: [
        {
          path: "/home/user/a.sage",
          type: "file",
          size: 12,
          mtime: "2026-06-27T00:00:00.000Z",
        },
      ],
    });

    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(getProjectFileServerClientMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      timeout: 10_000,
    });
    expect(getProjectFsClientMock).not.toHaveBeenCalled();
    expect(getDirectorySummaryMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      path: "/home/user",
      max_depth: 1,
      limit: 20,
    });
  });

  it("rejects non-admin callers before contacting the project host", async () => {
    isAdminMock = jest.fn(async () => false);
    const { getAdminProjectDirectorySummary } = await import("./projects");

    await expect(
      getAdminProjectDirectorySummary({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("must be an admin");

    expect(getProjectFileServerClientMock).not.toHaveBeenCalled();
    expect(getProjectFsClientMock).not.toHaveBeenCalled();
  });
});
