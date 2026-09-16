/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import getBalance from "./get-balance";

export async function getAccountFundingHolds({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<{
  prepaid_held_usd: string;
  postpaid_committed_usd: string;
}> {
  // A renewal's persisted split is its hold until terminal settlement. Worker
  // leases do not release it; terminal callbacks cannot debit a canceled attempt.
  const {
    rows: [held],
  } = await (client ?? getPool()).query<{ prepaid: string; postpaid: string }>(
    `SELECT COALESCE(SUM(remaining_usd) FILTER (WHERE lane='prepaid'),0)::text AS prepaid,
            COALESCE(SUM(remaining_usd) FILTER (WHERE lane='postpaid'),0)::text AS postpaid
     FROM (
       SELECT remaining_usd, lane FROM account_funding_holds WHERE payer_account_id=$1
       UNION ALL
       SELECT balance_applied AS remaining_usd, 'prepaid' AS lane
         FROM subscription_renewal_attempts
        WHERE account_id=$1 AND state IN ('scheduled','processing')
       UNION ALL
       SELECT amount AS remaining_usd, 'prepaid' AS lane
         FROM payment_fulfillments WHERE account_id=$1 AND state='pending'
       UNION ALL
       SELECT amount AS remaining_usd, 'prepaid' AS lane
         FROM provider_refund_attempts WHERE account_id=$1 AND state='pending'
     ) AS commitments`,
    [account_id],
  );
  return {
    prepaid_held_usd: moneyToDbString(held.prepaid),
    postpaid_committed_usd: moneyToDbString(held.postpaid),
  };
}

/** Account-home read. Admission callers must hold lockAccountSpending on client
 * through the debit/commit; a read without that transaction is only a preview.
 * Do not substitute this for the ledger balance in invoices or charge reporting.
 */
export default async function getSpendableBalance(
  opts: Parameters<typeof getBalance>[0],
): Promise<string> {
  const balance = await getBalance(opts);
  const holds = await getAccountFundingHolds(opts);
  return moneyToDbString(toDecimal(balance).minus(holds.prepaid_held_usd));
}
