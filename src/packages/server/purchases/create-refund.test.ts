/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockUserIsInGroup = jest.fn();
const mockGetPool = jest.fn();
const mockGetTransactionClient = jest.fn();
const mockCreatePurchase = jest.fn();
const mockGetConn = jest.fn();
const mockSend = jest.fn();

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetPool(...args),
  getTransactionClient: (...args: any[]) => mockGetTransactionClient(...args),
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("./create-purchase", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreatePurchase(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  support: jest.fn().mockResolvedValue("Support"),
  url: jest.fn(async (...args) => args.join("/")),
}));

import createRefund from "./create-refund";

function makeClient() {
  return {
    query: jest.fn(),
    release: jest.fn(),
  };
}

function makeStripe() {
  return {
    charges: {
      list: jest.fn().mockResolvedValue({ data: [{ id: "ch_123" }] }),
      retrieve: jest.fn().mockResolvedValue(undefined),
    },
    invoicePayments: {
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
    invoices: {
      retrieve: jest.fn().mockResolvedValue({ charge: "ch_123" }),
    },
    paymentIntents: {
      retrieve: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
    refunds: {
      create: jest.fn().mockResolvedValue({ id: "re_123" }),
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
  };
}

describe("createRefund", () => {
  beforeEach(() => {
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockGetPool.mockReset().mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            account_id: "user-1",
            description: { type: "credit" },
            service: "credit",
          },
        ],
      }),
    });
    mockGetTransactionClient.mockReset();
    mockCreatePurchase.mockReset().mockResolvedValue(55);
    mockGetConn.mockReset();
    mockSend.mockReset().mockResolvedValue(undefined);
  });

  it("returns an existing refund purchase without creating another Stripe refund", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            account_id: "user-1",
            invoice_id: "in_123",
            service: "credit",
            cost: 25,
            description: { type: "credit", refund_purchase_id: 99 },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const stripe = makeStripe();
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);

    await expect(
      createRefund({
        account_id: "admin-1",
        purchase_id: 10,
        reason: "requested_by_customer",
      }),
    ).resolves.toBe(99);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT id, account_id, invoice_id, service, cost, description FROM purchases WHERE id=$1 FOR UPDATE",
      [10],
    );
    expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(mockCreatePurchase).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("omits Stripe's reason for a CoCalc 'other' refund", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            account_id: "user-1",
            invoice_id: "in_123",
            service: "credit",
            cost: 25,
            description: { type: "credit" },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const stripe = makeStripe();
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);

    await expect(
      createRefund({
        account_id: "admin-1",
        purchase_id: 10,
        reason: "other",
        notes: "support case 1",
      }),
    ).resolves.toBe(55);

    expect(mockCreatePurchase).toHaveBeenCalledWith({
      account_id: "user-1",
      service: "refund",
      cost: expect.anything(),
      description: {
        type: "refund",
        purchase_id: 10,
        notes: "support case 1",
        reason: "other",
      },
      client,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        charge: "ch_123",
        metadata: { account_id: "admin-1", purchase_id: 10 },
      },
      { idempotencyKey: "cocalc-refund-purchase-10" },
    );
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to_ids: ["user-1"] }),
    );
  });

  it("resolves refundable charge through payment intent metadata invoice_id", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            account_id: "user-1",
            invoice_id: "pi_123",
            service: "credit",
            cost: 25,
            description: { type: "credit" },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_123",
      invoice: null,
      metadata: { invoice_id: "in_123" },
    });
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      charge: null,
      payment_intent: null,
    });
    stripe.charges.list.mockResolvedValue({ data: [{ id: "ch_from_pi" }] });
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);

    await expect(
      createRefund({
        account_id: "admin-1",
        purchase_id: 10,
        reason: "requested_by_customer",
      }),
    ).resolves.toBe(55);

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith("in_123");
    expect(stripe.charges.list).toHaveBeenCalledWith({
      payment_intent: "pi_123",
      limit: 1,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_from_pi" }),
      { idempotencyKey: "cocalc-refund-purchase-10" },
    );
  });

  it("resolves refundable charge through Stripe invoice payment records", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            account_id: "user-1",
            invoice_id: "in_123",
            service: "credit",
            cost: 25,
            description: { type: "credit" },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const stripe = makeStripe();
    stripe.invoices.retrieve.mockResolvedValue({
      id: "in_123",
      charge: null,
      payment_intent: null,
    });
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        {
          is_default: true,
          payment: {
            type: "payment_intent",
            payment_intent: { id: "pi_from_invoice_payment" },
          },
          status: "paid",
        },
      ],
    });
    stripe.charges.list.mockResolvedValue({
      data: [{ id: "ch_from_invoice" }],
    });
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);

    await expect(
      createRefund({
        account_id: "admin-1",
        purchase_id: 10,
        reason: "requested_by_customer",
      }),
    ).resolves.toBe(55);

    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({
      invoice: "in_123",
      payment: { type: "payment_intent" },
      limit: 10,
      expand: ["data.payment.payment_intent"],
    });
    expect(stripe.charges.list).toHaveBeenCalledWith({
      payment_intent: "pi_from_invoice_payment",
      limit: 1,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_from_invoice" }),
      { idempotencyKey: "cocalc-refund-purchase-10" },
    );
  });

  it("records a refund that was already completed directly in Stripe", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            account_id: "user-1",
            invoice_id: "in_123",
            service: "credit",
            cost: -25,
            description: { type: "credit" },
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const stripe = makeStripe();
    stripe.charges.retrieve.mockResolvedValue({
      id: "ch_123",
      amount: 2500,
      amount_refunded: 2500,
      refunded: true,
      refunds: { data: [{ id: "re_manual", status: "succeeded" }] },
    });
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);

    await expect(
      createRefund({
        account_id: "admin-1",
        purchase_id: 10,
        reason: "duplicate",
        notes: "Refunded in Stripe before reconciliation",
      }),
    ).resolves.toBe(55);

    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      "UPDATE purchases SET description=$2 WHERE id=$1",
      [
        55,
        expect.objectContaining({
          purchase_id: 10,
          refund_id: "re_manual",
        }),
      ],
    );
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
  });
});
