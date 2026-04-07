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

describe("getProjectLauncher", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [{ launcher: { quickCreate: ["chat", "ipynb"] } }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns launcher settings for a collaborator", async () => {
    const { getProjectLauncher } = await import("./projects");
    await expect(
      getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ quickCreate: ["chat", "ipynb"] });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(isAdminMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT launcher FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read launcher settings without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => true);
    const { getProjectLauncher } = await import("./projects");
    await expect(
      getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ quickCreate: ["chat", "ipynb"] });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("rejects non-admin non-collaborators", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => false);
    const { getProjectLauncher } = await import("./projects");
    await expect(
      getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("not a collaborator");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
