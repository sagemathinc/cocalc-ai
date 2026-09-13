/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const retrievePaymentIntentMock = jest.fn();
const createCreditMock = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => ({
    paymentIntents: { retrieve: retrievePaymentIntentMock },
  }),
}));

jest.mock("@cocalc/server/purchases/create-invoice", () => ({
  createCreditFromPaidStripePaymentIntent: (...args: unknown[]) =>
    createCreditMock(...args),
}));

jest.mock("@cocalc/server/purchases/stripe/util", () => ({
  currentStripeSite: async () => "authority.test",
  getStripeCustomerId: jest.fn(),
}));

import { runInBillingAuthorityContext } from "./context";
import { reconcileLegacyPaymentIntentCredit } from "../stripe-usage-based-subscription";

const ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";

describe("billing authority dynamic account registration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    retrievePaymentIntentMock.mockResolvedValue({
      id: "pi_frozen_account",
      status: "succeeded",
      amount_received: 2_500,
      metadata: { account_id: ACCOUNT_ID, service: "credit" },
    });
  });

  it("stops legacy payment-intent crediting when the resolved account is frozen", async () => {
    const registerAccount = jest.fn(async () => {
      throw Object.assign(new Error("billing is frozen for this account"), {
        status: 423,
      });
    });

    await expect(
      runInBillingAuthorityContext({
        operation: "reconcile-legacy-credit",
        request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        register_account: registerAccount,
        fn: async () =>
          await reconcileLegacyPaymentIntentCredit("pi_frozen_account"),
      }),
    ).rejects.toMatchObject({ status: 423 });

    expect(registerAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(createCreditMock).not.toHaveBeenCalled();
  });
});
