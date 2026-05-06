/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getManagedEgressHistoryForAccountMock = jest.fn();
const getManagedEgressAdminHistoryMock = jest.fn();
const getManagedEgressAdminOverviewMock = jest.fn();
const getProjectUsageAccountIdMock = jest.fn();
const isAdminMock = jest.fn();
const resolveMembershipDetailsForAccountMock = jest.fn();
const getMembershipPackageMock = jest.fn();
const listMembershipPackageDetailsForOwnerMock = jest.fn();
const resolveMembershipPackageQuoteMock = jest.fn();
const assignMembershipPackageSeatMock = jest.fn();
const revokeMembershipPackageSeatMock = jest.fn();

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
  getManagedEgressAdminHistory: (...args: any[]) =>
    getManagedEgressAdminHistoryMock(...args),
  getManagedEgressAdminOverview: (...args: any[]) =>
    getManagedEgressAdminOverviewMock(...args),
  getProjectUsageAccountId: (...args: any[]) =>
    getProjectUsageAccountIdMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipDetailsForAccount: (...args: any[]) =>
    resolveMembershipDetailsForAccountMock(...args),
  resolveMembershipForAccount: jest.fn(),
}));

jest.mock("@cocalc/server/membership/packages", () => ({
  getMembershipPackage: (...args: any[]) => getMembershipPackageMock(...args),
  listMembershipPackageDetailsForOwner: (...args: any[]) =>
    listMembershipPackageDetailsForOwnerMock(...args),
  resolveMembershipPackageQuote: (...args: any[]) =>
    resolveMembershipPackageQuoteMock(...args),
  assignMembershipPackageSeat: (...args: any[]) =>
    assignMembershipPackageSeatMock(...args),
  revokeMembershipPackageSeat: (...args: any[]) =>
    revokeMembershipPackageSeatMock(...args),
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
    getProjectUsageAccountIdMock.mockResolvedValue("other-account");

    const { getManagedEgressHistory } = await import("./purchases");
    await expect(
      getManagedEgressHistory({
        account_id: "account-1",
        project_id: "project-1",
      }),
    ).rejects.toThrow("project is not attributed to target account");
  });

  it("allows admins to inspect another account's project-scoped history", async () => {
    isAdminMock.mockResolvedValue(true);
    getProjectUsageAccountIdMock.mockResolvedValue("account-2");
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

describe("purchases.getMembershipDetails", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to cached usage-status for the signed-in account", async () => {
    resolveMembershipDetailsForAccountMock.mockResolvedValue({
      selected: { class: "free", source: "free", entitlements: {} },
      candidates: [],
      usage_status: undefined,
    });

    const { getMembershipDetails } = await import("./purchases");
    await getMembershipDetails({
      account_id: "account-1",
    });

    expect(resolveMembershipDetailsForAccountMock).toHaveBeenCalledWith(
      "account-1",
      { refresh_usage_status: undefined },
    );
  });

  it("forwards refresh_usage_status when explicitly requested", async () => {
    resolveMembershipDetailsForAccountMock.mockResolvedValue({
      selected: { class: "free", source: "free", entitlements: {} },
      candidates: [],
      usage_status: undefined,
    });

    const { getMembershipDetails } = await import("./purchases");
    await getMembershipDetails({
      account_id: "account-1",
      refresh_usage_status: true,
    });

    expect(resolveMembershipDetailsForAccountMock).toHaveBeenCalledWith(
      "account-1",
      { refresh_usage_status: true },
    );
  });
});

