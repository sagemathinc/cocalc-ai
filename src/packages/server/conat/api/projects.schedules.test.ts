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

describe("project schedule readers", () => {
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
          snapshots: { daily: 7, weekly: 4, monthly: 2 },
          backups: { disabled: true, daily: 1, weekly: 3 },
          run_quota: null,
          settings: null,
          course: null,
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("returns project snapshot schedule for a collaborator", async () => {
    const { getProjectSnapshotSchedule } = await import("./projects");
    await expect(
      getProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      daily: 7,
      weekly: 4,
      monthly: 2,
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("returns project backup schedule for a collaborator", async () => {
    const { getProjectBackupSchedule } = await import("./projects");
    await expect(
      getProjectBackupSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      disabled: true,
      daily: 1,
      weekly: 3,
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("allows admins to read schedules without collaborator access", async () => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    isAdminMock = jest.fn(async () => true);
    const { getProjectSnapshotSchedule, getProjectBackupSchedule } =
      await import("./projects");
    await expect(
      getProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      daily: 7,
      weekly: 4,
      monthly: 2,
    });
    await expect(
      getProjectBackupSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      disabled: true,
      daily: 1,
      weekly: 3,
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
