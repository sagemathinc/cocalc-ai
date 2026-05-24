/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { computeMembershipChange } from "./tiers";
import { claimMembershipTrial } from "./trials";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("membership tier free trials", () => {
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
    });

    expect(quote.trial_available).toBe(true);
    expect(quote.trial_days).toBe(3);
    expect(quote.charge).toBe(0);
    expect(quote.trial_email).toContain("@test.com");

    const client = await getPool("medium").connect();
    try {
      await claimMembershipTrial({
        account_id,
        email_address: quote.trial_email!,
        membership_class: targetClass,
        subscription_id: 1,
        purchase_id: 1,
        client,
      });
    } finally {
      client.release();
    }

    const secondQuote = await computeMembershipChange({
      account_id,
      targetClass,
      interval: "month",
    });

    expect(secondQuote.trial_available).toBe(false);
    expect(secondQuote.charge).toBe(50);
  });
});
