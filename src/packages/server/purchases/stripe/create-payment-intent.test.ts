/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockAssertPaymentCheckoutAllowed = jest.fn();
const mockGetConn = jest.fn();
const mockDefaultReturnUrl = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockSanityCheckAmount = jest.fn();
const mockAssertValidUserMetadata = jest.fn();
const mockGetStripeLineItems = jest.fn();
const mockIsReadyToProcess = jest.fn();
const mockProcessPaymentIntent = jest.fn();
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
  assertValidUserMetadata: (...args: any[]) =>
    mockAssertValidUserMetadata(...args),
  defaultReturnUrl: (...args: any[]) => mockDefaultReturnUrl(...args),
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
  getStripeLineItems: (...args: any[]) => mockGetStripeLineItems(...args),
  sanityCheckAmount: (...args: any[]) => mockSanityCheckAmount(...args),
}));

jest.mock("./process-payment-intents", () => ({
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

import createPaymentIntent, {
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
    },
    paymentIntents: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertPaymentCheckoutAllowed.mockResolvedValue(undefined);
    mockGetConn.mockResolvedValue(stripe);
    mockDefaultReturnUrl.mockResolvedValue("https://cocalc.example/return");
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    mockSanityCheckAmount.mockResolvedValue(undefined);
    mockAssertValidUserMetadata.mockReturnValue(undefined);
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
});
