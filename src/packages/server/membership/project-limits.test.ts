/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const resolveMembershipForAccountMock = jest.fn();

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

describe("project membership limits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the owned project count", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "7" }] });
    const { getOwnedProjectCountForAccount } = await import("./project-limits");
    await expect(getOwnedProjectCountForAccount("account-1")).resolves.toBe(7);
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
});
