/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import getConn from "@cocalc/server/stripe/connection";
import { currentStripeSite } from "../stripe/util";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertAccountWriteOnHomeBay } from "@cocalc/database/postgres/account-rehome-fence";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { PaymentRoot } from "@cocalc/util/credit-transfers";
import { v5 } from "uuid";

export interface VerifiedPaymentRoot {
  root: PaymentRoot;
  evidence: {
    charge_id: string;
    balance_transaction_id: string;
    available_on: number;
    verified_at: string;
    stripe_site?: string;
  };
}

/** Provider reads only, before any financial transaction. Successful capture is
 * insufficient: the charge's USD balance transaction must also be available.
 * https://docs.stripe.com/api/balance_transactions/object
 */
export async function verifyPaymentPurchase(
  account_id: string,
  purchase_id: number,
  root_id?: string,
): Promise<VerifiedPaymentRoot | undefined> {
  const db = getPool();
  await assertAccountWriteOnHomeBay({
    db,
    account_id,
    action: "verify transferable payment credit",
  });
  const { rows: roots } = await db.query<
    PaymentRoot & {
      local_purchase_id: number;
      evidence: VerifiedPaymentRoot["evidence"];
    }
  >(
    `SELECT root_id,account_id,home_bay_id,purchase_id AS local_purchase_id,
      COALESCE(original_purchase_id,purchase_id) AS purchase_id,
      payment_intent_id,amount_usd::text,evidence FROM credit_payment_roots
     WHERE account_id=$1 AND ($3::uuid IS NOT NULL AND root_id=$3
       OR $3::uuid IS NULL AND purchase_id=$2)`,
    [account_id, purchase_id, root_id ?? null],
  );
  const stored = roots[0];
  if (root_id && !stored) return;
  if (stored) purchase_id = stored.local_purchase_id;
  const {
    rows: [row],
  } = await db.query(
    `SELECT p.cost::text,p.invoice_id,p.service,p.description,a.stripe_customer_id
    FROM purchases p JOIN accounts a ON a.account_id=p.account_id
    WHERE p.account_id=$1 AND p.id=$2 AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE`,
    [account_id, purchase_id],
  );
  if (
    !row ||
    !["credit", "auto-credit"].includes(row.service) ||
    !row.invoice_id?.startsWith("pi_") ||
    !["add-credit", "auto-credit"].includes(row.description?.purpose) ||
    !row.stripe_customer_id ||
    row.cost == null ||
    !toDecimal(row.cost).lt(0)
  )
    return;
  const { rows: blocked } = await db.query(
    `SELECT 1 FROM provider_refund_attempts WHERE purchase_id=$1 AND state <> 'failed'
    UNION ALL SELECT 1 FROM payment_fulfillments WHERE credit_id=$1 LIMIT 1`,
    [purchase_id],
  );
  if (blocked.length) return;
  if (
    stored &&
    (stored.payment_intent_id !== row.invoice_id ||
      !toDecimal(stored.amount_usd).eq(toDecimal(row.cost).neg()))
  )
    return;
  const stripe = await getConn();
  const pi = await stripe.paymentIntents.retrieve(row.invoice_id, {
    expand: ["latest_charge.balance_transaction"],
  });
  // A moved payment retains its original verified provider-site binding.
  if (
    stored &&
    stored.home_bay_id !== getConfiguredBayId() &&
    !stored.evidence.stripe_site
  )
    return;
  const site = stored?.evidence.stripe_site ?? (await currentStripeSite());
  const id = (value: unknown) =>
    typeof value === "string" ? value : (value as { id?: string } | null)?.id;
  const cents = toDecimal(row.cost).neg().mul(100);
  if (
    pi.status !== "succeeded" ||
    pi.currency !== "usd" ||
    id(pi.customer) !== row.stripe_customer_id ||
    pi.metadata.account_id !== account_id ||
    pi.metadata.cocalc_site !== site ||
    pi.metadata.purpose !== row.description.purpose ||
    !cents.isInteger() ||
    !cents.eq(pi.metadata.total_excluding_tax_usd ?? "-1") ||
    cents.gt(pi.amount_received)
  )
    return;
  const charge = pi.latest_charge;
  if (
    !charge ||
    typeof charge === "string" ||
    charge.currency !== "usd" ||
    !charge.paid ||
    !charge.captured ||
    charge.status !== "succeeded" ||
    charge.disputed ||
    charge.refunded ||
    charge.amount_refunded !== 0 ||
    charge.review ||
    charge.fraud_details?.user_report ||
    charge.fraud_details?.stripe_report ||
    id(charge.customer) !== row.stripe_customer_id ||
    id(charge.payment_intent) !== pi.id ||
    cents.gt(charge.amount_captured)
  )
    return;
  const balance = charge.balance_transaction;
  if (
    !balance ||
    typeof balance === "string" ||
    balance.currency !== "usd" ||
    balance.status !== "available" ||
    balance.available_on > Date.now() / 1000 ||
    id(balance.source) !== charge.id ||
    balance.amount !== charge.amount_captured
  )
    return;
  return {
    root: {
      root_id:
        stored?.root_id ??
        v5(`cocalc-credit-payment:${getConfiguredBayId()}:${pi.id}`, v5.URL),
      home_bay_id: stored?.home_bay_id ?? getConfiguredBayId(),
      account_id,
      purchase_id: stored?.purchase_id ?? purchase_id,
      payment_intent_id: pi.id,
      amount_usd: moneyToDbString(toDecimal(row.cost).neg()),
    },
    evidence: {
      charge_id: charge.id,
      balance_transaction_id: balance.id,
      available_on: balance.available_on,
      verified_at: new Date().toISOString(),
      stripe_site: site,
    },
  };
}
