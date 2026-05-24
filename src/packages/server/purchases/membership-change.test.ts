/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after } from "@cocalc/server/test";
import { createTestAccount, createTestMembershipTier } from "./test-data";
import { applyMembershipChange } from "./membership-change";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("membership change payment enforcement", () => {
  const account_id = uuid();
  const targetClass = `paid-${uuid().slice(0, 8)}` as any;

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
});
