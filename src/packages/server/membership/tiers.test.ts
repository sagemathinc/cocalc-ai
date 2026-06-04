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
import { computeMembershipChange } from "./tiers";
import { claimMembershipTrial, membershipTrialEmailKey } from "./trials";

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
    const firstEmail = "co.dex+first@outlook.com";
    const secondEmail = "co.dex+second@outlook.com";
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
});
