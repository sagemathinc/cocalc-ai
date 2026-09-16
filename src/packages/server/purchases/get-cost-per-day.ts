/*
Computes the total spend during each day (when something was spent)
by the given account, and return that amount.
*/

import getPool from "@cocalc/database/pool";
import type { MoneyValue } from "@cocalc/util/money";
import { COST_OR_METERED_COST } from "./get-balance";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

interface Options {
  account_id: string;
  limit?: number;
  offset?: number;
}

function validatePaginationInteger({
  name,
  value,
  min,
  max,
}: {
  name: "limit" | "offset";
  value: number;
  min: number;
  max?: number;
}): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max != null && value > max)
  ) {
    const range = max == null ? `at least ${min}` : `between ${min} and ${max}`;
    throw Error(`${name} must be an integer ${range}`);
  }
  return value;
}

export default async function getCostPerDay({
  account_id,
  limit = DEFAULT_LIMIT,
  offset = 0,
}: Options): Promise<{ date: Date; total_cost: MoneyValue }[]> {
  const validatedLimit = validatePaginationInteger({
    name: "limit",
    value: limit,
    min: 1,
    max: MAX_LIMIT,
  });
  const validatedOffset = validatePaginationInteger({
    name: "offset",
    value: offset,
    min: 0,
  });
  const db = getPool("long");
  const { rows } = await db.query(
    `SELECT date_trunc('day', "time" AT TIME ZONE 'UTC') AS date, ROUND(SUM(${COST_OR_METERED_COST}), 2) AS total_cost
FROM purchases
WHERE account_id = $1 AND (cost > 0 OR cost_per_hour IS NOT NULL OR cost_so_far IS NOT NULL)
GROUP BY date_trunc('day', "time" AT TIME ZONE 'UTC')
ORDER BY date DESC LIMIT $2 OFFSET $3`,
    [account_id, validatedLimit, validatedOffset],
  );
  return rows;
}
