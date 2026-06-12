/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after } from "@cocalc/server/test";
import getPool from "@cocalc/database/pool";
import {
  createTestAccount,
  createTestMembershipSubscription,
  createTestMembershipTier,
} from "./test-data";

const mockAssertBillingReady = jest.fn();

jest.mock("@cocalc/server/purchases/stripe/billing-readiness", () => ({
  assertBillingReady: (...args: any[]) => mockAssertBillingReady(...args),
}));

import { applyMembershipChange } from "./membership-change";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("membership change payment enforcement", () => {
  const account_id = uuid();
  const targetClass = `paid-${uuid().slice(0, 8)}` as any;

  beforeEach(() => {
    mockAssertBillingReady.mockReset().mockResolvedValue({
      hasBillingDetails: true,
      hasPaymentMethod: true,
    });
  });

  it("rejects externally paid membership changes when the payment is too small", async () => {
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: targetClass,
      price_monthly: 100,
      price_yearly: 1000,
      priority: 20,
    });

    await expect(
      applyMembershipChange({
        account_id,
        targetClass,
        interval: "month",
        paymentAmount: 1,
      }),
    ).rejects.toThrow(/Please pay|minimum payment/);
  });

  it("allows externally paid membership changes when the payment covers the server-computed cost", async () => {
    const result = await applyMembershipChange({
      account_id,
      targetClass,
      interval: "month",
      paymentAmount: 100,
    });

    expect(result.subscription_id).toBeGreaterThan(0);
    expect(result.purchase_id).toBeGreaterThan(0);
  });

  it("does not create a purchase row for zero-cost deferred downgrades", async () => {
    const downgradeAccount = uuid();
    const highTier = `high-${uuid().slice(0, 8)}` as any;
    const lowTier = `low-${uuid().slice(0, 8)}` as any;
    await createTestAccount(downgradeAccount);
    await createTestMembershipTier({
      id: lowTier,
      price_monthly: 20,
      price_yearly: 200,
      priority: 10,
    });
    await createTestMembershipTier({
      id: highTier,
      price_monthly: 100,
      price_yearly: 1000,
      priority: 20,
    });
    await createTestMembershipSubscription(downgradeAccount, {
      class: highTier,
      cost: 100,
      end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const result = await applyMembershipChange({
      account_id: downgradeAccount,
      targetClass: lowTier,
      interval: "month",
      allowDowngrade: true,
    });

    expect(result.charge).toBe(0);
    expect(result.purchase_id).toBeUndefined();
    const { rows: subscriptionRows } = await getPool().query(
      "SELECT latest_purchase_id FROM subscriptions WHERE id=$1",
      [result.subscription_id],
    );
    expect(subscriptionRows[0]?.latest_purchase_id).toBeNull();
    const { rows: purchaseRows } = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND service='membership'",
      [downgradeAccount],
    );
    expect(purchaseRows[0]?.count).toBe(0);
  });

  it("rejects free trials when billing is not ready", async () => {
    const trialAccount = uuid();
    const trialTier = `trial-${uuid().slice(0, 8)}` as any;
    await createTestAccount(trialAccount);
    await createTestMembershipTier({
      id: trialTier,
      price_monthly: 50,
      price_yearly: 500,
      priority: 20,
      trial_days: 7,
    });
    mockAssertBillingReady.mockRejectedValueOnce(
      new Error("Billing details are required to start a free trial."),
    );

    await expect(
      applyMembershipChange({
        account_id: trialAccount,
        targetClass: trialTier,
        interval: "month",
      }),
    ).rejects.toThrow("Billing details are required");

    expect(mockAssertBillingReady).toHaveBeenCalledWith(trialAccount);
  });

  it("allows free trials when billing is ready", async () => {
    const trialAccount = uuid();
    const trialTier = `trial-${uuid().slice(0, 8)}` as any;
    await createTestAccount(trialAccount);
    await createTestMembershipTier({
      id: trialTier,
      price_monthly: 50,
      price_yearly: 500,
      priority: 20,
      trial_days: 7,
    });

    const result = await applyMembershipChange({
      account_id: trialAccount,
      targetClass: trialTier,
      interval: "month",
    });

    expect(mockAssertBillingReady).toHaveBeenCalledWith(trialAccount);
    expect(result.subscription_id).toBeGreaterThan(0);
    expect(result.purchase_id).toBeUndefined();
    expect(result.trial_available).toBe(true);
  });
});
