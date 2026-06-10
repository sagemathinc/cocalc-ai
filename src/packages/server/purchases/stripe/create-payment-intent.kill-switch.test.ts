/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const assertPaymentCheckoutAllowedMock = jest.fn();
const getConnMock = jest.fn();

jest.mock("@cocalc/server/launch/kill-switches", () => ({
  assertPaymentCheckoutAllowed: (...args: any[]) =>
    assertPaymentCheckoutAllowedMock(...args),
}));

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => getConnMock(...args),
}));

describe("Stripe payment intent launch kill switches", () => {
  beforeEach(() => {
    jest.resetModules();
    assertPaymentCheckoutAllowedMock.mockReset();
    getConnMock.mockReset();
  });

  it("blocks direct payment-intent creation before any Stripe work", async () => {
    assertPaymentCheckoutAllowedMock.mockRejectedValue(
      new Error("Payment checkout is temporarily disabled"),
    );

    const { default: createPaymentIntent } =
      await import("./create-payment-intent");

    await expect(
      createPaymentIntent({
        account_id: "11111111-1111-4111-8111-111111111111",
        purpose: "admin-payment",
        lineItems: [{ description: "test", amount: 10 }],
      }),
    ).rejects.toThrow("Payment checkout is temporarily disabled");
    expect(assertPaymentCheckoutAllowedMock).toHaveBeenCalledTimes(1);
    expect(getConnMock).not.toHaveBeenCalled();
  });
});
