/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getManagedEgressHistoryForAccountMock = jest.fn();
const getManagedEgressAdminHistoryMock = jest.fn();
const getManagedEgressAdminOverviewMock = jest.fn();
const getManagedCpuAdminHistoryMock = jest.fn();
const getManagedCpuAdminOverviewMock = jest.fn();
const createAbuseReviewAnnotationMock = jest.fn();
const listAbuseReviewAnnotationsMock = jest.fn();
const revokeAbuseReviewAnnotationMock = jest.fn();
const resetAccountUsageEpochMock = jest.fn();
const getAccountUsageOverviewForAccountMock = jest.fn();
const getProjectUsageAccountIdMock = jest.fn();
const isAdminMock = jest.fn();
const resolveMembershipDetailsForAccountMock = jest.fn();
const getMembershipPackageMock = jest.fn();
const listMembershipPackageDetailsForOwnerMock = jest.fn();
const updateMembershipPackageMock = jest.fn();
const resolveMembershipPackageQuoteMock = jest.fn();
const assignMembershipPackageSeatMock = jest.fn();
const revokeMembershipPackageSeatMock = jest.fn();
const listClaimableMembershipPackagesForAccountMock = jest.fn();
const resolveClaimableMembershipPackageOwnerBayMock = jest.fn();
const claimMembershipPackageSeatMock = jest.fn();
const adminProvisionSiteLicenseMock = jest.fn();
const getVerifiedEmailAddressesForAccountMock = jest.fn();
const getSiteLicenseOverviewMock = jest.fn();
const listSiteLicenseOverviewsMock = jest.fn();
const addSiteLicensePoolMock = jest.fn();
const requestSiteLicensePoolMock = jest.fn();
const getSiteLicenseAffiliationReverificationStatusForAccountMock = jest.fn();
const refreshSiteLicenseAffiliationVerificationForAccountMock = jest.fn();
const refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBayMock =
  jest.fn();
const reviewSiteLicensePoolRequestMock = jest.fn();
const updateSiteLicensePoolMock = jest.fn();
const updateSiteLicenseMock = jest.fn();
const setSiteLicenseManagerMock = jest.fn();
const removeSiteLicenseManagerMock = jest.fn();
const purchaseMembershipPackageMock = jest.fn();
const resolveAccountHomeBayMock = jest.fn();
const getClusterAccountByIdDirectMock = jest.fn();
const interBayGetMembershipDetailsMock = jest.fn();
const interBayGetAccountUsageOverviewMock = jest.fn();
const interBayGetMembershipPackagesMock = jest.fn();
const interBayUpdateMembershipPackageMock = jest.fn();
const interBayGetClaimableMembershipPackagesForAccountMock = jest.fn();
const interBayClaimMembershipPackageSeatForAccountMock = jest.fn();
const interBayAdminProvisionSiteLicenseMock = jest.fn();
const interBayGetSiteLicenseOverviewMock = jest.fn();
const interBayListSiteLicenseOverviewsMock = jest.fn();
const interBayAddSiteLicensePoolMock = jest.fn();
const interBayRequestSiteLicensePoolMock = jest.fn();
const interBayRequestSiteLicensePoolForAccountMock = jest.fn();
const interBayReviewSiteLicensePoolRequestMock = jest.fn();
const interBayUpdateSiteLicenseMock = jest.fn();
const interBaySetSiteLicenseManagerMock = jest.fn();
const interBayRemoveSiteLicenseManagerMock = jest.fn();
const interBayGetSiteLicenseAffiliationReverificationStatusForAccountMock =
  jest.fn();
const interBayRefreshSiteLicenseAffiliationVerificationMock = jest.fn();
const interBayRefreshSiteLicenseAffiliationVerificationForAccountMock =
  jest.fn();
const getBrowserAuthSessionHashMock = jest.fn();
const requireFreshAuthForSessionHashMock = jest.fn();
const assertAccountTrustedForProductAccessMock = jest.fn();
const getConfiguredClusterSeedBayIdMock = jest.fn();

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

jest.mock("@cocalc/server/membership/managed-cpu", () => ({
  getManagedCpuAdminHistory: (...args: any[]) =>
    getManagedCpuAdminHistoryMock(...args),
  getManagedCpuAdminOverview: (...args: any[]) =>
    getManagedCpuAdminOverviewMock(...args),
}));

jest.mock("@cocalc/server/membership/abuse-review-annotations", () => ({
  createAbuseReviewAnnotation: (...args: any[]) =>
    createAbuseReviewAnnotationMock(...args),
  listAbuseReviewAnnotations: (...args: any[]) =>
    listAbuseReviewAnnotationsMock(...args),
  revokeAbuseReviewAnnotation: (...args: any[]) =>
    revokeAbuseReviewAnnotationMock(...args),
}));

jest.mock("@cocalc/server/membership/usage-windows", () => ({
  resetAccountUsageEpoch: (...args: any[]) =>
    resetAccountUsageEpochMock(...args),
}));

jest.mock("@cocalc/server/membership/account-usage-overview", () => ({
  getAccountUsageOverviewForAccount: (...args: any[]) =>
    getAccountUsageOverviewForAccountMock(...args),
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
  resolveClaimableMembershipPackageOwnerBay: (...args: any[]) =>
    resolveClaimableMembershipPackageOwnerBayMock(...args),
  claimMembershipPackageSeat: (...args: any[]) =>
    claimMembershipPackageSeatMock(...args),
}));

