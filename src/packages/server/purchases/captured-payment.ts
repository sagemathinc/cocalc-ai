/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import { moneyRoundToCents, moneyToDbString } from "@cocalc/util/money";
import { lockAccountSpending } from "./lock-account-spending";
import createCredit from "./create-credit";

interface CapturedPayment {
  payment_id: string;
  account_id: string;
  credit_id: number;
  purpose: string;
  amount: string;
  state: "pending" | "fulfilled";
  result: unknown;
}

/** Internal account-home API. Caller must verify the captured provider payment
 * and its account binding first. Never accept these terms from a client RPC.
 * request contains immutable product terms, not credentials or invoice content.
 */
export async function recordCapturedPayment(opts: {
  account_id: string;
  payment_id: string;
  purpose: string;
  amount: Parameters<typeof createCredit>[0]["amount"];
  request: Record<string, unknown>;
  description?: Parameters<typeof createCredit>[0]["description"];
}): Promise<CapturedPayment> {
  const amount = moneyRoundToCents(opts.amount);
  if (
    !opts.payment_id ||
    !opts.purpose ||
    !Number.isFinite(amount.toNumber()) ||
    amount.lte(0)
  ) {
    throw Error("invalid captured payment");
  }
  const request = JSON.stringify(opts.request);
  const client = await getTransactionClient();
  try {
    await lockAccountSpending(client, opts.account_id);
    const {
      rows: [existing],
    } = await client.query<CapturedPayment & { matches: boolean }>(
      `SELECT *, (account_id=$2 AND purpose=$3 AND amount=$4 AND request=$5::jsonb) AS matches
         FROM payment_fulfillments WHERE payment_id=$1 FOR UPDATE`,
      [
        opts.payment_id,
        opts.account_id,
        opts.purpose,
        moneyToDbString(amount),
        request,
      ],
    );
    if (existing) {
      if (!existing.matches)
        throw Error("captured payment terms do not match the recorded payment");
      await client.query("COMMIT");
      return existing;
    }
    const { rows: credits } = await client.query(
      "SELECT id FROM purchases WHERE invoice_id=$1 AND service IN ('credit','auto-credit')",
      [opts.payment_id],
    );
    if (credits.length) {
      throw Error(
        "captured payment credit predates its fulfillment receipt; reconcile before retrying",
      );
    }
    const credit_id = await createCredit({
      account_id: opts.account_id,
      invoice_id: opts.payment_id,
      amount,
      description: { ...opts.description, purpose: opts.purpose },
      client,
    });
    const {
      rows: [receipt],
    } = await client.query<CapturedPayment>(
      `INSERT INTO payment_fulfillments (payment_id, account_id, credit_id, purpose, amount, request)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [
        opts.payment_id,
        opts.account_id,
        credit_id,
        opts.purpose,
        moneyToDbString(amount),
        request,
      ],
    );
    await client.query("COMMIT");
    return receipt;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** The callback must perform database-only product fulfillment on this client.
 * Its debit, result and release of captured funds commit atomically. Do not send
 * mail, call a provider, or commit/release this transaction in the callback.
 */
export async function fulfillCapturedPayment<T>(
  opts: { account_id: string; payment_id: string; purpose: string },
  fulfill: (client: PoolClient, payment: CapturedPayment) => Promise<T>,
): Promise<T> {
  const client = await getTransactionClient();
  try {
    await lockAccountSpending(client, opts.account_id);
    const {
      rows: [payment],
    } = await client.query<CapturedPayment>(
      "SELECT * FROM payment_fulfillments WHERE payment_id=$1 AND account_id=$2 AND purpose=$3 FOR UPDATE",
      [opts.payment_id, opts.account_id, opts.purpose],
    );
    if (!payment)
      throw Error(
        "captured payment fulfillment not found for this account and purpose",
      );
    if (payment.state === "fulfilled") {
      await client.query("COMMIT");
      return payment.result as T;
    }
    // Expose only this payment's funds to the debit within the locked transaction.
    // A callback failure rolls this update back along with all product changes.
    await client.query(
      "UPDATE payment_fulfillments SET state='fulfilled', result='null'::jsonb WHERE payment_id=$1",
      [opts.payment_id],
    );
    const result = JSON.stringify((await fulfill(client, payment)) ?? null);
    await client.query(
      "UPDATE payment_fulfillments SET result=$2::jsonb, fulfilled_at=NOW() WHERE payment_id=$1",
      [opts.payment_id, result],
    );
    await client.query("COMMIT");
    return JSON.parse(result);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
