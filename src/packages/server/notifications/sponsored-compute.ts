import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";
import { lowCreditThreshold } from "@cocalc/util/compute-notifications";
import { toDecimal } from "@cocalc/util/money";
import { v5 as uuidv5 } from "uuid";
import { ensureSponsoredComputeNoticeSchema } from "./sponsored-compute-state";

export async function notifyLowSponsoredCompute(
  accountId: string,
): Promise<number> {
  const bay = getConfiguredBayId();
  const { rows } = await getPool().query(
    `SELECT other_settings FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE
      AND COALESCE(NULLIF(home_bay_id,''),$3)=$2`,
    [accountId, bay, DEFAULT_BAY_ID],
  );
  if (lowCreditThreshold(rows[0]?.other_settings, "sponsored") === undefined)
    return 0;

  // Pool discovery may route to the central billing bay. Never hold the local
  // account/rehome transaction while waiting for that RPC.
  const { getOwnedPools } =
    await import("@cocalc/server/conat/api/compute-funding");
  const snapshot = await getOwnedPools({ account_id: accountId });
  const asOf = Date.parse(snapshot.as_of);
  if (!Number.isFinite(asOf) || Math.abs(Date.now() - asOf) > 120_000)
    throw Error("Sponsored compute snapshot is stale or unavailable");

  await ensureSponsoredComputeNoticeSchema();
  return await withAccountRehomeWriteFence({
    account_id: accountId,
    action: "send sponsored compute reminders",
    fn: async (db) => {
      const { rows: accounts } = await db.query(
        "SELECT other_settings FROM accounts WHERE account_id=$1 FOR SHARE",
        [accountId],
      );
      const threshold = lowCreditThreshold(
        accounts[0]?.other_settings,
        "sponsored",
      );
      if (threshold === undefined) return 0;
      let notices = 0;
      for (const pool of snapshot.pools) {
        if (pool.state !== "active") continue;
        const available = toDecimal(pool.authorized_usd)
          .minus(pool.released_usd)
          .minus(pool.spent_usd)
          .minus(pool.reserved_usd);
        if (available.isNegative())
          throw Error("Sponsored compute snapshot is invalid");
        const id = uuidv5(
          `sponsored-compute:${accountId}:${pool.id}`,
          uuidv5.URL,
        );
        const previous = (
          await db.query(
            "SELECT * FROM notification_sponsored_compute_states WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (previous && new Date(previous.as_of).getTime() >= asOf) continue;
        const below = available.lessThan(threshold);
        const crossed =
          below &&
          (!previous?.below_threshold ||
            Number(previous.threshold_usd) !== threshold);
        const generation = (previous?.generation ?? 0) + (crossed ? 1 : 0);
        await db.query(
          `INSERT INTO notification_sponsored_compute_states
          (id,account_id,pool_id,threshold_usd,below_threshold,generation,as_of)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(id) DO UPDATE SET threshold_usd=$4,below_threshold=$5,generation=$6,as_of=$7`,
          [
            id,
            accountId,
            pool.id,
            threshold,
            below,
            generation,
            snapshot.as_of,
          ],
        );
        if (!crossed) continue;
        const summary = {
          title: "Sponsored compute budget is low",
          severity: "warning",
          origin_label: "Sponsored compute",
          notice_type: "low_sponsored_compute",
          body_markdown: `An active sponsored compute pool has $${available.toFixed(2)} USD available, below your $${threshold.toFixed(2)} USD reminder threshold. Reserved VM and storage costs are excluded from the available amount. Checked ${snapshot.as_of}.`,
          action_label: "View course project",
          action_link: `/projects/${pool.course_project_id}/files`,
          pool_id: pool.id,
          course_project_id: pool.course_project_id,
        };
        await createNotificationEventGraphInTransaction({
          db,
          input: {
            event_id: uuidv5(`crossing:${generation}`, id),
            kind: "account_notice",
            source_bay_id: bay,
            origin_kind: "system",
            payload_json: summary,
            targets: [
              {
                target_account_id: accountId,
                target_home_bay_id: bay,
                dedupe_key: `${id}:${generation}`,
                summary_json: summary,
              },
            ],
          },
        });
        notices++;
      }
      return notices;
    },
  });
}