jest.mock("@cocalc/server/membership/site-licenses", () => ({
  adminProvisionSiteLicense: (...args: any[]) =>
    adminProvisionSiteLicenseMock(...args),
  getVerifiedEmailAddressesForAccount: (...args: any[]) =>
    getVerifiedEmailAddressesForAccountMock(...args),
  getSiteLicenseOverview: (...args: any[]) =>
    getSiteLicenseOverviewMock(...args),
  listSiteLicenseOverviews: (...args: any[]) =>
    listSiteLicenseOverviewsMock(...args),
  addSiteLicensePool: (...args: any[]) => addSiteLicensePoolMock(...args),
  requestSiteLicensePool: (...args: any[]) =>
    requestSiteLicensePoolMock(...args),
  getSiteLicenseAffiliationReverificationStatusForAccount: (...args: any[]) =>
    getSiteLicenseAffiliationReverificationStatusForAccountMock(...args),
  refreshSiteLicenseAffiliationVerificationForAccount: (...args: any[]) =>
    refreshSiteLicenseAffiliationVerificationForAccountMock(...args),
  refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay: (
    ...args: any[]
  ) =>
    refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBayMock(
      ...args,
    ),
  reviewSiteLicensePoolRequest: (...args: any[]) =>
    reviewSiteLicensePoolRequestMock(...args),
  updateSiteLicensePool: (...args: any[]) => updateSiteLicensePoolMock(...args),
  updateSiteLicense: (...args: any[]) => updateSiteLicenseMock(...args),
  setSiteLicenseManager: (...args: any[]) => setSiteLicenseManagerMock(...args),
  removeSiteLicenseManager: (...args: any[]) =>
    removeSiteLicenseManagerMock(...args),
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

jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  getClusterAccountByIdDirect: (...args: any[]) =>
    getClusterAccountByIdDirectMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: (...args: any[]) =>
    getConfiguredClusterSeedBayIdMock(...args),
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
    getAccountUsageOverview: (...args: any[]) =>
      interBayGetAccountUsageOverviewMock(...args),
    getMembershipPackages: (...args: any[]) =>
      interBayGetMembershipPackagesMock(...args),
    updateMembershipPackage: (...args: any[]) =>
      interBayUpdateMembershipPackageMock(...args),
    getClaimableMembershipPackagesForAccount: (...args: any[]) =>
      interBayGetClaimableMembershipPackagesForAccountMock(...args),
    claimMembershipPackageSeatForAccount: (...args: any[]) =>
      interBayClaimMembershipPackageSeatForAccountMock(...args),
    adminProvisionSiteLicense: (...args: any[]) =>
      interBayAdminProvisionSiteLicenseMock(...args),
    getSiteLicenseOverview: (...args: any[]) =>
      interBayGetSiteLicenseOverviewMock(...args),
    listSiteLicenseOverviews: (...args: any[]) =>
      interBayListSiteLicenseOverviewsMock(...args),
    addSiteLicensePool: (...args: any[]) =>
      interBayAddSiteLicensePoolMock(...args),
    requestSiteLicensePool: (...args: any[]) =>
      interBayRequestSiteLicensePoolMock(...args),
    requestSiteLicensePoolForAccount: (...args: any[]) =>
      interBayRequestSiteLicensePoolForAccountMock(...args),
    reviewSiteLicensePoolRequest: (...args: any[]) =>
      interBayReviewSiteLicensePoolRequestMock(...args),
    updateSiteLicense: (...args: any[]) =>
      interBayUpdateSiteLicenseMock(...args),
    setSiteLicenseManager: (...args: any[]) =>
      interBaySetSiteLicenseManagerMock(...args),
    removeSiteLicenseManager: (...args: any[]) =>
      interBayRemoveSiteLicenseManagerMock(...args),
    getSiteLicenseAffiliationReverificationStatusForAccount: (...args: any[]) =>
      interBayGetSiteLicenseAffiliationReverificationStatusForAccountMock(
        ...args,
      ),
    refreshSiteLicenseAffiliationVerification: (...args: any[]) =>
      interBayRefreshSiteLicenseAffiliationVerificationMock(...args),
    refreshSiteLicenseAffiliationVerificationForAccount: (...args: any[]) =>
      interBayRefreshSiteLicenseAffiliationVerificationForAccountMock(...args),
  })),
}));

beforeEach(() => {
  getBrowserAuthSessionHashMock.mockReset();
  requireFreshAuthForSessionHashMock.mockReset();
  assertAccountTrustedForProductAccessMock.mockReset();
  updateSiteLicensePoolMock.mockReset();
  updateSiteLicenseMock.mockReset();
  addSiteLicensePoolMock.mockReset();
  listSiteLicenseOverviewsMock.mockReset();
  setSiteLicenseManagerMock.mockReset();
  removeSiteLicenseManagerMock.mockReset();
  interBayUpdateSiteLicenseMock.mockReset();
  interBayAddSiteLicensePoolMock.mockReset();
  interBayListSiteLicenseOverviewsMock.mockReset();
  interBaySetSiteLicenseManagerMock.mockReset();
  interBayRemoveSiteLicenseManagerMock.mockReset();
  getConfiguredClusterSeedBayIdMock.mockReset();
  resolveAccountHomeBayMock.mockReset();
  getClusterAccountByIdDirectMock.mockReset();
  getBrowserAuthSessionHashMock.mockReturnValue(undefined);
  requireFreshAuthForSessionHashMock.mockResolvedValue(undefined);
  assertAccountTrustedForProductAccessMock.mockResolvedValue(undefined);
  getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-0");
  resolveAccountHomeBayMock.mockResolvedValue({
    account_id: "account-1",
    home_bay_id: "bay-0",
    source: "cluster-directory",
  });
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

  it("routes the signed-in account's membership details to its home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "account-1",
      home_bay_id: "bay-1",
      source: "cluster-directory",
    });
    interBayGetMembershipDetailsMock.mockResolvedValue({
      selected: { class: "student", source: "site-license", entitlements: {} },
      candidates: [],
      usage_status: undefined,
    });

    const { getMembershipDetails } = await import("./purchases");
    const result = await getMembershipDetails({
      account_id: "account-1",
      refresh_usage_status: true,
    });

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "account-1",
      user_account_id: "account-1",
    });
    expect(interBayGetMembershipDetailsMock).toHaveBeenCalledWith({
      account_id: "account-1",
      refresh_usage_status: true,
    });
    expect(resolveMembershipDetailsForAccountMock).not.toHaveBeenCalled();
    expect(result.selected.class).toBe("student");
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

