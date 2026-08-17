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
    const creditId = 123;
    const result = await applyTestMembershipChange({
      account_id,
      targetClass,
      interval: "month",
      paymentAmount: 100,
      creditId,
    });

    expect(result.subscription_id).toBeGreaterThan(0);
    expect(result.purchase_id).toBeGreaterThan(0);
    const { rows } = await getPool().query(
      "SELECT description FROM purchases WHERE id=$1",
      [result.purchase_id],
    );
    expect(rows[0]?.description).toMatchObject({ credit_id: creditId });
    const { rows: allocationRows } = await getPool().query(
      `SELECT lifecycle, membership_class, billing_interval,
              active_memberships, revenue_cents
         FROM membership_allocation_facts
        WHERE purchase_id=$1`,
      [result.purchase_id],
    );
    expect(allocationRows).toEqual([
      {
        lifecycle: "first_paid",
        membership_class: targetClass,
        billing_interval: "month",
        active_memberships: 1,
        revenue_cents: "10000",
      },
    ]);
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
      "SELECT latest_purchase_id, metadata FROM subscriptions WHERE id=$1",
      [result.subscription_id],
    );
    expect(subscriptionRows[0]?.latest_purchase_id).toBeNull();
    expect(subscriptionRows[0]?.metadata?.pending_plan_change).toMatchObject({
      kind: "downgrade",
      previous_class: highTier,
      previous_interval: "month",
    });
    const { rows: purchaseRows } = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND service='membership'",
      [downgradeAccount],
    );
    expect(purchaseRows[0]?.count).toBe(0);
    const { rows: allocationRows } = await getPool().query(
      `SELECT COUNT(*)::int AS count
         FROM membership_allocation_facts
        WHERE subscription_id=$1`,
      [result.subscription_id],
    );
    expect(allocationRows[0]?.count).toBe(0);
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

  it("configures legacy migration grant renewal without charging immediately", async () => {
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
    });

    expect(result.charge).toBe(0);
    expect(result.purchase_id).toBeUndefined();
    expect(result.subscription_id).toBe(grantSubscriptionId);
    const { rows } = await getPool().query(
      `SELECT metadata->>'class' AS class,
              metadata->>'renewal_class' AS renewal_class,
              metadata->>'renewal_interval' AS renewal_interval,
              metadata->>'renewal_configured' AS renewal_configured,
              status,
              cost,
              interval,
              current_period_end,
              latest_purchase_id
         FROM subscriptions
        WHERE id=$1`,
      [result.subscription_id],
    );
    expect(rows[0]?.class).toBe(standardTier);
    expect(rows[0]?.renewal_class).toBe(basicTier);
    expect(rows[0]?.renewal_interval).toBe("month");
    expect(rows[0]?.renewal_configured).toBe("true");
    expect(rows[0]?.status).toBe("active");
    expect(Number(rows[0]?.cost)).toBe(8);
    expect(rows[0]?.interval).toBe("month");
    expect(rows[0]?.latest_purchase_id).toBeNull();
    expect(new Date(rows[0]?.current_period_end).getTime()).toBe(
      grantEnd.getTime(),
    );
    const { rows: purchaseRows } = await getPool().query(
      "SELECT COUNT(*)::int AS count FROM purchases WHERE account_id=$1 AND service='membership'",
      [grantAccount],
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
    const { rows: allocationRows } = await getPool().query(
      `SELECT source_kind, lifecycle, membership_class, billing_interval,
              active_memberships, revenue_cents
         FROM membership_allocation_facts
        WHERE subscription_id=$1`,
      [result.subscription_id],
    );
    expect(allocationRows).toEqual([
      {
        source_kind: "trial",
        lifecycle: "trial",
        membership_class: trialTier,
        billing_interval: "trial",
        active_memberships: 1,
        revenue_cents: "0",
      },
    ]);
  });

  it("records both sides of an immediate paid membership upgrade", async () => {
    const upgradeAccount = uuid();
    const oldTier = `upgrade-old-${uuid().slice(0, 8)}` as any;
    const newTier = `upgrade-new-${uuid().slice(0, 8)}` as any;
    await createTestAccount(upgradeAccount);
    await createTestMembershipTier({
      id: oldTier,
      price_monthly: 100,
      price_yearly: 1000,
      priority: 10,
    });
    await createTestMembershipTier({
      id: newTier,
      price_monthly: 200,
      price_yearly: 2000,
      priority: 20,
    });
    const old = await createTestMembershipSubscription(upgradeAccount, {
      class: oldTier,
      cost: 100,
      start: new Date(),
      end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const result = await applyTestMembershipChange({
      account_id: upgradeAccount,
      targetClass: newTier,
      interval: "month",
      paymentAmount: 200,
    });

    const { rows } = await getPool().query(
      `SELECT source_kind, membership_class, billing_interval, lifecycle,
              previous_membership_class, previous_billing_interval,
              tier_change, active_memberships, revenue_cents,
              subscription_id
         FROM membership_allocation_facts
        WHERE purchase_id=$1
        ORDER BY active_memberships DESC`,
      [result.purchase_id],
    );
    expect(rows).toEqual([
      {
        source_kind: "plan-change",
        membership_class: newTier,
        billing_interval: "month",
        lifecycle: "plan_change",
        previous_membership_class: oldTier,
        previous_billing_interval: "month",
        tier_change: "upgrade",
        active_memberships: 1,
        revenue_cents: "20000",
        subscription_id: result.subscription_id,
      },
      {
        source_kind: "plan-change-credit",
        membership_class: oldTier,
        billing_interval: "month",
        lifecycle: "plan_change",
        previous_membership_class: null,
        previous_billing_interval: null,
        tier_change: "upgrade",
        active_memberships: -1,
        revenue_cents: `${-Math.round((result.price - result.charge) * 100)}`,
        subscription_id: old.subscription_id,
      },
    ]);
  });

  it.each(["unpaid", "past_due"] as const)(
    "explicitly replaces an expired %s membership",
    async (status) => {
      const replacementAccount = uuid();
      const oldTier = `old-${uuid().slice(0, 8)}` as any;
      const newTier = `new-${uuid().slice(0, 8)}` as any;
      await createTestAccount(replacementAccount);
      await createTestMembershipTier({
        id: oldTier,
        price_monthly: 24,
        price_yearly: 216,
        priority: 20,
      });
      await createTestMembershipTier({
        id: newTier,
        price_monthly: 50,
        price_yearly: 500,
        priority: 30,
      });
      const { subscription_id: oldSubscriptionId } =
        await createTestMembershipSubscription(replacementAccount, {
          class: oldTier,
          cost: 24,
          start: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          end: new Date(Date.now() - 24 * 60 * 60 * 1000),
          status,
        });

      const result = await applyTestMembershipChange({
        account_id: replacementAccount,
        targetClass: newTier,
        interval: "month",
        paymentAmount: 50,
      });

      expect(result.subscription_id).toBeGreaterThan(0);
      expect(result.subscription_id).not.toBe(oldSubscriptionId);
      const { rows } = await getPool().query(
        `SELECT id, metadata->>'class' AS class, status, canceled_reason
           FROM subscriptions
          WHERE account_id=$1
          ORDER BY id`,
        [replacementAccount],
      );
      expect(rows).toEqual([
        {
          id: oldSubscriptionId,
          class: oldTier,
          status: "canceled",
          canceled_reason: `Changed membership to ${newTier}`,
        },
        {
          id: result.subscription_id,
          class: newTier,
          status: "active",
          canceled_reason: null,
        },
      ]);
    },
  );

  it("blocks a membership change while an expired period is renewing", async () => {
    const renewingAccount = uuid();
    const currentTier = `renewing-${uuid().slice(0, 8)}` as any;
    const nextTier = `next-${uuid().slice(0, 8)}` as any;
    await createTestAccount(renewingAccount);
    await createTestMembershipTier({
      id: currentTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    await createTestMembershipTier({
      id: nextTier,
      price_monthly: 50,
      price_yearly: 500,
      priority: 30,
    });
    await createTestMembershipSubscription(renewingAccount, {
      class: currentTier,
      cost: 24,
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      end: new Date(Date.now() - 60_000),
    });

    await expect(
      applyTestMembershipChange({
        account_id: renewingAccount,
        targetClass: nextTier,
        interval: "month",
        paymentAmount: 50,
      }),
    ).rejects.toThrow(/is renewing/);

    const { rows } = await getPool().query(
      `SELECT metadata->>'class' AS class, status
         FROM subscriptions
        WHERE account_id=$1`,
      [renewingAccount],
    );
    expect(rows).toEqual([{ class: currentTier, status: "active" }]);
  });
});
