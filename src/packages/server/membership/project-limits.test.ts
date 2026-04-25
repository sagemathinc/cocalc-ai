/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();
const getMembershipUsageStatusForAccountMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

jest.mock("./resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("./usage-status", () => ({
  __esModule: true,
  getMembershipUsageStatusForAccount: (...args: any[]) =>
    getMembershipUsageStatusForAccountMock(...args),
}));

describe("project membership limits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMembershipUsageStatusForAccountMock.mockResolvedValue({
      total_storage_bytes: 0,
    });
  });

  it("returns the owned project count", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "7" }] });
    const { getOwnedProjectCountForAccount } = await import("./project-limits");
    await expect(getOwnedProjectCountForAccount("account-1")).resolves.toBe(7);
  });

  it("returns the owner account id for a project", async () => {
    queryMock.mockResolvedValue({ rows: [{ account_id: "owner-1" }] });
    const { getProjectOwnerAccountId } = await import("./project-limits");
    await expect(getProjectOwnerAccountId("project-1")).resolves.toBe(
      "owner-1",
    );
  });

  it("allows creation below the configured max_projects limit", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "2" }] });
    resolveMembershipForAccountMock.mockResolvedValue({
      entitlements: { usage_limits: { max_projects: 3 } },
    });
    const { assertCanOwnAdditionalProject } = await import("./project-limits");
    await expect(
      assertCanOwnAdditionalProject({ account_id: "account-1" }),
    ).resolves.toBeUndefined();
  });

  it("blocks creation at the configured max_projects limit", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "3" }] });
    resolveMembershipForAccountMock.mockResolvedValue({
      entitlements: { usage_limits: { max_projects: 3 } },
    });
    const { assertCanOwnAdditionalProject } = await import("./project-limits");
    await expect(
      assertCanOwnAdditionalProject({ account_id: "account-1" }),
    ).rejects.toThrow("owned project limit reached (3/3)");
  });

  it("does nothing when no max_projects limit is configured", async () => {
    const { assertCanOwnAdditionalProject } = await import("./project-limits");
    await expect(
      assertCanOwnAdditionalProject({
        account_id: "account-1",
        resolution: {
          class: "free",
          source: "free",
          entitlements: {},
        },
      }),
    ).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows storage-increasing operations below the hard total storage cap", async () => {
    getMembershipUsageStatusForAccountMock.mockResolvedValue({
      total_storage_bytes: 50,
    });
    const { assertCanIncreaseAccountStorage } =
      await import("./project-limits");
    await expect(
      assertCanIncreaseAccountStorage({
        account_id: "account-1",
        resolution: {
          class: "pro",
          source: "subscription",
          entitlements: { usage_limits: { total_storage_hard_bytes: 100 } },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks storage-increasing operations at the hard total storage cap", async () => {
    getMembershipUsageStatusForAccountMock.mockResolvedValue({
      total_storage_bytes: 100,
    });
    const { assertCanIncreaseAccountStorage } =
      await import("./project-limits");
    await expect(
      assertCanIncreaseAccountStorage({
        account_id: "account-1",
        resolution: {
          class: "pro",
          source: "subscription",
          entitlements: { usage_limits: { total_storage_hard_bytes: 100 } },
        },
      }),
    ).rejects.toThrow("total account storage hard cap reached");
  });
});
