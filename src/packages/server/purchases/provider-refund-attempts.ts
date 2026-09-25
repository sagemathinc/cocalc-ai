/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { getTransactionClient, type PoolClient } from "@cocalc/database/pool";
import type { Reason } from "@cocalc/util/db-schema/purchases";
import {
  moneyRoundToCents,
  moneyToDbString,
  toDecimal,
} from "@cocalc/util/money";
import { lockAccountSpending } from "./lock-account-spending";
import getSpendableBalance from "./get-spendable-balance";
import createPurchase from "./create-purchase";
import { assertPaymentRootNotExported } from "./credit-transfers/ledger";

export interface ProviderRefundRequest {
  charge: string;
  amount?: number;
  metadata: {
    account_id: string;
    purchase_id: number;
    refund_attempt_id?: string;
  };
  reason?: Exclude<Reason, "other">;
}

export interface ProviderRefundResult {
  id: string;
  charge: string;
  status: string;
  amount: number;
}

export interface ProviderRefundAttempt {
  id: string;
  purchase_id: number;
  account_id: string;
  invoice_id: string;
  amount: string;
  request: { admin_account_id: string; reason: Reason; notes: string };
  provider_request: ProviderRefundRequest | null;
  previous_refunded_cents: number;
  provider_result: ProviderRefundResult | null;
  dispatched_at: Date | null;
  state: "pending" | "succeeded" | "failed";
  refund_purchase_id: number | null;
  reconcile_token: string | null;
  reconcile_lease_valid?: boolean;
}

async function transaction<T>(
  account_id: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await (
    await import("@cocalc/server/compute/funding/authority")
  ).assertFundingAccountHome(account_id);
  const client = await getTransactionClient();
  try {
    await lockAccountSpending(client, account_id);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Internal, after administrator authorization and payer resolution. No provider
 * work may begin until this hold commits. No error/timeout releases it.
 */
export async function prepareProviderRefund(opts: {
  account_id: string;
  purchase_id: number;
  admin_account_id: string;
  reason: Reason;
  notes: string;
}): Promise<ProviderRefundAttempt | { refund_purchase_id: number }> {
  return transaction(opts.account_id, async (client) => {
    const {
      rows: [purchase],
    } = await client.query(
      "SELECT account_id,service,cost,invoice_id,description FROM purchases WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [opts.purchase_id, opts.account_id],
    );
    if (!purchase) throw Error("Refund purchase is not on this payer account");
    await assertPaymentRootNotExported(
      client,
      opts.account_id,
      opts.purchase_id,
    );
    if (Number.isInteger(purchase.description?.refund_purchase_id))
      return { refund_purchase_id: purchase.description.refund_purchase_id };
    const {
      rows: [existing],
    } = await client.query<ProviderRefundAttempt>(
      "SELECT * FROM provider_refund_attempts WHERE purchase_id=$1 FOR UPDATE",
      [opts.purchase_id],
    );
    if (existing) {
      if (
        existing.account_id !== opts.account_id ||
        existing.invoice_id !== purchase.invoice_id ||
        !toDecimal(existing.amount).eq(
          moneyRoundToCents(toDecimal(purchase.cost).neg()),
        )
      )
        throw Error("Refund purchase changed; reconcile before retrying");
      return existing;
    }
    if (
      !["credit", "auto-credit"].includes(purchase.service) ||
      !purchase.invoice_id ||
      purchase.cost == null ||
      !toDecimal(purchase.cost).lt(0)
    )
      throw Error(
        "Only a finalized provider credit can use this refund workflow",
      );
    const amount = moneyRoundToCents(toDecimal(purchase.cost).neg());
    const available = await getSpendableBalance({
      account_id: opts.account_id,
      client,
      noSave: true,
    });
    if (toDecimal(available).lt(amount))
      throw Error(
        "Refund would consume spent or reserved credit; reconcile existing commitments first",
      );
    const {
      rows: [attempt],
    } = await client.query<ProviderRefundAttempt>(
      "INSERT INTO provider_refund_attempts (id,purchase_id,account_id,invoice_id,amount,request) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        randomUUID(),
        opts.purchase_id,
        opts.account_id,
        purchase.invoice_id,
        moneyToDbString(amount),
        {
          admin_account_id: opts.admin_account_id,
          reason: opts.reason,
          notes: opts.notes,
        },
      ],
    );
    return attempt;
  });
}

/** Bind once, including the original actor/reason and exact provider amount.
 * Replays return that request unchanged, never recompute its financial terms.
 */
export async function bindProviderRefundRequest(
  attempt: ProviderRefundAttempt,
  request: ProviderRefundRequest,
  previous_refunded_cents = 0,
): Promise<ProviderRefundAttempt> {
  if (
    !request.charge ||
    !Number.isSafeInteger(request.amount) ||
    request.amount! <= 0 ||
    !Number.isSafeInteger(previous_refunded_cents) ||
    previous_refunded_cents < 0
  )
    throw Error("Invalid provider refund request");
  return transaction(attempt.account_id, async (client) => {
    const row = await lockedAttempt(client, attempt);
    if (row.state !== "pending" || row.provider_result) return row;
    if (row.provider_request) {
      if (row.provider_request.charge !== request.charge)
        throw Error("Refund charge changed; reconcile before retrying");
      return row;
    }
    const {
      rows: [bound],
    } = await client.query<ProviderRefundAttempt>(
      "UPDATE provider_refund_attempts SET provider_request=$2, previous_refunded_cents=$3, dispatched_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [
        row.id,
        {
          charge: request.charge,
          amount: request.amount,
          metadata: {
            account_id: row.request.admin_account_id,
            purchase_id: row.purchase_id,
            refund_attempt_id: row.id,
          },
          reason:
            row.request.reason === "other" ? undefined : row.request.reason,
        },
        previous_refunded_cents,
      ],
    );
    return bound;
  });
}

