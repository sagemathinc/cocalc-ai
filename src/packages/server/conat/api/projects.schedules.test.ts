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

describe("project schedule readers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async (sql: string) => {
      if (sql.startsWith("SELECT snapshots")) {
        return {
          rows: [{ snapshots: { daily: 7, weekly: 4, monthly: 2 } }],
        };
      }
      if (sql.startsWith("SELECT backups")) {
        return {
          rows: [{ backups: { disabled: true, daily: 1, weekly: 3 } }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
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
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT snapshots FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
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
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT backups FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });

  it("allows admins to read schedules without collaborator access", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("not a collaborator");
    });
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
