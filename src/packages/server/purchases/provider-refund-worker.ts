/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import getConn from "@cocalc/server/stripe/connection";
import { registerBillingAuthorityAccount } from "./billing-authority/context";
import type { ProviderRefundAttempt } from "./provider-refund-attempts";
import {
  readClaimedProviderRefund,
  recordProviderRefundResult,
} from "./provider-refund-attempts";
import { readProviderRefund } from "./provider-refund-reader";
import { refreshAccountBalanceAndPublishBestEffort } from "./refresh-balance";

const logger = getLogger("purchases:provider-refund-worker");
const LEASE_SECONDS = 60;
const LOOKUP_TIMEOUT_MS = 15_000;

/** This short statement locks job metadata only and commits before acquiring
 * any account lock. A claim is not financial authority and never releases money.
 */
export async function claimProviderRefundReconciliation(
  account_id?: string,
): Promise<ProviderRefundAttempt | undefined> {
  const {
    rows: [row],
  } = await getPool().query<ProviderRefundAttempt>(
    `WITH candidate AS (
       SELECT r.id FROM provider_refund_attempts r
       JOIN accounts a ON a.account_id=r.account_id
       LEFT JOIN account_funding_authorities f ON f.payer_account_id=r.account_id
       WHERE r.state='pending' AND r.next_reconcile_at <= clock_timestamp()
         AND (r.provider_request IS NOT NULL OR r.provider_result IS NOT NULL)
         AND (r.reconcile_lease_expires_at IS NULL OR r.reconcile_lease_expires_at <= clock_timestamp())
         AND a.deleted IS NOT TRUE
         AND COALESCE(NULLIF(TRIM(a.home_bay_id),''),$1)=$1
         AND (f.state IS NULL OR f.state='active')
         AND ($2::uuid IS NULL OR r.account_id=$2)
       ORDER BY r.next_reconcile_at, r.id
       LIMIT 1 FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE provider_refund_attempts r
       SET reconcile_token=gen_random_uuid(),
           reconcile_lease_expires_at=clock_timestamp()+$3*INTERVAL '1 second',
           reconcile_attempts=r.reconcile_attempts+1
       FROM candidate c WHERE r.id=c.id RETURNING r.*`,
    [getConfiguredBayId(), account_id ?? null, LEASE_SECONDS],
  );
  return row;
}

type ReconciliationError =
  | "no_provider_receipt"
  | "provider_pending"
  | "partial_refund_needs_review"
  | "reconciliation_failed";

async function finishClaim(
  attempt: ProviderRefundAttempt,
  error: ReconciliationError | null,
): Promise<void> {
  await getPool().query(
    `UPDATE provider_refund_attempts
       SET reconcile_token=NULL, reconcile_lease_expires_at=NULL,
           next_reconcile_at=clock_timestamp()+LEAST(3600,60*POWER(2,LEAST(reconcile_attempts-1,6)))*INTERVAL '1 second',
           last_reconcile_error=$3
       WHERE id=$1 AND reconcile_token=$2`,
    [attempt.id, attempt.reconcile_token, error],
  );
}

async function timedLookup<T>(
  lookup: Promise<T>,
  timeout_ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Provider refund lookup timed out")),
          timeout_ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function reconcileClaimedProviderRefund(
  attempt: ProviderRefundAttempt,
  lookup_timeout_ms = LOOKUP_TIMEOUT_MS,
): Promise<void> {
  if (
    !Number.isInteger(lookup_timeout_ms) ||
    lookup_timeout_ms < 1 ||
    lookup_timeout_ms > LOOKUP_TIMEOUT_MS
  )
    throw Error("Invalid refund lookup timeout");
  let error: ReconciliationError | null = "reconciliation_failed";
  try {
    await registerBillingAuthorityAccount(attempt.account_id);
    if (!attempt.reconcile_token)
      throw Error("Refund reconciliation requires a claim");
    const current = await readClaimedProviderRefund(
      attempt,
      attempt.reconcile_token,
    );
    if (current.state !== "pending") {
      error = null;
      return;
    }
    const result = await timedLookup(
      (async () => readProviderRefund(await getConn(), current))(),
      lookup_timeout_ms,
    );
    // Only the read is raced. A late provider response cannot reach settlement.
    if (!result) {
      error = "no_provider_receipt";
      return;
    }
    const settled = await recordProviderRefundResult(
      current,
      result,
      attempt.reconcile_token,
    );
    if (settled.state === "pending") {
      error = ["failed", "canceled"].includes(result.status)
        ? "partial_refund_needs_review"
        : "provider_pending";
    } else {
      error = null;
      await refreshAccountBalanceAndPublishBestEffort({
        account_id: current.account_id,
      });
    }
  } catch (err) {
    logger.warn("provider refund reconciliation remains pending", {
      attempt_id: attempt.id,
      account_id: attempt.account_id,
      err: `${err}`,
    });
  } finally {
    // Token comparison prevents an old worker from clearing its successor's job.
    await finishClaim(attempt, error);
  }
}

/** Internal maintenance/operations entry point. It only reconciles existing
 * dispatches; no account or project credential may invoke this as a refund API.
 */
export async function reconcileProviderRefunds({
  account_id,
  limit = 25,
}: { account_id?: string; limit?: number } = {}): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("Invalid refund reconciliation limit");
  const deadline = Date.now() + 60_000;
  let processed = 0;
  while (processed < limit && Date.now() < deadline) {
    const attempt = await claimProviderRefundReconciliation(account_id);
    if (!attempt) break;
    await reconcileClaimedProviderRefund(attempt);
    processed++;
  }
  return processed;
}

export default async function maintainProviderRefunds(): Promise<void> {
  await reconcileProviderRefunds();
}
