export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let projectDetailsGetMock: jest.Mock;
let loadProjectReadDetailsDirectMock: jest.Mock;

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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectDetails: jest.fn(() => ({
      get: (...args: any[]) => projectDetailsGetMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/details", () => ({
  __esModule: true,
  loadProjectReadDetailsDirect: (...args: any[]) =>
    loadProjectReadDetailsDirectMock(...args),
}));

describe("remote project detail reads", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "missing-project",
    );
    isAdminMock = jest.fn(async () => false);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 2,
    }));
    projectDetailsGetMock = jest.fn(async () => ({
      launcher: null,
      region: "wnam",
      created: new Date("2026-04-08T20:00:00Z"),
      env: { FOO: "bar" },
      rootfs: { image: "buildpack-deps:noble-scm" },
      snapshots: { daily: 7 },
      backups: { daily: 1 },
      run_quota: { disk_quota: 1234 },
      settings: { mintime: 3600 },
      course: null,
    }));
    loadProjectReadDetailsDirectMock = jest.fn();
  });

  it("routes getProjectCreated through the owning bay", async () => {
    const { getProjectCreated } = await import("./projects");
    await expect(
      getProjectCreated({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual(new Date("2026-04-08T20:00:00Z"));
    expect(resolveProjectBayMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectDetailsGetMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(loadProjectReadDetailsDirectMock).not.toHaveBeenCalled();
  });
});
