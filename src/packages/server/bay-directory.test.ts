export {};

let queryMock: jest.Mock;
let userQueryMock: jest.Mock;
let isAdminMock: jest.Mock;
let listHostsMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/database/user-query", () => ({
  __esModule: true,
  default: (...args: any[]) => userQueryMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/conat/api/hosts", () => ({
  __esModule: true,
  listHosts: (...args: any[]) => listHostsMock(...args),
}));

describe("bay-directory", () => {
  const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
  const OTHER_ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
  const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
  const HOST_ID = "44444444-4444-4444-4444-444444444444";

  let prevBayId: string | undefined;
  let prevBayLabel: string | undefined;
  let prevBayRegion: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    prevBayId = process.env.COCALC_BAY_ID;
    prevBayLabel = process.env.COCALC_BAY_LABEL;
    prevBayRegion = process.env.COCALC_BAY_REGION;
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_BAY_LABEL;
    delete process.env.COCALC_BAY_REGION;

    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM accounts")) {
        return {
          rows: [{ account_id: params?.[0] ?? ACCOUNT_ID }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    userQueryMock = jest.fn(async () => ({
      projects_all: [
        {
          project_id: PROJECT_ID,
          title: "Project",
          host_id: HOST_ID,
          deleted: null,
        },
      ],
    }));
    isAdminMock = jest.fn(async () => false);
    listHostsMock = jest.fn(async () => [
      {
        id: HOST_ID,
        name: "host-1",
      },
    ]);
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
    expect(userQueryMock).toHaveBeenCalled();
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
});