async function lockedAttempt(
  client: PoolClient,
  attempt: ProviderRefundAttempt,
): Promise<ProviderRefundAttempt> {
  const {
    rows: [row],
  } = await client.query<ProviderRefundAttempt>(
    "SELECT *, reconcile_lease_expires_at > clock_timestamp() AS reconcile_lease_valid FROM provider_refund_attempts WHERE id=$1 AND account_id=$2 AND purchase_id=$3 FOR UPDATE",
    [attempt.id, attempt.account_id, attempt.purchase_id],
  );
  if (!row) throw Error("Refund attempt not found");
  return row;
}

function assertReconciliationLease(
  attempt: ProviderRefundAttempt,
  token: string,
): void {
  if (attempt.reconcile_token !== token || !attempt.reconcile_lease_valid)
    throw Error("Refund reconciliation lease expired or was replaced");
}

export async function readClaimedProviderRefund(
  attempt: ProviderRefundAttempt,
  token: string,
): Promise<ProviderRefundAttempt> {
  return transaction(attempt.account_id, async (client) => {
    const row = await lockedAttempt(client, attempt);
    assertReconciliationLease(row, token);
    return row;
  });
}

/** Persist only a verified result retrieved from this refund's provider charge.
 * Pending/requires-action keeps the hold. A confirmed failure releases it but
 * does not authorize another refund. Success debits and releases atomically.
 */
export async function recordProviderRefundResult(
  attempt: ProviderRefundAttempt,
  result: ProviderRefundResult,
  reconcile_token?: string,
): Promise<ProviderRefundAttempt> {
  if (
    !result.id ||
    !result.charge ||
    !Number.isSafeInteger(result.amount) ||
    result.amount <= 0 ||
    !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(
      result.status,
    )
  )
    throw Error("Invalid provider refund result; funds remain reserved");
  return transaction(attempt.account_id, async (client) => {
    const row = await lockedAttempt(client, attempt);
    if (reconcile_token != null)
      assertReconciliationLease(row, reconcile_token);
    if (row.provider_request && row.provider_request.charge !== result.charge)
      throw Error("Provider refund charge does not match its request");
    if (row.provider_request && row.provider_request.amount !== result.amount)
      throw Error("Provider refund amount does not match its request");
    if (
      row.provider_result &&
      (row.provider_result.id !== result.id ||
        row.provider_result.charge !== result.charge)
    )
      throw Error(
        "Provider refund identity changed; reconcile before retrying",
      );
    if (row.state !== "pending") {
      if (["pending", "requires_action"].includes(result.status)) return row;
      if (row.provider_result?.status !== result.status)
        throw Error(
          "Terminal refund result changed; reconcile before retrying",
        );
      return row;
    }
    let refund_purchase_id: number | null = null;
    let state =
      result.status === "succeeded"
        ? "succeeded"
        : ["failed", "canceled"].includes(result.status)
          ? "failed"
          : "pending";
    // Failure of a remainder does not erase a prior out-of-band partial refund.
    if (state === "failed" && row.previous_refunded_cents > 0)
      state = "pending";
    if (state === "succeeded") {
      const {
        rows: [purchase],
      } = await client.query(
        "SELECT description, account_id, cost, invoice_id FROM purchases WHERE id=$1 FOR UPDATE",
        [row.purchase_id],
      );
      if (
        !purchase ||
        purchase.account_id !== row.account_id ||
        purchase.invoice_id !== row.invoice_id ||
        purchase.cost == null ||
        !moneyRoundToCents(toDecimal(purchase.cost).neg()).eq(row.amount) ||
        purchase.description?.refund_purchase_id != null
      )
        throw Error("Refund purchase changed; reconcile before settlement");
      refund_purchase_id = await createPurchase({
        account_id: row.account_id,
        client,
        cost: row.amount,
        service: "refund",
        description: {
          type: "refund",
          purchase_id: row.purchase_id,
          reason: row.request.reason,
          notes: row.request.notes,
          refund_id: result.id,
        },
      });
      await client.query("UPDATE purchases SET description=$2 WHERE id=$1", [
        row.purchase_id,
        { ...purchase.description, refund_purchase_id },
      ]);
    }
    const {
      rows: [updated],
    } = await client.query<ProviderRefundAttempt>(
      "UPDATE provider_refund_attempts SET state=$2,provider_result=$3,refund_purchase_id=$4,completed_at=CASE WHEN $2='pending' THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING *",
      [
        row.id,
        state,
        {
          id: result.id,
          charge: result.charge,
          status: result.status,
          amount: result.amount,
        },
        refund_purchase_id,
      ],
    );
    return updated;
  });
}
