/*
The legacy min_balance "credit line" model is deprecated. Purchases must not
intentionally drive an account below zero, so the effective minimum balance is
always exactly zero.

The accounts.min_balance column still exists for compatibility with legacy data
and admin views, but it is intentionally ignored here.
*/

import type { PoolClient, Pool } from "@cocalc/database/pool";
import { moneyToDbString, type MoneyValue } from "@cocalc/util/money";

export default async function getMinBalance(
  _account_id: string,
  _client?: PoolClient | Pool,
): Promise<MoneyValue> {
  return moneyToDbString(0);
}
