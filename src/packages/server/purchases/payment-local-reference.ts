/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool, { type PoolClient } from "@cocalc/database/pool";

/** Provider metadata retains original bay-local IDs. Resolve the stable payment
 * or attempt identity against the copied local records before using an ID.
 * This does not authorize a payment; the existing amount/owner/status checks
 * and account lock still apply in the fulfillment transaction.
 */
export async function localPaymentSubscriptionId(
  account_id: string,
  payment: {
    id?: string;
    metadata?: {
      subscription_id?: string | number;
      renewal_attempt_id?: string;
    };
  },
  client?: Pick<PoolClient, "query">,
): Promise<number> {
  const db = client ?? getPool();
  const { rows } = await db.query(
    `SELECT s.id FROM subscriptions s WHERE s.account_id=$1
    AND (s.payment->>'payment_intent_id'=$2 OR s.resume_payment_intent=$2
      OR EXISTS (SELECT 1 FROM subscription_renewal_attempts a
        WHERE a.account_id=s.account_id AND a.subscription_id=s.id
          AND (a.payment_intent_id=$2 OR a.id::text=$3)))`,
    [
      account_id,
      payment.id ?? null,
      payment.metadata?.renewal_attempt_id ?? null,
    ],
  );
  if (rows.length > 1) throw Error("Ambiguous subscription payment identity");
  const id = rows[0]?.id ?? Number(payment.metadata?.subscription_id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw Error("Invalid subscription payment reference");
  return id;
}

export async function localPaymentStatementId(
  account_id: string,
  payment_id: string,
  original_id: number,
): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT id FROM statements WHERE account_id=$1 AND automatic_payment_intent_id=$2",
    [account_id, payment_id],
  );
  if (rows.length > 1) throw Error("Ambiguous statement payment identity");
  return rows[0]?.id ?? original_id;
}
