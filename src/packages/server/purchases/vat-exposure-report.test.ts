/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import dayjs from "dayjs";

import { after, before, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";
import createCredit from "./create-credit";
import { vatExposureReportPage } from "./vat-exposure-report";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

// A Stripe client that only reads: any other call fails the test.
// byAccount: Stripe customers found by their account_id metadata.
function fakeStripe(
  customers: Record<string, any>,
  byAccount: Record<string, string> = {},
) {
  const customer = (id: string) => {
    const c = customers[id];
    if (c instanceof Error) throw c;
    return c ?? { deleted: true };
  };
  return {
    customers: {
      retrieve: async (id: string) => customer(id),
      listPaymentMethods: async (id: string) => ({
        data: (customer(id).cards ?? []).map((country: string) => ({
          card: { country },
        })),
        has_more: false,
      }),
      listSources: async () => ({ data: [], has_more: false }),
      retrieveSource: async () => ({}),
      search: async ({ query }: { query: string }) => {
        const account_id = /:'([^']+)'/.exec(query)?.[1] ?? "";
        const id = byAccount[account_id];
        return { data: id ? [{ id }] : [] };
      },
    },
  };
}

async function membership(stripe_customer_id: string | null, cost = 10) {
  const account_id = uuid();
  await createTestAccount(account_id);
  if (stripe_customer_id) {
    await getPool().query(
      "UPDATE accounts SET stripe_customer_id=$2 WHERE account_id=$1",
      [account_id, stripe_customer_id],
    );
  }
  const { subscription_id } = await createTestMembershipSubscription(
    account_id,
    { start: dayjs().toDate(), end: dayjs().add(1, "month").toDate(), cost },
  );
  return { account_id, subscription_id };
}

async function count(table: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0].n;
}

