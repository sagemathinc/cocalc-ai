/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockQuery = jest.fn();
const mockIsMultiBayCluster = jest.fn();
const mockIsBillingAuthorityEnabled = jest.fn();
const mockGetClusterAccountById = jest.fn();
const mockGetConfiguredBayId = jest.fn();
const mockGetInterBayFabricClient = jest.fn(() => ({ fabric: true }));
const mockGetBillingPreferences = jest.fn();
const mockSetBillingProjection = jest.fn();
const mockIsAdminRemote = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockCreateInterBayAccountLocalClient = jest.fn(() => ({
  getBillingPreferences: mockGetBillingPreferences,
  setBillingProjection: mockSetBillingProjection,
  isAdmin: mockIsAdminRemote,
  requireFreshAuth: mockRequireFreshAuth,
}));
const mockIsAdminLocal = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => mockIsMultiBayCluster(),
}));
jest.mock("./billing-authority/config", () => ({
  isBillingAuthorityEnabled: () => mockIsBillingAuthorityEnabled(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: unknown[]) =>
    mockGetClusterAccountById(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockGetConfiguredBayId(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => mockGetInterBayFabricClient(),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: (...args: unknown[]) =>
    mockCreateInterBayAccountLocalClient(...args),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockIsAdminLocal(...args),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: unknown[]) =>
    mockRequireDangerousSessionAuth(...args),
}));

import {
  billingAccountsTable,
  ensureBillingAccount,
  getBillingAccountPreferences,
  isBillingAccountAdmin,
  publishBillingAccountProjection,
  requireBillingAccountDangerousAuth,
} from "./billing-account";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("seed billing accounts with sharded account homes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMultiBayCluster.mockReturnValue(true);
    mockIsBillingAuthorityEnabled.mockReturnValue(true);
    mockGetConfiguredBayId.mockReturnValue("seed");
    mockGetClusterAccountById.mockResolvedValue({
      account_id: ACCOUNT_ID,
      home_bay_id: "bay-1",
      banned: false,
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("uses a compact seed billing row without creating a seed account", async () => {
    expect(billingAccountsTable()).toBe("billing_accounts");

    await ensureBillingAccount(ACCOUNT_ID);

    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT 1 FROM billing_accounts WHERE account_id=$1",
      [ACCOUNT_ID],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO billing_accounts"),
      [ACCOUNT_ID, "bay-1", false],
    );
    expect(
      mockQuery.mock.calls.some(([sql]) => /INSERT INTO accounts/.test(sql)),
    ).toBe(false);
  });

  it("routes preferences, projections, admin checks, and fresh auth home", async () => {
    mockGetBillingPreferences.mockResolvedValue({
      email_daily_statements: true,
    });
    mockIsAdminRemote.mockResolvedValue(true);

    await expect(getBillingAccountPreferences(ACCOUNT_ID)).resolves.toEqual({
      email_daily_statements: true,
    });
    await publishBillingAccountProjection({
      account_id: ACCOUNT_ID,
      balance: 12.5,
      balance_alert: true,
    });
    await expect(isBillingAccountAdmin(ACCOUNT_ID)).resolves.toBe(true);
    await requireBillingAccountDangerousAuth({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      require_second_factor: "if_enabled",
      allow_actor_impersonation: false,
    });

    expect(mockCreateInterBayAccountLocalClient).toHaveBeenCalledWith({
      client: { fabric: true },
      dest_bay: "bay-1",
    });
    expect(mockSetBillingProjection).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      balance: 12.5,
      balance_alert: true,
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      require_second_factor: "if_enabled",
      allow_actor_impersonation: false,
    });
    expect(mockIsAdminLocal).not.toHaveBeenCalled();
    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
  });

  it("preserves the historical accounts table in standalone deployments", async () => {
    mockIsMultiBayCluster.mockReturnValue(false);
    mockIsAdminLocal.mockResolvedValue(true);

    expect(billingAccountsTable()).toBe("accounts");
    await ensureBillingAccount(ACCOUNT_ID);
    await expect(isBillingAccountAdmin(ACCOUNT_ID)).resolves.toBe(true);

    expect(mockGetClusterAccountById).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
