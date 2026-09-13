import { v5 as uuidv5 } from "uuid";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { withFundingAccountTransaction } from "./backing";
import { finalizeClosingCourseFundingPoolInTransaction } from "./pool-lifecycle";

const logger = getLogger("compute:funding:pool-lifecycle");
const NAMESPACE = "3a092eff-731f-4902-86bb-d8f29c7546a5";
let cursor = "00000000-0000-0000-0000-000000000000";

/** Writes only at current payer authority. The bounded cursor prevents one
 * unavailable receipt target from starving later pools. Durable pool state
 * makes restarts and concurrent workers harmless.
 */
export async function finalizeSettledCourseFundingPools(): Promise<number> {
  const { rows } = await getPool().query<{
    id: string;
    payer_account_id: string;
  }>(
    `SELECT id,payer_account_id FROM compute_funding_pools
      WHERE reserved_usd=0 AND id>$1 AND
        (state='closing' OR (state IN ('active','scheduled','suspended') AND ends_at<=clock_timestamp()))
      ORDER BY id LIMIT 100`,
    [cursor],
  );
  cursor =
    rows.length === 100
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  let count = 0;
  for (const pool of rows) {
    try {
      const { rows: grants } = await getPool().query<{
        beneficiary_account_id: string;
      }>(
        "SELECT beneficiary_account_id FROM compute_funding_grants WHERE pool_id=$1",
        [pool.id],
      );
      const ids = [
        ...new Set([
          pool.payer_account_id,
          ...grants.map((g) => g.beneficiary_account_id),
        ]),
      ];
      const accounts = await getClusterAccountsByIds(ids);
      const homes = Object.fromEntries(
        accounts.map((a) => [
          a.account_id,
          a.home_bay_id ||
            (!isMultiBayCluster() ? getConfiguredBayId() : undefined),
        ]),
      );
      if (ids.some((id) => !homes[id]))
        throw Error("Closing pool receipt home unavailable");
      if (homes[pool.payer_account_id] !== getConfiguredBayId()) continue;
      const finalized = await withFundingAccountTransaction(
        pool.payer_account_id,
        (db) =>
          finalizeClosingCourseFundingPoolInTransaction(db, {
            payer_account_id: pool.payer_account_id,
            pool_id: pool.id,
            operation_id: uuidv5(pool.id, NAMESPACE),
            home_bay_by_account_id: homes as Record<string, string>,
          }),
      );
      if (finalized) count++;
    } catch (err) {
      logger.warn("closing course funding pool needs reconciliation", {
        pool_id: pool.id,
        err,
      });
    }
  }
  return count;
}
