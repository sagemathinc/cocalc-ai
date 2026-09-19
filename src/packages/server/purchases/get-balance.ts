import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  billingAccountsTable,
  ensureBillingAccount,
} from "@cocalc/server/purchases/billing-account";
import {
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";

/*
compute the sum of the following, over all rows of the table for a given account_id:

- the cost if it is not null
- if the cost is null, I want to compute cost_per_hour times the number of
  hours from period_start to period_end, or if period_end is null, the
  current time.
*/

// Newly finalized costs are whole cents. Legacy finalized rows may retain
// sub-cent precision, so callers round only after summing them. Active metered
// values remain precise internally and are rounded per active ledger entry.
export const COST_OR_METERED_COST =
  "COALESCE(cost, ROUND(COALESCE(cost_so_far, cost_per_hour * (EXTRACT(EPOCH FROM (COALESCE(period_end, NOW()) - period_start))::numeric / 3600)), 2))";

// Approximate purchase cost at a selected point in time.  Active rate-based
// rows are evaluated using elapsed time up to asOf instead of NOW(), so a
// bounded purchase-history report starts from a meaningful historical balance.
// This is still an approximation for rows whose final cost was recorded later
// but whose transaction time is already within the selected window.
const COST_OR_METERED_COST_AS_OF =
  "COALESCE(cost, ROUND(COALESCE(cost_per_hour * GREATEST(EXTRACT(EPOCH FROM (COALESCE(LEAST(period_end, $2::timestamptz), $2::timestamptz) - period_start))::numeric / 3600, 0), cost_so_far), 2))";

// never update the balance more frequently than this for a given user.
const MIN_BALANCE_UPDATE_MS = 1000;

const lastUpdate: { [account_id: string]: number } = {};
export default async function getBalance({
  account_id,
  client,
  forceSave,
  noSave,
}: {
  account_id: string;
  client?: PoolClient;
  // Save the computed balance even if this process recently updated it.
  forceSave?: boolean;
  // do not save the computed balance to the accounts table.
  noSave?: boolean;
}): Promise<MoneyValue> {
  const pool = client ?? getPool();

  // Criticism:
  //   - user may have a large number of purchases, and this is adding them all
  //     up every single time it computes the balance.

  const { rows } = await pool.query(
    `SELECT ROUND(-COALESCE(SUM(${COST_OR_METERED_COST}), 0), 2) as balance FROM purchases WHERE account_id=$1`,
    [account_id],
  );
  const balance = toDecimal(rows[0]?.balance ?? 0);
  if (!noSave) {
    await ensureBillingAccount(account_id, pool);
    const table = billingAccountsTable();
    const now = Date.now();
    if (
      forceSave ||
      now - (lastUpdate[account_id] ?? 0) >= MIN_BALANCE_UPDATE_MS
    ) {
      lastUpdate[account_id] = now;
      await pool.query(`UPDATE ${table} SET balance=$2 WHERE account_id=$1`, [
        account_id,
        moneyToDbString(balance),
      ]);
    }
  }
  return moneyToDbString(balance);
}

// total balance right now
export async function getTotalBalance(
  account_id: string,
  client?: PoolClient,
): Promise<MoneyValue> {
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    `SELECT ROUND(-COALESCE(SUM(${COST_OR_METERED_COST}), 0), 2) as balance FROM purchases WHERE account_id=$1`,
    [account_id],
  );
  return moneyToDbString(rows[0]?.balance ?? 0);
}

export async function getBalanceAsOf({
  account_id,
  asOf,
  client,
}: {
  account_id: string;
  asOf: Date;
  client?: PoolClient;
}): Promise<MoneyValue> {
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    `
      SELECT ROUND(-COALESCE(SUM(${COST_OR_METERED_COST_AS_OF}), 0), 2) as balance
        FROM purchases
       WHERE account_id=$1
         AND time <= $2
    `,
    [account_id, asOf],
  );
  return moneyToDbString(rows[0]?.balance ?? 0);
}
