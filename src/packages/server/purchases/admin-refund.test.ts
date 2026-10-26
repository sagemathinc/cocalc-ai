/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const executeBillingHttpCommandMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/purchases/billing-authority/client", () => ({
  executeBillingHttpCommand: (...args: any[]) =>
    executeBillingHttpCommandMock(...args),
}));

import { adminRefundPurchase } from "./admin-refund";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function purchaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 4242,
    account_id: USER,
    time: new Date("2026-03-10T12:00:00Z"),
    service: "credit",
    cost: "-12.00",
    invoice_id: "pi_test",
    description: { type: "credit" },
    ...overrides,
  };
}

describe("adminRefundPurchase", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("previews a card payment without calling the billing authority", async () => {
    queryMock.mockResolvedValue({ rows: [purchaseRow()] });

    const result = await adminRefundPurchase({
      admin_account_id: ADMIN,
      purchase_id: "4242",
      reason: "requested_by_customer",
      notes: "  duplicate charge  ",
      commit: false,
    });

    expect(result).toEqual({
      commit: false,
      purchase: {
        id: 4242,
        account_id: USER,
        time: "2026-03-10T12:00:00.000Z",
        service: "credit",
        cost: -12,
        description_type: "credit",
        provider_payment: true,
        existing_refund_purchase_id: null,
      },
      reason: "requested_by_customer",
      notes: "duplicate charge",
    });
    expect(executeBillingHttpCommandMock).not.toHaveBeenCalled();
  });

  it("shows a membership purchase as internal and an existing refund", async () => {
    queryMock.mockResolvedValue({
      rows: [
        purchaseRow({
          id: 4243,
          service: "membership",
          cost: 15,
          invoice_id: null,
          description: { type: "membership", refund_purchase_id: 9002 },
        }),
      ],
    });

    const result = await adminRefundPurchase({
      admin_account_id: ADMIN,
      purchase_id: 4243,
      reason: "requested_by_customer",
      commit: false,
    });

    expect(result.purchase.provider_payment).toBe(false);
    expect(result.purchase.existing_refund_purchase_id).toBe(9002);
  });

  it("commits through the create-refund billing command", async () => {
    queryMock.mockResolvedValue({ rows: [purchaseRow()] });
    executeBillingHttpCommandMock.mockResolvedValue(9001);

    const result = await adminRefundPurchase({
      admin_account_id: ADMIN,
      purchase_id: 4242,
      reason: "requested_by_customer",
      notes: "duplicate charge",
      commit: true,
    });

    expect(executeBillingHttpCommandMock).toHaveBeenCalledWith(
      "create-refund",
      {
        account_id: ADMIN,
        actor_account_id: ADMIN,
        purchase_id: 4242,
        reason: "requested_by_customer",
        notes: "duplicate charge",
      },
    );
    expect(result.commit).toBe(true);
    expect(result.refund_purchase_id).toBe(9001);
  });

  it.each([0, -3, 1.5, "abc", undefined])(
    "rejects purchase id %p",
    async (purchase_id) => {
      await expect(
        adminRefundPurchase({
          admin_account_id: ADMIN,
          purchase_id,
          reason: "other",
          commit: true,
        }),
      ).rejects.toThrow("purchase_id must be a positive integer");
      expect(queryMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown reason and overlong notes", async () => {
    await expect(
      adminRefundPurchase({
        admin_account_id: ADMIN,
        purchase_id: 4242,
        reason: "because",
        commit: true,
      }),
    ).rejects.toThrow("reason must be one of");
    await expect(
      adminRefundPurchase({
        admin_account_id: ADMIN,
        purchase_id: 4242,
        reason: "other",
        notes: "x".repeat(1001),
        commit: true,
      }),
    ).rejects.toThrow("notes must be at most 1000 characters");
    expect(executeBillingHttpCommandMock).not.toHaveBeenCalled();
  });

  it("reports a missing purchase", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(
      adminRefundPurchase({
        admin_account_id: ADMIN,
        purchase_id: 77,
        reason: "other",
        commit: true,
      }),
    ).rejects.toThrow("No purchase with id 77");
    expect(executeBillingHttpCommandMock).not.toHaveBeenCalled();
  });
});
