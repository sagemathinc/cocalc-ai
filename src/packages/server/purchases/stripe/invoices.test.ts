/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetStripeCustomerId = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./util", () => ({
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
}));

describe("purchases stripe invoices", () => {
  const stripe = {
    invoices: {
      retrieve: jest.fn(),
    },
    paymentIntents: {
      retrieve: jest.fn(),
    },
    charges: {
      list: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetConn.mockReset().mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockReset().mockResolvedValue("cus_own");
    stripe.invoices.retrieve.mockReset();
    stripe.paymentIntents.retrieve.mockReset();
    stripe.charges.list.mockReset();
  });

  it("returns an owned Stripe invoice", async () => {
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      customer: "cus_own",
      hosted_invoice_url: "https://stripe.example/invoice",
    });
    const { getInvoice } = await import("./invoices");

    await expect(
      getInvoice({ account_id: "acct-1", invoice_id: "in_123" }),
    ).resolves.toMatchObject({
      id: "in_123",
      customer: "cus_own",
    });
  });

  it("rejects invoices owned by another Stripe customer", async () => {
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      customer: "cus_other",
    });
    const { getInvoice } = await import("./invoices");

    await expect(
      getInvoice({ account_id: "acct-1", invoice_id: "in_123" }),
    ).rejects.toThrow("invoice not found");
  });

  it("returns a legacy payment-intent receipt URL only for owned intents", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      customer: { id: "cus_own" },
    });
    stripe.charges.list.mockResolvedValue({
      data: [{ receipt_url: "https://stripe.example/receipt" }],
    });
    const { getInvoiceUrl } = await import("./invoices");

    await expect(
      getInvoiceUrl({ account_id: "acct-1", invoice_id: "pi_123" }),
    ).resolves.toBe("https://stripe.example/receipt");
  });

  it("rejects legacy payment intents owned by another Stripe customer", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      customer: "cus_other",
    });
    const { getInvoiceUrl } = await import("./invoices");

    await expect(
      getInvoiceUrl({ account_id: "acct-1", invoice_id: "pi_123" }),
    ).rejects.toThrow("invoice not found");
    expect(stripe.charges.list).not.toHaveBeenCalled();
  });
});
