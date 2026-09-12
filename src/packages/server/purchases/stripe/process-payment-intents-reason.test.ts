/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { subscriptionRenewalPaymentReason } from "./process-payment-intents";

describe("subscription renewal payment receipts", () => {
  it("reports a fulfilled renewal", () => {
    expect(
      subscriptionRenewalPaymentReason({
        subscription_id: "17",
        result: { status: "renewed" },
      }),
    ).toBe("renew a subscription (id=17)");
  });

  it("reports account credit when the renewal was skipped", () => {
    expect(
      subscriptionRenewalPaymentReason({
        subscription_id: "17",
        result: {
          status: "skipped",
          reason: "subscription-not-active",
        },
      }),
    ).toBe(
      "add credit to your account because the subscription renewal was not applied",
    );
  });
});
