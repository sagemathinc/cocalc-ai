export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;

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

describe("project course info helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          launcher: null,
          region: null,
          created: null,
          env: null,
          rootfs_image: null,
          rootfs_image_id: null,
          snapshots: null,
          backups: null,
          run_quota: null,
          settings: null,
          course: {
            type: "student",
            project_id: "33333333-3333-4333-8333-333333333333",
            path: ".course/main.course",
          },
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns project course info for a collaborator", async () => {
    const { getProjectCourseInfo } = await import("./projects");
    await expect(
      getProjectCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      type: "student",
      project_id: "33333333-3333-4333-8333-333333333333",
      path: ".course/main.course",
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("allows admins to read project course info without collaborator access", async () => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    isAdminMock = jest.fn(async () => true);
    const { getProjectCourseInfo } = await import("./projects");
    await expect(
      getProjectCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      type: "student",
      project_id: "33333333-3333-4333-8333-333333333333",
      path: ".course/main.course",
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
