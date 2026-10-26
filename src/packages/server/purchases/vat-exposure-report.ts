/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Which active personal memberships the EU/UK business tax ID check would refuse
at their next renewal, so admins can contact those customers before then.

Like a renewal, it finds the account's Stripe customer (stored, or else by
its account_id metadata, as getStripeCustomerId recovers it), predicts how the
renewal would be paid (predictRenewalFunding, with the open attempt's saved
payment and funding split: an already bound Stripe payment, or no card payment
at all, means no check) and decides with
decideBusinessTaxIdForPurchase, the same function the check itself uses.

Read only: it records no refusals, sends no notices, stores no recovered
customer ids, creates no Stripe customers and only reads from Stripe.

Stripe calls are paced, and each call checks subscriptions for a bounded time
and returns a cursor, so the report is read page by page.
*/

import getPool from "@cocalc/database/pool";
import { SUBSCRIPTION_RENEWAL } from "@cocalc/util/db-schema/purchases";
import type {
  VatExposureReportPage,
  VatExposureRow,
} from "@cocalc/conat/hub/api/purchases";
import getConn from "@cocalc/server/stripe/connection";
import { billingAccountsTable } from "./billing-account";
import { decideBusinessTaxIdForPurchase } from "./stripe/business-tax-id-gate";
import { predictRenewalFunding } from "./stripe/create-subscription-payment";
import { searchStripeCustomerIdByAccountMetadata } from "./stripe/util";
import { renewalAttemptClaimableSql } from "./subscription-renewal-attempts";

// At most this long checking subscriptions per call (the call returns a cursor
// for the rest). With the per-customer cap below, a call stays under the 30 s
// RPC and billing authority timeouts.
export const VAT_EXPOSURE_PAGE_MS = 12_000;
// One customer's check is reported as an error if it takes longer than this.
export const VAT_EXPOSURE_CUSTOMER_TIMEOUT_MS = 10_000;
// At least this long between the Stripe checks of two customers. A check is
// one to three Stripe reads.
export const VAT_EXPOSURE_CUSTOMER_INTERVAL_MS = 150;
const PAGE_ROWS = 100;

interface Candidate {
  subscription_id: number;
  account_id: string;
  current_period_end: Date;
  amount: string;
  stripe_customer_id: string | null;
  // The open renewal attempt's id and funding state, if there is one.
  attempt_id: string | null;
  payment_intent_id: string | null;
  balance_applied: string | null;
  // subscriptions.payment
  payment: { status?: string; renewal_attempt_id?: string | null } | null;
  // Whether this bay's renewal worker may renew it at all.
  claimable: boolean;
}

// Stops waiting after ms; the read itself may still finish in the background.
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function shortError(err: unknown): string {
  const e = err as any;
  const text = `${e?.code ?? e?.type ?? ""} ${e?.message ?? e}`.trim();
  return text.slice(0, 200);
}

// One subscription: undefined if it has no Stripe customer, stored or
// recoverable; otherwise how its renewal would be paid and, if the check would
// refuse it, the row.
async function checkCandidate(
  stripe,
  candidate: Candidate,
): Promise<
  | {
      funding: "open-payment" | "below-minimum" | "balance" | "card";
      row?: VatExposureRow;
    }
  | undefined
> {
  const stored = `${candidate.stripe_customer_id ?? ""}`.trim();
  const customer =
    stored ||
    (await searchStripeCustomerIdByAccountMetadata(
      stripe,
      candidate.account_id,
    ));
  if (!customer) return;
  const funding = await predictRenewalFunding({
    account_id: candidate.account_id,
    amount: candidate.amount,
    attempt: {
      id: candidate.attempt_id,
      payment_intent_id: candidate.payment_intent_id,
      balance_applied: candidate.balance_applied,
    },
    subscriptionPayment: candidate.payment,
  });
  const { refusal } = await decideBusinessTaxIdForPurchase({
    stripe,
    customer,
    path: SUBSCRIPTION_RENEWAL,
  });
  if (refusal == null) return { funding };
  return {
    funding,
    row: {
      account_id: candidate.account_id,
      subscription_id: candidate.subscription_id,
      current_period_end: new Date(candidate.current_period_end).toISOString(),
      reason: refusal.reason,
      country: refusal.status.country,
      stripe_customer: stored ? "stored" : "recovered",
    },
  };
}

