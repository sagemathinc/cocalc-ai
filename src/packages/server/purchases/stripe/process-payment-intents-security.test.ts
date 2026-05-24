/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";
import { before, after, getPool } from "@cocalc/server/test";
import { createTestAccount } from "@cocalc/server/purchases/test-data";
import { markStatementPaidByPurchase } from "./process-payment-intents";

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
