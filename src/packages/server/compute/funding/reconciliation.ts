/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { fundingId } from "@cocalc/util/compute-funding";
import type { CourseFundingAudit } from "@cocalc/conat/hub/api/compute-funding";

const logger = getLogger("compute:funding:reconciliation");

// Report only. Corrections must go through the existing idempotent settlement
// and cleanup workers, never through a balance rewrite derived from this view.
export async function audit(opts: {
  account_id?: string;
  payer_account_id: string;
  bay_id: string;
}): Promise<CourseFundingAudit> {
  const actor = fundingId(opts.account_id, "Account");
  const payer = fundingId(opts.payer_account_id, "Payer");
  if (!(await isAdmin(actor))) throw Error("Administrator access required.");
  const bay = getConfiguredBayId();
  if (opts.bay_id !== bay)
    throw Error("Connect to the explicitly selected funding bay.");
  const home = await resolveAccountHomeBay({ account_id: payer });
  if (home.home_bay_id !== bay)
    throw Error("The selected bay is not the payer's authoritative home.");
  logger.info("payer funding audit requested", {
    actor_account_id: actor,
    payer_account_id: payer,
    bay_id: bay,
  });
  const db = await getPool().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout='15s'");
    const result = await auditFundingSnapshot(db, payer, bay);
    await db.query("COMMIT");
    logger.info("payer funding audit completed", {
      actor_account_id: actor,
      payer_account_id: payer,
      bay_id: bay,
      findings: result.findings.length,
      truncated: result.truncated,
    });
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

export async function auditFundingSnapshot(
  db: Pick<PoolClient, "query">,
  payer: string,
  bay: string,
): Promise<CourseFundingAudit> {
  const {
    rows: [clock],
  } = await db.query("SELECT transaction_timestamp() AS as_of");
  const { rows: authority } = await db.query(
    "SELECT state,home_bay_id FROM account_funding_authorities WHERE payer_account_id=$1",
    [payer],
  );
  if (
    authority.length &&
    (authority[0].state !== "active" || authority[0].home_bay_id !== bay)
  )
    throw Error("Payer funding authority is moving or inactive.");
  const { rows: backing } = await db.query(
    `SELECT lane,SUM(remaining_usd)::text AS held_usd
    FROM account_funding_holds WHERE payer_account_id=$1 GROUP BY lane`,
    [payer],
  );
  const { rows: findings } = await db.query(
    `
    WITH pool_totals AS (
      SELECT p.*,COALESCE(g.spent,0) AS grant_spent,COALESCE(g.reserved,0) AS grant_reserved,
        COALESCE(g.usable,0) AS grant_usable,h.remaining_usd AS backing
      FROM compute_funding_pools p JOIN account_funding_holds h ON h.id=p.hold_id
      LEFT JOIN LATERAL (SELECT SUM(spent_usd) AS spent,SUM(reserved_usd) AS reserved,
        SUM(authorized_usd-released_usd) AS usable FROM compute_funding_grants WHERE pool_id=p.id) g ON true
      WHERE p.payer_account_id=$1
    ), reservation_totals AS (
      SELECT r.*,COALESCE(a.charged,0) AS attributed_charged
      FROM compute_funding_reservations r
      LEFT JOIN LATERAL (SELECT SUM(charged_usd) AS charged FROM compute_funding_purchase_attributions WHERE reservation_id=r.id) a ON true
      WHERE r.payer_account_id=$1
    ), issues AS (
      SELECT 'pool_backing_mismatch' AS code,id::text AS resource_id,'Pool backing differs from unspent, unreleased authorization.' AS message
        FROM pool_totals WHERE backing<>authorized_usd-spent_usd-released_usd
      UNION ALL SELECT 'pool_grant_totals_mismatch',id::text,'Pool spent/reserved totals differ from its grants.'
        FROM pool_totals WHERE spent_usd<>grant_spent OR reserved_usd<>grant_reserved
      UNION ALL SELECT 'pool_overcommit_without_consent',id::text,'Grant ceilings exceed the pool without overcommit authorization.'
        FROM pool_totals WHERE NOT allow_overcommit AND grant_usable>authorized_usd-released_usd
      UNION ALL SELECT 'grant_reservation_mismatch',g.id::text,'Grant committed credit differs from its resource reservations.'
        FROM compute_funding_grants g JOIN compute_funding_pools p ON p.id=g.pool_id
        LEFT JOIN LATERAL (SELECT COALESCE(SUM(authorized_usd-spent_usd-released_usd),0) AS remaining FROM compute_funding_reservations WHERE grant_id=g.id) r ON true
        WHERE p.payer_account_id=$1 AND g.reserved_usd<>r.remaining
      UNION ALL SELECT 'reservation_purchase_mismatch',id::text,'Reservation spending differs from attributed purchases.'
        FROM reservation_totals WHERE spent_usd<>attributed_charged
      UNION ALL SELECT 'purchase_attribution_mismatch',a.purchase_id::text,'Attributed amount or payer differs from the purchase ledger.'
        FROM compute_funding_purchase_attributions a JOIN purchases p ON p.id=a.purchase_id
        WHERE a.payer_account_id=$1 AND (a.charged_usd<>p.cost OR a.payer_account_id<>p.account_id)
      UNION ALL SELECT 'uncertain_resource',resource_id::text,'Provider work is uncertain; retain its backing until reconciled.'
        FROM reservation_totals WHERE state='uncertain'
      UNION ALL SELECT 'stale_runtime_observation',resource_id::text,'Active reservation has no update in the last two minutes.'
        FROM reservation_totals WHERE state IN ('dispatched','consuming') AND updated_at<transaction_timestamp()-interval '2 minutes'
    ) SELECT * FROM issues ORDER BY code,resource_id LIMIT 1001`,
    [payer],
  );
  const { rows: reservations } = await db.query(
    `SELECT id,resource_id,resource_kind,resource_generation,pool_id,grant_id,state,
      authorized_usd::text,spent_usd::text,released_usd::text,protected_usd::text,authorized_until,updated_at
    FROM compute_funding_reservations WHERE payer_account_id=$1 AND state<>'settled'
    ORDER BY authorized_until,id LIMIT 1001`,
    [payer],
  );
  return {
    payer_account_id: payer,
    bay_id: bay,
    as_of: new Date(clock.as_of).toISOString(),
    scope:
      "payer-home ledger; provider inventory and remote worker state require separate checks",
    backing,
    findings: findings.slice(0, 1000),
    reservations: reservations.slice(0, 1000).map((r) => ({
      ...r,
      authorized_until: new Date(r.authorized_until).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    truncated: findings.length > 1000 || reservations.length > 1000,
  };
}