export async function vatExposureReportPage({
  after_subscription_id = 0,
  page_ms = VAT_EXPOSURE_PAGE_MS,
  customer_interval_ms = VAT_EXPOSURE_CUSTOMER_INTERVAL_MS,
  customer_timeout_ms = VAT_EXPOSURE_CUSTOMER_TIMEOUT_MS,
  stripe,
}: {
  after_subscription_id?: number;
  page_ms?: number;
  customer_interval_ms?: number;
  customer_timeout_ms?: number;
  // For tests.
  stripe?;
} = {}): Promise<VatExposureReportPage> {
  const after = Number(after_subscription_id);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw Error("after_subscription_id must be a nonnegative integer");
  }
  const deadline = Date.now() + Math.min(page_ms, VAT_EXPOSURE_PAGE_MS);
  // Active personal memberships, the ones the renewal worker renews.
  // The renewal worker's own eligibility condition, for this account.
  const claimable = await renewalAttemptClaimableSql("$3", "s.account_id");
  const { rows: candidates } = await getPool().query<Candidate>(
    `SELECT s.id AS subscription_id, s.account_id, s.current_period_end,
            COALESCE(att.amount, s.cost)::text AS amount, b.stripe_customer_id,
            att.id AS attempt_id, att.payment_intent_id,
            att.balance_applied::text AS balance_applied, s.payment,
            (${claimable.sql}
              -- A closed attempt for the current period is never rescheduled
              -- (scheduling skips existing periods) nor claimed.
              AND NOT EXISTS (
                SELECT 1 FROM subscription_renewal_attempts closed
                 WHERE closed.subscription_id=s.id
                   AND closed.period_end=s.current_period_end
                   AND closed.state NOT IN ('scheduled','processing')
              )) AS claimable
       FROM subscriptions s
       LEFT JOIN ${billingAccountsTable()} b ON b.account_id=s.account_id
       LEFT JOIN subscription_renewal_attempts att
         ON att.subscription_id=s.id
        AND att.period_end=s.current_period_end
        AND att.state IN ('scheduled','processing')
      WHERE s.metadata->>'type'='membership'
        AND s.status='active'
        AND s.id > $1
      ORDER BY s.id
      LIMIT $2`,
    [after, PAGE_ROWS, ...(claimable.bay != null ? [claimable.bay] : [])],
  );
  stripe ??= await getConn();
  const affected: VatExposureRow[] = [];
  const paid_without_check: VatExposureReportPage["paid_without_check"] = [];
  const stripe_errors: VatExposureReportPage["stripe_errors"] = [];
  let checked = 0;
  let no_stripe_customer = 0;
  let not_claimable = 0;
  let last: number | null = null;
  let lastCall = 0;
  for (const candidate of candidates) {
    if (checked > 0 && Date.now() >= deadline) break;
    last = candidate.subscription_id;
    checked += 1;
    if (!candidate.claimable) {
      // Banned, deleted or billing-frozen, (without the billing authority)
      // owned by another bay, or its current period's attempt is closed:
      // this bay's worker never renews it.
      not_claimable += 1;
      continue;
    }
    const wait = lastCall + customer_interval_ms - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    try {
      const result = await withTimeout(
        checkCandidate(stripe, candidate),
        Math.min(customer_timeout_ms, VAT_EXPOSURE_CUSTOMER_TIMEOUT_MS),
      );
      if (result == null) {
        no_stripe_customer += 1;
      } else if (result.row != null) {
        if (result.funding === "card") {
          affected.push(result.row);
        } else {
          paid_without_check.push({ ...result.row, funding: result.funding });
        }
      }
    } catch (err) {
      stripe_errors.push({
        account_id: candidate.account_id,
        subscription_id: candidate.subscription_id,
        error: shortError(err),
      });
    }
  }
  const done = candidates.length < PAGE_ROWS && checked === candidates.length;
  return {
    checked,
    no_stripe_customer,
    not_claimable,
    affected,
    paid_without_check,
    stripe_errors,
    next_after_subscription_id: done ? null : (last ?? after),
  };
}
