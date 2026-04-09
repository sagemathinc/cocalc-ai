export {};

let queryMock: jest.Mock;
let isAdminMock: jest.Mock;
let listHostsMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  __esModule: true,
  listHosts: (...args: any[]) => listHostsMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
}));

describe("bay-directory", () => {
  const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
  const OTHER_ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
  const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
  const HOST_ID = "44444444-4444-4444-4444-444444444444";

  let prevBayId: string | undefined;
  let prevBayLabel: string | undefined;
  let prevBayRegion: string | undefined;
  let prevClusterRole: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    prevBayId = process.env.COCALC_BAY_ID;
    prevBayLabel = process.env.COCALC_BAY_LABEL;
    prevBayRegion = process.env.COCALC_BAY_REGION;
    prevClusterRole = process.env.COCALC_CLUSTER_ROLE;
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_BAY_LABEL;
    delete process.env.COCALC_BAY_REGION;
    delete process.env.COCALC_CLUSTER_ROLE;

    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM accounts")) {
        return {
          rows: [
            {
              account_id: params?.[0] ?? ACCOUNT_ID,
              home_bay_id: null,
            },
          ],
        };
      }
      if (sql.includes("FROM projects")) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              title: "Project",
              host_id: HOST_ID,
              owning_bay_id: null,
            },
          ],
        };
      }
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [{ bay_id: null }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    isAdminMock = jest.fn(async () => false);
    listHostsMock = jest.fn(async () => [
      {
        id: HOST_ID,
        name: "host-1",
      },
    ]);
    resolveProjectBayMock = jest.fn(async () => null);
    projectReferenceGetMock = jest.fn(async () => null);
    getClusterAccountByIdMock = jest.fn(async () => null);
  });

  afterEach(() => {
    if (prevBayId == null) {
      delete process.env.COCALC_BAY_ID;
    } else {
      process.env.COCALC_BAY_ID = prevBayId;
    }
    if (prevBayLabel == null) {
      delete process.env.COCALC_BAY_LABEL;
    } else {
      process.env.COCALC_BAY_LABEL = prevBayLabel;
    }
    if (prevBayRegion == null) {
      delete process.env.COCALC_BAY_REGION;
    } else {
      process.env.COCALC_BAY_REGION = prevBayRegion;
    }
    if (prevClusterRole == null) {
      delete process.env.COCALC_CLUSTER_ROLE;
    } else {
      process.env.COCALC_CLUSTER_ROLE = prevClusterRole;
    }
  });

  it("returns the default one-bay configuration", async () => {
    const { getSingleBayInfo, listConfiguredBays } =
      await import("./bay-directory");
    expect(getSingleBayInfo()).toEqual({
      bay_id: "bay-0",
      label: "bay-0",
      region: null,
      deployment_mode: "single-bay",
      role: "combined",
      is_default: true,
    });
    await expect(listConfiguredBays()).resolves.toEqual([
      {
        bay_id: "bay-0",
        label: "bay-0",
        region: null,
        deployment_mode: "single-bay",
        role: "combined",
        is_default: true,
      },
    ]);
  });

  it("reports a seed bay in multi-bay mode", async () => {
    process.env.COCALC_BAY_ID = "bay-seed";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    const { getSingleBayInfo } = await import("./bay-directory");
    expect(getSingleBayInfo()).toEqual({
      bay_id: "bay-seed",
      label: "bay-seed",
      region: null,
      deployment_mode: "multi-bay",
      role: "seed",
      is_default: true,
    });
  });

  it("allows resolving another account only for admins", async () => {
    const { resolveAccountHomeBay } = await import("./bay-directory");

    await expect(
      resolveAccountHomeBay({
        account_id: ACCOUNT_ID,
        user_account_id: OTHER_ACCOUNT_ID,
      }),
    ).rejects.toThrow("not authorized");

    isAdminMock = jest.fn(async () => true);

    await expect(
      resolveAccountHomeBay({
        account_id: ACCOUNT_ID,
        user_account_id: OTHER_ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      account_id: OTHER_ACCOUNT_ID,
      home_bay_id: "bay-0",
      source: "single-bay-default",
    });
  });

  it("prefers a stored account home bay when present", async () => {
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM accounts")) {
        return {
          rows: [
            {
              account_id: params?.[0] ?? OTHER_ACCOUNT_ID,
              home_bay_id: "bay-7",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    isAdminMock = jest.fn(async () => true);
    const { resolveAccountHomeBay } = await import("./bay-directory");

    await expect(
      resolveAccountHomeBay({
        account_id: ACCOUNT_ID,
        user_account_id: OTHER_ACCOUNT_ID,
      }),
    ).resolves.toEqual({
      account_id: OTHER_ACCOUNT_ID,
      home_bay_id: "bay-7",
      source: "account-row",
    });
  });

  it("resolves the owning bay for a visible project", async () => {
    const { resolveProjectOwningBay } = await import("./bay-directory");

    await expect(
      resolveProjectOwningBay({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      owning_bay_id: "bay-0",
      host_id: HOST_ID,
      title: "Project",
      source: "single-bay-default",
    });
    expect(queryMock).toHaveBeenCalled();
  });

  it("prefers a stored project owning bay when present", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM projects")) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              title: "Project",
              host_id: HOST_ID,
              owning_bay_id: "bay-9",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { resolveProjectOwningBay } = await import("./bay-directory");

    await expect(
      resolveProjectOwningBay({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      owning_bay_id: "bay-9",
      host_id: HOST_ID,
      title: "Project",
      source: "project-row",
    });
  });

  it("falls back to remote project reference when the project lives on another bay", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM projects")) {
        throw new Error(`project '${PROJECT_ID}' not found`);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-9",
      epoch: 0,
    }));
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Remote Project",
      host_id: HOST_ID,
      owning_bay_id: "bay-9",
    }));
    const { resolveProjectOwningBay } = await import("./bay-directory");

    await expect(
      resolveProjectOwningBay({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      owning_bay_id: "bay-9",
      host_id: HOST_ID,
      title: "Remote Project",
      source: "project-row",
    });
  });

  it("resolves the bay for a visible host", async () => {
    const { resolveHostBay } = await import("./bay-directory");

    await expect(
      resolveHostBay({
        account_id: ACCOUNT_ID,
        host_id: HOST_ID,
      }),
    ).resolves.toEqual({
      host_id: HOST_ID,
      bay_id: "bay-0",
      name: "host-1",
      source: "single-bay-default",
    });
    expect(listHostsMock).toHaveBeenCalled();
  });

  it("prefers a stored host bay when present", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [{ bay_id: "bay-5" }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { resolveHostBay } = await import("./bay-directory");

    await expect(
      resolveHostBay({
        account_id: ACCOUNT_ID,
        host_id: HOST_ID,
      }),
    ).resolves.toEqual({
      host_id: HOST_ID,
      bay_id: "bay-5",
      name: "host-1",
      source: "host-row",
    });
  });
});
