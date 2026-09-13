/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/database/postgres/account-rehome-fence";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";

// Compiled writer protocol consumed by isolated-development rollout inspection.
export const FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION = 1;

/** Acquire before any purchase, subscription, pool or reservation row locks.
 * The caller owns the transaction; hold this lock through admission and commit.
 * This is serialization, not actor authorization or a spending reservation.
 */
export async function lockAccountSpending(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  const account_id = fundingId(accountId, "Spending account");
  await assertAccountNotRehoming({
    db: client,
    account_id,
    action: "change account spending",
  });
  await assertAccountWriteOnHomeBay({
    db: client,
    account_id,
    action: "change account spending",
  });
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('account-funding'), hashtext($1))",
    [account_id],
  );
  // A failed/retrying account move must not reopen financial writes after the
  // source has frozen. Ordinary accounts without funding authority are unchanged.
  const {
    rows: [authority],
  } = await client.query<{ state: string }>(
    "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1 FOR SHARE",
    [account_id],
  );
  if (authority && authority.state !== "active")
    throw new ComputeFundingError(
      "funding_unavailable",
      "Account spending is frozen pending financial handoff reconciliation.",
    );
}