describe("purchases.getAccountUsageOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads the signed-in account overview on the account home bay", async () => {
    getAccountUsageOverviewForAccountMock.mockResolvedValue({
      collected_at: "2026-06-02T12:00:00.000Z",
      summary: {},
      meters: [],
      recent_events: {},
      measurement_warnings: [],
    });

    const { getAccountUsageOverview } = await import("./purchases");
    const result = await getAccountUsageOverview({
      account_id: "account-1",
    });

    expect(getAccountUsageOverviewForAccountMock).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(result.collected_at).toBe("2026-06-02T12:00:00.000Z");
  });

  it("routes another account overview to that account's home bay for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "account-2",
      home_bay_id: "bay-2",
      source: "cluster-directory",
    });
    interBayGetAccountUsageOverviewMock.mockResolvedValue({
      collected_at: "2026-06-02T12:00:00.000Z",
      membership_label: "member",
      summary: {},
      meters: [],
      recent_events: {},
      measurement_warnings: [],
    });

    const { getAccountUsageOverview } = await import("./purchases");
    const result = await getAccountUsageOverview({
      account_id: "admin-1",
      user_account_id: "account-2",
    });

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      user_account_id: "account-2",
    });
    expect(interBayGetAccountUsageOverviewMock).toHaveBeenCalledWith({
      account_id: "account-2",
    });
    expect(getAccountUsageOverviewForAccountMock).not.toHaveBeenCalled();
    expect(result.membership_label).toBe("member");
  });

  it("does not allow non-admins to load another account overview", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getAccountUsageOverview } = await import("./purchases");
    await expect(
      getAccountUsageOverview({
        account_id: "account-1",
        user_account_id: "account-2",
      }),
    ).rejects.toThrow("must be an admin");

    expect(getAccountUsageOverviewForAccountMock).not.toHaveBeenCalled();
    expect(interBayGetAccountUsageOverviewMock).not.toHaveBeenCalled();
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

  it("routes admin pool-based site-license provisioning to the seed bay", async () => {
    isAdminMock.mockResolvedValue(true);
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayAdminProvisionSiteLicenseMock.mockResolvedValue({
      site_license: {
        id: "license-remote-1",
        owner_account_id: "owner-1",
        name: "Example Campus",
        organization_name: "Example University",
        allowed_domains: ["example.edu"],
      },
      pools: [],
      managers: [],
      pending_requests: [],
    });

    const { adminProvisionSiteLicense } = await import("./purchases");
    const result = await adminProvisionSiteLicense({
      account_id: "admin-1",
      session_hash: "session-1",
      bay_id: "bay-0",
      owner_account_id: "owner-1",
      name: "Example Campus",
      organization_name: "Example University",
      allowed_domains: ["example.edu"],
      pools: [
        {
          pool_name: "Students",
          membership_class: "member",
          seat_count: 100,
          requires_approval: false,
          verification_policy: "email-domain",
        },
      ],
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "session-1",
      allow_actor_impersonation: false,
    });
    expect(interBayAdminProvisionSiteLicenseMock).toHaveBeenCalledWith({
      actor_account_id: "admin-1",
      bay_id: "bay-0",
      owner_account_id: "owner-1",
      name: "Example Campus",
      organization_name: "Example University",
      allowed_domains: ["example.edu"],
      pools: [
        {
          pool_name: "Students",
          membership_class: "member",
          seat_count: 100,
          requires_approval: false,
          verification_policy: "email-domain",
        },
      ],
      custom_terms_url: undefined,
      custom_policy_url: undefined,
      terms_version_label: undefined,
      renewal_policy: undefined,
      overage_policy: undefined,
      starts_at: undefined,
      expires_at: undefined,
      metadata: undefined,
    });
    expect(adminProvisionSiteLicenseMock).not.toHaveBeenCalled();
    expect(result.site_license.id).toBe("license-remote-1");
  });

  it("requires fresh auth before admin site-license provisioning", async () => {
    isAdminMock.mockResolvedValue(true);

    const { adminProvisionSiteLicense } = await import("./purchases");
    await expect(
      adminProvisionSiteLicense({
        account_id: "admin-1",
        bay_id: "bay-0",
        owner_account_id: "owner-1",
        name: "Example Campus",
        organization_name: "Example University",
        allowed_domains: ["example.edu"],
      }),
    ).rejects.toMatchObject({
      code: "fresh_auth_required",
    });

    expect(resolveAccountHomeBayMock).not.toHaveBeenCalled();
    expect(interBayAdminProvisionSiteLicenseMock).not.toHaveBeenCalled();
    expect(adminProvisionSiteLicenseMock).not.toHaveBeenCalled();
  });

  it("blocks impersonated admin sessions before site-license provisioning", async () => {
    isAdminMock.mockResolvedValue(true);
    requireFreshAuthForSessionHashMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "cannot perform this dangerous operation while impersonating another account",
        ),
        { code: "impersonation_blocked" },
      ),
    );

    const { adminProvisionSiteLicense } = await import("./purchases");
    await expect(
      adminProvisionSiteLicense({
        account_id: "admin-1",
        session_hash: "session-1",
        bay_id: "bay-0",
        owner_account_id: "owner-1",
        name: "Example Campus",
        organization_name: "Example University",
        allowed_domains: ["example.edu"],
      }),
    ).rejects.toMatchObject({
      code: "impersonation_blocked",
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "session-1",
      allow_actor_impersonation: false,
    });
    expect(interBayAdminProvisionSiteLicenseMock).not.toHaveBeenCalled();
    expect(adminProvisionSiteLicenseMock).not.toHaveBeenCalled();
  });

  it("routes site-license overview to the seed bay", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayGetSiteLicenseOverviewMock.mockResolvedValue({
      site_license: {
        id: "license-remote-1",
        owner_account_id: "owner-1",
        name: "Example Campus",
        organization_name: "Example University",
        allowed_domains: ["example.edu"],
      },
      pools: [],
      managers: [],
      pending_requests: [],
    });

    const { getSiteLicenseOverview } = await import("./purchases");
    const result = await getSiteLicenseOverview({
      account_id: "manager-1",
      owner_account_id: "owner-1",
      site_license_id: "license-remote-1",
    });

    expect(interBayGetSiteLicenseOverviewMock).toHaveBeenCalledWith({
      account_id: "manager-1",
      site_license_id: "license-remote-1",
    });
    expect(getSiteLicenseOverviewMock).not.toHaveBeenCalled();
    expect(result.site_license.id).toBe("license-remote-1");
  });

  it("lists site-license overviews locally on the seed bay", async () => {
    isAdminMock.mockResolvedValue(true);
    listSiteLicenseOverviewsMock.mockResolvedValue([
      { site_license: { id: "license-1" } },
    ]);

    const { listSiteLicenseOverviews } = await import("./purchases");
    const result = await listSiteLicenseOverviews({
      account_id: "admin-1",
      admin: true,
    });

    expect(listSiteLicenseOverviewsMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      admin: true,
    });
    expect(interBayListSiteLicenseOverviewsMock).not.toHaveBeenCalled();
    expect(result).toEqual([{ site_license: { id: "license-1" } }]);
  });

  it("routes site-license overview lists to the seed bay", async () => {
    isAdminMock.mockResolvedValue(true);
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayListSiteLicenseOverviewsMock.mockResolvedValue([
      { site_license: { id: "license-remote-1" } },
    ]);

    const { listSiteLicenseOverviews } = await import("./purchases");
    const result = await listSiteLicenseOverviews({
      account_id: "admin-1",
      admin: true,
    });

    expect(interBayListSiteLicenseOverviewsMock).toHaveBeenCalledWith({
      actor_account_id: "admin-1",
      admin: true,
      trusted_admin: true,
    });
    expect(listSiteLicenseOverviewsMock).not.toHaveBeenCalled();
    expect(result).toEqual([{ site_license: { id: "license-remote-1" } }]);
  });

  it("blocks non-admin site-license overview lists before routing to seed", async () => {
    isAdminMock.mockResolvedValue(false);
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");

    const { listSiteLicenseOverviews } = await import("./purchases");
    await expect(
      listSiteLicenseOverviews({
        account_id: "user-1",
        admin: true,
      }),
    ).rejects.toThrow("must be an admin");

    expect(interBayListSiteLicenseOverviewsMock).not.toHaveBeenCalled();
    expect(listSiteLicenseOverviewsMock).not.toHaveBeenCalled();
  });

  it("routes site-license setting and manager edits to the seed bay", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayUpdateSiteLicenseMock.mockResolvedValue({
      site_license: { id: "license-remote-1", name: "Updated" },
      pools: [],
      managers: [],
      pending_requests: [],
    });
    interBaySetSiteLicenseManagerMock.mockResolvedValue({
      site_license: { id: "license-remote-1" },
      pools: [],
      managers: [{ account_id: "manager-2", role: "manager" }],
      pending_requests: [],
    });
    interBayRemoveSiteLicenseManagerMock.mockResolvedValue({
      site_license: { id: "license-remote-1" },
      pools: [],
      managers: [],
      pending_requests: [],
    });

    const {
      updateSiteLicense,
      setSiteLicenseManager,
      removeSiteLicenseManager,
    } = await import("./purchases");
    getBrowserAuthSessionHashMock.mockReturnValue("fresh-session-1");
    await updateSiteLicense({
      account_id: "manager-1",
      browser_id: "browser-1",
      site_license_id: "license-remote-1",
      name: "Updated",
      allowed_domains: ["Example.EDU"],
    });
    await setSiteLicenseManager({
      account_id: "manager-1",
      browser_id: "browser-1",
      site_license_id: "license-remote-1",
      target_account_id: "manager-2",
      role: "manager",
    });
    await removeSiteLicenseManager({
      account_id: "manager-1",
      browser_id: "browser-1",
      site_license_id: "license-remote-1",
      target_account_id: "manager-2",
    });

    expect(interBayUpdateSiteLicenseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_account_id: "manager-1",
        site_license_id: "license-remote-1",
        name: "Updated",
        allowed_domains: ["example.edu"],
      }),
    );
    expect(getBrowserAuthSessionHashMock).toHaveBeenCalledWith({
      account_id: "manager-1",
      browser_id: "browser-1",
    });
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "manager-1",
      session_hash: "fresh-session-1",
      allow_actor_impersonation: false,
    });
    expect(interBaySetSiteLicenseManagerMock).toHaveBeenCalledWith({
      actor_account_id: "manager-1",
      site_license_id: "license-remote-1",
      target_account_id: "manager-2",
      role: "manager",
    });
    expect(interBayRemoveSiteLicenseManagerMock).toHaveBeenCalledWith({
      actor_account_id: "manager-1",
      site_license_id: "license-remote-1",
      target_account_id: "manager-2",
    });
  });

  it("routes site-license pool creation to the seed bay with fresh auth", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayAddSiteLicensePoolMock.mockResolvedValue({
      site_license: { id: "license-remote-1" },
      pools: [{ id: "pool-2", pool_name: "Researchers" }],
      managers: [],
      pending_requests: [],
    });

    const { addSiteLicensePool } = await import("./purchases");
    getBrowserAuthSessionHashMock.mockReturnValueOnce("fresh-session-2");
    await addSiteLicensePool({
      account_id: "manager-1",
      browser_id: "browser-1",
      site_license_id: "license-remote-1",
      pool: {
        pool_name: "Researchers",
        membership_class: "researcher",
        seat_count: 5,
        requires_approval: true,
        verification_policy: "email-domain",
        exclusive_group: "research",
      },
    });

    expect(interBayAddSiteLicensePoolMock).toHaveBeenCalledWith({
      actor_account_id: "manager-1",
      site_license_id: "license-remote-1",
      pool: expect.objectContaining({
        pool_name: "Researchers",
        membership_class: "researcher",
        seat_count: 5,
      }),
    });
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "manager-1",
      session_hash: "fresh-session-2",
      allow_actor_impersonation: false,
    });
    expect(addSiteLicensePoolMock).not.toHaveBeenCalled();
  });

  it("routes site-license pool requests to the seed bay with requester verified emails", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    resolveAccountHomeBayMock.mockResolvedValueOnce({
      account_id: "student-1",
      home_bay_id: "bay-0",
      source: "cluster-directory",
    });
    getVerifiedEmailAddressesForAccountMock.mockResolvedValue([
      "student@example.edu",
    ]);
    interBayRequestSiteLicensePoolMock.mockResolvedValue({
      id: "request-remote-1",
      site_license_id: "license-remote-1",
      package_id: "pool-remote-1",
      account_id: "student-1",
      matched_email_address: "student@example.edu",
      canonical_identity: "student@example.edu",
      requested_membership_class: "member",
      state: "pending",
    });

    const { requestSiteLicensePool } = await import("./purchases");
    const result = await requestSiteLicensePool({
      account_id: "student-1",
      owner_account_id: "owner-1",
      package_id: "pool-remote-1",
      requester_note: "Teaching assistant",
      accepted_terms: true,
    });

    expect(getVerifiedEmailAddressesForAccountMock).toHaveBeenCalledWith(
      "student-1",
    );
    expect(interBayRequestSiteLicensePoolMock).toHaveBeenCalledWith({
      account_id: "student-1",
      package_id: "pool-remote-1",
      verified_email_addresses: ["student@example.edu"],
      requester_note: "Teaching assistant",
      accepted_terms: true,
    });
    expect(requestSiteLicensePoolMock).not.toHaveBeenCalled();
    expect(result.id).toBe("request-remote-1");
  });

  it("routes site-license pool requests to seed even when claimant cannot inspect owner", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    resolveAccountHomeBayMock.mockResolvedValueOnce({
      account_id: "student-1",
      home_bay_id: "bay-0",
      source: "cluster-directory",
    });
    getVerifiedEmailAddressesForAccountMock.mockResolvedValue([
      "student@example.edu",
    ]);
    interBayRequestSiteLicensePoolMock.mockResolvedValue({
      id: "request-remote-1",
      site_license_id: "license-remote-1",
      package_id: "pool-remote-1",
      account_id: "student-1",
      matched_email_address: "student@example.edu",
      canonical_identity: "student@example.edu",
      requested_membership_class: "member",
      state: "pending",
    });

    const { requestSiteLicensePool } = await import("./purchases");
    const result = await requestSiteLicensePool({
      account_id: "student-1",
      owner_account_id: "owner-1",
      package_id: "pool-remote-1",
      accepted_terms: true,
    });

    expect(getClusterAccountByIdDirectMock).not.toHaveBeenCalled();
    expect(interBayRequestSiteLicensePoolMock).toHaveBeenCalledWith({
      account_id: "student-1",
      package_id: "pool-remote-1",
      verified_email_addresses: ["student@example.edu"],
      requester_note: undefined,
      accepted_terms: true,
    });
    expect(requestSiteLicensePoolMock).not.toHaveBeenCalled();
    expect(result.id).toBe("request-remote-1");
  });

  it("does not need claimable package owner lookup when routing site-license requests", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    resolveAccountHomeBayMock.mockResolvedValueOnce({
      account_id: "student-1",
      home_bay_id: "bay-0",
      source: "cluster-directory",
    });
    getVerifiedEmailAddressesForAccountMock.mockResolvedValue([
      "student@example.edu",
    ]);
    interBayRequestSiteLicensePoolMock.mockResolvedValue({
      id: "request-remote-1",
      site_license_id: "license-remote-1",
      package_id: "pool-remote-1",
      account_id: "student-1",
      matched_email_address: "student@example.edu",
      canonical_identity: "student@example.edu",
      requested_membership_class: "member",
      state: "pending",
    });

    const { requestSiteLicensePool } = await import("./purchases");
    const result = await requestSiteLicensePool({
      account_id: "student-1",
      owner_account_id: "owner-1",
      package_id: "pool-remote-1",
      accepted_terms: true,
    });

    expect(
      resolveClaimableMembershipPackageOwnerBayMock,
    ).not.toHaveBeenCalled();
    expect(interBayRequestSiteLicensePoolMock).toHaveBeenCalledWith({
      account_id: "student-1",
      package_id: "pool-remote-1",
      verified_email_addresses: ["student@example.edu"],
      requester_note: undefined,
      accepted_terms: true,
    });
    expect(requestSiteLicensePoolMock).not.toHaveBeenCalled();
    expect(result.id).toBe("request-remote-1");
  });

  it("routes site-license pool requests to the signed-in account's home bay first", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "student-1",
      home_bay_id: "bay-1",
      source: "cluster-directory",
    });
    interBayRequestSiteLicensePoolForAccountMock.mockResolvedValue({
      id: "request-home-1",
      site_license_id: "license-remote-1",
      package_id: "pool-remote-1",
      account_id: "student-1",
      matched_email_address: "student@example.edu",
      canonical_identity: "student@example.edu",
      requested_membership_class: "member",
      state: "pending",
    });

    const { requestSiteLicensePool } = await import("./purchases");
    const result = await requestSiteLicensePool({
      account_id: "student-1",
      owner_account_id: "owner-1",
      package_id: "pool-remote-1",
      requester_note: "Instructor",
      accepted_terms: true,
    });

    expect(interBayRequestSiteLicensePoolForAccountMock).toHaveBeenCalledWith({
      account_id: "student-1",
      owner_account_id: "owner-1",
      package_id: "pool-remote-1",
      requester_note: "Instructor",
      accepted_terms: true,
    });
    expect(getVerifiedEmailAddressesForAccountMock).not.toHaveBeenCalled();
    expect(interBayRequestSiteLicensePoolMock).not.toHaveBeenCalled();
    expect(requestSiteLicensePoolMock).not.toHaveBeenCalled();
    expect(result.id).toBe("request-home-1");
  });

  it("routes site-license pool request reviews to the seed bay", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    interBayReviewSiteLicensePoolRequestMock.mockResolvedValue({
      id: "request-remote-1",
      site_license_id: "license-remote-1",
      package_id: "pool-remote-1",
      account_id: "student-1",
      matched_email_address: "student@example.edu",
      canonical_identity: "student@example.edu",
      requested_membership_class: "member",
      state: "approved",
      reviewer_account_id: "manager-1",
    });

    const { reviewSiteLicensePoolRequest } = await import("./purchases");
    getBrowserAuthSessionHashMock.mockReturnValueOnce("fresh-review-session");
    const result = await reviewSiteLicensePoolRequest({
      account_id: "manager-1",
      browser_id: "browser-1",
      owner_account_id: "owner-1",
      request_id: "request-remote-1",
      action: "approve",
      review_note: "Approved",
    });

    expect(interBayReviewSiteLicensePoolRequestMock).toHaveBeenCalledWith({
      actor_account_id: "manager-1",
      request_id: "request-remote-1",
      action: "approve",
      review_note: "Approved",
    });
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "manager-1",
      session_hash: "fresh-review-session",
      allow_actor_impersonation: false,
    });
    expect(reviewSiteLicensePoolRequestMock).not.toHaveBeenCalled();
    expect(result.state).toBe("approved");
  });

  it("requires fresh auth before reviewing site-license pool requests", async () => {
    const { reviewSiteLicensePoolRequest } = await import("./purchases");
    await expect(
      reviewSiteLicensePoolRequest({
        account_id: "manager-1",
        browser_id: "browser-1",
        request_id: "request-1",
        action: "approve",
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });
    expect(reviewSiteLicensePoolRequestMock).not.toHaveBeenCalled();
    expect(interBayReviewSiteLicensePoolRequestMock).not.toHaveBeenCalled();
  });

  it("routes site-license reverification status to the account home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "student-1",
      home_bay_id: "bay-1",
      source: "cluster-directory",
    });
    interBayGetSiteLicenseAffiliationReverificationStatusForAccountMock.mockResolvedValue(
      {
        seats: [],
        pending_count: 0,
        grace_expired_count: 0,
        next_reverification_due_at: null,
        next_reverification_grace_expires_at: null,
      },
    );

    const { getSiteLicenseAffiliationReverificationStatus } =
      await import("./purchases");
    const result = await getSiteLicenseAffiliationReverificationStatus({
      account_id: "student-1",
    });

    expect(
      interBayGetSiteLicenseAffiliationReverificationStatusForAccountMock,
    ).toHaveBeenCalledWith({ account_id: "student-1" });
    expect(
      getSiteLicenseAffiliationReverificationStatusForAccountMock,
    ).not.toHaveBeenCalled();
    expect(result.pending_count).toBe(0);
  });

  it("routes site-license affiliation refresh from account home to the seed bay", async () => {
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-2");
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "student-1",
      home_bay_id: "bay-0",
      source: "cluster-directory",
    });
    getSiteLicenseAffiliationReverificationStatusForAccountMock.mockResolvedValue(
      {
        seats: [
          {
            site_license_id: "license-1",
            package_id: "package-1",
            assignment_id: "assignment-1",
            account_id: "student-1",
            membership_class: "student",
            pool_name: "Students",
            exclusive_group: "teaching",
            verification_policy: "email-domain",
            matched_email_address: "student@example.edu",
            state: "pending_reverification",
            site_license_owner_account_id: "owner-1",
            can_refresh_with_verified_email: true,
          },
        ],
        pending_count: 1,
        grace_expired_count: 0,
        next_reverification_due_at: null,
        next_reverification_grace_expires_at: null,
      },
    );
    getVerifiedEmailAddressesForAccountMock.mockResolvedValue([
      "student@example.edu",
    ]);
    interBayRefreshSiteLicenseAffiliationVerificationMock.mockResolvedValue([
      {
        site_license_id: "license-1",
        package_id: "package-1",
        assignment_id: "assignment-1",
        account_id: "student-1",
        membership_class: "student",
        exclusive_group: "teaching",
        verification_policy: "email-domain",
        state: "current",
      },
    ]);

    const { refreshSiteLicenseAffiliationVerification } =
      await import("./purchases");
    const result = await refreshSiteLicenseAffiliationVerification({
      account_id: "student-1",
    });

    expect(
      interBayRefreshSiteLicenseAffiliationVerificationMock,
    ).toHaveBeenCalledWith({
      account_id: "student-1",
      site_license_id: "license-1",
      verified_email_addresses: ["student@example.edu"],
    });
    expect(result).toEqual([
      expect.objectContaining({
        site_license_id: "license-1",
        state: "current",
      }),
    ]);
  });

  it("updates seed site-license pool domains", async () => {
    isAdminMock.mockResolvedValue(true);
    getBrowserAuthSessionHashMock.mockReturnValue("fresh-session-1");
    updateSiteLicensePoolMock.mockResolvedValue({
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
      browser_id: "browser-1",
      owner_account_id: "owner-1",
      site_license_id: "license-1",
      package_id: "site-1",
      seat_count: 12,
      allowed_domains: ["Example.EDU", "@dept.example.edu"],
    });

    expect(updateSiteLicensePoolMock).toHaveBeenCalledWith({
      actor_account_id: "admin-1",
      package_id: "site-1",
      seat_count: 12,
      expires_at: undefined,
      allowed_domains: ["dept.example.edu", "example.edu"],
    });
    expect(getBrowserAuthSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      browser_id: "browser-1",
    });
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-1",
      allow_actor_impersonation: false,
    });
    expect(result.metadata?.allowed_domains).toEqual([
      "dept.example.edu",
      "example.edu",
    ]);
  });

  it("requires fresh auth for seed site-license pool updates", async () => {
    isAdminMock.mockResolvedValue(true);

    const { updateMembershipPackage } = await import("./purchases");
    await expect(
      updateMembershipPackage({
        account_id: "admin-1",
        owner_account_id: "owner-1",
        site_license_id: "license-1",
        package_id: "site-1",
        seat_count: 12,
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });
    expect(updateSiteLicensePoolMock).not.toHaveBeenCalled();
  });

  it("routes site-license pool updates to the seed bay", async () => {
    isAdminMock.mockResolvedValue(true);
    getConfiguredClusterSeedBayIdMock.mockReturnValue("bay-9");
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
      session_hash: "fresh-session-1",
      owner_account_id: "owner-1",
      site_license_id: "license-1",
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
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-1",
      allow_actor_impersonation: false,
    });
    expect(resolveAccountHomeBayMock).not.toHaveBeenCalled();
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
      session_hash: "session-1",
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
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      allow_actor_impersonation: false,
      session_hash: "session-1",
    });
    expect(result.id).toBe("assignment-1");
  });

  it("requires fresh auth before assigning a package seat", async () => {
    requireFreshAuthForSessionHashMock.mockRejectedValueOnce(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );

    const { assignMembershipPackageSeat } = await import("./purchases");
    await expect(
      assignMembershipPackageSeat({
        account_id: "owner-1",
        session_hash: "stale-session",
        package_id: "package-1",
        target_account_id: "student-1",
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });

    expect(getMembershipPackageMock).not.toHaveBeenCalled();
    expect(assignMembershipPackageSeatMock).not.toHaveBeenCalled();
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
      kind: "team",
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
      session_hash: "session-1",
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

  it("blocks direct public assignment into site-license pools", async () => {
    getMembershipPackageMock.mockResolvedValue({
      id: "site-package-1",
      owner_account_id: "owner-1",
      kind: "site",
      membership_class: "member",
      seat_count: 3,
      metadata: {
        site_license_id: "site-license-1",
        allowed_domains: ["example.edu"],
      },
    });

    const { assignMembershipPackageSeat } = await import("./purchases");
    await expect(
      assignMembershipPackageSeat({
        account_id: "owner-1",
        session_hash: "session-1",
        package_id: "site-package-1",
        target_email_address: "student@example.edu",
      }),
    ).rejects.toThrow(
      "site-license seats must be claimed or approved through site-license workflows",
    );

    expect(assignMembershipPackageSeatMock).not.toHaveBeenCalled();
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
      session_hash: "session-1",
      package_id: "package-1",
      target_account_id: "student-1",
    });

    expect(revokeMembershipPackageSeatMock).toHaveBeenCalledWith({
      package_id: "package-1",
      account_id: "student-1",
      email_address: undefined,
    });
    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      allow_actor_impersonation: false,
      session_hash: "session-1",
    });
    expect(result).toEqual({ revoked: true });
  });

  it("requires fresh auth before revoking a package seat", async () => {
    requireFreshAuthForSessionHashMock.mockRejectedValueOnce(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );

    const { revokeMembershipPackageSeat } = await import("./purchases");
    await expect(
      revokeMembershipPackageSeat({
        account_id: "owner-1",
        session_hash: "stale-session",
        package_id: "package-1",
        target_account_id: "student-1",
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });

    expect(getMembershipPackageMock).not.toHaveBeenCalled();
    expect(revokeMembershipPackageSeatMock).not.toHaveBeenCalled();
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

  it("routes claimable package lookup to the signed-in account's home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "account-1",
      home_bay_id: "bay-1",
      source: "cluster-directory",
    });
    interBayGetClaimableMembershipPackagesForAccountMock.mockResolvedValue([
      {
        package_id: "package-remote-1",
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

    expect(resolveAccountHomeBayMock).toHaveBeenCalledWith({
      account_id: "account-1",
      user_account_id: "account-1",
    });
    expect(
      interBayGetClaimableMembershipPackagesForAccountMock,
    ).toHaveBeenCalledWith({
      account_id: "account-1",
    });
    expect(
      listClaimableMembershipPackagesForAccountMock,
    ).not.toHaveBeenCalled();
    expect(result[0]?.package_id).toBe("package-remote-1");
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

  it("routes package seat claims to the signed-in account's home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({
      account_id: "account-1",
      home_bay_id: "bay-1",
      source: "cluster-directory",
    });
    interBayClaimMembershipPackageSeatForAccountMock.mockResolvedValue({
      id: "assignment-remote-1",
      package_id: "package-1",
      account_id: "account-1",
    });

    const { claimMembershipPackageSeat } = await import("./purchases");
    const result = await claimMembershipPackageSeat({
      account_id: "account-1",
      package_id: "package-1",
      accepted_terms: true,
    });

    expect(
      interBayClaimMembershipPackageSeatForAccountMock,
    ).toHaveBeenCalledWith({
      account_id: "account-1",
      package_id: "package-1",
      accepted_terms: true,
    });
    expect(assertAccountTrustedForProductAccessMock).not.toHaveBeenCalled();
    expect(claimMembershipPackageSeatMock).not.toHaveBeenCalled();
    expect(result.id).toBe("assignment-remote-1");
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

describe("purchases.getManagedCpuAdminOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getManagedCpuAdminOverview } = await import("./purchases");
    await expect(
      getManagedCpuAdminOverview({
        account_id: "viewer-1",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("loads the CPU admin overview for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    getManagedCpuAdminOverviewMock.mockResolvedValue({
      start: "2026-05-30T00:00:00.000Z",
      end: "2026-05-31T00:00:00.000Z",
      total_cpu_seconds: 3600,
      top_accounts: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedCpuAdminOverview } = await import("./purchases");
    const result = await getManagedCpuAdminOverview({
      account_id: "admin-1",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });

    expect(getManagedCpuAdminOverviewMock).toHaveBeenCalledWith({
      start: undefined,
      end: undefined,
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });
    expect(result.total_cpu_seconds).toBe(3600);
  });
});

describe("purchases.getManagedCpuAdminHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission", async () => {
    isAdminMock.mockResolvedValue(false);

    const { getManagedCpuAdminHistory } = await import("./purchases");
    await expect(
      getManagedCpuAdminHistory({
        account_id: "viewer-1",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("loads filtered CPU history for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    getProjectUsageAccountIdMock.mockResolvedValue("acct-1");
    getManagedCpuAdminHistoryMock.mockResolvedValue({
      start: "2026-05-30T00:00:00.000Z",
      end: "2026-05-31T00:00:00.000Z",
      bucket: "1h",
      total_cpu_seconds: 3600,
      points: [],
      top_accounts: [],
      top_projects: [],
      recent_events: [],
    });

    const { getManagedCpuAdminHistory } = await import("./purchases");
    const result = await getManagedCpuAdminHistory({
      account_id: "admin-1",
      user_account_id: "acct-1",
      project_id: "project-1",
      bucket: "1h",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });

    expect(getProjectUsageAccountIdMock).toHaveBeenCalledWith("project-1");
    expect(getManagedCpuAdminHistoryMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "project-1",
      start: undefined,
      end: undefined,
      bucket: "1h",
      top_account_limit: 5,
      top_project_limit: 7,
      recent_event_limit: 9,
    });
    expect(result.total_cpu_seconds).toBe(3600);
  });

  it("rejects a project that is not attributed to the filtered account", async () => {
    isAdminMock.mockResolvedValue(true);
    getProjectUsageAccountIdMock.mockResolvedValue("other-account");

    const { getManagedCpuAdminHistory } = await import("./purchases");
    await expect(
      getManagedCpuAdminHistory({
        account_id: "admin-1",
        user_account_id: "acct-1",
        project_id: "project-1",
      }),
    ).rejects.toThrow("project is not attributed to target account");
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

describe("purchases abuse review annotations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission to create annotations", async () => {
    isAdminMock.mockResolvedValue(false);

    const { createAbuseReviewAnnotation } = await import("./purchases");
    await expect(
      createAbuseReviewAnnotation({
        account_id: "viewer-1",
        user_account_id: "acct-1",
        reason: "reviewed",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("creates a normal annotation without fresh auth", async () => {
    isAdminMock.mockResolvedValue(true);
    createAbuseReviewAnnotationMock.mockResolvedValue({
      id: "annotation-1",
      account_id: "acct-1",
      category: "cpu",
      disposition: "legitimate",
      priority_adjustment: "lower",
      reason: "legitimate computation",
      created_by: "admin-1",
      created_at: "2026-05-31T00:00:00.000Z",
    });

    const { createAbuseReviewAnnotation } = await import("./purchases");
    const result = await createAbuseReviewAnnotation({
      account_id: "admin-1",
      user_account_id: "acct-1",
      project_id: "project-1",
      category: "cpu",
      disposition: "legitimate",
      priority_adjustment: "lower",
      reason: "legitimate computation",
      evidence: { cpu_seconds: 3600 },
    });

    expect(requireFreshAuthForSessionHashMock).not.toHaveBeenCalled();
    expect(createAbuseReviewAnnotationMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "project-1",
      category: "cpu",
      disposition: "legitimate",
      priority_adjustment: "lower",
      reason: "legitimate computation",
      evidence: { cpu_seconds: 3600 },
      created_by: "admin-1",
      expires_at: undefined,
    });
    expect(result.id).toBe("annotation-1");
  });

  it("requires fresh auth for abusive or urgent annotations", async () => {
    isAdminMock.mockResolvedValue(true);
    getBrowserAuthSessionHashMock.mockReturnValue("fresh-session-1");
    createAbuseReviewAnnotationMock.mockResolvedValue({
      id: "annotation-2",
      account_id: "acct-1",
      category: "cpu",
      disposition: "abusive",
      priority_adjustment: "urgent",
      reason: "crypto mining",
      created_by: "admin-1",
      created_at: "2026-05-31T00:00:00.000Z",
    });

    const { createAbuseReviewAnnotation } = await import("./purchases");
    await createAbuseReviewAnnotation({
      account_id: "admin-1",
      browser_id: "browser-1",
      user_account_id: "acct-1",
      disposition: "abusive",
      priority_adjustment: "urgent",
      reason: "crypto mining",
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-1",
      allow_actor_impersonation: false,
    });
  });

  it("lists and revokes annotations for admins", async () => {
    isAdminMock.mockResolvedValue(true);
    getBrowserAuthSessionHashMock.mockReturnValue("fresh-session-2");
    listAbuseReviewAnnotationsMock.mockResolvedValue([]);
    revokeAbuseReviewAnnotationMock.mockResolvedValue({ id: "annotation-1" });

    const { listAbuseReviewAnnotations, revokeAbuseReviewAnnotation } =
      await import("./purchases");
    await expect(
      listAbuseReviewAnnotations({
        account_id: "admin-1",
        user_account_id: "acct-1",
        active_only: true,
      }),
    ).resolves.toEqual([]);
    expect(listAbuseReviewAnnotationsMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: undefined,
      category: undefined,
      active_only: true,
      limit: undefined,
    });

    await revokeAbuseReviewAnnotation({
      account_id: "admin-1",
      browser_id: "browser-1",
      id: "annotation-1",
      revoked_reason: "superseded",
    });
    expect(revokeAbuseReviewAnnotationMock).toHaveBeenCalledWith({
      id: "annotation-1",
      revoked_by: "admin-1",
      revoked_reason: "superseded",
    });
  });
});

describe("purchases.adminResetMembershipUsageWindows", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin permission", async () => {
    isAdminMock.mockResolvedValue(false);

    const { adminResetMembershipUsageWindows } = await import("./purchases");
    await expect(
      adminResetMembershipUsageWindows({
        account_id: "viewer-1",
        reason: "bad tier configuration",
      }),
    ).rejects.toThrow("must be an admin");
  });

  it("requires fresh auth before resetting usage windows", async () => {
    isAdminMock.mockResolvedValue(true);

    const { adminResetMembershipUsageWindows } = await import("./purchases");
    await expect(
      adminResetMembershipUsageWindows({
        account_id: "admin-1",
        reason: "bad tier configuration",
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });
    expect(resetAccountUsageEpochMock).not.toHaveBeenCalled();
  });

  it("resets both shared membership windows by default", async () => {
    isAdminMock.mockResolvedValue(true);
    getBrowserAuthSessionHashMock.mockReturnValue("fresh-session-1");
    resetAccountUsageEpochMock
      .mockResolvedValueOnce({ scope: "membership", window: "5h", epoch: 2 })
      .mockResolvedValueOnce({ scope: "membership", window: "7d", epoch: 3 });

    const { adminResetMembershipUsageWindows } = await import("./purchases");
    const result = await adminResetMembershipUsageWindows({
      account_id: "admin-1",
      browser_id: "browser-1",
      reason: "bad tier configuration",
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-1",
      allow_actor_impersonation: false,
    });
    expect(resetAccountUsageEpochMock).toHaveBeenCalledTimes(2);
    expect(resetAccountUsageEpochMock).toHaveBeenNthCalledWith(1, {
      window: "5h",
      reset_by: "admin-1",
      reason: "bad tier configuration",
    });
    expect(resetAccountUsageEpochMock).toHaveBeenNthCalledWith(2, {
      window: "7d",
      reset_by: "admin-1",
      reason: "bad tier configuration",
    });
    expect(result).toEqual({
      windows: [
        { scope: "membership", window: "5h", epoch: 2 },
        { scope: "membership", window: "7d", epoch: 3 },
      ],
    });
  });

  it("can reset a single selected shared membership window", async () => {
    isAdminMock.mockResolvedValue(true);
    resetAccountUsageEpochMock.mockResolvedValue({
      scope: "membership",
      window: "5h",
      epoch: 4,
    });

    const { adminResetMembershipUsageWindows } = await import("./purchases");
    await adminResetMembershipUsageWindows({
      account_id: "admin-1",
      session_hash: "fresh-session-2",
      window: "5h",
      reason: "support reset",
    });

    expect(requireFreshAuthForSessionHashMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-2",
      allow_actor_impersonation: false,
    });
    expect(resetAccountUsageEpochMock).toHaveBeenCalledTimes(1);
    expect(resetAccountUsageEpochMock).toHaveBeenCalledWith({
      window: "5h",
      reset_by: "admin-1",
      reason: "support reset",
    });
  });
});
