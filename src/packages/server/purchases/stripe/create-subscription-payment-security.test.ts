/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after, getPool } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "@cocalc/server/purchases/test-data";
import {
  processResumeSubscriptionFailure,
  processSubscriptionRenewalFailure,
} from "./create-subscription-payment";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

async function getSubscriptionState(subscription_id: number) {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT status, payment, resume_payment_intent FROM subscriptions WHERE id=$1",
    [subscription_id],
  );
  return rows[0];
}

describe("Stripe subscription payment failure ownership checks", () => {
  it("does not let a canceled payment for one account cancel another account's subscription", async () => {
    const owner = uuid();
    const attacker = uuid();
    await createTestAccount(owner);
    await createTestAccount(attacker);
    const { subscription_id } = await createTestMembershipSubscription(owner, {
      status: "active",
    });
    const pool = getPool();
    await pool.query("UPDATE subscriptions SET payment=$2 WHERE id=$1", [
      subscription_id,
      {
        payment_intent_id: "pi_owner",
        amount: 10,
        created: Date.now(),
        status: "active",
        new_expires_ms: Date.now() + 1000 * 60 * 60,
      },
    ]);

    await expect(
      processSubscriptionRenewalFailure({
        account_id: attacker,
        paymentIntent: {
          id: "pi_attacker",
          metadata: { subscription_id: `${subscription_id}` },
        },
      }),
    ).rejects.toThrow(/You do not have a subscription/);

    const state = await getSubscriptionState(subscription_id);
    expect(state.status).toBe("active");
    expect(state.payment.status).toBe("active");
  });

  it("does not let a canceled resume payment for one account clear another account's resume payment", async () => {
    const owner = uuid();
    const attacker = uuid();
    await createTestAccount(owner);
    await createTestAccount(attacker);
    const { subscription_id } = await createTestMembershipSubscription(owner, {
      status: "canceled",
    });
    const pool = getPool();
    await pool.query(
      "UPDATE subscriptions SET resume_payment_intent=$2 WHERE id=$1",
      [subscription_id, "pi_owner_resume"],
    );

    await expect(
      processResumeSubscriptionFailure({
        account_id: attacker,
        paymentIntent: {
          id: "pi_attacker",
          metadata: { subscription_id: `${subscription_id}` },
        },
      }),
    ).rejects.toThrow(/You do not have a subscription/);

    const state = await getSubscriptionState(subscription_id);
    expect(state.resume_payment_intent).toBe("pi_owner_resume");
  });
});
