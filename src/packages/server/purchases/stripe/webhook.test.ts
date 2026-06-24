/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetConn = jest.fn();
const mockGetServerSettings = jest.fn();
const mockProcessPaymentIntent = jest.fn();
const mockIsReadyToProcess = jest.fn();
const mockBelongsToCurrentStripeSite = jest.fn();
const mockAlertUncreditedSucceededPayment = jest.fn();
const mockCreateCreditFromPaidStripeInvoice = jest.fn();
const mockSetUsageSubscription = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockIsValidAccount = jest.fn();
const mockAdminAlert = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

jest.mock("./process-payment-intents", () => ({
  alertUncreditedSucceededPayment: (...args: any[]) =>
    mockAlertUncreditedSucceededPayment(...args),
  belongsToCurrentStripeSite: (...args: any[]) =>
    mockBelongsToCurrentStripeSite(...args),
  isReadyToProcess: (...args: any[]) => mockIsReadyToProcess(...args),
  processPaymentIntent: (...args: any[]) => mockProcessPaymentIntent(...args),
}));

jest.mock("@cocalc/server/purchases/create-invoice", () => ({
  createCreditFromPaidStripeInvoice: (...args: any[]) =>
    mockCreateCreditFromPaidStripeInvoice(...args),
}));

jest.mock("@cocalc/server/purchases/stripe-usage-based-subscription", () => ({
  setUsageSubscription: (...args: any[]) => mockSetUsageSubscription(...args),
}));

jest.mock("./util", () => ({
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockIsValidAccount(...args),
}));

jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => mockAdminAlert(...args),
}));

describe("Stripe webhook processing", () => {
  const stripe = {
    invoices: {
      retrieve: jest.fn(),
    },
    paymentIntents: {
      retrieve: jest.fn(),
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    mockGetServerSettings.mockResolvedValue({
      stripe_webhook_secret: "whsec_test",
    });
    mockCurrentStripeSite.mockResolvedValue("cocalc.ai");
    mockIsValidAccount.mockResolvedValue(true);
    mockBelongsToCurrentStripeSite.mockResolvedValue(true);
    mockIsReadyToProcess.mockReturnValue(true);
    mockProcessPaymentIntent.mockResolvedValue(101);
    mockCreateCreditFromPaidStripeInvoice.mockResolvedValue(true);
    mockSetUsageSubscription.mockResolvedValue(undefined);
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      metadata: {
        account_id: "acct-1",
        cocalc_site: "cocalc.ai",
        purpose: "membership-package-purchase",
        total_excluding_tax_usd: "500",
      },
      status: "succeeded",
    });
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      metadata: {
        account_id: "acct-1",
        cocalc_site: "cocalc.ai",
        service: "credit",
      },
      paid: true,
      total_excluding_tax: 500,
      currency: "usd",
      lines: { data: [] },
    });
  });

  it("processes payment_intent.succeeded by retrieving the latest intent", async () => {
    const { processStripeWebhookEvent } = await import("./webhook");

    await expect(
      processStripeWebhookEvent({
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_123" } },
      }),
    ).resolves.toEqual({
      processed: true,
      type: "payment_intent.succeeded",
      action: "payment-intent",
    });

    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_123");
    expect(mockProcessPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pi_123" }),
    );
  });

  it("credits paid service invoices", async () => {
    const { processStripeWebhookEvent } = await import("./webhook");

    await expect(
      processStripeWebhookEvent({
        type: "invoice.paid",
        data: { object: { id: "in_123" } },
      }),
    ).resolves.toEqual({
      processed: true,
      type: "invoice.paid",
      action: "invoice-credit",
    });

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(
      "in_123",
      expect.objectContaining({
        expand: ["payments.data.payment.payment_intent"],
      }),
    );
    expect(mockCreateCreditFromPaidStripeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: "in_123" }),
    );
  });

  it("records active usage subscriptions", async () => {
    const { processStripeWebhookEvent } = await import("./webhook");

    await expect(
      processStripeWebhookEvent({
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_123",
            status: "active",
            metadata: {
              account_id: "acct-1",
              cocalc_site: "cocalc.ai",
              service: "credit",
            },
          },
        },
      }),
    ).resolves.toEqual({
      processed: true,
      type: "customer.subscription.created",
      action: "set-usage-subscription",
    });

    expect(mockSetUsageSubscription).toHaveBeenCalledWith({
      account_id: "acct-1",
      subscription_id: "sub_123",
    });
  });

  it("verifies the Stripe signature before processing", async () => {
    stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_123",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123" } },
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/webhooks/stripe",
      body: Buffer.from("{}"),
      headers: {
        "stripe-signature": "t=123,v1=abc",
      },
    });
    const { default: handler } = await import("./webhook");

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      req.body,
      "t=123,v1=abc",
      "whsec_test",
    );
    expect(mockProcessPaymentIntent).toHaveBeenCalled();
  });
});