describe("VAT exposure report", () => {
  it("predicts exactly which renewals the business tax ID check refuses, read only", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const missing = await membership("cus_de_missing");
    const unverified = await membership("cus_fr_unverified");
    await membership("cus_de_valid");
    await membership("cus_us");
    const card = await membership("cus_no_address_eu_card");
    await membership("cus_no_address_us_card");
    const broken = await membership("cus_error");
    await membership(null);
    const stripe = fakeStripe({
      cus_de_missing: { address: { country: "DE" }, tax_ids: { data: [] } },
      cus_fr_unverified: {
        address: { country: "FR" },
        tax_ids: {
          data: [
            {
              type: "eu_vat",
              value: "FR00000000000",
              verification: { status: "unverified" },
            },
          ],
        },
      },
      cus_de_valid: {
        address: { country: "DE" },
        tax_ids: {
          data: [
            {
              type: "eu_vat",
              value: "DE000000000",
              verification: { status: "verified" },
            },
          ],
        },
      },
      cus_us: { address: { country: "US" }, tax_ids: { data: [] } },
      cus_no_address_eu_card: { tax_ids: { data: [] }, cards: ["IT"] },
      cus_no_address_us_card: { tax_ids: { data: [] }, cards: ["US"] },
      cus_error: Object.assign(new Error("rate limited"), {
        code: "rate_limit",
      }),
    });
    const refusalsBefore = await count("business_tax_id_refusals");
    const noticesBefore = await count("business_tax_id_notices");

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
    });

    expect(page.checked).toBe(8);
    expect(page.no_stripe_customer).toBe(1);
    expect(page.next_after_subscription_id).toBeNull();
    const affected = Object.fromEntries(
      page.affected.map((row) => [row.subscription_id, row]),
    );
    expect(Object.keys(affected).sort()).toEqual(
      [missing, unverified, card].map((m) => `${m.subscription_id}`).sort(),
    );
    expect(affected[missing.subscription_id]).toMatchObject({
      account_id: missing.account_id,
      reason: "missing",
      country: "DE",
    });
    expect(affected[unverified.subscription_id]).toMatchObject({
      reason: "unverified",
      country: "FR",
    });
    expect(affected[card.subscription_id]).toMatchObject({
      reason: "card-country",
      country: "IT",
    });
    expect(typeof affected[missing.subscription_id].current_period_end).toBe(
      "string",
    );
    // a Stripe error is reported and does not stop the report
    expect(page.stripe_errors).toEqual([
      {
        account_id: broken.account_id,
        subscription_id: broken.subscription_id,
        error: expect.stringContaining("rate limited"),
      },
    ]);
    // nothing recorded, nobody notified
    expect(await count("business_tax_id_refusals")).toBe(refusalsBefore);
    expect(await count("business_tax_id_notices")).toBe(noticesBefore);
  });

  it("finds a Stripe customer the renewal would recover by its account metadata, without storing it", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const lost = await membership(null);
    const none = await membership(null);
    const stripe = fakeStripe(
      { cus_recovered: { address: { country: "DE" }, tax_ids: { data: [] } } },
      { [lost.account_id]: "cus_recovered" },
    );

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
    });

    expect(page.affected).toEqual([
      expect.objectContaining({
        subscription_id: lost.subscription_id,
        reason: "missing",
        stripe_customer: "recovered",
      }),
    ]);
    expect(page.no_stripe_customer).toBe(1);
    const { rows } = await getPool().query(
      "SELECT stripe_customer_id FROM accounts WHERE account_id=ANY($1)",
      [[lost.account_id, none.account_id]],
    );
    expect(rows.map((row) => row.stripe_customer_id)).toEqual([null, null]);
  });

  it("lists renewals paid without a card (balance or below minimum) separately", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const card = await membership("cus_de", 10);
    const balance = await membership("cus_de", 10);
    await createCredit({ account_id: balance.account_id, amount: 20 });
    const tiny = await membership("cus_de", 1);
    const stripe = fakeStripe({
      cus_de: { address: { country: "DE" }, tax_ids: { data: [] } },
    });

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
    });

    expect(page.affected.map((row) => row.subscription_id)).toEqual([
      card.subscription_id,
    ]);
    expect(
      page.paid_without_check.map((row) => [row.subscription_id, row.funding]),
    ).toEqual([
      [balance.subscription_id, "balance"],
      [tiny.subscription_id, "below-minimum"],
    ]);
  });

  it("follows the open attempt's saved funding split and bound payment", async () => {
    await getPool().query("DELETE FROM subscriptions");
    // a split was saved on the attempt, then the account was topped up: the
    // retry keeps the split and charges the card, so the check runs
    const split = await membership("cus_de", 10);
    await createCredit({ account_id: split.account_id, amount: 20 });
    // a Stripe payment is already bound: the retry reuses it, no check
    const bound = await membership("cus_de", 10);
    for (const [subscription_id, sql] of [
      [split.subscription_id, "balance_applied=0"],
      [bound.subscription_id, "payment_intent_id='pi_bound'"],
    ] as const) {
      const { rowCount } = await getPool().query(
        `UPDATE subscription_renewal_attempts SET ${sql}
          WHERE subscription_id=$1 AND state IN ('scheduled','processing')`,
        [subscription_id],
      );
      expect(rowCount).toBe(1);
    }
    // an active (legacy) payment on the subscription that the attempt is not
    // bound to: the renewal adopts it or waits on it, no check
    const legacy = await membership("cus_de", 10);
    // and the same with no open attempt yet: the renewal creates one first
    const legacyNoAttempt = await membership("cus_de", 10);
    await getPool().query(
      `UPDATE subscriptions
          SET payment=jsonb_build_object('status','active','payment_intent_id','pi_legacy')
        WHERE id=ANY($1)`,
      [[legacy.subscription_id, legacyNoAttempt.subscription_id]],
    );
    await getPool().query(
      "DELETE FROM subscription_renewal_attempts WHERE subscription_id=$1",
      [legacyNoAttempt.subscription_id],
    );
    const stripe = fakeStripe({
      cus_de: { address: { country: "DE" }, tax_ids: { data: [] } },
    });

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
    });

    expect(page.affected.map((row) => row.subscription_id)).toEqual([
      split.subscription_id,
    ]);
    expect(
      page.paid_without_check.map((row) => [row.subscription_id, row.funding]),
    ).toEqual([
      [bound.subscription_id, "open-payment"],
      [legacy.subscription_id, "open-payment"],
      [legacyNoAttempt.subscription_id, "open-payment"],
    ]);
  });

  it("counts memberships this bay never renews without looking them up", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const banned = await membership("cus_banned");
    const foreign = await membership("cus_foreign");
    const closed = await membership("cus_closed");
    const renewed = await membership("cus_de");
    // the current period's attempt was canceled (say, while billing was
    // frozen): scheduling skips the period and the claim skips the attempt
    const { rowCount } = await getPool().query(
      `UPDATE subscription_renewal_attempts SET state='canceled'
        WHERE subscription_id=$1`,
      [closed.subscription_id],
    );
    expect(rowCount).toBe(1);
    await getPool().query(
      "UPDATE accounts SET banned=true WHERE account_id=$1",
      [banned.account_id],
    );
    await getPool().query(
      "UPDATE accounts SET home_bay_id='another-bay' WHERE account_id=$1",
      [foreign.account_id],
    );
    const looked: string[] = [];
    const stripe = fakeStripe({
      cus_banned: { address: { country: "DE" }, tax_ids: { data: [] } },
      cus_foreign: { address: { country: "DE" }, tax_ids: { data: [] } },
      cus_closed: { address: { country: "DE" }, tax_ids: { data: [] } },
      cus_de: { address: { country: "DE" }, tax_ids: { data: [] } },
    });
    const retrieve = stripe.customers.retrieve;
    stripe.customers.retrieve = async (id: string) => {
      looked.push(id);
      return retrieve(id);
    };

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
    });

    expect(page.checked).toBe(4);
    expect(page.not_claimable).toBe(3);
    expect(page.affected.map((row) => row.subscription_id)).toEqual([
      renewed.subscription_id,
    ]);
    expect(new Set(looked)).toEqual(new Set(["cus_de"]));
  });

  it("skips canceled subscriptions and continues from a cursor", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const first = await membership("cus_a");
    const second = await membership("cus_b");
    const canceled = await membership("cus_c");
    await getPool().query(
      "UPDATE subscriptions SET status='canceled' WHERE id=$1",
      [canceled.subscription_id],
    );
    const stripe = fakeStripe({
      cus_a: { address: { country: "DE" }, tax_ids: { data: [] } },
      cus_b: { address: { country: "AT" }, tax_ids: { data: [] } },
      cus_c: { address: { country: "DE" }, tax_ids: { data: [] } },
    });

    const page = await vatExposureReportPage({
      stripe,
      after_subscription_id: first.subscription_id,
      customer_interval_ms: 0,
    });

    expect(page.checked).toBe(1);
    expect(page.affected.map((row) => row.subscription_id)).toEqual([
      second.subscription_id,
    ]);
    expect(page.next_after_subscription_id).toBeNull();
  });

  it("reports a customer whose check hangs as an error and continues", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const hung = await membership("cus_hung");
    const next = await membership("cus_next");
    const stripe = fakeStripe({
      cus_next: { address: { country: "DE" }, tax_ids: { data: [] } },
    });
    const retrieve = stripe.customers.retrieve;
    stripe.customers.retrieve = async (id: string) =>
      id === "cus_hung" ? new Promise(() => {}) : retrieve(id);

    const page = await vatExposureReportPage({
      stripe,
      customer_interval_ms: 0,
      customer_timeout_ms: 50,
    });

    expect(page.stripe_errors).toEqual([
      {
        account_id: hung.account_id,
        subscription_id: hung.subscription_id,
        error: expect.stringContaining("timed out"),
      },
    ]);
    expect(page.affected.map((row) => row.subscription_id)).toEqual([
      next.subscription_id,
    ]);
  });

  it("stops at its time budget and returns a cursor", async () => {
    await getPool().query("DELETE FROM subscriptions");
    const first = await membership("cus_a");
    await membership("cus_b");
    const stripe = fakeStripe({
      cus_a: { address: { country: "US" } },
      cus_b: { address: { country: "US" } },
    });

    const page = await vatExposureReportPage({
      stripe,
      page_ms: 0,
      customer_interval_ms: 0,
    });

    expect(page.checked).toBe(1);
    expect(page.next_after_subscription_id).toBe(first.subscription_id);
  });
});
