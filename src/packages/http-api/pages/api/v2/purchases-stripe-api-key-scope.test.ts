/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetPaymentMethods = jest.fn();
const mockGetPaymentMethod = jest.fn();
const mockGetCustomer = jest.fn();
const mockGetPayments = jest.fn();
const mockGetAllOpenPayments = jest.fn();
const mockGetInvoice = jest.fn();
const mockGetInvoiceUrl = jest.fn();
const mockThrottle = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockCreatePaymentIntent = jest.fn();
const mockGetCheckoutSession = jest.fn();
const mockGetPaymentIntentAccountId = jest.fn();
const mockProcessPaymentIntents = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockGetCustomerSession = jest.fn();
const mockSetCustomer = jest.fn();
const mockDeletePaymentMethod = jest.fn();
const mockSetDefaultPaymentMethod = jest.fn();
const mockGetCurrentAuthSession = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();

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
  default: (...args) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSession: (...args) => mockGetCurrentAuthSession(...args),
}));

jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args) =>
    mockRequireDangerousSessionAuth(...args),
}));

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/purchases/stripe/get-payment-methods", () => ({
  __esModule: true,
  default: (...args) => mockGetPaymentMethods(...args),
  getPaymentMethod: (...args) => mockGetPaymentMethod(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/customer", () => ({
  getCustomer: (...args) => mockGetCustomer(...args),
  setCustomer: (...args) => mockSetCustomer(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-payments", () => ({
  __esModule: true,
  default: (...args) => mockGetPayments(...args),
  getAllOpenPayments: (...args) => mockGetAllOpenPayments(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/invoices", () => ({
  getInvoice: (...args) => mockGetInvoice(...args),
  getInvoiceUrl: (...args) => mockGetInvoiceUrl(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/create-payment-intent", () => ({
  __esModule: true,
  default: (...args) => mockCreatePaymentIntent(...args),
  cancelPaymentIntent: (...args) => mockCancelPaymentIntent(...args),
  getPaymentIntentAccountId: (...args) =>
    mockGetPaymentIntentAccountId(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-checkout-session", () => ({
  __esModule: true,
  default: (...args) => mockGetCheckoutSession(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/process-payment-intents", () => ({
  __esModule: true,
  default: (...args) => mockProcessPaymentIntents(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/create-setup-intent", () => ({
  __esModule: true,
  default: (...args) => mockCreateSetupIntent(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-customer-session", () => ({
  __esModule: true,
  default: (...args) => mockGetCustomerSession(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/delete-payment-method", () => ({
  __esModule: true,
  default: (...args) => mockDeletePaymentMethod(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/set-default-payment-method", () => ({
  __esModule: true,
  default: (...args) => mockSetDefaultPaymentMethod(...args),
}));

describe("Stripe billing read routes API-key scope", () => {
  const denied = {
    error: "API keys are not allowed to access Stripe billing details",
  };
  const mutationDenied = {
    error: "API keys are not allowed to modify Stripe billing details",
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({ invoice_id: "in_123" });
    mockGetPaymentMethods.mockReset().mockResolvedValue({ data: [] });
    mockGetPaymentMethod.mockReset().mockResolvedValue({ id: "pm_123" });
    mockGetCustomer.mockReset().mockResolvedValue({ id: "cus_123" });
    mockGetPayments.mockReset().mockResolvedValue({ data: [] });
    mockGetAllOpenPayments.mockReset().mockResolvedValue([]);
    mockGetInvoice.mockReset().mockResolvedValue({ id: "in_123" });
    mockGetInvoiceUrl
      .mockReset()
      .mockResolvedValue("https://stripe.example/in");
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
    mockCancelPaymentIntent.mockReset().mockResolvedValue(undefined);
    mockCreatePaymentIntent.mockReset().mockResolvedValue({
      payment_intent: "pi_123",
      hosted_invoice_url: "https://stripe.example/in",
    });
    mockGetCheckoutSession.mockReset().mockResolvedValue({
      clientSecret: "cs_test",
      sessionId: "cs_123",
    });
    mockGetPaymentIntentAccountId.mockReset().mockResolvedValue("acct-1");
    mockProcessPaymentIntents.mockReset().mockResolvedValue(0);
    mockCreateSetupIntent.mockReset().mockResolvedValue({
      clientSecret: "seti_secret",
    });
    mockGetCustomerSession.mockReset().mockResolvedValue({
      customerSessionClientSecret: "css_secret",
    });
    mockSetCustomer.mockReset().mockResolvedValue(undefined);
    mockDeletePaymentMethod.mockReset().mockResolvedValue(undefined);
    mockSetDefaultPaymentMethod.mockReset().mockResolvedValue(undefined);
    mockGetCurrentAuthSession.mockReset().mockResolvedValue({
      session_hash: "fresh-session-hash",
    });
    mockRequireDangerousSessionAuth.mockReset().mockResolvedValue(undefined);
    mockThrottle.mockReset();
  });

  it.each([
    ["./purchases/stripe/get-payment-methods", mockGetPaymentMethods],
    ["./purchases/stripe/get-payment-method", mockGetPaymentMethod],
    ["./purchases/stripe/get-customer", mockGetCustomer],
    ["./purchases/stripe/get-payments", mockGetPayments],
    ["./purchases/stripe/get-open-payments", mockGetAllOpenPayments],
    ["./purchases/stripe/get-invoice", mockGetInvoice],
    ["./purchases/stripe/get-invoice-url", mockGetInvoiceUrl],
  ])("rejects API-key access to %s", async (modulePath, backendCall) => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { invoice_id: "in_123" },
    });

    const { default: handler } = await import(modulePath);
    await handler(req, res);

    expect(res._getJSONData()).toEqual(denied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(backendCall).not.toHaveBeenCalled();
  });

  it("rejects API-key payment-intent cancellation before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { id: "pi_123", reason: "requested_by_customer" },
    });

    const { default: handler } =
      await import("./purchases/stripe/cancel-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(mutationDenied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(mockGetPaymentIntentAccountId).not.toHaveBeenCalled();
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects API-key payment-intent processing before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
    });

    const { default: handler } =
      await import("./purchases/stripe/process-payment-intents");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(mutationDenied);
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(mockProcessPaymentIntents).not.toHaveBeenCalled();
  });

  it.each([
    ["./purchases/stripe/create-payment-intent", mockCreatePaymentIntent],
    ["./purchases/stripe/get-checkout-session", mockGetCheckoutSession],
    ["./purchases/stripe/create-setup-intent", mockCreateSetupIntent],
    ["./purchases/stripe/get-customer-session", mockGetCustomerSession],
    ["./purchases/stripe/set-customer", mockSetCustomer],
    ["./purchases/stripe/delete-payment-method", mockDeletePaymentMethod],
    [
      "./purchases/stripe/set-default-payment-method",
      mockSetDefaultPaymentMethod,
    ],
  ])(
    "rejects API-key Stripe billing mutation access to %s before account resolution",
    async (modulePath, backendCall) => {
      mockGetParams.mockReturnValue({
        changes: { name: "Ada Lovelace" },
        default_payment_method: "pm_123",
        description: "Add a new payment method.",
        payment_method: "pm_123",
      });
      const { req, res } = createMocks({
        method: "POST",
        headers: { Authorization: "Bearer cocalc_api_key_test" },
      });

      const { default: handler } = await import(modulePath);
      await handler(req, res);

      expect(res._getJSONData()).toEqual(mutationDenied);
      expect(mockGetAccountId).not.toHaveBeenCalled();
      expect(mockThrottle).not.toHaveBeenCalled();
      expect(backendCall).not.toHaveBeenCalled();
    },
  );

  it("keeps browser-session payment-intent cancellation", async () => {
    mockGetParams.mockReturnValue({
      id: "pi_123",
      reason: "requested_by_customer",
    });
    const { req, res } = createMocks({
      method: "POST",
      body: { id: "pi_123", reason: "requested_by_customer" },
    });

    const { default: handler } =
      await import("./purchases/stripe/cancel-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockCancelPaymentIntent).toHaveBeenCalledWith({
      id: "pi_123",
      reason: "requested_by_customer",
    });
  });

  it("keeps browser-session payment method listing", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    const { default: handler } =
      await import("./purchases/stripe/get-payment-methods");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ data: [] });
    expect(mockGetPaymentMethods).toHaveBeenCalledWith({
      account_id: "acct-1",
      ending_before: undefined,
      starting_after: undefined,
      limit: undefined,
    });
  });

  it("keeps browser-session payment-intent processing", async () => {
    mockProcessPaymentIntents.mockResolvedValue(2);
    const { req, res } = createMocks({
      method: "POST",
      body: {},
    });

    const { default: handler } =
      await import("./purchases/stripe/process-payment-intents");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ count: 2, success: true });
    expect(mockThrottle).toHaveBeenCalledWith({
      account_id: "acct-1",
      endpoint: "purchases/stripe/process-payment-intents",
    });
    expect(mockProcessPaymentIntents).toHaveBeenCalledWith({
      account_id: "acct-1",
    });
  });
});
