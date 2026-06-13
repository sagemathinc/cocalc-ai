/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetCurrentAuthSession = jest.fn();
const mockRequireFreshAuth = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();
const mockCreateSubscriptionPayment = jest.fn();
const mockCreatePaymentIntent = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockGetPaymentIntentAccountId = jest.fn();
const mockGetCheckoutSession = jest.fn();
const mockGetCustomerSession = jest.fn();
const mockSetCustomer = jest.fn();
const mockDeletePaymentMethod = jest.fn();
const mockSetDefaultPaymentMethod = jest.fn();
const mockThrottle = jest.fn();
const mockUserIsInGroup = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSession: (...args: any[]) => mockGetCurrentAuthSession(...args),
  requireFreshAuth: (...args: any[]) => mockRequireFreshAuth(...args),
}));

jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) =>
    mockRequireDangerousSessionAuth(...args),
}));

jest.mock("@cocalc/util/api/throttle", () => ({
  __esModule: true,
  default: (...args: any[]) => mockThrottle(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/purchases/stripe/create-payment-intent", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePaymentIntent(...args),
  cancelPaymentIntent: (...args: any[]) => mockCancelPaymentIntent(...args),
  getPaymentIntentAccountId: (...args: any[]) =>
    mockGetPaymentIntentAccountId(...args),
}));

jest.mock(
  "@cocalc/server/purchases/stripe/create-subscription-payment",
  () => ({
    __esModule: true,
    default: (...args: any[]) => mockCreateSubscriptionPayment(...args),
  }),
);

jest.mock("@cocalc/server/purchases/stripe/create-setup-intent", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateSetupIntent(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-checkout-session", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetCheckoutSession(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/get-customer-session", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetCustomerSession(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/customer", () => ({
  setCustomer: (...args: any[]) => mockSetCustomer(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/delete-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => mockDeletePaymentMethod(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/set-default-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSetDefaultPaymentMethod(...args),
}));

describe("purchases Stripe fresh-auth routes", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({ subscription_id: 123 });
    mockGetCurrentAuthSession.mockReset().mockResolvedValue({
      session_hash: "fresh-session-hash",
    });
    mockRequireFreshAuth.mockReset().mockResolvedValue(undefined);
    mockRequireDangerousSessionAuth.mockReset().mockResolvedValue(undefined);
    mockCreateSubscriptionPayment.mockReset().mockResolvedValue(undefined);
    mockCreatePaymentIntent.mockReset().mockResolvedValue(undefined);
    mockCreateSetupIntent.mockReset().mockResolvedValue({
      clientSecret: "seti_test_secret",
    });
    mockCancelPaymentIntent.mockReset().mockResolvedValue(undefined);
    mockGetPaymentIntentAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetCheckoutSession.mockReset().mockResolvedValue({
      clientSecret: "cs_test",
    });
    mockGetCustomerSession.mockReset().mockResolvedValue({
      customerSessionClientSecret: "css_test",
    });
    mockSetCustomer.mockReset().mockResolvedValue(undefined);
    mockDeletePaymentMethod.mockReset().mockResolvedValue(undefined);
    mockSetDefaultPaymentMethod.mockReset().mockResolvedValue(undefined);
    mockThrottle.mockReset();
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
  });

  it("requires fresh auth before creating a subscription-renewal payment", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/create-subscription-payment");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockCreateSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("creates a subscription-renewal payment after fresh auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/create-subscription-payment");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockCreateSubscriptionPayment).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: 123,
    });
  });

  it("requires recent dangerous auth before admin-created payment intent", async () => {
    mockGetParams.mockReturnValue({
      user_account_id: "user-1",
      purpose: "admin-payment",
      description: "Manual charge",
      lineItems: [{ description: "Credit", amount: 10 }],
      metadata: { support_case: "case-1" },
    });
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "two_factor_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/create-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "recent two-factor verification is required",
      code: "two_factor_required",
    });
    expect(mockGetCurrentAuthSession).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("creates an admin payment intent after dangerous auth", async () => {
    mockGetParams.mockReturnValue({
      user_account_id: "user-1",
      purpose: "admin-payment",
      description: "Manual charge",
      lineItems: [{ description: "Credit", amount: 10 }],
      metadata: { support_case: "case-1" },
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/create-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockCreatePaymentIntent).toHaveBeenCalledWith({
      account_id: "user-1",
      purpose: "admin-payment",
      description: "Manual charge",
      lineItems: [{ description: "Credit", amount: 10 }],
      metadata: {
        support_case: "case-1",
        admin_account_id: "acct-1",
      },
    });
  });

  it("requires recent dangerous auth before admin payment-intent cancellation", async () => {
    mockGetParams.mockReturnValue({
      id: "pi_123",
      reason: "requested_by_customer",
    });
    mockGetPaymentIntentAccountId.mockResolvedValue("user-1");
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "two_factor_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/cancel-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "recent two-factor verification is required",
    });
    expect(mockGetCurrentAuthSession).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
    });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("does not require dangerous auth for self payment-intent cancellation", async () => {
    mockGetParams.mockReturnValue({
      id: "pi_123",
      reason: "requested_by_customer",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/cancel-payment-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockCancelPaymentIntent).toHaveBeenCalledWith({
      id: "pi_123",
      reason: "requested_by_customer",
    });
  });

  it("requires fresh auth before creating a checkout session", async () => {
    mockGetParams.mockReturnValue({
      purpose: "membership",
      description: "Membership",
      lineItems: [{ description: "Membership", amount: 10 }],
      metadata: { membership_id: "membership-1" },
    });
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/get-checkout-session");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "fresh auth is required",
      code: "fresh_auth_required",
    });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockGetCheckoutSession).not.toHaveBeenCalled();
  });

  it("creates a checkout session after fresh auth", async () => {
    mockGetParams.mockReturnValue({
      purpose: "membership",
      description: "Membership",
      lineItems: [{ description: "Membership", amount: 10 }],
      return_url: "https://example.com/return",
      metadata: { membership_id: "membership-1" },
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/get-checkout-session");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ clientSecret: "cs_test" });
    expect(mockRequireFreshAuth).toHaveBeenCalledWith({
      req,
      account_id: "acct-1",
      allow_actor_impersonation: true,
    });
    expect(mockGetCheckoutSession).toHaveBeenCalledWith({
      account_id: "acct-1",
      purpose: "membership",
      description: "Membership",
      lineItems: [{ description: "Membership", amount: 10 }],
      return_url: "https://example.com/return",
      metadata: { membership_id: "membership-1" },
    });
  });

  it("creates a setup intent without fresh auth", async () => {
    mockGetParams.mockReturnValue({
      description: "Add a new payment method.",
    });
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/create-setup-intent");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      clientSecret: "seti_test_secret",
    });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockCreateSetupIntent).toHaveBeenCalledWith({
      account_id: "acct-1",
      description: "Add a new payment method.",
    });
  });

  it("creates a customer session without fresh auth", async () => {
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/get-customer-session");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      customerSessionClientSecret: "css_test",
    });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockGetCustomerSession).toHaveBeenCalledWith("acct-1");
  });

  it("updates a Stripe customer without fresh auth", async () => {
    const changes = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      address: { country: "US" },
    };
    mockGetParams.mockReturnValue({
      changes,
    });
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/set-customer");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockSetCustomer).toHaveBeenCalledWith("acct-1", changes);
  });

  it("deletes a payment method without fresh auth", async () => {
    mockGetParams.mockReturnValue({ payment_method: "pm_123" });
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/delete-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockDeletePaymentMethod).toHaveBeenCalledWith({
      account_id: "acct-1",
      payment_method: "pm_123",
    });
  });

  it("sets a default payment method without fresh auth", async () => {
    mockGetParams.mockReturnValue({ default_payment_method: "pm_123" });
    mockRequireFreshAuth.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } =
      await import("./purchases/stripe/set-default-payment-method");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockRequireFreshAuth).not.toHaveBeenCalled();
    expect(mockSetDefaultPaymentMethod).toHaveBeenCalledWith({
      account_id: "acct-1",
      default_payment_method: "pm_123",
    });
  });
});
