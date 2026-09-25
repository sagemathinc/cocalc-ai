/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import { before, after } from "@cocalc/server/test";
import {
  recordCapturedPayment,
  fulfillCapturedPayment,
} from "./captured-payment";
import createCredit from "./create-credit";
import getBalance from "./get-balance";
import getSpendableBalance from "./get-spendable-balance";
import { createTestMembershipTier } from "./test-data";
import { purchaseMembershipPackages } from "./membership-package";
import { resolveMembershipPackageQuote } from "@cocalc/server/membership/packages";
import { isPurchaseAllowed } from "./is-purchase-allowed";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import {
  withFundingAccountTransaction,
  reserveAccountFundingBacking,
} from "../compute/funding/backing";

const tier = `captured-${randomUUID()}`;
beforeAll(async () => {
  await before({ noConat: true });
  await createTestMembershipTier({
    id: tier,
    team_visible: true,
    price_monthly: 20,
  });
}, 60_000);
afterAll(after);

async function fixture() {
  const account_id = randomUUID();
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    account_id,
  ]);
  return {
    account_id,
    payment_id: `pi_${randomUUID()}`,
    purpose: MEMBERSHIP_PACKAGE_PURCHASE,
    amount: 50,
    request: { tier, quantity: 2 },
  };
}

describe("captured payment fulfillment", () => {
  it("does not cache uncommitted accounts during transactional credit creation", async () => {
    const account_id = randomUUID();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO accounts (account_id) VALUES ($1)", [
        account_id,
      ]);
      await createCredit({ account_id, amount: 50, client });
      expect(await isValidAccount(account_id, client)).toBe(true);
      expect(
        (
          await isPurchaseAllowed({
            account_id,
            client,
            service: "membership",
            cost: 20,
          })
        ).allowed,
      ).toBe(true);
      await client.query(
        "UPDATE membership_tiers SET price_monthly=17 WHERE id=$1",
        [tier],
      );
      const quote = await resolveMembershipPackageQuote(
        {
          type: "membership-package",
          kind: "team",
          membership_class: tier,
          interval: "month",
          seat_count: 1,
        },
        client,
      );
      expect(quote.total_price).toBe(17);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await isValidAccount(account_id)).toBe(false);
  });
  it("posts credit and its reservation atomically, rejecting changed replay terms", async () => {
    const f = await fixture();
    const first = await recordCapturedPayment(f);
    expect((await recordCapturedPayment(f)).credit_id).toBe(first.credit_id);
    expect(Number(await getBalance(f))).toBe(50);
    expect(Number(await getSpendableBalance(f))).toBe(0);
    for (const change of [
      { amount: 51 },
      { purpose: "other" },
      { request: { tier, quantity: 3 } },
      { account_id: (await fixture()).account_id },
    ]) {
      await expect(recordCapturedPayment({ ...f, ...change })).rejects.toThrow(
        /terms do not match/,
      );
    }
    await expect(
      withFundingAccountTransaction(f.account_id, (client) =>
        reserveAccountFundingBacking(client, {
          payer_account_id: f.account_id,
          source_kind: "course-pool",
          source_id: randomUUID(),
          lane: "prepaid",
          authorized_usd: "1",
          capacity_usd: "50",
        }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_funding" });
    await expect(
      fulfillCapturedPayment(
        { ...f, account_id: (await fixture()).account_id },
        async () => null,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("rolls back products with failed fulfillment and replays the committed bundle result", async () => {
    const f = await fixture();
    await recordCapturedPayment(f);
    const buy = (client) =>
      purchaseMembershipPackages({
        account_id: f.account_id,
        fulfillment_id: f.payment_id,
        client,
        amount: 50,
        products: [1, 2].map(() => ({
          type: "membership-package" as const,
          kind: "team" as const,
          membership_class: tier,
          interval: "month" as const,
          seat_count: 1,
        })),
      });
    await expect(
      fulfillCapturedPayment(f, async (client) => {
        await buy(client);
        throw Error("fail after products");
      }),
    ).rejects.toThrow("fail after products");
    expect(Number(await getBalance(f))).toBe(50);
    expect(Number(await getSpendableBalance(f))).toBe(0);
    expect(
      (
        await getPool().query(
          "SELECT id FROM membership_packages WHERE owner_account_id=$1",
          [f.account_id],
        )
      ).rows,
    ).toHaveLength(0);
    const result = await fulfillCapturedPayment(f, buy);
    expect(result).toHaveLength(2);
    const replay = jest.fn();
    expect(await fulfillCapturedPayment(f, replay)).toEqual(result);
    expect(replay).not.toHaveBeenCalled();
    expect(Number(await getBalance(f))).toBe(10);
    expect(Number(await getSpendableBalance(f))).toBe(10);
    expect((await recordCapturedPayment(f)).state).toBe("fulfilled");
  });

  it("does not reinterpret previously posted legacy credit as a new pending purchase", async () => {
    const f = await fixture();
    await createCredit({
      account_id: f.account_id,
      amount: f.amount,
      invoice_id: f.payment_id,
    });
    await expect(recordCapturedPayment(f)).rejects.toThrow(
      /reconcile before retrying/,
    );
    expect(Number(await getBalance(f))).toBe(50);
    expect(Number(await getSpendableBalance(f))).toBe(50);
  });

  const concurrentTest =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
  concurrentTest(
    "posts and fulfills once across competing workers",
    async () => {
      const f = await fixture();
      const credits = await Promise.all([
        recordCapturedPayment(f),
        recordCapturedPayment(f),
      ]);
      expect(credits[0].credit_id).toBe(credits[1].credit_id);
      const fulfill = jest.fn(async (client) => {
        await client.query(
          "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,20,'membership',NOW())",
          [f.account_id],
        );
        return { completed: true };
      });
      const results = await Promise.all([
        fulfillCapturedPayment(f, fulfill),
        fulfillCapturedPayment(f, fulfill),
      ]);
      expect(results).toEqual([{ completed: true }, { completed: true }]);
      expect(fulfill).toHaveBeenCalledTimes(1);
      expect(Number(await getSpendableBalance(f))).toBe(30);
    },
  );
});
