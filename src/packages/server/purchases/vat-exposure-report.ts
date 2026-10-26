/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Which active personal memberships the EU/UK business tax ID check would refuse
at their next renewal, so admins can contact those customers before then.

Read only: it reads the subscriptions, each account's existing Stripe customer
id and the Stripe customer (with its tax IDs and, if needed, its cards). It
records no refusals, sends no notices, creates no Stripe customers and writes
nothing to Stripe. The decision is decideBusinessTaxIdForPurchase, the same
function the check itself uses at renewal.

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
  stripe_customer_id: string | null;
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
  const { rows: candidates } = await getPool().query<Candidate>(
    `SELECT s.id AS subscription_id, s.account_id, s.current_period_end,
            b.stripe_customer_id
       FROM subscriptions s
       LEFT JOIN ${billingAccountsTable()} b ON b.account_id=s.account_id
      WHERE s.metadata->>'type'='membership'
        AND s.status='active'
        AND s.id > $1
      ORDER BY s.id
      LIMIT $2`,
    [after, PAGE_ROWS],
  );
  stripe ??= await getConn();
  const affected: VatExposureRow[] = [];
  const stripe_errors: VatExposureReportPage["stripe_errors"] = [];
  let checked = 0;
  let no_stripe_customer = 0;
  let last: number | null = null;
  let lastCall = 0;
  for (const candidate of candidates) {
    if (checked > 0 && Date.now() >= deadline) break;
    last = candidate.subscription_id;
    checked += 1;
    const customer = `${candidate.stripe_customer_id ?? ""}`.trim();
    if (!customer) {
      // A renewal would create a customer without an address or cards, which
      // the check accepts.
      no_stripe_customer += 1;
      continue;
    }
    const wait = lastCall + customer_interval_ms - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    try {
      const { refusal } = await withTimeout(
        decideBusinessTaxIdForPurchase({
          stripe,
          customer,
          path: SUBSCRIPTION_RENEWAL,
        }),
        Math.min(customer_timeout_ms, VAT_EXPOSURE_CUSTOMER_TIMEOUT_MS),
      );
      if (refusal != null) {
        affected.push({
          account_id: candidate.account_id,
          subscription_id: candidate.subscription_id,
          current_period_end: new Date(
            candidate.current_period_end,
          ).toISOString(),
          reason: refusal.reason,
          country: refusal.status.country,
        });
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
    affected,
    stripe_errors,
    next_after_subscription_id: done ? null : (last ?? after),
  };
}
