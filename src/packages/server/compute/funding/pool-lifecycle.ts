/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  requireFundingAccountTransaction,
  reduceAccountFundingBacking,
} from "./backing";
import type { CourseFundingGrantRow, CourseFundingPoolRow } from "./pools";
import { enqueueCourseFundingReceiptInTransaction } from "./receipts";

/** Call after trusted resource settlement has updated all reserved liabilities.
 * Never infer settlement from a stop request, timeout, or provider outage.
 * Recipient homes must be resolved before entering the funding transaction.
 */
export async function finalizeClosingCourseFundingPoolInTransaction(
  db: PoolClient,
  opts: {
    payer_account_id: string;
    pool_id: string;
    operation_id: string;
    home_bay_by_account_id: Record<string, string>;
  },
): Promise<boolean> {
  const payer = fundingId(opts.payer_account_id, "Payer account");
  requireFundingAccountTransaction(db, payer);
  const {
    rows: [pool],
  } = await db.query<CourseFundingPoolRow>(
    "SELECT * FROM compute_funding_pools WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
    [fundingId(opts.pool_id, "Pool"), payer],
  );
  if (!pool)
    throw new ComputeFundingError(
      "funding_not_found",
      "Funding pool not found.",
    );
  if (pool.state !== "closing" || !toDecimal(pool.reserved_usd).isZero())
    return false;
  const { rows: grants } = await db.query<CourseFundingGrantRow>(
    "SELECT * FROM compute_funding_grants WHERE pool_id=$1 ORDER BY id FOR UPDATE",
    [pool.id],
  );
  if (grants.some((g) => !toDecimal(g.reserved_usd).isZero()))
    throw new ComputeFundingError(
      "funding_conflict",
      "Student liabilities must settle before closing the pool.",
    );
  const release = toDecimal(pool.authorized_usd)
    .minus(pool.released_usd)
    .minus(pool.spent_usd);
  if (release.lt(0))
    throw new ComputeFundingError(
      "funding_conflict",
      "Closing pool liabilities exceed authorization.",
    );
  if (release.gt(0))
    await reduceAccountFundingBacking(db, {
      payer_account_id: payer,
      hold_id: pool.hold_id,
      amount_usd: moneyToDbString(release),
    });
  const {
    rows: [closed],
  } = await db.query<CourseFundingPoolRow>(
    "UPDATE compute_funding_pools SET state='closed',released_usd=authorized_usd-spent_usd,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
    [pool.id],
  );
  const { rows: revoked } = await db.query<CourseFundingGrantRow>(
    "UPDATE compute_funding_grants SET state='revoked',released_usd=authorized_usd-spent_usd,version=version+1,updated_at=clock_timestamp() WHERE pool_id=$1 RETURNING *",
    [pool.id],
  );
  await enqueueCourseFundingReceiptInTransaction(db, {
    ...opts,
    payer_account_id: payer,
    action: "closed",
    pool: closed,
    grants: revoked,
  });
  return true;
}
