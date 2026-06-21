/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockUserIsInGroup = jest.fn();
const mockGetTransactionClient = jest.fn();
const mockCreatePurchase = jest.fn();
const mockGetConn = jest.fn();
const mockSend = jest.fn();

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
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
    invoices: {
      retrieve: jest.fn().mockResolvedValue({ charge: "ch_123" }),
    },
    paymentIntents: {
      retrieve: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
    refunds: {
      create: jest.fn().mockResolvedValue({ id: "re_123" }),
    },
  };
}

describe("createRefund", () => {
  beforeEach(() => {
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
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

  it("creates Stripe refunds with a deterministic idempotency key", async () => {
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
        reason: "requested_by_customer",
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
        reason: "requested_by_customer",
      },
      client,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        charge: "ch_123",
        metadata: { account_id: "admin-1", purchase_id: 10 },
        reason: "requested_by_customer",
      },
      { idempotencyKey: "cocalc-refund-purchase-10" },
    );
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to_ids: ["user-1"] }),
    );
  });
});
