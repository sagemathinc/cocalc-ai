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

import { hasPaymentMethod } from "./get-payment-methods";

describe("hasPaymentMethod", () => {
  const stripe = {
    customers: {
      listPaymentMethods: jest.fn(),
      retrieve: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConn.mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockResolvedValue("cus_123");
    stripe.customers.listPaymentMethods.mockResolvedValue({ data: [] });
    stripe.customers.retrieve.mockResolvedValue({
      default_source: null,
      sources: { data: [] },
    });
  });

  it("returns false when the account has no Stripe customer", async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined);

    await expect(hasPaymentMethod("account-1")).resolves.toBe(false);

    expect(mockGetConn).not.toHaveBeenCalled();
  });

  it("detects modern Stripe PaymentMethods", async () => {
    stripe.customers.listPaymentMethods.mockResolvedValue({
      data: [{ id: "pm_123" }],
    });

    await expect(hasPaymentMethod("account-1")).resolves.toBe(true);

    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("detects a legacy default source", async () => {
    stripe.customers.retrieve.mockResolvedValue({
      default_source: "card_123",
      sources: { data: [] },
    });

    await expect(hasPaymentMethod("account-1")).resolves.toBe(true);
  });

  it("detects expanded legacy card sources", async () => {
    stripe.customers.retrieve.mockResolvedValue({
      default_source: null,
      sources: { data: [{ id: "card_123", object: "card" }] },
    });

    await expect(hasPaymentMethod("account-1")).resolves.toBe(true);
  });

  it("ignores deleted legacy sources", async () => {
    stripe.customers.retrieve.mockResolvedValue({
      default_source: null,
      sources: {
        data: [{ id: "card_deleted", object: "card", deleted: true }],
      },
    });

    await expect(hasPaymentMethod("account-1")).resolves.toBe(false);
  });
});
