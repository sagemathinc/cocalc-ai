/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetBalance = jest.fn();
const mockGetPurchases = jest.fn();
const mockGetStatements = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockGetLiveSubscriptions = jest.fn();
const mockGetUnpaidInvoices = jest.fn();
const mockGetChargesThisMonthByService = jest.fn();
const mockEmailStatement = jest.fn();
const mockGetCostPerDay = jest.fn();
const mockGetAIUsageStatus = jest.fn();
const mockResolveMembershipForAccount = jest.fn();
const mockGetMinBalance = jest.fn();
const mockIsPurchaseAllowed = jest.fn();
const mockComputeMembershipChange = jest.fn();
const mockGetSeedMembershipTierMap = jest.fn();
const mockGetBillingReadiness = jest.fn();
const mockCostToResumeSubscription = jest.fn();
const mockThrottle = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/util/api/throttle", () => ({
  __esModule: true,
  default: (...args) => mockThrottle(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(false),
}));

jest.mock("@cocalc/server/purchases/get-balance", () => ({
  __esModule: true,
  default: (...args) => mockGetBalance(...args),
}));

jest.mock("@cocalc/server/purchases/get-purchases", () => ({
  __esModule: true,
  default: (...args) => mockGetPurchases(...args),
}));

jest.mock("@cocalc/server/purchases/statements/get-statements", () => ({
  __esModule: true,
  default: (...args) => mockGetStatements(...args),
}));

jest.mock("@cocalc/server/purchases/get-subscriptions", () => ({
  __esModule: true,
  default: (...args) => mockGetSubscriptions(...args),
}));

jest.mock("@cocalc/server/purchases/get-live-subscriptions", () => ({
  __esModule: true,
  default: (...args) => mockGetLiveSubscriptions(...args),
}));

jest.mock("@cocalc/server/purchases/get-unpaid-invoices", () => ({
  __esModule: true,
  default: (...args) => mockGetUnpaidInvoices(...args),
}));

jest.mock("@cocalc/server/purchases/get-charges", () => ({
  getChargesThisMonthByService: (...args) =>
    mockGetChargesThisMonthByService(...args),
}));

jest.mock("@cocalc/server/purchases/statements/email-statement", () => ({
  __esModule: true,
  default: (...args) => mockEmailStatement(...args),
}));

jest.mock("@cocalc/server/purchases/get-cost-per-day", () => ({
  __esModule: true,
  default: (...args) => mockGetCostPerDay(...args),
}));

