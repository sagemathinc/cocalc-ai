/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getConfiguredBayIdMock: jest.Mock;
let getConfiguredClusterSeedBayIdMock: jest.Mock;
let getInterBayBridgeMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    getConfiguredClusterSeedBayIdMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: (...args: any[]) => getInterBayBridgeMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

describe("seed membership tier routing", () => {
  beforeEach(() => {
    jest.resetModules();
    getConfiguredBayIdMock = jest.fn(() => "bay-0");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "bay-0");
    queryMock = jest.fn(async () => ({
      rows: [{ id: "pro", store_visible: true, disabled: false }],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    getInterBayBridgeMock = jest.fn(() => ({
      bayOps: jest.fn(() => ({
        getMembershipTiers: jest.fn(async () => [
          { id: "remote-pro", store_visible: true, disabled: false },
        ]),
      })),
    }));
  });

  it("reads membership tiers locally on the seed bay", async () => {
    const { getSeedMembershipTiers } = await import("./tiers");

    const tiers = await getSeedMembershipTiers({
      includeDisabled: false,
      storeVisibleOnly: true,
    });

    expect(tiers.map((tier) => tier.id)).toEqual(["pro"]);
    expect(getPoolMock).toHaveBeenCalledWith();
    expect(getInterBayBridgeMock).not.toHaveBeenCalled();
  });

  it("routes membership tier reads from attached bays to the seed bay", async () => {
    const getMembershipTiers = jest.fn(async () => [
      { id: "remote-pro", store_visible: true, disabled: false },
    ]);
    const bayOps = jest.fn(() => ({ getMembershipTiers }));
    getConfiguredBayIdMock = jest.fn(() => "bay-2");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "bay-0");
    getInterBayBridgeMock = jest.fn(() => ({ bayOps }));
    const { getSeedMembershipTiers } = await import("./tiers");

    const tiers = await getSeedMembershipTiers({
      includeDisabled: true,
      courseStoreVisibleOnly: true,
    });

    expect(tiers.map((tier) => tier.id)).toEqual(["remote-pro"]);
    expect(getPoolMock).not.toHaveBeenCalled();
    expect(bayOps).toHaveBeenCalledWith("bay-0", { timeout_ms: 15_000 });
    expect(getMembershipTiers).toHaveBeenCalledWith({
      includeDisabled: true,
      storeVisibleOnly: false,
      courseStoreVisibleOnly: true,
    });
  });

  it("resolves a tier by id from the seed bay on attached bays", async () => {
    const getMembershipTiers = jest.fn(async () => [
      {
        id: "student1",
        course_store_visible: true,
        disabled: false,
        priority: 10,
      },
    ]);
    const bayOps = jest.fn(() => ({ getMembershipTiers }));
    getConfiguredBayIdMock = jest.fn(() => "bay-2");
    getConfiguredClusterSeedBayIdMock = jest.fn(() => "bay-0");
    getInterBayBridgeMock = jest.fn(() => ({ bayOps }));
    const { getSeedMembershipTierById } = await import("./tiers");

    const tier = await getSeedMembershipTierById({ id: "student1" });

    expect(tier).toMatchObject({
      id: "student1",
      course_store_visible: true,
      disabled: false,
    });
    expect(getPoolMock).not.toHaveBeenCalled();
    expect(bayOps).toHaveBeenCalledWith("bay-0", { timeout_ms: 15_000 });
    expect(getMembershipTiers).toHaveBeenCalledWith({
      includeDisabled: true,
      storeVisibleOnly: false,
      courseStoreVisibleOnly: false,
    });
  });
});
