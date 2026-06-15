/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipSubscription,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { computeMembershipChange, computeMembershipPricing } from "./tiers";
import { claimMembershipTrial, membershipTrialEmailKey } from "./trials";

async function attachMembershipPurchase({
  account_id,
  subscription_id,
  membershipClass,
  interval,
  cost,
  start,
  end,
}: {
  account_id: string;
  subscription_id: number;
  membershipClass: string;
  interval: "month" | "year";
  cost: number;
  start: Date;
  end: Date;
}) {
  const purchase_id = await createPurchase({
    account_id,
    cost,
    service: "membership",
    description: {
      type: "membership",
      subscription_id,
      class: membershipClass as any,
      interval,
    },
    tag: "membership-change",
    period_start: start,
    period_end: end,
    client: null,
  });
  await getPool().query(
    "UPDATE subscriptions SET latest_purchase_id=$1 WHERE id=$2",
    [purchase_id, subscription_id],
  );
  return purchase_id;
}

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("membership tier free trials", () => {
  it("uses provider-aware email keys for trial eligibility", () => {
    expect(membershipTrialEmailKey("Co.Dex+trial@googlemail.com")).toBe(
      "codex@gmail.com",
    );
    expect(membershipTrialEmailKey("Co.Dex+trial@outlook.com")).toBe(
      "co.dex@outlook.com",
    );
    expect(membershipTrialEmailKey("codex-alias@yahoo.com")).toBe(
      "codex-*@yahoo.com",
    );
    expect(membershipTrialEmailKey("codex+trial@example.com")).toBe(
      "codex+trial@example.com",
    );
  });

  it("quotes one free trial per account and email address", async () => {
    const account_id = uuid();
    const targetClass = `trial-${uuid().slice(0, 8)}` as any;
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: targetClass,
      price_monthly: 50,
      price_yearly: 500,
      priority: 20,
      trial_days: 3,
    });

    const quote = await computeMembershipChange({
      account_id,
      targetClass,
      interval: "month",
      client: getPool() as any,
    });

    expect(quote.trial_available).toBe(true);
    expect(quote.trial_days).toBe(3);
    expect(quote.charge).toBe(0);
    expect(quote.trial_email).toContain("@test.com");

    await claimMembershipTrial({
      account_id,
      email_address: quote.trial_email!,
      membership_class: targetClass,
      subscription_id: 1,
      purchase_id: 1,
      client: getPool() as any,
    });

    const secondQuote = await computeMembershipChange({
      account_id,
      targetClass,
      interval: "month",
      client: getPool() as any,
    });

    expect(secondQuote.trial_available).toBe(false);
    expect(secondQuote.charge).toBe(50);
  });

  it("blocks free trial reuse across provider-specific aliases", async () => {
    const firstAccount = uuid();
    const secondAccount = uuid();
    const targetClass = `trial-${uuid().slice(0, 8)}` as any;
    await createTestAccount(firstAccount);
    await createTestAccount(secondAccount);
    const aliasBase = `co.dex-${uuid().slice(0, 8)}`;
    const firstEmail = `${aliasBase}+first@outlook.com`;
    const secondEmail = `${aliasBase}+second@outlook.com`;
    await getPool().query(
      `UPDATE accounts
          SET email_address=$1,
              email_address_verified=$2::jsonb
        WHERE account_id=$3`,
      [firstEmail, { [firstEmail]: new Date().toISOString() }, firstAccount],
    );
    await getPool().query(
      `UPDATE accounts
          SET email_address=$1,
              email_address_verified=$2::jsonb
        WHERE account_id=$3`,
      [secondEmail, { [secondEmail]: new Date().toISOString() }, secondAccount],
    );
    await createTestMembershipTier({
      id: targetClass,
      price_monthly: 50,
      price_yearly: 500,
      priority: 20,
      trial_days: 3,
    });

    const firstQuote = await computeMembershipChange({
      account_id: firstAccount,
      targetClass,
      interval: "month",
      client: getPool() as any,
    });
    expect(firstQuote.trial_available).toBe(true);
    expect(firstQuote.trial_email).toBe(firstEmail);

    await claimMembershipTrial({
      account_id: firstAccount,
      email_address: firstQuote.trial_email!,
      membership_class: targetClass,
      subscription_id: 2,
      purchase_id: 2,
      client: getPool() as any,
    });

    const secondQuote = await computeMembershipChange({
      account_id: secondAccount,
      targetClass,
      interval: "month",
      client: getPool() as any,
    });
    expect(secondQuote.trial_available).toBe(false);
    expect(secondQuote.charge).toBe(50);
  });
});

