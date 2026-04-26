/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getStorageOverviewMock = jest.fn();
const clientCloseMock = jest.fn();
const getManagedEgressUsageForAccountMock = jest.fn();
const conatWithProjectRoutingForAccountMock = jest.fn(() => ({
  close: clientCloseMock,
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

jest.mock("@cocalc/conat/project/storage-info", () => ({
  getStorageOverview: (...args: any[]) => getStorageOverviewMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: (...args: any[]) =>
    conatWithProjectRoutingForAccountMock(...args),
}));

jest.mock("./managed-egress", () => ({
  getManagedEgressUsageForAccount: (...args: any[]) =>
    getManagedEgressUsageForAccountMock(...args),
}));

describe("getMembershipUsageStatusForAccount", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 0,
      managed_egress_7d_bytes: 0,
      managed_egress_categories_5h_bytes: {},
      managed_egress_categories_7d_bytes: {},
    });
  });

  it("aggregates owned project storage and compares against configured limits", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { project_id: "project-1", host_id: "host-1", provisioned: true },
        { project_id: "project-2", host_id: "host-2", provisioned: true },
        { project_id: "project-3", host_id: null, provisioned: false },
      ],
    });
    getStorageOverviewMock
      .mockResolvedValueOnce({
        quotas: [{ key: "project", used: 100, size: 1000 }],
      })
      .mockResolvedValueOnce({
        quotas: [{ key: "project", used: 250, size: 1000 }],
      });

    const { getMembershipUsageStatusForAccount } =
      await import("./usage-status");
    const result = await getMembershipUsageStatusForAccount({
      account_id: "account-1",
      resolution: {
        class: "pro",
        source: "subscription",
        entitlements: {
          usage_limits: {
            total_storage_soft_bytes: 300,
            total_storage_hard_bytes: 500,
            max_projects: 2,
          },
        },
      },
    });

    expect(result.total_storage_bytes).toBe(350);
    expect(result.owned_project_count).toBe(3);
    expect(result.sampled_project_count).toBe(2);
    expect(result.unsampled_project_count).toBe(0);
    expect(result.measurement_error_count).toBe(0);
    expect(result.total_storage_soft_remaining_bytes).toBe(-50);
    expect(result.total_storage_hard_remaining_bytes).toBe(150);
    expect(result.over_total_storage_soft).toBe(true);
    expect(result.over_total_storage_hard).toBe(false);
    expect(result.remaining_project_slots).toBe(-1);
    expect(result.over_max_projects).toBe(true);
    expect(result.managed_egress_5h_bytes).toBe(0);
    expect(conatWithProjectRoutingForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(getManagedEgressUsageForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
      limit5h: undefined,
      limit7d: undefined,
    });
    expect(clientCloseMock).toHaveBeenCalled();
  });

  it("tracks sampling failures without failing the whole status call", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { project_id: "project-1", host_id: "host-1", provisioned: true },
        { project_id: "project-2", host_id: "host-2", provisioned: true },
      ],
    });
    getStorageOverviewMock
      .mockResolvedValueOnce({
        quotas: [{ key: "project", used: 64, size: 1000 }],
      })
      .mockRejectedValueOnce(new Error("route failed"));

    const { getMembershipUsageStatusForAccount } =
      await import("./usage-status");
    const result = await getMembershipUsageStatusForAccount({
      account_id: "account-1",
      resolution: {
        class: "free",
        source: "free",
        entitlements: {},
      },
    });

    expect(result.total_storage_bytes).toBe(64);
    expect(result.sampled_project_count).toBe(1);
    expect(result.unsampled_project_count).toBe(1);
    expect(result.measurement_error_count).toBe(1);
    expect(result.total_storage_soft_bytes).toBeUndefined();
    expect(result.max_projects).toBeUndefined();
  });

  it("ignores unprovisioned projects for active storage sampling", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { project_id: "project-1", host_id: "host-1", provisioned: true },
        { project_id: "project-2", host_id: "host-2", provisioned: false },
        { project_id: "project-3", host_id: null, provisioned: false },
      ],
    });
    getStorageOverviewMock.mockResolvedValueOnce({
      quotas: [{ key: "project", used: 64, size: 1000 }],
    });

    const { getMembershipUsageStatusForAccount } =
      await import("./usage-status");
    const result = await getMembershipUsageStatusForAccount({
      account_id: "account-1",
      resolution: {
        class: "free",
        source: "free",
        entitlements: {},
      },
    });

    expect(result.owned_project_count).toBe(3);
    expect(result.sampled_project_count).toBe(1);
    expect(result.unsampled_project_count).toBe(0);
    expect(result.total_storage_bytes).toBe(64);
    expect(getStorageOverviewMock).toHaveBeenCalledTimes(1);
  });

  it("includes managed egress usage and category breakdowns", async () => {
    queryMock.mockResolvedValue({
      rows: [],
    });
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 123,
      managed_egress_7d_bytes: 456,
      managed_egress_5h_remaining_bytes: 877,
      managed_egress_7d_remaining_bytes: 1544,
      over_managed_egress_5h: false,
      over_managed_egress_7d: false,
      managed_egress_categories_5h_bytes: { "file-download": 123 },
      managed_egress_categories_7d_bytes: { "file-download": 456 },
    });

    const { getMembershipUsageStatusForAccount } =
      await import("./usage-status");
    const result = await getMembershipUsageStatusForAccount({
      account_id: "account-1",
      resolution: {
        class: "pro",
        source: "subscription",
        entitlements: {
          usage_limits: {
            egress_5h_bytes: 1000,
            egress_7d_bytes: 2000,
          },
        },
      },
    });

    expect(result.managed_egress_5h_bytes).toBe(123);
    expect(result.managed_egress_7d_bytes).toBe(456);
    expect(result.managed_egress_categories_5h_bytes).toEqual({
      "file-download": 123,
    });
    expect(result.managed_egress_categories_7d_bytes).toEqual({
      "file-download": 456,
    });
    expect(getManagedEgressUsageForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
      limit5h: 1000,
      limit7d: 2000,
    });
  });
});
