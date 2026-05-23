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

describe("purchases stripe payment method mutations", () => {
  const stripe = {
    customers: {
      retrievePaymentMethod: jest.fn(),
      update: jest.fn(),
    },
    paymentMethods: {
      detach: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetModules();
    mockGetConn.mockReset().mockResolvedValue(stripe);
    mockGetStripeCustomerId.mockReset().mockResolvedValue("cus_own");
    stripe.customers.retrievePaymentMethod.mockReset().mockResolvedValue({
      id: "pm_own",
    });
    stripe.customers.update.mockReset().mockResolvedValue(undefined);
    stripe.paymentMethods.detach.mockReset().mockResolvedValue(undefined);
  });

  it("verifies ownership before detaching a payment method", async () => {
    const { default: deletePaymentMethod } =
      await import("./delete-payment-method");

    await deletePaymentMethod({
      account_id: "acct-1",
      payment_method: "pm_own",
    });

    expect(stripe.customers.retrievePaymentMethod).toHaveBeenCalledWith(
      "cus_own",
      "pm_own",
    );
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_own");
  });

  it("does not detach payment methods that are not owned by the account", async () => {
    stripe.customers.retrievePaymentMethod.mockRejectedValue(
      new Error("No such PaymentMethod"),
    );
    const { default: deletePaymentMethod } =
      await import("./delete-payment-method");

    await expect(
      deletePaymentMethod({
        account_id: "acct-1",
        payment_method: "pm_other",
      }),
    ).rejects.toThrow("No such PaymentMethod");

    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it("verifies ownership before setting a default payment method", async () => {
    const { default: setDefaultPaymentMethod } =
      await import("./set-default-payment-method");

    await setDefaultPaymentMethod({
      account_id: "acct-1",
      default_payment_method: "pm_own",
    });

    expect(stripe.customers.retrievePaymentMethod).toHaveBeenCalledWith(
      "cus_own",
      "pm_own",
    );
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_own", {
      invoice_settings: { default_payment_method: "pm_own" },
    });
  });

  it("does not set payment methods that are not owned by the account as default", async () => {
    stripe.customers.retrievePaymentMethod.mockRejectedValue(
      new Error("No such PaymentMethod"),
    );
    const { default: setDefaultPaymentMethod } =
      await import("./set-default-payment-method");

    await expect(
      setDefaultPaymentMethod({
        account_id: "acct-1",
        default_payment_method: "pm_other",
      }),
    ).rejects.toThrow("No such PaymentMethod");

    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});
