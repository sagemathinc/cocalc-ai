/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockAssertPaymentCheckoutAllowed = jest.fn();
const mockGetConn = jest.fn();
const mockDefaultReturnUrl = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockSanityCheckAmount = jest.fn();
const mockAssertValidStripePaymentInput = jest.fn();
const mockGetStripeLineItems = jest.fn();
const mockCurrentStripeSite = jest.fn();
const mockIsReadyToProcess = jest.fn();
const mockProcessPaymentIntent = jest.fn();
const mockAlertUncreditedSucceededPayment = jest.fn();
const mockBindSubscriptionRenewalPaymentIntent = jest.fn();
const mockBindAdminMembershipPayment = jest.fn();
const mockDelay = jest.fn();

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: (...args: any[]) =>
    mockAssertPaymentCheckoutAllowed(...args),
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  assertValidStripePaymentInput: (...args: any[]) =>
    mockAssertValidStripePaymentInput(...args),
  defaultReturnUrl: (...args: any[]) => mockDefaultReturnUrl(...args),
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
  getStripeLineItems: (...args: any[]) => mockGetStripeLineItems(...args),
  normalizeStripeLineItems: (lineItems: unknown) => lineItems,
  sanityCheckAmount: (...args: any[]) => mockSanityCheckAmount(...args),
  currentStripeSite: (...args: any[]) => mockCurrentStripeSite(...args),
}));

