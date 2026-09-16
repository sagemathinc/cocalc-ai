/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const cancelPaymentIntentMock = jest.fn();
const getAllOpenPaymentsMock = jest.fn();
const getPaymentMethodsMock = jest.fn();
const deletePaymentMethodMock = jest.fn();

jest.mock("@cocalc/server/purchases/stripe/create-payment-intent", () => ({
  cancelPaymentIntent: (...args: any[]) => cancelPaymentIntentMock(...args),
}));
jest.mock("@cocalc/server/purchases/stripe/get-payments", () => ({
  getAllOpenPayments: (...args: any[]) => getAllOpenPaymentsMock(...args),
}));
jest.mock("@cocalc/server/purchases/stripe/get-payment-methods", () => ({
  __esModule: true,
  default: (...args: any[]) => getPaymentMethodsMock(...args),
}));
jest.mock("@cocalc/server/purchases/stripe/delete-payment-method", () => ({
  __esModule: true,
  default: (...args: any[]) => deletePaymentMethodMock(...args),
}));

import {
  cancelOpenPaymentIntentsForQuarantine,
  detachPaymentMethodsForQuarantine,
} from "./resource-quarantine-stripe";

describe("resource quarantine Stripe actions", () => {
  beforeEach(() => {
    cancelPaymentIntentMock.mockReset().mockResolvedValue(undefined);
    getAllOpenPaymentsMock.mockReset();
    getPaymentMethodsMock.mockReset();
    deletePaymentMethodMock.mockReset().mockResolvedValue(undefined);
  });

  it("cancels every open payment intent", async () => {
    getAllOpenPaymentsMock.mockResolvedValue({
      data: [{ id: "pi_1" }, {}, { id: "pi_2" }],
    });
    await expect(
      cancelOpenPaymentIntentsForQuarantine("account-1"),
    ).resolves.toBe(2);
    expect(cancelPaymentIntentMock.mock.calls).toEqual([
      [{ id: "pi_1", reason: "fraudulent" }],
      [{ id: "pi_2", reason: "fraudulent" }],
    ]);
  });

  it("detaches all payment methods across pages", async () => {
    getPaymentMethodsMock
      .mockResolvedValueOnce({
        data: [{ id: "pm_1" }, { id: "pm_2" }],
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [{ id: "pm_3" }], has_more: false });

    await expect(detachPaymentMethodsForQuarantine("account-1")).resolves.toBe(
      3,
    );
    expect(getPaymentMethodsMock.mock.calls).toEqual([
      [
        {
          account_id: "account-1",
          starting_after: undefined,
          limit: 100,
        },
      ],
      [
        {
          account_id: "account-1",
          starting_after: "pm_2",
          limit: 100,
        },
      ],
    ]);
    expect(deletePaymentMethodMock).toHaveBeenCalledTimes(3);
  });
});
