export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let assertCollabMock: jest.Mock;
let publishProjectDetailInvalidationBestEffortMock: jest.Mock;

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

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: (...args: any[]) =>
    publishProjectDetailInvalidationBestEffortMock(...args),
}));

describe("project env helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    assertCollabMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [{ env: { FOO: "bar", PATH: "/custom/bin:$PATH" } }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    publishProjectDetailInvalidationBestEffortMock = jest.fn(
      async () => undefined,
    );
  });

  it("returns project env for a collaborator", async () => {
    const { getProjectEnv } = await import("./projects");
    await expect(
      getProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ FOO: "bar", PATH: "/custom/bin:$PATH" });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT env FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read project env without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
    isAdminMock = jest.fn(async () => true);
    const { getProjectEnv } = await import("./projects");
    await expect(
      getProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ FOO: "bar", PATH: "/custom/bin:$PATH" });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("updates project env and publishes detail invalidation", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    const { setProjectEnv } = await import("./projects");

    await expect(
      setProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        env: { HELLO: "world" },
      }),
    ).resolves.toBeUndefined();

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE projects SET env = $2 WHERE project_id = $1",
      [PROJECT_ID, { HELLO: "world" }],
    );
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["env"],
      },
    );
  });
});
