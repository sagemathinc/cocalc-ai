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
  createTestMembershipTier as insertTestMembershipTier,
} from "./test-data";
import {
  getMembershipTierMap,
  type MembershipTierRecord,
} from "@cocalc/server/membership/tiers";

const mockAssertBillingReady = jest.fn();

jest.mock("@cocalc/server/purchases/stripe/billing-readiness", () => ({
  assertBillingReady: (...args: any[]) => mockAssertBillingReady(...args),
}));

import { applyMembershipChange } from "./membership-change";

const testTierMap: Record<string, MembershipTierRecord> = {};

async function createTestMembershipTier(
  opts: Parameters<typeof insertTestMembershipTier>[0],
) {
  await insertTestMembershipTier(opts);
  testTierMap[opts.id] = {
    id: opts.id,
    label: opts.id,
    store_visible: true,
    team_visible: opts.team_visible ?? false,
    course_store_visible: opts.course_store_visible ?? false,
    priority: opts.priority ?? 0,
    price_monthly: opts.price_monthly ?? 0,
    price_yearly: opts.price_yearly ?? 0,
    trial_days: opts.trial_days,
    course_price: opts.course_price,
    course_duration_days: opts.course_duration_days,
    course_grace_days: opts.course_grace_days,
    project_defaults: opts.project_defaults ?? {},
    ai_limits: opts.ai_limits ?? {},
    features: opts.features ?? {},
    usage_limits: opts.usage_limits ?? {},
    disabled: false,
  };
}

async function applyTestMembershipChange(
  opts: Parameters<typeof applyMembershipChange>[0],
) {
  const tierMap = await getMembershipTierMap({
    includeDisabled: true,
  });
  return await applyMembershipChange({
    ...opts,
    tierMap: opts.tierMap ?? { ...tierMap, ...testTierMap },
  });
}

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
      applyTestMembershipChange({
        account_id,
        targetClass,
        interval: "month",
        paymentAmount: 1,
      }),
    ).rejects.toThrow(/Please pay|minimum payment/);
  });

  it("allows externally paid membership changes when the payment covers the server-computed cost", async () => {
    const result = await applyTestMembershipChange({
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

    const result = await applyTestMembershipChange({
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

  it("downgrades to a zero-cost tier without creating a subscription", async () => {
    const downgradeAccount = uuid();
    const paidTier = `paid-${uuid().slice(0, 8)}` as any;
    const freeTier = `free-${uuid().slice(0, 8)}` as any;
    await createTestAccount(downgradeAccount);
    await createTestMembershipTier({
      id: freeTier,
      price_monthly: 0,
      price_yearly: 0,
      priority: 0,
    });
    await createTestMembershipTier({
      id: paidTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    await createTestMembershipSubscription(downgradeAccount, {
      class: paidTier,
      cost: 216,
      end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const result = await applyTestMembershipChange({
      account_id: downgradeAccount,
      targetClass: freeTier,
      interval: "year",
      allowDowngrade: true,
    });

    expect(result.charge).toBe(0);
    expect(result.subscription_id).toBeUndefined();
    expect(result.purchase_id).toBeUndefined();
    const { rows: activeRows } = await getPool().query(
      `SELECT COUNT(*)::int AS count
         FROM subscriptions
        WHERE account_id=$1
          AND metadata->>'type'='membership'
          AND status != 'canceled'
          AND current_period_end >= NOW()`,
      [downgradeAccount],
    );
    expect(activeRows[0]?.count).toBe(0);
  });

  it("cancels scheduled lower-tier renewals when downgrading to a zero-cost tier", async () => {
    const downgradeAccount = uuid();
    const highTier = `high-${uuid().slice(0, 8)}` as any;
    const lowTier = `low-${uuid().slice(0, 8)}` as any;
    const freeTier = `free-${uuid().slice(0, 8)}` as any;
    await createTestAccount(downgradeAccount);
    await createTestMembershipTier({
      id: freeTier,
      price_monthly: 0,
      price_yearly: 0,
      priority: 0,
    });
    await createTestMembershipTier({
      id: lowTier,
      price_monthly: 8,
      price_yearly: 72,
      priority: 10,
    });
    await createTestMembershipTier({
      id: highTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    await createTestMembershipSubscription(downgradeAccount, {
      class: highTier,
      cost: 216,
      end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const lowResult = await applyTestMembershipChange({
      account_id: downgradeAccount,
      targetClass: lowTier,
      interval: "year",
      allowDowngrade: true,
    });
    expect(lowResult.subscription_id).toBeGreaterThan(0);

    const freeResult = await applyTestMembershipChange({
      account_id: downgradeAccount,
      targetClass: freeTier,
      interval: "year",
      allowDowngrade: true,
    });

    expect(freeResult.subscription_id).toBeUndefined();
    const { rows: activeRows } = await getPool().query(
      `SELECT metadata->>'class' AS class
         FROM subscriptions
        WHERE account_id=$1
          AND metadata->>'type'='membership'
          AND status != 'canceled'
          AND current_period_end >= NOW()`,
      [downgradeAccount],
    );
    expect(activeRows).toEqual([]);
  });

  it("continues a legacy migration grant as a paid membership after the grant", async () => {
    const grantAccount = uuid();
    const standardTier = `grant-standard-${uuid().slice(0, 8)}` as any;
    const basicTier = `grant-basic-${uuid().slice(0, 8)}` as any;
    await createTestAccount(grantAccount);
    await createTestMembershipTier({
      id: basicTier,
      price_monthly: 8,
      price_yearly: 72,
      priority: 10,
    });
    await createTestMembershipTier({
      id: standardTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    const grantEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { subscription_id: grantSubscriptionId } =
      await createTestMembershipSubscription(grantAccount, {
        class: standardTier,
        cost: 216,
        interval: "year",
        end: grantEnd,
        status: "canceled",
      });
    await getPool().query(
      "UPDATE subscriptions SET latest_purchase_id=NULL, metadata=metadata || $2::jsonb WHERE id=$1",
      [
        grantSubscriptionId,
        JSON.stringify({
          grant: true,
          source_id: "legacy-migration",
        }),
      ],
    );

    const result = await applyTestMembershipChange({
      account_id: grantAccount,
      targetClass: basicTier,
      interval: "month",
      allowDowngrade: true,
      paymentAmount: 8,
    });

    expect(result.charge).toBe(8);
    expect(result.purchase_id).toBeGreaterThan(0);
    expect(result.subscription_id).toBeGreaterThan(0);
    const { rows } = await getPool().query(
      `SELECT metadata->>'class' AS class,
              status,
              current_period_end,
              latest_purchase_id
         FROM subscriptions
        WHERE id=$1`,
      [result.subscription_id],
    );
    expect(rows[0]?.class).toBe(basicTier);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.latest_purchase_id).toBe(result.purchase_id);
    expect(new Date(rows[0]?.current_period_end).getTime()).toBeGreaterThan(
      grantEnd.getTime() + 25 * 24 * 60 * 60 * 1000,
    );
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
      applyTestMembershipChange({
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

    const result = await applyTestMembershipChange({
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