describe("purchases membership packages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads the signed-in account's packages", async () => {
    listMembershipPackageDetailsForOwnerMock.mockResolvedValue([
      {
        id: "package-1",
        owner_account_id: "account-1",
        kind: "team",
        membership_class: "member",
        seat_count: 3,
        active_assignment_count: 1,
        available_seat_count: 2,
        assignments: [],
      },
    ]);

    const { getMembershipPackages } = await import("./purchases");
    const result = await getMembershipPackages({ account_id: "account-1" });

    expect(listMembershipPackageDetailsForOwnerMock).toHaveBeenCalledWith({
      owner_account_id: "account-1",
    });
    expect(result).toHaveLength(1);
  });

  it("requires ownership or admin rights to quote an existing package", async () => {
    getMembershipPackageMock.mockResolvedValue({
      id: "package-1",
      owner_account_id: "owner-1",
      kind: "team",
      membership_class: "member",
      seat_count: 3,
      metadata: { interval: "month", seat_price: 20 },
    });
    isAdminMock.mockResolvedValue(false);

    const { getMembershipPackageQuote } = await import("./purchases");
    await expect(
      getMembershipPackageQuote({
        account_id: "viewer-1",
        package_id: "package-1",
        kind: "team",
        membership_class: "member",
        seat_count: 1,
        interval: "month",
      }),
    ).rejects.toThrow("must own membership package");
  });

  it("assigns a package seat for the owner", async () => {
    getMembershipPackageMock.mockResolvedValue({
      id: "package-1",
      owner_account_id: "owner-1",
      kind: "team",
      membership_class: "member",
      seat_count: 3,
    });
    assignMembershipPackageSeatMock.mockResolvedValue({
      id: "assignment-1",
      package_id: "package-1",
      account_id: "student-1",
      assigned_by_account_id: "owner-1",
    });

    const { assignMembershipPackageSeat } = await import("./purchases");
    const result = await assignMembershipPackageSeat({
      account_id: "owner-1",
      package_id: "package-1",
      target_account_id: "student-1",
    });

    expect(assignMembershipPackageSeatMock).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "student-1",
      assigned_by_account_id: "owner-1",
      metadata: null,
    });
    expect(result.id).toBe("assignment-1");
  });

  it("revokes a package seat for the owner", async () => {
    getMembershipPackageMock.mockResolvedValue({
      id: "package-1",
      owner_account_id: "owner-1",
      kind: "team",
      membership_class: "member",
      seat_count: 3,
    });
    revokeMembershipPackageSeatMock.mockResolvedValue(true);

    const { revokeMembershipPackageSeat } = await import("./purchases");
    const result = await revokeMembershipPackageSeat({
      account_id: "owner-1",
      package_id: "package-1",
      target_account_id: "student-1",
    });

    expect(revokeMembershipPackageSeatMock).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "student-1",
    });
    expect(result).toEqual({ revoked: true });
  });
});

describe("purchases.getManagedEgressAdminOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getManagedEgressAdminOverview } = await import("./purchases");
    await expect(
      getManagedEgressAdminOverview({
        account_id: "viewer-1",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("loads the admin overview for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    getManagedEgressAdminOverviewMock.mockResolvedValue({
      start: "2026-04-28T00:00:00.000Z",
      end: "2026-04-29T00:00:00.000Z",
      total_bytes: 1234,
      categories_bytes: { "raw-network": 1234 },
      top_accounts: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedEgressAdminOverview } = await import("./purchases");
    const result = await getManagedEgressAdminOverview({
      account_id: "admin-1",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });

    expect(getManagedEgressAdminOverviewMock).toHaveBeenCalledWith({
      start: undefined,
      end: undefined,
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });
    expect(result.total_bytes).toBe(1234);
  });
});

describe("purchases.getManagedEgressAdminHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getManagedEgressAdminHistory } = await import("./purchases");
    await expect(
      getManagedEgressAdminHistory({
        account_id: "viewer-1",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("loads the admin history for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    getManagedEgressAdminHistoryMock.mockResolvedValue({
      start: "2026-04-28T00:00:00.000Z",
      end: "2026-04-29T00:00:00.000Z",
      bucket: "1h",
      total_bytes: 1234,
      categories_bytes: { "raw-network": 1234 },
      points: [],
      top_accounts: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedEgressAdminHistory } = await import("./purchases");
    const result = await getManagedEgressAdminHistory({
      account_id: "admin-1",
      bucket: "1h",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });

    expect(getManagedEgressAdminHistoryMock).toHaveBeenCalledWith({
      start: undefined,
      end: undefined,
      bucket: "1h",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });
    expect(result.total_bytes).toBe(1234);
  });
});
