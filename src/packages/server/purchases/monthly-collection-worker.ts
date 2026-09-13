/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details.
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings";
import {
  withFundingAccountTransaction,
  getAccountFundingBacking,
} from "@cocalc/server/compute/funding/backing";
import {
  moneyToDbString,
  moneyToCurrency,
  toDecimal,
} from "@cocalc/util/money";
import { readMonthlyCollection } from "./monthly-collection";
import createPaymentIntent from "./stripe/create-payment-intent";
import send from "@cocalc/server/messages/send";

const logger = getLogger("purchases:monthly-collection");

/** Claim once under the same account locks as consent, spending and rehome.
 * Provider work happens after commit. An unknown outcome is NOT permission to
 * retry with another invoice; reconciliation must first inspect the attempt.
 */
export async function claimMonthlyCollection(
  account_id: string,
  minimum: number,
) {
  return withFundingAccountTransaction(account_id, async (db) => {
    const { consent } = await readMonthlyCollection(account_id, db);
    if (!consent.enabled || consent.terms_version !== 1) return;
    const {
      rows: [statement],
    } = await db.query(
      `SELECT id,time,balance::text,automatic_payment,paid_purchase_id,automatic_payment_intent_id
      FROM statements WHERE account_id=$1 AND interval='month' AND time<=clock_timestamp() ORDER BY time DESC,id DESC LIMIT 1 FOR UPDATE`,
      [account_id],
    );
    if (
      !statement ||
      statement.automatic_payment ||
      statement.paid_purchase_id ||
      statement.automatic_payment_intent_id
    )
      return;
    const due = toDecimal(statement.balance).neg();
    if (due.lte(0) || due.lt(minimum)) return;
    // Unreconciled earlier attempts must not be collected a second time via a
    // newer statement's cumulative balance.
    const { rows: pending } = await db.query(
      `SELECT 1 FROM statements WHERE account_id=$1 AND id<>$2 AND paid_purchase_id IS NULL
      AND (monthly_collection->>'state' IN ('claimed','requires_review','issued') OR automatic_payment_intent_id IS NOT NULL) LIMIT 1`,
      [account_id, statement.id],
    );
    if (pending.length) return;
    const backing = await getAccountFundingBacking(db, account_id);
    // A deposit/adjustment since statement closing may already cover some or
    // all of it. Leave partial balances for explicit settlement, not a full
    // stale statement charge or an invoice falsely marked fully paid.
    if (toDecimal(backing.ledger_balance_usd).neg().lt(due)) return;
    const claim = {
      attempt_id: randomUUID(),
      consent_version: consent.version,
      amount_usd: moneyToDbString(due),
      state: "claimed",
      claimed_at: new Date().toISOString(),
    };
    await db.query(
      "UPDATE statements SET automatic_payment=clock_timestamp(),monthly_collection=$3::jsonb WHERE account_id=$1 AND id=$2",
      [account_id, statement.id, JSON.stringify(claim)],
    );
    return {
      account_id,
      statement_id: statement.id,
      time: statement.time,
      ...claim,
    };
  });
}

export async function maintainMonthlyCollections() {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id FROM accounts WHERE monthly_collection->>'enabled'='true' AND banned IS NOT TRUE AND deleted IS NOT TRUE",
  );
  if (!rows.length) return;
  const settings = await getServerSettings();
  if (!settings.stripe_secret_key || !settings.stripe_publishable_key) return;
  for (const { account_id } of rows) {
    let claim: Awaited<ReturnType<typeof claimMonthlyCollection>>;
    try {
      claim = await claimMonthlyCollection(
        account_id,
        settings.pay_as_you_go_min_payment ?? 0,
      );
      if (!claim) continue;
      const payment = await createPaymentIntent({
        account_id,
        purpose: `statement-${claim.statement_id}`,
        description: `Monthly statement ${claim.statement_id}`,
        lineItems: [
          {
            amount: Number(claim.amount_usd),
            description: `Pay monthly account statement ${claim.statement_id}`,
          },
        ],
        idempotencyKeyPrefix: `monthly-collection:${claim.attempt_id}`,
        requireAddress: true,
        metadata: { monthly_collection_attempt: claim.attempt_id },
        allowedPaymentMethodTypes: ["card"],
      });
      await pool.query(
        "UPDATE statements SET automatic_payment_intent_id=$3,monthly_collection=monthly_collection || $4::jsonb WHERE account_id=$1 AND id=$2 AND monthly_collection->>'attempt_id'=$5",
        [
          account_id,
          claim.statement_id,
          payment.payment_intent,
          JSON.stringify({ state: "issued" }),
          claim.attempt_id,
        ],
      );
      await send({
        to_ids: [account_id],
        subject: "Monthly statement payment",
        body: `Automatic collection of ${moneyToCurrency(claim.amount_usd)} USD plus applicable taxes was submitted for statement ${claim.statement_id}. [View invoice](${payment.hosted_invoice_url}).`,
      }).catch((error) =>
        logger.warn("monthly collection notice failed", { account_id, error }),
      );
    } catch (error) {
      logger.warn("monthly collection requires attention", {
        account_id,
        error,
      });
      if (!claim) continue;
      await pool.query(
        "UPDATE statements SET monthly_collection=monthly_collection || $3::jsonb WHERE account_id=$1 AND id=$2 AND monthly_collection->>'attempt_id'=$4",
        [
          account_id,
          claim.statement_id,
          JSON.stringify({ state: "requires_review" }),
          claim.attempt_id,
        ],
      );
      await send({
        to_ids: [account_id],
        subject: "Monthly collection needs attention",
        body: `Automatic payment for statement ${claim.statement_id} could not be confirmed. Check your invoices before paying again; an uncertain payment will not be retried automatically. Contact support if necessary.`,
      }).catch((error) =>
        logger.warn("monthly collection notice failed", { account_id, error }),
      );
    }
  }
}
