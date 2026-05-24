/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";
import { resumeSubscriptionSetPaymentIntent } from "./create-subscription-payment";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("Stripe payment-intent ownership checks", () => {
  it("does not let one account attach a resume payment intent to another account's subscription", async () => {
    const owner = uuid();
    const attacker = uuid();
    await createTestAccount(owner);
    await createTestAccount(attacker);
    const { subscription_id } = await createTestMembershipSubscription(owner, {
      status: "canceled",
    });

    await expect(
      resumeSubscriptionSetPaymentIntent({
        account_id: attacker,
        subscription_id,
        paymentIntentId: "pi_attacker",
      }),
    ).rejects.toThrow(/You do not have a subscription/);
  });
});
