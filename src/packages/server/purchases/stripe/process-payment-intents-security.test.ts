/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after, getPool } from "@cocalc/server/test";
import { createTestAccount } from "@cocalc/server/purchases/test-data";
import {
  assertInvoiceAccountBinding,
  assertPaymentIntentAccountBinding,
  paymentSuccessBody,
  paymentSuccessSubject,
  markStatementPaidByPurchase,
} from "./process-payment-intents";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

async function createStatement(account_id: string, balance: number) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO statements(
      interval,
      time,
      account_id,
      balance,
      total_charges,
      num_charges,
      total_credits,
      num_credits
    )
    VALUES ('month', NOW(), $1, $2, $3, 1, 0, 0)
    RETURNING id`,
    [account_id, balance, Math.abs(balance)],
  );
  return rows[0].id as number;
}

async function getPaidPurchaseId(statement_id: number) {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT paid_purchase_id FROM statements WHERE id=$1",
    [statement_id],
  );
  return rows[0]?.paid_purchase_id;
}

describe("Stripe statement payment-intent fulfillment checks", () => {
  it("builds a clean user-facing payment receipt", () => {
    const subject = paymentSuccessSubject({ amount: 18 });
    const body = paymentSuccessBody({
      amount: 18,
      reason: "purchase a course membership package",
      credit_id: 5,
      balance: 0,
      paymentsUrl: "https://lite1b.cocalc.ai/settings/payments",
      purchasesUrl: "https://lite1b.cocalc.ai/settings/purchases",
      supportUrl: "https://lite1b.cocalc.ai/support/new",
    });

    expect(subject).toBe("Payment received: $18.00");
    expect(subject).not.toContain("Credit id");
    expect(body).toContain("CoCalc credit id: 5");
    expect(body).toContain("purchase a course membership package");
    expect(body).toContain("Receipt details:\n\n- Amount: $18.00");
    expect(body).toContain(
      "Account pages:\n\n- Payments: https://lite1b.cocalc.ai/settings/payments",
    );
    expect(body).toContain(
      "Payments: https://lite1b.cocalc.ai/settings/payments",
    );
    expect(body).toContain(
      "Purchases: https://lite1b.cocalc.ai/settings/purchases",
    );
    expect(body).not.toContain("Payment id:");
    expect(body).not.toContain("pi_");
    expect(body).not.toContain("](");
  });

  it("rejects payment intents whose metadata account does not match the payer", () => {
    expect(() =>
      assertPaymentIntentAccountBinding({
        paymentIntent: {
          customer: "cus_attacker",
          metadata: { account_id: "victim" },
        },
        account_id: "attacker",
        expected_customer_id: "cus_attacker",
      }),
    ).toThrow(/account metadata does not match payer/);
  });

  it("rejects payment intents whose Stripe customer does not match the payer", () => {
    expect(() =>
      assertPaymentIntentAccountBinding({
        paymentIntent: {
          customer: "cus_victim",
          metadata: { account_id: "attacker" },
        },
        account_id: "attacker",
        expected_customer_id: "cus_attacker",
      }),
    ).toThrow(/customer does not match payer/);
  });

  it("rejects invoices whose Stripe customer does not match the payer", () => {
    expect(() =>
      assertInvoiceAccountBinding({
        invoice: { customer: "cus_victim" },
        expected_customer_id: "cus_attacker",
      }),
    ).toThrow(/invoice customer does not match payer/);
  });

  it("accepts payment intent and invoice bindings for the payer", () => {
    expect(() =>
      assertPaymentIntentAccountBinding({
        paymentIntent: {
          customer: { id: "cus_payer" },
          metadata: { account_id: "payer" },
        },
        account_id: "payer",
        expected_customer_id: "cus_payer",
      }),
    ).not.toThrow();
    expect(() =>
      assertInvoiceAccountBinding({
        invoice: { customer: { id: "cus_payer" } },
        expected_customer_id: "cus_payer",
      }),
    ).not.toThrow();
  });

  it("does not let one account mark another account's statement paid", async () => {
    const owner = uuid();
    const attacker = uuid();
    await createTestAccount(owner);
    await createTestAccount(attacker);
    const statement_id = await createStatement(owner, -1000);

    await expect(
      markStatementPaidByPurchase({
        account_id: attacker,
        statement_id,
        credit_id: 123,
        amount: 1000,
      }),
    ).rejects.toThrow(/statement does not belong to this account/);
    expect(await getPaidPurchaseId(statement_id)).toBeNull();
  });

  it("does not let a short payment mark a statement paid", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const statement_id = await createStatement(account_id, -1000);

    await expect(
      markStatementPaidByPurchase({
        account_id,
        statement_id,
        credit_id: 123,
        amount: 1,
      }),
    ).rejects.toThrow(/less than statement amount due/);
    expect(await getPaidPurchaseId(statement_id)).toBeNull();
  });

  it("marks the payer's statement paid when the payment covers the balance due", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const statement_id = await createStatement(account_id, -25);

    await markStatementPaidByPurchase({
      account_id,
      statement_id,
      credit_id: 456,
      amount: 25,
    });

    expect(await getPaidPurchaseId(statement_id)).toBe(456);
  });
});
