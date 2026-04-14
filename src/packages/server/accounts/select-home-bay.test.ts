export {};

const getClusterAccountHomeBayCountsMock = jest.fn();

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountHomeBayCounts: (...args: any[]) =>
    getClusterAccountHomeBayCountsMock(...args),
}));

describe("selectSignupHomeBay", () => {
  const prev = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_BAY_LABEL: process.env.COCALC_BAY_LABEL,
    COCALC_BAY_REGION: process.env.COCALC_BAY_REGION,
    COCALC_CLUSTER_BAY_IDS: process.env.COCALC_CLUSTER_BAY_IDS,
    HUB_CLUSTER_BAY_COUNT: process.env.HUB_CLUSTER_BAY_COUNT,
    HUB_CLUSTER_BAY_0_ID: process.env.HUB_CLUSTER_BAY_0_ID,
    HUB_CLUSTER_BAY_0_REGION: process.env.HUB_CLUSTER_BAY_0_REGION,
    HUB_CLUSTER_BAY_1_ID: process.env.HUB_CLUSTER_BAY_1_ID,
    HUB_CLUSTER_BAY_1_REGION: process.env.HUB_CLUSTER_BAY_1_REGION,
    HUB_CLUSTER_BAY_2_ID: process.env.HUB_CLUSTER_BAY_2_ID,
    HUB_CLUSTER_BAY_2_REGION: process.env.HUB_CLUSTER_BAY_2_REGION,
  };

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_BAY_ID = "bay-0";
    process.env.COCALC_BAY_REGION = "wnam";
    process.env.COCALC_CLUSTER_BAY_IDS = "bay-0,bay-1,bay-2";
    process.env.HUB_CLUSTER_BAY_COUNT = "3";
    process.env.HUB_CLUSTER_BAY_0_ID = "bay-0";
    process.env.HUB_CLUSTER_BAY_0_REGION = "wnam";
    process.env.HUB_CLUSTER_BAY_1_ID = "bay-1";
    process.env.HUB_CLUSTER_BAY_1_REGION = "eun";
    process.env.HUB_CLUSTER_BAY_2_ID = "bay-2";
    process.env.HUB_CLUSTER_BAY_2_REGION = "wnam";
    getClusterAccountHomeBayCountsMock.mockReset();
  });

  afterAll(() => {
    Object.assign(process.env, prev);
  });

  it("prefers a region match before falling back to load", async () => {
    getClusterAccountHomeBayCountsMock.mockResolvedValue({
      "bay-0": 10,
      "bay-1": 1,
      "bay-2": 3,
    });
    const { selectSignupHomeBay } = await import("./select-home-bay");
    const bay_id = await selectSignupHomeBay({
      req: {
        headers: { "x-cocalc-region": "wnam" },
      } as any,
    });
    expect(bay_id).toBe("bay-2");
  });

  it("falls back to the least-loaded bay when no region matches", async () => {
    getClusterAccountHomeBayCountsMock.mockResolvedValue({
      "bay-0": 8,
      "bay-1": 2,
      "bay-2": 5,
    });
    const { selectSignupHomeBay } = await import("./select-home-bay");
    const bay_id = await selectSignupHomeBay({
      req: {
        headers: { "x-cocalc-region": "apac" },
      } as any,
    });
    expect(bay_id).toBe("bay-1");
  });
});
