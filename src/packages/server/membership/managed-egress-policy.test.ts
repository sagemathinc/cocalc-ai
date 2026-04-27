/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getProjectOwnerAccountIdMock = jest.fn();
const getManagedEgressUsageForAccountMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();

jest.mock("./managed-egress", () => ({
  getProjectOwnerAccountId: (...args: any[]) =>
    getProjectOwnerAccountIdMock(...args),
  getManagedEgressUsageForAccount: (...args: any[]) =>
    getManagedEgressUsageForAccountMock(...args),
}));

jest.mock("./resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("getManagedProjectEgressPolicy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows managed egress when no owner can be resolved", async () => {
    getProjectOwnerAccountIdMock.mockResolvedValue(undefined);
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        project_id: "project-1",
        category: "file-download",
      }),
    ).resolves.toEqual({
      category: "file-download",
      allowed: true,
    });
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
    expect(getManagedEgressUsageForAccountMock).not.toHaveBeenCalled();
  });

  it("blocks managed egress when the 5-hour window is already over limit", async () => {
    getProjectOwnerAccountIdMock.mockResolvedValue("account-1");
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {
        usage_limits: {
          egress_5h_bytes: 1000,
          egress_7d_bytes: 2000,
        },
      },
    });
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 1200,
      managed_egress_7d_bytes: 1500,
      over_managed_egress_5h: true,
      over_managed_egress_7d: false,
      managed_egress_categories_5h_bytes: { "file-download": 1200 },
      managed_egress_categories_7d_bytes: { "file-download": 1500 },
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        project_id: "project-1",
        category: "file-download",
      }),
    ).resolves.toMatchObject({
      account_id: "account-1",
      category: "file-download",
      allowed: false,
      blocked_by: "5h",
      managed_egress_5h_bytes: 1200,
      egress_5h_bytes: 1000,
    });
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith("account-1");
    expect(getManagedEgressUsageForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
      limit5h: 1000,
      limit7d: 2000,
    });
  });
});
