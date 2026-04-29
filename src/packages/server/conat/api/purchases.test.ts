/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getManagedEgressHistoryForAccountMock = jest.fn();
const getProjectOwnerAccountIdMock = jest.fn();
const isAdminMock = jest.fn();

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/purchases/get-min-balance", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/membership/managed-egress", () => ({
  getManagedEgressHistoryForAccount: (...args: any[]) =>
    getManagedEgressHistoryForAccountMock(...args),
  getProjectOwnerAccountId: (...args: any[]) =>
    getProjectOwnerAccountIdMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipDetailsForAccount: jest.fn(),
  resolveMembershipForAccount: jest.fn(),
}));

jest.mock("@cocalc/server/ai/usage-status", () => ({
  getAIUsageStatus: jest.fn(),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

describe("purchases.getManagedEgressHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads history for the signed-in account", async () => {
    getManagedEgressHistoryForAccountMock.mockResolvedValue({
      account_id: "account-1",
      project_id: null,
      start: "2026-04-28T00:00:00.000Z",
      end: "2026-04-29T00:00:00.000Z",
      bucket: "1h",
      total_bytes: 123,
      categories_bytes: {},
      points: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedEgressHistory } = await import("./purchases");
    const result = await getManagedEgressHistory({
      account_id: "account-1",
      bucket: "1h",
    });

    expect(getManagedEgressHistoryForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
      project_id: undefined,
      start: undefined,
      end: undefined,
      bucket: "1h",
      recent_event_limit: undefined,
      top_project_limit: undefined,
    });
    expect(result.total_bytes).toBe(123);
  });

  it("requires admin permission to inspect another account", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getManagedEgressHistory } = await import("./purchases");
    await expect(
      getManagedEgressHistory({
        account_id: "viewer-1",
        user_account_id: "account-1",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("rejects project filters that do not belong to the target account", async () => {
    getProjectOwnerAccountIdMock.mockResolvedValue("other-account");

    const { getManagedEgressHistory } = await import("./purchases");
    await expect(
      getManagedEgressHistory({
        account_id: "account-1",
        project_id: "project-1",
      }),
    ).rejects.toThrow("project is not owned by target account");
  });

  it("allows admins to inspect another account's project-scoped history", async () => {
    isAdminMock.mockResolvedValue(true);
    getProjectOwnerAccountIdMock.mockResolvedValue("account-2");
    getManagedEgressHistoryForAccountMock.mockResolvedValue({
      account_id: "account-2",
      project_id: "project-9",
      start: "2026-04-28T00:00:00.000Z",
      end: "2026-04-29T00:00:00.000Z",
      bucket: "5m",
      total_bytes: 4096,
      categories_bytes: { ssh: 4096 },
      points: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedEgressHistory } = await import("./purchases");
    await getManagedEgressHistory({
      account_id: "admin-1",
      user_account_id: "account-2",
      project_id: "project-9",
      bucket: "5m",
      recent_event_limit: 5,
      top_project_limit: 3,
    });

    expect(getManagedEgressHistoryForAccountMock).toHaveBeenCalledWith({
      account_id: "account-2",
      project_id: "project-9",
      start: undefined,
      end: undefined,
      bucket: "5m",
      recent_event_limit: 5,
      top_project_limit: 3,
    });
  });
});