jest.mock("@cocalc/server/ai/usage-status", () => ({
  getAIUsageStatus: (...args) => mockGetAIUsageStatus(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  resolveMembershipForAccount: (...args) =>
    mockResolveMembershipForAccount(...args),
}));

jest.mock("@cocalc/server/purchases/get-min-balance", () => ({
  __esModule: true,
  default: (...args) => mockGetMinBalance(...args),
}));

jest.mock("@cocalc/server/purchases/is-purchase-allowed", () => ({
  isPurchaseAllowed: (...args) => mockIsPurchaseAllowed(...args),
}));

jest.mock("@cocalc/server/membership/tiers", () => ({
  computeMembershipChange: (...args) => mockComputeMembershipChange(...args),
  getSeedMembershipTierMap: (...args) => mockGetSeedMembershipTierMap(...args),
}));

jest.mock(
  "@cocalc/server/purchases/stripe/billing-readiness",
  () => ({
    getBillingReadiness: (...args) => mockGetBillingReadiness(...args),
  }),
  { virtual: true },
);

jest.mock("@cocalc/server/purchases/resume-subscription", () => ({
  costToResumeSubscription: (...args) => mockCostToResumeSubscription(...args),
}));

describe("billing account read routes API-key scope", () => {
  const denied = {
    error: "API keys are not allowed to access billing account details",
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams
      .mockReset()
      .mockReturnValue({ interval: "month", limit: 10, offset: 0 });
    mockGetBalance.mockReset().mockResolvedValue({ balance: 12 });
    mockGetPurchases.mockReset().mockResolvedValue({ purchases: [] });
    mockGetStatements.mockReset().mockResolvedValue({ statements: [] });
    mockGetSubscriptions.mockReset().mockResolvedValue({ subscriptions: [] });
    mockGetLiveSubscriptions.mockReset().mockResolvedValue([]);
    mockGetUnpaidInvoices.mockReset().mockResolvedValue([]);
    mockGetChargesThisMonthByService.mockReset().mockResolvedValue({});
    mockEmailStatement.mockReset().mockResolvedValue(undefined);
    mockGetCostPerDay.mockReset().mockResolvedValue([]);
    mockGetAIUsageStatus.mockReset().mockResolvedValue({ used: 1 });
    mockResolveMembershipForAccount.mockReset().mockResolvedValue({
      tier_id: "tier-1",
    });
    mockGetMinBalance.mockReset().mockResolvedValue(0);
    mockIsPurchaseAllowed.mockReset().mockResolvedValue({ allowed: true });
    mockComputeMembershipChange.mockReset().mockResolvedValue({
      charge: 0,
    });
    mockGetSeedMembershipTierMap.mockReset().mockResolvedValue({});
    mockGetBillingReadiness.mockReset().mockResolvedValue({
      hasBillingDetails: true,
      hasPaymentMethod: true,
    });
    mockCostToResumeSubscription.mockReset().mockResolvedValue({
      cost: 12,
      periodicCost: 12,
    });
    mockThrottle.mockReset();
  });

  it.each([
    ["./purchases/get-balance", mockGetBalance],
    ["./purchases/get-purchases", mockGetPurchases],
    ["./purchases/get-statements", mockGetStatements],
    ["./purchases/get-subscriptions", mockGetSubscriptions],
    ["./purchases/get-live-subscriptions", mockGetLiveSubscriptions],
    ["./purchases/get-unpaid-invoices", mockGetUnpaidInvoices],
    ["./purchases/get-charges-by-service", mockGetChargesThisMonthByService],
    ["./purchases/email-statement", mockEmailStatement],
    ["./purchases/get-cost-per-day", mockGetCostPerDay],
    ["./purchases/get-llm-usage", mockGetAIUsageStatus],
    ["./purchases/get-membership", mockResolveMembershipForAccount],
    ["./purchases/get-min-balance", mockGetMinBalance],
    ["./purchases/is-purchase-allowed", mockIsPurchaseAllowed],
    ["./purchases/membership-quote", mockComputeMembershipChange],
    ["./purchases/cost-to-resume-subscription", mockCostToResumeSubscription],
  ])("rejects API-key access to %s", async (modulePath, backendCall) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: { interval: "month" },
    });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });

  it("keeps browser-session balance reads", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    const { default: handler } = await import("./purchases/get-balance");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ balance: 12 });
    expect(mockGetBalance).toHaveBeenCalledWith({ account_id: "acct-1" });
  });

  it("keeps browser-session statement email requests", async () => {
    mockGetParams.mockReturnValue({ statement_id: 5 });
    const { req, res } = createMocks({
      method: "POST",
      body: { statement_id: 5 },
    });

    const { default: handler } = await import("./purchases/email-statement");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockEmailStatement).toHaveBeenCalledWith({
      account_id: "acct-1",
      statement_id: 5,
    });
  });

  it("reports missing trial billing requirements separately", async () => {
    mockGetParams.mockReturnValue({
      class: "standard",
      interval: "year",
    });
    mockComputeMembershipChange.mockResolvedValue({
      change: "new",
      charge: 0,
      price: 216,
      trial_available: true,
      trial_days: 7,
    });
    mockGetBillingReadiness.mockResolvedValue({
      hasBillingDetails: false,
      hasPaymentMethod: true,
    });
    const { req, res } = createMocks({
      method: "POST",
      body: { class: "standard", interval: "year" },
    });

    const { default: handler } = await import("./purchases/membership-quote");
    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({
      allowed: false,
      charge_amount: 0,
      reason: "Add billing details to start this free trial.",
      trial_requires_billing_details: true,
      trial_requires_payment_method: false,
    });
  });

  it("allows trial quotes when billing is ready", async () => {
    mockGetParams.mockReturnValue({
      class: "standard",
      interval: "year",
    });
    mockComputeMembershipChange.mockResolvedValue({
      change: "new",
      charge: 0,
      price: 216,
      trial_available: true,
      trial_days: 7,
    });
    const { req, res } = createMocks({
      method: "POST",
      body: { class: "standard", interval: "year" },
    });

    const { default: handler } = await import("./purchases/membership-quote");
    await handler(req, res);

    expect(res._getJSONData()).toMatchObject({
      allowed: true,
      charge_amount: 0,
      trial_requires_billing_details: false,
      trial_requires_payment_method: false,
    });
  });

  it("keeps browser-session resume-cost reads", async () => {
    mockGetParams.mockReturnValue({ subscription_id: 7 });
    const { req, res } = createMocks({
      method: "POST",
      body: { subscription_id: 7 },
    });

    const { default: handler } =
      await import("./purchases/cost-to-resume-subscription");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      cost: 12,
      periodicCost: 12,
    });
    expect(mockCostToResumeSubscription).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: 7,
    });
  });
});
