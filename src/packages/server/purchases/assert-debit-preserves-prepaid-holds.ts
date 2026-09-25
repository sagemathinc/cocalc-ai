/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import { ComputeFundingError } from "@cocalc/util/compute-funding";
import {
  moneyRoundToCents,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import getBalance from "./get-balance";
import { getAccountFundingHolds } from "./get-spendable-balance";

/** For discretionary ledger reversals/adjustments, not delivered-service bills
 * or forced provider chargebacks. Caller must hold lockAccountSpending through
 * this check and debit. This preserves legacy debt adjustments when no prepaid
 * credit is held; postpaid commitments are not cash.
 */
export async function assertDebitPreservesPrepaidHolds({
  account_id,
  client,
  amount,
}: {
  account_id: string;
  client: PoolClient;
  amount: MoneyValue;
}): Promise<void> {
  const raw = toDecimal(amount);
  if (!Number.isFinite(raw.toNumber()) || raw.lt(0))
    throw Error("invalid debit amount");
  const debit = moneyRoundToCents(raw);
  if (debit.isZero()) return;
  const { prepaid_held_usd } = await getAccountFundingHolds({
    account_id,
    client,
  });
  if (toDecimal(prepaid_held_usd).lte(0)) return;
  const balance = await getBalance({ account_id, client, noSave: true });
  if (toDecimal(balance).minus(debit).lt(prepaid_held_usd)) {
    throw new ComputeFundingError(
      "insufficient_funding",
      "This reversal would consume reserved credit. Release or reconcile the funding commitments first.",
    );
  }
}
