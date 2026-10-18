/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getProjectUsageAccountIdMock = jest.fn();
const getManagedEgressUsageForAccountMock = jest.fn();
const getManagedEgressCategoryUsageForAccountMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();
const getManagedEgressCategoryBlockedUntilMock = jest.fn();
const maybeNotifyManagedEgressLimitMock = jest.fn();

jest.mock("./managed-egress", () => ({
  getProjectUsageAccountId: (...args: any[]) =>
    getProjectUsageAccountIdMock(...args),
  getManagedEgressUsageForAccount: (...args: any[]) =>
    getManagedEgressUsageForAccountMock(...args),
  getManagedEgressCategoryUsageForAccount: (...args: any[]) =>
    getManagedEgressCategoryUsageForAccountMock(...args),
  getManagedEgressCategoryBlockedUntil: (...args: any[]) =>
    getManagedEgressCategoryBlockedUntilMock(...args),
}));

jest.mock("@cocalc/server/notifications/managed-egress", () => ({
  maybeNotifyManagedEgressLimit: (...args: any[]) =>
    maybeNotifyManagedEgressLimitMock(...args),
}));

jest.mock("./resolve", () => ({
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("getManagedProjectEgressPolicy", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.COCALC_CONTROL_PLANE_EGRESS_5H_BYTES;
    delete process.env.COCALC_CONTROL_PLANE_EGRESS_7D_BYTES;
  });

  it("allows managed egress when no usage account can be resolved", async () => {
    getProjectUsageAccountIdMock.mockResolvedValue(undefined);
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
    getProjectUsageAccountIdMock.mockResolvedValue("account-1");
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

  it("uses the explicitly attributed account when provided", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        egress_5h_bytes: 1000,
        egress_7d_bytes: 2000,
      },
    });
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 200,
      managed_egress_7d_bytes: 300,
      over_managed_egress_5h: false,
      over_managed_egress_7d: false,
      managed_egress_categories_5h_bytes: { "file-download": 200 },
      managed_egress_categories_7d_bytes: { "file-download": 300 },
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        account_id: "collaborator-1",
        project_id: "project-1",
        category: "file-download",
      }),
    ).resolves.toMatchObject({
      account_id: "collaborator-1",
      category: "file-download",
      allowed: true,
      managed_egress_5h_bytes: 200,
      managed_egress_7d_bytes: 300,
    });
    expect(getProjectUsageAccountIdMock).not.toHaveBeenCalled();
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith(
      "collaborator-1",
    );
    expect(getManagedEgressUsageForAccountMock).toHaveBeenCalledWith({
      account_id: "collaborator-1",
      limit5h: 1000,
      limit7d: 2000,
    });
  });

  it("allows account-attributed interactive egress without a project id", async () => {
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
      managed_egress_5h_bytes: 200,
      managed_egress_7d_bytes: 300,
      over_managed_egress_5h: false,
      over_managed_egress_7d: false,
      managed_egress_categories_5h_bytes: { "interactive-conat": 200 },
      managed_egress_categories_7d_bytes: { "interactive-conat": 300 },
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-2",
        category: "interactive-conat",
      }),
    ).resolves.toMatchObject({
      account_id: "account-2",
      category: "interactive-conat",
      allowed: true,
      managed_egress_5h_bytes: 200,
      managed_egress_7d_bytes: 300,
    });
    expect(getProjectUsageAccountIdMock).not.toHaveBeenCalled();
  });

  it("does not let membership egress exhaustion block control-plane traffic", async () => {
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 9_000_000_000,
      managed_egress_7d_bytes: 20_000_000_000,
      over_managed_egress_5h: true,
      over_managed_egress_7d: true,
    });
    getManagedEgressCategoryUsageForAccountMock.mockResolvedValue({
      bytes_5h: 100_000_000,
      bytes_7d: 500_000_000,
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");

    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-2",
        category: "control-plane-conat",
      }),
    ).resolves.toMatchObject({
      account_id: "account-2",
      category: "control-plane-conat",
      allowed: true,
      managed_egress_5h_bytes: 100_000_000,
      egress_5h_bytes: 10_000_000_000,
    });
    expect(getManagedEgressUsageForAccountMock).not.toHaveBeenCalled();
  });

  it("blocks abnormal control-plane traffic at its independent safety limit", async () => {
    getManagedEgressCategoryUsageForAccountMock.mockResolvedValue({
      bytes_5h: 11_000_000_000,
      bytes_7d: 20_000_000_000,
    });
    const resetAt = new Date("2026-10-19T03:00:00.000Z");
    getManagedEgressCategoryBlockedUntilMock.mockResolvedValue(resetAt);
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");

    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-2",
        category: "control-plane-conat",
      }),
    ).resolves.toMatchObject({
      account_id: "account-2",
      category: "control-plane-conat",
      allowed: false,
      blocked_by: "5h",
      managed_egress_5h_bytes: 11_000_000_000,
      egress_5h_bytes: 10_000_000_000,
      egress_7d_bytes: 100_000_000_000,
      blocked_until: resetAt,
    });
    expect(getManagedEgressCategoryBlockedUntilMock).toHaveBeenCalledWith({
      account_id: "account-2",
      category: "control-plane-conat",
      window: "5h",
      limit: 10_000_000_000,
    });
    expect(getManagedEgressUsageForAccountMock).not.toHaveBeenCalled();
    expect(maybeNotifyManagedEgressLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "account-2",
        pool: "control-plane",
        window: "5h",
        used: 11_000_000_000,
        limit: 10_000_000_000,
        blocked: true,
        resets_at: resetAt,
      }),
    );
  });

  it("uses a per-account control-plane override instead of the site default", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        egress_5h_bytes: 1000,
        egress_7d_bytes: 2000,
        control_plane_egress_7d_bytes: 200_000_000_000,
      },
    });
    getManagedEgressCategoryUsageForAccountMock.mockResolvedValue({
      bytes_5h: 1_000_000_000,
      bytes_7d: 150_000_000_000,
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-4",
        category: "control-plane-conat",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      egress_5h_bytes: 10_000_000_000,
      egress_7d_bytes: 200_000_000_000,
    });
    // 150 of 200 GB is under the 90% notice threshold; the policy still
    // offers both windows to the notifier, which applies the threshold.
    expect(maybeNotifyManagedEgressLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: "control-plane",
        window: "7d",
        used: 150_000_000_000,
        limit: 200_000_000_000,
        blocked: false,
      }),
    );
  });

  it("falls back to the site control-plane default if membership lookup fails", async () => {
    resolveMembershipForAccountMock.mockRejectedValue(new Error("db down"));
    getManagedEgressCategoryUsageForAccountMock.mockResolvedValue({
      bytes_5h: 0,
      bytes_7d: 0,
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-5",
        category: "control-plane-conat",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      egress_5h_bytes: 10_000_000_000,
      egress_7d_bytes: 100_000_000_000,
    });
  });

  it("uses the fixed membership window reset as blocked_until and notifies the shared pool", async () => {
    const resetAt = new Date("2026-10-19T00:00:00.000Z");
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {},
      effective_limits: { egress_5h_bytes: 1000, egress_7d_bytes: 2000 },
    });
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 500,
      managed_egress_7d_bytes: 2100,
      managed_egress_7d_reset_at: resetAt,
      over_managed_egress_5h: false,
      over_managed_egress_7d: true,
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    await expect(
      getManagedProjectEgressPolicy({
        account_id: "account-6",
        category: "ssh",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      blocked_by: "7d",
      blocked_until: resetAt,
    });
    expect(maybeNotifyManagedEgressLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "account-6",
        pool: "shared",
        window: "7d",
        blocked: true,
        resets_at: resetAt,
      }),
    );
  });

  it("coalesces and briefly caches identical account policy checks", async () => {
    resolveMembershipForAccountMock.mockResolvedValue({
      class: "pro",
      source: "subscription",
      entitlements: {},
      effective_limits: {
        egress_5h_bytes: 1000,
        egress_7d_bytes: 2000,
      },
    });
    getManagedEgressUsageForAccountMock.mockResolvedValue({
      managed_egress_5h_bytes: 100,
      managed_egress_7d_bytes: 200,
      over_managed_egress_5h: false,
      over_managed_egress_7d: false,
      managed_egress_categories_5h_bytes: { "raw-network": 100 },
      managed_egress_categories_7d_bytes: { "raw-network": 200 },
    });
    const { getManagedProjectEgressPolicy } =
      await import("./managed-egress-policy");
    const options = {
      account_id: "account-3",
      category: "raw-network" as const,
    };

    const [first, second] = await Promise.all([
      getManagedProjectEgressPolicy(options),
      getManagedProjectEgressPolicy(options),
    ]);
    expect(second).toEqual(first);
    await expect(getManagedProjectEgressPolicy(options)).resolves.toEqual(
      first,
    );
    expect(resolveMembershipForAccountMock).toHaveBeenCalledTimes(1);
    expect(getManagedEgressUsageForAccountMock).toHaveBeenCalledTimes(1);
  });
});
