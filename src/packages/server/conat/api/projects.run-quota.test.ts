export {};

let assertLocalProjectCollaboratorMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let dbMockFn: jest.Mock;
let callback2Mock: jest.Mock;
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

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: (...args: any[]) => dbMockFn(...args),
}));

jest.mock("@cocalc/util/async-utils", () => ({
  __esModule: true,
  callback2: (...args: any[]) => callback2Mock(...args),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: (...args: any[]) =>
    publishProjectDetailInvalidationBestEffortMock(...args),
}));

describe("getProjectRunQuota", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT settings FROM projects")) {
        return {
          rows: [{ settings: { memory: 2000, mintime: 3600 } }],
        };
      }
      return {
        rows: [{ run_quota: { disk_quota: 4000, always_running: false } }],
      };
    });
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    callback2Mock = jest.fn(async (fn: any, opts: any) => await fn(opts));
    publishProjectDetailInvalidationBestEffortMock = jest.fn(
      async () => undefined,
    );
    dbMockFn = jest.fn(() => ({
      set_project_settings: jest.fn(async () => undefined),
      projectControl: jest.fn(async () => ({
        setAllQuotas: jest.fn(async () => undefined),
      })),
    }));
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

  it("publishes detail invalidation after updating quotas", async () => {
    isAdminMock = jest.fn(async () => true);
    const setProjectSettingsMock = jest.fn(async () => undefined);
    const setAllQuotasMock = jest.fn(async () => undefined);
    dbMockFn = jest.fn(() => ({
      set_project_settings: setProjectSettingsMock,
      projectControl: jest.fn(async () => ({
        setAllQuotas: setAllQuotasMock,
      })),
    }));
    const { setQuotas } = await import("./projects");

    await expect(
      setQuotas({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        disk_quota: 1234,
      }),
    ).resolves.toBeUndefined();

    expect(setProjectSettingsMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      settings: {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        disk_quota: 1234,
      },
    });
    expect(setAllQuotasMock).toHaveBeenCalled();
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["run_quota", "settings"],
      },
    );
  });

  it("returns project settings for a collaborator", async () => {
    const { getProjectSettings } = await import("./projects");
    await expect(
      getProjectSettings({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      memory: 2000,
      mintime: 3600,
    });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT settings FROM projects WHERE project_id = $1",
      [PROJECT_ID],
    );
  });
});