describe("membership change pricing", () => {
  it("quotes against the effective paid-through subscription", async () => {
    const account_id = uuid();
    const lowTier = `quote-low-${uuid().slice(0, 8)}` as any;
    const highTier = `quote-high-${uuid().slice(0, 8)}` as any;
    await createTestAccount(account_id);
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

    await createTestMembershipSubscription(account_id, {
      class: highTier,
      cost: 100,
      end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "canceled",
    });
    await createTestMembershipSubscription(account_id, {
      class: lowTier,
      cost: 20,
      end: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      status: "active",
    });

    await expect(
      computeMembershipChange({
        account_id,
        targetClass: highTier,
        interval: "month",
        client: getPool() as any,
      }),
    ).rejects.toThrow(`already subscribed to ${highTier}`);
  });

  it.each(["unpaid", "past_due"] as const)(
    "does not quote %s membership subscriptions as existing plans",
    async (status) => {
      const account_id = uuid();
      const targetTier = `quote-${status}-${uuid().slice(0, 8)}` as any;
      await createTestAccount(account_id);
      await createTestMembershipTier({
        id: targetTier,
        price_monthly: 50,
        price_yearly: 500,
        priority: 20,
      });
      await createTestMembershipSubscription(account_id, {
        class: targetTier,
        cost: 50,
        status,
      });

      const quote = await computeMembershipChange({
        account_id,
        targetClass: targetTier,
        interval: "month",
        client: getPool() as any,
      });

      expect(quote.change).toBe("new");
      expect(quote.existing_subscription_id).toBeUndefined();
      expect(quote.charge).toBe(50);
    },
  );

  it("does not give prorated upgrade credit for a free trial subscription", async () => {
    const account_id = uuid();
    const trialTier = `trial-paid-${uuid().slice(0, 8)}` as any;
    const proTier = `trial-pro-${uuid().slice(0, 8)}` as any;
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: trialTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    await createTestMembershipTier({
      id: proTier,
      price_monthly: 160,
      price_yearly: 1440,
      priority: 30,
    });

    const start = new Date(Date.now() - 60 * 1000);
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        class: trialTier,
        cost: 216,
        interval: "year",
        start,
        end,
      },
    );
    await attachMembershipPurchase({
      account_id,
      subscription_id,
      membershipClass: trialTier,
      interval: "year",
      cost: 0,
      start,
      end,
    });

    const quote = await computeMembershipChange({
      account_id,
      targetClass: proTier,
      interval: "year",
      client: getPool() as any,
    });

    expect(quote.change).toBe("upgrade");
    expect(quote.refund).toBe(0);
    expect(quote.charge).toBe(1440);

    const pricing = await computeMembershipPricing({
      account_id,
      targetClass: proTier,
      interval: "year",
      client: getPool() as any,
    });
    expect(pricing.refund).toBe(0);
    expect(pricing.charge).toBe(1440);
  });

  it("bases prorated upgrade credit on the actual paid amount", async () => {
    const account_id = uuid();
    const standardTier = `custom-standard-${uuid().slice(0, 8)}` as any;
    const proTier = `custom-pro-${uuid().slice(0, 8)}` as any;
    await createTestAccount(account_id);
    await createTestMembershipTier({
      id: standardTier,
      price_monthly: 24,
      price_yearly: 216,
      priority: 20,
    });
    await createTestMembershipTier({
      id: proTier,
      price_monthly: 160,
      price_yearly: 1440,
      priority: 30,
    });

    const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        class: standardTier,
        cost: 216,
        interval: "year",
        start,
        end,
      },
    );
    await attachMembershipPurchase({
      account_id,
      subscription_id,
      membershipClass: standardTier,
      interval: "year",
      cost: 100,
      start,
      end,
    });

    const quote = await computeMembershipChange({
      account_id,
      targetClass: proTier,
      interval: "year",
      client: getPool() as any,
    });

    expect(quote.change).toBe("upgrade");
    expect(quote.refund).toBeCloseTo(50, 2);
    expect(quote.charge).toBeCloseTo(1390, 2);
  });
});
