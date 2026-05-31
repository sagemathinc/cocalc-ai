/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getProjectUsageAccountIdMock = jest.fn();
const getManagedCpuUsageForAccountMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();

jest.mock("./project-usage", () => ({
  getProjectUsageAccountId: (...args: any[]) =>
    getProjectUsageAccountIdMock(...args),
}));

jest.mock("./managed-cpu", () => ({
  getManagedCpuUsageForAccount: (...args: any[]) =>
    getManagedCpuUsageForAccountMock(...args),
}));

jest.mock("./resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("getManagedProjectCpuPolicy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows starts when no usage account can be resolved", async () => {
    getProjectUsageAccountIdMock.mockResolvedValue(undefined);
    const { getManagedProjectCpuPolicy } = await import("./managed-cpu-policy");
    await expect(
      getManagedProjectCpuPolicy({ project_id: "project-1" }),
    ).resolves.toEqual({ allowed: true });
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
    expect(getManagedCpuUsageForAccountMock).not.toHaveBeenCalled();
  });

  it("blocks starts when the 5-hour CPU budget is already over limit", async () => {
    getProjectUsageAccountIdMock.mockResolvedValue("account-1");
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "free",
      source: "free",
      entitlements: {
        usage_limits: {
          cpu_5h_seconds: 3600,
          cpu_7d_seconds: 7200,
        },
      },
    });
    getManagedCpuUsageForAccountMock.mockResolvedValue({
      managed_cpu_5h_seconds: 4000,
      managed_cpu_7d_seconds: 5000,
      managed_cpu_5h_reset_in: "37 minutes",
      over_managed_cpu_5h: true,
      over_managed_cpu_7d: false,
    });
    const { getManagedProjectCpuPolicy } = await import("./managed-cpu-policy");
    await expect(
      getManagedProjectCpuPolicy({ project_id: "project-1" }),
    ).resolves.toMatchObject({
      account_id: "account-1",
      allowed: false,
      blocked_by: "5h",
      managed_cpu_5h_seconds: 4000,
      cpu_5h_seconds: 3600,
    });
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith("account-1");
    expect(getManagedCpuUsageForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
      limit5h: 3600,
      limit7d: 7200,
    });
  });

  it("uses explicitly attributed account when provided", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "standard",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        cpu_5h_seconds: 10_000,
        cpu_7d_seconds: 20_000,
      },
    });
    getManagedCpuUsageForAccountMock.mockResolvedValue({
      managed_cpu_5h_seconds: 1200,
      managed_cpu_7d_seconds: 3000,
      over_managed_cpu_5h: false,
      over_managed_cpu_7d: false,
    });
    const { getManagedProjectCpuPolicy } = await import("./managed-cpu-policy");
    await expect(
      getManagedProjectCpuPolicy({
        account_id: "account-2",
        project_id: "project-1",
      }),
    ).resolves.toMatchObject({
      account_id: "account-2",
      allowed: true,
      managed_cpu_5h_seconds: 1200,
      cpu_5h_seconds: 10_000,
    });
    expect(getProjectUsageAccountIdMock).not.toHaveBeenCalled();
  });

  it("renders a user-facing block message with CPU-hours and reset time", async () => {
    const { formatManagedProjectCpuPolicyBlockMessage } =
      await import("./managed-cpu-policy");
    expect(
      formatManagedProjectCpuPolicyBlockMessage({
        allowed: false,
        blocked_by: "7d",
        managed_cpu_7d_seconds: 12_960,
        cpu_7d_seconds: 10_800,
        managed_cpu_7d_reset_in: "3 hours",
      }),
    ).toContain("3.60 of 3.00 CPU-hours");
  });
});
