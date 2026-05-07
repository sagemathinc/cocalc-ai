/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const getMembershipTierMapMock = jest.fn();
const getMembershipTierByIdMock = jest.fn();
const getMembershipUsageStatusForAccountMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("./tiers", () => ({
  getMembershipTierMap: (...args: any[]) => getMembershipTierMapMock(...args),
  getMembershipTierById: (...args: any[]) => getMembershipTierByIdMock(...args),
}));

jest.mock("./usage-status", () => ({
  getMembershipUsageStatusForAccount: (...args: any[]) =>
    getMembershipUsageStatusForAccountMock(...args),
}));

describe("resolveMembershipDetailsForAccount usage-status cache", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    getMembershipTierByIdMock.mockResolvedValue(undefined);
    getMembershipUsageStatusForAccountMock.mockResolvedValue({
      total_storage_bytes: 123,
    });
  });

  it("does not compute usage-status unless refresh is requested", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    getMembershipTierMapMock.mockResolvedValue({
      free: {
        id: "free",
        priority: 0,
        usage_limits: {},
      },
    });

    const { resolveMembershipDetailsForAccount } = await import("./resolve");
    const first = await resolveMembershipDetailsForAccount("account-1");
    const second = await resolveMembershipDetailsForAccount("account-1");

    expect(first.usage_status).toBeUndefined();
    expect(second.usage_status).toBeUndefined();
    expect(getMembershipUsageStatusForAccountMock).not.toHaveBeenCalled();
  });

  it("reuses recent usage-status results for the same account and limits when refresh is requested", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    getMembershipTierMapMock.mockResolvedValue({
      free: {
        id: "free",
        priority: 0,
        usage_limits: {},
      },
    });

    const { resolveMembershipDetailsForAccount } = await import("./resolve");
    const first = await resolveMembershipDetailsForAccount("account-1", {
      refresh_usage_status: true,
    });
    const second = await resolveMembershipDetailsForAccount("account-1");

    expect(first.usage_status?.total_storage_bytes).toBe(123);
    expect(second.usage_status?.total_storage_bytes).toBe(123);
    expect(getMembershipUsageStatusForAccountMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache when the selected membership limits change", async () => {
    let subscriptionQueryCount = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM subscriptions")) {
        subscriptionQueryCount += 1;
        if (subscriptionQueryCount === 1) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: "sub-1",
              metadata: { class: "pro" },
              current_period_end: new Date("2026-06-01T00:00:00.000Z"),
              status: "active",
            },
          ],
        };
      }
      return { rows: [] };
    });
    getMembershipTierMapMock.mockResolvedValue({
      free: {
        id: "free",
        priority: 0,
        usage_limits: {},
      },
      pro: {
        id: "pro",
        priority: 10,
        usage_limits: {
          total_storage_soft_bytes: 10_000,
        },
      },
    });

    const { resolveMembershipDetailsForAccount } = await import("./resolve");
    const first = await resolveMembershipDetailsForAccount("account-1", {
      refresh_usage_status: true,
    });
    const second = await resolveMembershipDetailsForAccount("account-1", {
      refresh_usage_status: true,
    });

    expect(first.selected.class).toBe("free");
    expect(second.selected.class).toBe("pro");
    expect(getMembershipUsageStatusForAccountMock).toHaveBeenCalledTimes(2);
  });
});