jest.mock("./process-payment-intents", () => ({
  alertUncreditedSucceededPayment: (...args: any[]) =>
    mockAlertUncreditedSucceededPayment(...args),
  isReadyToProcess: (...args: any[]) => mockIsReadyToProcess(...args),
  processPaymentIntent: (...args: any[]) => mockProcessPaymentIntent(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: jest.fn(),
  name: jest.fn(),
  support: jest.fn(),
  url: jest.fn(),
}));

jest.mock("awaiting", () => ({
  delay: (...args: any[]) => mockDelay(...args),
}));

jest.mock("../subscription-renewal-attempts", () => ({
  bindSubscriptionRenewalPaymentIntent: (...args: any[]) =>
    mockBindSubscriptionRenewalPaymentIntent(...args),
}));
jest.mock("../admin-membership-orders", () => ({
  bindAdminMembershipPayment: (...args) =>
    mockBindAdminMembershipPayment(...args),
}));

import createPaymentIntent, {
  cancelPaymentIntent,
  getPaymentIntentIdFromInvoice,
} from "./create-payment-intent";

describe("createPaymentIntent", () => {
  const lineItems = [{ description: "Basic membership, annual", amount: 72 }];
  const stripe = {
    customers: {
      retrieve: jest.fn(),
      listPaymentMethods: jest.fn(),
    },
    invoiceItems: {
      create: jest.fn(),
    },
    invoicePayments: {
      list: jest.fn(),
    },
    invoices: {
      create: jest.fn(),
      finalizeInvoice: jest.fn(),
      pay: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      voidInvoice: jest.fn(),
    },
    paymentIntents: {
      cancel: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockBindAdminMembershipPayment.mockReset().mockResolvedValue(undefined);
    mockAssertPaymentCheckoutAllowed.mockResolvedValue(undefined);
    mockGetConn.mockResolvedValue(stripe);
    mockDefaultReturnUrl.mockResolvedValue("https://cocalc.example/return");
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockSanityCheckAmount.mockResolvedValue(undefined);
    mockAssertValidStripePaymentInput.mockReturnValue(undefined);
    mockCurrentStripeSite.mockResolvedValue("cocalc.ai");
    mockGetStripeLineItems.mockReturnValue({
      lineItemsWithoutCredit: lineItems,
      total_excluding_tax_usd: 7200,
    });
    mockIsReadyToProcess.mockReturnValue(false);
    mockDelay.mockResolvedValue(undefined);
    stripe.customers.retrieve.mockResolvedValue({
      invoice_settings: {},
    });
    stripe.customers.listPaymentMethods.mockResolvedValue({ data: [] });
    stripe.invoiceItems.create.mockResolvedValue({});
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    stripe.invoices.create.mockResolvedValue({ id: "in_123" });
    stripe.invoices.pay.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      status: "paid",
    });
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
    });
    stripe.invoices.update.mockResolvedValue({});
    stripe.invoices.voidInvoice.mockResolvedValue({});
    stripe.paymentIntents.cancel.mockResolvedValue({});
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      status: "requires_payment_method",
    });
    stripe.paymentIntents.update.mockResolvedValue({});
  });

  it("extracts payment intent ids from current and legacy invoice shapes", () => {
    expect(
      getPaymentIntentIdFromInvoice({
        payments: {
          data: [
            {
              is_default: true,
              payment: {
                type: "payment_intent",
                payment_intent: "pi_from_invoice_payment",
              },
            },
          ],
        },
      }),
    ).toBe("pi_from_invoice_payment");

    expect(
      getPaymentIntentIdFromInvoice({
        payments: {
          data: [
            {
              is_default: true,
              payment: {
                type: "payment_intent",
                payment_intent: { id: "pi_expanded" },
              },
            },
          ],
        },
      }),
    ).toBe("pi_expanded");

    expect(
      getPaymentIntentIdFromInvoice({
        confirmation_secret: {
          client_secret: "pi_123_secret_abc",
        },
      }),
    ).toBe("pi_123");

    expect(
      getPaymentIntentIdFromInvoice({
        payment_intent: "pi_legacy",
      }),
    ).toBe("pi_legacy");
  });

  it("voids the metadata invoice when Stripe rejects direct intent cancellation", async () => {
    stripe.paymentIntents.cancel.mockRejectedValue(
      new Error(
        "You cannot cancel PaymentIntents created by invoices. Try voiding the invoice instead.",
      ),
    );
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_invoice",
      metadata: { invoice_id: "in_from_metadata" },
      status: "requires_payment_method",
    });

    await cancelPaymentIntent({ id: "pi_invoice", reason: "abandoned" });

    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      "in_from_metadata",
    );
  });

  it("rechecks self-service ownership before canceling", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_other",
      metadata: { account_id: "other-account" },
      status: "requires_payment_method",
    });

    await expect(
      cancelPaymentIntent({
        id: "pi_other",
        reason: "abandoned",
        expected_account_id: "self-account",
      }),
    ).rejects.toMatchObject({ code: 403, status: 403 });

    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("creates an invoice and returns the default invoice payment intent", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_123",
            },
          },
        ],
      },
    });

    const result = await createPaymentIntent({
      account_id: "acct-1",
      purpose: "membership-change",
      description: "Basic membership, annual",
      lineItems,
      metadata: { membership_class: "basic" },
    });

    expect(result).toMatchObject({
      payment_intent: "pi_123",
      hosted_invoice_url: "https://stripe.example/invoice",
    });
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith("in_123", {
      auto_advance: false,
      expand: ["payments.data.payment.payment_intent"],
    });
    expect(stripe.paymentIntents.update).toHaveBeenCalledWith("pi_123", {
      description: "Basic membership, annual",
      metadata: expect.objectContaining({
        account_id: "acct-1",
        cocalc_site: "cocalc.ai",
        invoice_id: "in_123",
        membership_class: "basic",
        purpose: "membership-change",
        total_excluding_tax_usd: "7200",
      }),
      setup_future_usage: "off_session",
    });
  });

  it("falls back to listing invoice payments when the invoice omits payments", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
    });
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        {
          is_default: true,
          payment: {
            type: "payment_intent",
            payment_intent: "pi_from_list",
          },
        },
      ],
    });

    const result = await createPaymentIntent({
      account_id: "acct-1",
      purpose: "membership-change",
      description: "Basic membership, annual",
      lineItems,
    });

    expect(result.payment_intent).toBe("pi_from_list");
    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({
      invoice: "in_123",
      payment: { type: "payment_intent" },
      limit: 10,
      expand: ["data.payment.payment_intent"],
    });
  });

  it("refreshes the invoice while waiting for Stripe to expose the payment intent", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
    });
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });
    stripe.invoices.retrieve.mockResolvedValueOnce({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_after_refresh",
            },
          },
        ],
      },
    });

    const result = await createPaymentIntent({
      account_id: "acct-1",
      purpose: "membership-change",
      description: "Basic membership, annual",
      lineItems,
    });

    expect(result.payment_intent).toBe("pi_after_refresh");
    expect(mockDelay).toHaveBeenCalled();
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith("in_123", {
      expand: ["payments.data.payment.payment_intent"],
    });
  });

  it("awaits processing when the payment intent is immediately paid", async () => {
    let processed = false;
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_123",
            },
          },
        ],
      },
    });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
    });
    mockIsReadyToProcess.mockReturnValue(true);
    mockProcessPaymentIntent.mockImplementation(async () => {
      await Promise.resolve();
      processed = true;
    });

    await createPaymentIntent({
      account_id: "acct-1",
      purpose: "membership-change",
      description: "Basic membership, annual",
      lineItems,
    });

    expect(mockProcessPaymentIntent).toHaveBeenCalledWith({
      id: "pi_123",
      status: "succeeded",
    });
    expect(processed).toBe(true);
  });

  it("can skip immediate processing for callers that must persist local payment state first", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_123",
            },
          },
        ],
      },
    });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
    });
    mockIsReadyToProcess.mockReturnValue(true);

    await createPaymentIntent({
      account_id: "acct-1",
      purpose: "subscription-renewal",
      description: "Renew a subscription",
      lineItems,
      metadata: {
        renewal_attempt_id: "attempt-1",
        subscription_id: "123",
      },
      processImmediately: false,
    });

    expect(mockBindSubscriptionRenewalPaymentIntent).toHaveBeenCalledWith({
      account_id: "acct-1",
      attempt_id: "attempt-1",
      payment_intent_id: "pi_123",
      stripe_invoice_id: "in_123",
      subscription_id: 123,
    });
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(mockIsReadyToProcess).not.toHaveBeenCalled();
    expect(mockProcessPaymentIntent).not.toHaveBeenCalled();
  });

  it("surfaces processing failures instead of reporting checkout success", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_123",
            },
          },
        ],
      },
    });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
    });
    mockIsReadyToProcess.mockReturnValue(true);
    mockProcessPaymentIntent.mockRejectedValue(
      new Error("membership update failed"),
    );

    await expect(
      createPaymentIntent({
        account_id: "acct-1",
        purpose: "membership-change",
        description: "Basic membership, annual",
        lineItems,
      }),
    ).rejects.toThrow("membership update failed");
    expect(mockAlertUncreditedSucceededPayment).toHaveBeenCalledWith({
      account_id: "acct-1",
      err: expect.any(Error),
      paymentIntent: {
        id: "pi_123",
        status: "succeeded",
      },
      stage: "process",
    });
  });

  it("requires customer name and address for interactive tax-enabled payments", async () => {
    stripe.invoices.finalizeInvoice.mockRejectedValueOnce(
      new Error("customer address is missing"),
    );

    await expect(
      createPaymentIntent({
        account_id: "acct-1",
        purpose: "membership-change",
        description: "Basic membership, annual",
        lineItems,
        requireAddress: true,
      }),
    ).rejects.toThrow("Name and address are required");

    expect(stripe.invoices.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "binds the approved admin order before attempting collection (rejected=%s)",
    async (rejected) => {
      stripe.invoices.finalizeInvoice.mockResolvedValue({
        id: "in_123",
        payment_intent: "pi_123",
        hosted_invoice_url: "https://stripe.example/invoice",
      });
      if (rejected)
        mockBindAdminMembershipPayment.mockRejectedValueOnce(
          Error("order authority unavailable"),
        );
      const run = createPaymentIntent({
        account_id: "acct-1",
        purpose: "admin-membership-package-purchase",
        lineItems,
        metadata: { admin_membership_order_id: "order-1" },
        processImmediately: false,
        idempotencyKeyPrefix: "admin-membership-order:order-1",
      });
      if (rejected) {
        await expect(run).rejects.toThrow("order authority unavailable");
        expect(stripe.invoices.pay).not.toHaveBeenCalled();
      } else {
        await run;
        expect(
          mockBindAdminMembershipPayment.mock.invocationCallOrder[0],
        ).toBeLessThan(stripe.invoices.pay.mock.invocationCallOrder[0]);
      }
      const binding = mockBindAdminMembershipPayment.mock.calls[0][0];
      expect(binding).toMatchObject({
        account_id: "acct-1",
        order_id: "order-1",
        payment_intent_id: "pi_123",
        stripe_invoice_id: "in_123",
      });
      expect(binding.amount.toString()).toBe("72");
    },
  );

  it("uses stable Stripe keys and only tries allowed instant methods", async () => {
    stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: "in_123",
      hosted_invoice_url: "https://stripe.example/invoice",
      payments: {
        data: [
          {
            is_default: true,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_123",
            },
          },
        ],
      },
    });
    stripe.customers.retrieve.mockResolvedValue({
      invoice_settings: { default_payment_method: "pm_bank" },
    });
    stripe.customers.listPaymentMethods.mockResolvedValue({
      data: [
        { id: "pm_bank", type: "us_bank_account" },
        { id: "pm_card", type: "card" },
      ],
    });

    await createPaymentIntent({
      account_id: "acct-1",
      purpose: "subscription-renewal",
      description: "Standard membership renewal, monthly",
      lineItems,
      metadata: {
        renewal_attempt_id: "attempt-1",
        subscription_id: "123",
      },
      processImmediately: false,
      idempotencyKeyPrefix: "subscription-renewal:attempt-1",
      allowedPaymentMethodTypes: ["card"],
    });

    expect(stripe.invoices.create).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: "subscription-renewal:attempt-1:invoice",
    });
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.any(Object),
      { idempotencyKey: "subscription-renewal:attempt-1:item:0" },
    );
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.pay).toHaveBeenCalledWith(
      "in_123",
      {},
      {
        idempotencyKey: "subscription-renewal:attempt-1:pay:pm_card",
      },
    );
    expect(stripe.invoices.update).toHaveBeenCalledWith(
      "in_123",
      { default_payment_method: "pm_card" },
      { idempotencyKey: "subscription-renewal:attempt-1:method:pm_card" },
    );
  });
});
