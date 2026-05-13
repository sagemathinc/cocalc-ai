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
const createMembershipPackageMock = jest.fn();
const getMembershipPackageMock = jest.fn();
const listMembershipPackageDetailsForOwnerMock = jest.fn();
const updateMembershipPackageMock = jest.fn();
const resolveMembershipPackageQuoteMock = jest.fn();
const assignMembershipPackageSeatMock = jest.fn();
const revokeMembershipPackageSeatMock = jest.fn();
const listClaimableMembershipPackagesForAccountMock = jest.fn();
const claimMembershipPackageSeatMock = jest.fn();
const purchaseMembershipPackageMock = jest.fn();
const resolveAccountHomeBayMock = jest.fn();
const interBayGetMembershipDetailsMock = jest.fn();
const interBayGetMembershipPackagesMock = jest.fn();
const interBayAdminProvisionMembershipPackageMock = jest.fn();
const interBayUpdateMembershipPackageMock = jest.fn();
const getBrowserAuthSessionHashMock = jest.fn();
const requireFreshAuthForSessionHashMock = jest.fn();
const assertAccountTrustedForProductAccessMock = jest.fn();

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
  createMembershipPackage: (...args: any[]) =>
    createMembershipPackageMock(...args),
  getMembershipPackage: (...args: any[]) => getMembershipPackageMock(...args),
  listMembershipPackageDetailsForOwner: (...args: any[]) =>
    listMembershipPackageDetailsForOwnerMock(...args),
  updateMembershipPackage: (...args: any[]) =>
    updateMembershipPackageMock(...args),
  resolveMembershipPackageQuote: (...args: any[]) =>
    resolveMembershipPackageQuoteMock(...args),
  assignMembershipPackageSeat: (...args: any[]) =>
    assignMembershipPackageSeatMock(...args),
  revokeMembershipPackageSeat: (...args: any[]) =>
    revokeMembershipPackageSeatMock(...args),
  listClaimableMembershipPackagesForAccount: (...args: any[]) =>
    listClaimableMembershipPackagesForAccountMock(...args),
  claimMembershipPackageSeat: (...args: any[]) =>
    claimMembershipPackageSeatMock(...args),
}));

jest.mock("@cocalc/server/ai/usage-status", () => ({
  getAIUsageStatus: jest.fn(),
}));

jest.mock("@cocalc/server/purchases/membership-package", () => ({
  __esModule: true,
  default: (...args: any[]) => purchaseMembershipPackageMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  getBrowserAuthSessionHash: (...args: any[]) =>
    getBrowserAuthSessionHashMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuthForSessionHash: (...args: any[]) =>
    requireFreshAuthForSessionHashMock(...args),
}));

jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: (...args: any[]) =>
    assertAccountTrustedForProductAccessMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(() => ({ kind: "fabric-client" })),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: jest.fn(({ dest_bay }) => ({
    dest_bay,
    getMembershipDetails: (...args: any[]) =>
      interBayGetMembershipDetailsMock(...args),
    getMembershipPackages: (...args: any[]) =>
      interBayGetMembershipPackagesMock(...args),
    adminProvisionMembershipPackage: (...args: any[]) =>
      interBayAdminProvisionMembershipPackageMock(...args),
    updateMembershipPackage: (...args: any[]) =>
      interBayUpdateMembershipPackageMock(...args),
  })),
}));

