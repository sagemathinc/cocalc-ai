export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

describe("getProjectRunQuota", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [{ run_quota: { disk_quota: 4000, always_running: false } }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns run quota for a collaborator", async () => {
    const { getProjectRunQuota } = await import("./projects");
    await expect(
      getProjectRunQuota({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      disk_quota: 4000,
      always_running: false,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT run_quota FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read run quota without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => true);
    const { getProjectRunQuota } = await import("./projects");
    await expect(
      getProjectRunQuota({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      disk_quota: 4000,
      always_running: false,
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
