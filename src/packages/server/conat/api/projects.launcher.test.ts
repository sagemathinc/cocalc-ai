export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let assertCollabMock: jest.Mock;
let publishProjectDetailInvalidationBestEffortMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  PROJECT_COLLABORATOR_REQUIRED_ERROR: "user must be a collaborator on project",
  PROJECT_NOT_FOUND_ERROR: "project not found",
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
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

describe("getProjectLauncher", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    assertCollabMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          launcher: { quickCreate: ["chat", "ipynb"] },
          region: null,
          created: null,
          env: null,
          rootfs_image: null,
          rootfs_image_id: null,
          snapshots: null,
          backups: null,
          run_quota: null,
          settings: null,
          course: null,
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    publishProjectDetailInvalidationBestEffortMock = jest.fn(
      async () => undefined,
    );
  });

  it("returns launcher settings for a collaborator", async () => {
    const { getProjectLauncher } = await import("./projects");
    await expect(
      getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ quickCreate: ["chat", "ipynb"] });
    expect(getLocalProjectCollaboratorAccessStatusMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(isAdminMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("allows admins to read launcher settings without collaborator access", async () => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
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
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    isAdminMock = jest.fn(async () => false);
    const { getProjectLauncher } = await import("./projects");
    await expect(
      getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("user must be a collaborator on project");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("updates launcher settings and publishes detail invalidation", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    const { setProjectLauncher } = await import("./projects");

    await expect(
      setProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        launcher: { quickCreate: ["term"] },
      }),
    ).resolves.toBeUndefined();

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE projects SET launcher = $2 WHERE project_id = $1",
      [PROJECT_ID, { quickCreate: ["term"] }],
    );
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["launcher"],
      },
    );
  });
});