beforeEach(() => {
  getBrowserAuthSessionHashMock.mockReset();
  requireFreshAuthForSessionHashMock.mockReset();
  assertAccountTrustedForProductAccessMock.mockReset();
  getBrowserAuthSessionHashMock.mockReturnValue(undefined);
  requireFreshAuthForSessionHashMock.mockResolvedValue(undefined);
  assertAccountTrustedForProductAccessMock.mockResolvedValue(undefined);
});

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

  it("routes another account's membership details to that account's home bay", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "account-2",
      home_bay_id: "bay-2",
      source: "cluster-directory",
    });
    interBayGetMembershipDetailsMock.mockResolvedValue({
      selected: { class: "member", source: "grant", entitlements: {} },
      candidates: [],
      usage_status: undefined,
    });

    const { getMembershipDetails } = await import("./purchases");
    const result = await getMembershipDetails({
      account_id: "admin-1",
      user_account_id: "account-2",
      refresh_usage_status: true,
    });

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      user_account_id: "account-2",
    });
    expect(interBayGetMembershipDetailsMock).toHaveBeenCalledWith({
      account_id: "account-2",
      refresh_usage_status: true,
    });
    expect(resolveMembershipDetailsForAccountMock).not.toHaveBeenCalled();
    expect(result.selected.class).toBe("member");
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

  it("routes another account's package list to that account's home bay", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "owner-1",
      home_bay_id: "bay-2",
      source: "cluster-directory",
    });
    interBayGetMembershipPackagesMock.mockResolvedValue([
      {
        id: "package-remote-1",
        owner_account_id: "owner-1",
        kind: "team",
        membership_class: "member",
        seat_count: 2,
        active_assignment_count: 1,
        available_seat_count: 1,
        assignments: [],
      },
    ]);

    const { getMembershipPackages } = await import("./purchases");
    const result = await getMembershipPackages({
      account_id: "admin-1",
      user_account_id: "owner-1",
    });

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      user_account_id: "owner-1",
    });
    expect(interBayGetMembershipPackagesMock).toHaveBeenCalledWith({
      owner_account_id: "owner-1",
    });
    expect(listMembershipPackageDetailsForOwnerMock).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("package-remote-1");
  });

  it("lets admins provision site licenses without purchase sessions", async () => {
    isAdminMock.mockResolvedValue(true);
    createMembershipPackageMock.mockResolvedValue("site-1");
    listMembershipPackageDetailsForOwnerMock.mockResolvedValue([
      {
        id: "site-1",
        owner_account_id: "admin-1",
        kind: "site",
        membership_class: "pro",
        seat_count: 25,
        active_assignment_count: 0,
        available_seat_count: 25,
        assignments: [],
        metadata: { allowed_domains: ["example.edu"] },
      },
    ]);

    const { adminProvisionMembershipPackage } = await import("./purchases");
    const result = await adminProvisionMembershipPackage({
      account_id: "admin-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 25,
      allowed_domains: ["Example.EDU", "@dept.example.edu"],
    });

    expect(createMembershipPackageMock).toHaveBeenCalledWith({
      owner_account_id: "admin-1",
      kind: "site",
      membership_class: "pro",
      seat_count: 25,
      starts_at: undefined,
      expires_at: undefined,
      metadata: expect.objectContaining({
        allowed_domains: ["dept.example.edu", "example.edu"],
        provisioned_by_account_id: "admin-1",
        provisioned_via: "admin",
      }),
    });
    expect(result.id).toBe("site-1");
    expect(purchaseMembershipPackageMock).not.toHaveBeenCalled();
  });

  it("rejects non-admin site license provisioning", async () => {
    isAdminMock.mockResolvedValue(false);

    const { adminProvisionMembershipPackage } = await import("./purchases");
    await expect(
      adminProvisionMembershipPackage({
        account_id: "user-1",
        kind: "site",
        membership_class: "member",
        seat_count: 5,
        allowed_domains: ["example.edu"],
      }),
    ).rejects.toThrow("must be an admin");

    expect(createMembershipPackageMock).not.toHaveBeenCalled();
  });

  it("routes admin site-license provisioning to the owner's home bay", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "owner-1",
      home_bay_id: "bay-2",
      source: "cluster-directory",
    });
    interBayAdminProvisionMembershipPackageMock.mockResolvedValue({
      id: "site-remote-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 10,
      active_assignment_count: 0,
      available_seat_count: 10,
      assignments: [],
    });

    const { adminProvisionMembershipPackage } = await import("./purchases");
    const result = await adminProvisionMembershipPackage({
      account_id: "admin-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 10,
      allowed_domains: ["example.edu"],
    });

    expect(interBayAdminProvisionMembershipPackageMock).toHaveBeenCalledWith({
      owner_account_id: "owner-1",
      actor_account_id: "admin-1",
      kind: "site",
      membership_class: "member",
      seat_count: 10,
      allowed_domains: ["example.edu"],
      starts_at: undefined,
      expires_at: undefined,
      metadata: null,
    });
    expect(createMembershipPackageMock).not.toHaveBeenCalled();
    expect(result.id).toBe("site-remote-1");
  });

  it("updates site-license allowed domains", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "owner-1",
      home_bay_id: "bay-0",
      source: "cluster-directory",
    });
    getMembershipPackageMock.mockResolvedValue({
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 10,
      metadata: { allowed_domains: ["example.edu"] },
    });
    updateMembershipPackageMock.mockResolvedValue({
      id: "site-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 12,
      active_assignment_count: 0,
      available_seat_count: 12,
      assignments: [],
      metadata: { allowed_domains: ["dept.example.edu", "example.edu"] },
    });

    const { updateMembershipPackage } = await import("./purchases");
    const result = await updateMembershipPackage({
      account_id: "admin-1",
      owner_account_id: "owner-1",
      package_id: "site-1",
      seat_count: 12,
      allowed_domains: ["Example.EDU", "@dept.example.edu"],
    });

    expect(updateMembershipPackageMock).toHaveBeenCalledWith({
      package_id: "site-1",
      seat_count: 12,
      expires_at: undefined,
      allowed_domains: ["dept.example.edu", "example.edu"],
    });
    expect(result.metadata?.allowed_domains).toEqual([
      "dept.example.edu",
      "example.edu",
    ]);
  });

  it("routes site-license allowed domain updates to the owner's home bay", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "owner-1",
      home_bay_id: "bay-2",
      source: "cluster-directory",
    });
    interBayUpdateMembershipPackageMock.mockResolvedValue({
      id: "site-remote-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 10,
      active_assignment_count: 0,
      available_seat_count: 10,
      assignments: [],
      metadata: { allowed_domains: ["dept.example.edu", "example.edu"] },
    });

    const { updateMembershipPackage } = await import("./purchases");
    await updateMembershipPackage({
      account_id: "admin-1",
      owner_account_id: "owner-1",
      package_id: "site-remote-1",
      allowed_domains: ["Example.EDU", "@dept.example.edu"],
    });

    expect(interBayUpdateMembershipPackageMock).toHaveBeenCalledWith({
      package_id: "site-remote-1",
      actor_account_id: "admin-1",
      seat_count: undefined,
      expires_at: undefined,
      allowed_domains: ["dept.example.edu", "example.edu"],
    });
    expect(updateMembershipPackageMock).not.toHaveBeenCalled();
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
    expect(assertAccountTrustedForProductAccessMock).toHaveBeenCalledWith(
      "owner-1",
      "assign membership seats",
    );
    expect(result.id).toBe("assignment-1");
  });

  it("blocks untrusted accounts from assigning package seats", async () => {
    assertAccountTrustedForProductAccessMock.mockRejectedValue(
      new Error("verify"),
    );

    const { assignMembershipPackageSeat } = await import("./purchases");
    await expect(
      assignMembershipPackageSeat({
        account_id: "owner-1",
        package_id: "package-1",
        target_account_id: "student-1",
      }),
    ).rejects.toThrow("verify");

    expect(getMembershipPackageMock).not.toHaveBeenCalled();
    expect(assignMembershipPackageSeatMock).not.toHaveBeenCalled();
  });

  it("assigns a package seat by reserved email for the owner", async () => {
    getMembershipPackageMock.mockResolvedValue({
      id: "package-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 3,
    });
    assignMembershipPackageSeatMock.mockResolvedValue({
      id: "assignment-1",
      package_id: "package-1",
      email_address: "student@example.com",
      assigned_by_account_id: "owner-1",
    });

    const { assignMembershipPackageSeat } = await import("./purchases");
    const result = await assignMembershipPackageSeat({
      account_id: "owner-1",
      package_id: "package-1",
      target_email_address: "student@example.com",
    });

    expect(assignMembershipPackageSeatMock).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: undefined,
      email_address: "student@example.com",
      assigned_by_account_id: "owner-1",
      metadata: null,
    });
    expect(result.email_address).toBe("student@example.com");
  });

  it("purchases a course package for the owner", async () => {
    purchaseMembershipPackageMock.mockResolvedValue({
      package_id: "package-1",
      purchase_id: 17,
    });

    const { purchaseMembershipPackage } = await import("./purchases");
    const result = await purchaseMembershipPackage({
      account_id: "owner-1",
      kind: "course",
      seat_count: 5,
      course_project_id: "course-project-1",
    });

    expect(purchaseMembershipPackageMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      product: {
        type: "membership-package",
        kind: "course",
        membership_class: "",
        seat_count: 5,
        interval: undefined,
        package_id: undefined,
        course_project_id: "course-project-1",
        starts_at: undefined,
        expires_at: undefined,
        metadata: undefined,
      },
    });
    expect(assertAccountTrustedForProductAccessMock).toHaveBeenCalledWith(
      "owner-1",
      "purchase memberships",
    );
    expect(result).toEqual({
      package_id: "package-1",
      purchase_id: 17,
    });
  });

  it("blocks untrusted accounts from purchasing membership packages", async () => {
    assertAccountTrustedForProductAccessMock.mockRejectedValue(
      new Error("verify"),
    );

    const { purchaseMembershipPackage } = await import("./purchases");
    await expect(
      purchaseMembershipPackage({
        account_id: "owner-1",
        kind: "team",
        seat_count: 2,
      }),
    ).rejects.toThrow("verify");

    expect(requireFreshAuthForSessionHashMock).not.toHaveBeenCalled();
    expect(purchaseMembershipPackageMock).not.toHaveBeenCalled();
  });

  it("requires fresh auth for browser membership-package purchases", async () => {
    const { purchaseMembershipPackage } = await import("./purchases");

    await expect(
      purchaseMembershipPackage({
        account_id: "owner-1",
        browser_id: "browser-1",
        kind: "team",
        seat_count: 2,
      }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
    });

    expect(purchaseMembershipPackageMock).not.toHaveBeenCalled();
  });

  it("checks browser-session fresh auth before purchasing a membership package", async () => {
    getBrowserAuthSessionHashMock.mockReturnValue("session-1");
    purchaseMembershipPackageMock.mockResolvedValue({
      package_id: "package-1",
      purchase_id: 17,
    });

    const { purchaseMembershipPackage } = await import("./purchases");
    await purchaseMembershipPackage({
      account_id: "owner-1",
      browser_id: "browser-1",
      kind: "team",
      seat_count: 2,
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      allow_actor_impersonation: true,
      session_hash: "session-1",
    });
    expect(purchaseMembershipPackageMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      product: {
        type: "membership-package",
        kind: "team",
        membership_class: "",
        seat_count: 2,
        interval: undefined,
        package_id: undefined,
        course_project_id: undefined,
        starts_at: undefined,
        expires_at: undefined,
        metadata: undefined,
      },
    });
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
      email_address: undefined,
    });
    expect(result).toEqual({ revoked: true });
  });

  it("loads claimable packages for the signed-in account", async () => {
    listClaimableMembershipPackagesForAccountMock.mockResolvedValue([
      {
        package_id: "package-1",
        kind: "site",
        membership_class: "member",
        owner_account_id: "owner-1",
        available_seat_count: 4,
        matched_email_address: "ada@example.edu",
        reason: "domain-match",
      },
    ]);

    const { getClaimableMembershipPackages } = await import("./purchases");
    const result = await getClaimableMembershipPackages({
      account_id: "account-1",
    });

    expect(listClaimableMembershipPackagesForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(result).toHaveLength(1);
  });

  it("claims a membership package seat for the signed-in account", async () => {
    claimMembershipPackageSeatMock.mockResolvedValue({
      id: "assignment-1",
      package_id: "package-1",
      account_id: "account-1",
    });

    const { claimMembershipPackageSeat } = await import("./purchases");
    const result = await claimMembershipPackageSeat({
      account_id: "account-1",
      package_id: "package-1",
    });

    expect(claimMembershipPackageSeatMock).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "account-1",
    });
    expect(assertAccountTrustedForProductAccessMock).toHaveBeenCalledWith(
      "account-1",
      "claim membership seats",
    );
    expect(result.account_id).toBe("account-1");
  });

  it("blocks untrusted accounts from claiming membership seats", async () => {
    assertAccountTrustedForProductAccessMock.mockRejectedValue(
      new Error("verify"),
    );

    const { claimMembershipPackageSeat } = await import("./purchases");
    await expect(
      claimMembershipPackageSeat({
        account_id: "account-1",
        package_id: "package-1",
      }),
    ).rejects.toThrow("verify");

    expect(claimMembershipPackageSeatMock).not.toHaveBeenCalled();
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
