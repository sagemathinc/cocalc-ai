/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockAssertPaymentCheckoutAllowed = jest.fn();
const mockGetConn = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockHasBillingDetails = jest.fn();
const mockSetCustomer = jest.fn();

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: (...args: any[]) =>
    mockAssertPaymentCheckoutAllowed(...args),
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
}));

jest.mock("./customer", () => ({
  hasBillingDetails: (...args: any[]) => mockHasBillingDetails(...args),
  setCustomer: (...args: any[]) => mockSetCustomer(...args),
}));

import createSetupIntent from "./create-setup-intent";

describe("createSetupIntent", () => {
  const stripe = {
    setupIntents: {
      create: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertPaymentCheckoutAllowed.mockResolvedValue(undefined);
    mockGetConn.mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockHasBillingDetails.mockResolvedValue(true);
    mockSetCustomer.mockResolvedValue(undefined);
    stripe.setupIntents.create.mockResolvedValue({
      client_secret: "seti_secret",
    });
  });

  it("requires billing details before creating a setup intent", async () => {
    mockHasBillingDetails.mockResolvedValueOnce(false);

    await expect(
      createSetupIntent({
        account_id: "acct-1",
        description: "Add payment method",
      }),
    ).rejects.toThrow("Billing details are required");

    expect(stripe.setupIntents.create).not.toHaveBeenCalled();
  });

  it("creates an off-session setup intent when billing details are present", async () => {
    const result = await createSetupIntent({
      account_id: "acct-1",
      description: "Add payment method",
    });

    expect(result).toEqual({ clientSecret: "seti_secret" });
    expect(stripe.setupIntents.create).toHaveBeenCalledWith({
      customer: "cus_123",
      description: "Add payment method",
      automatic_payment_methods: { enabled: true, allow_redirects: "always" },
      usage: "off_session",
      metadata: { account_id: "acct-1" },
      use_stripe_sdk: true,
    });
  });

  it("applies supplied billing details before checking readiness", async () => {
    const billing_details = {
      name: "Ada Lovelace",
      address: { country: "US", postal_code: "94105" },
    };

    await createSetupIntent({
      account_id: "acct-1",
      description: "Add payment method",
      billing_details,
    });

    expect(mockSetCustomer).toHaveBeenCalledWith("acct-1", billing_details);
    expect(mockHasBillingDetails).toHaveBeenCalledWith("acct-1");
  });
});
