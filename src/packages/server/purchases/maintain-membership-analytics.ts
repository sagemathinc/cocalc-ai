/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  ensureMembershipAnalyticsTables,
  snapshotMembershipAnalyticsDailyCounts,
} from "@cocalc/server/membership/analytics";

const logger = getLogger("purchases:maintain-membership-analytics");

function todayUtc(): string {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return today.toISOString().slice(0, 10);
}

async function snapshotExists({
  bay_id,
  snapshot_date,
}: {
  bay_id: string;
  snapshot_date: string;
}): Promise<boolean> {
  await ensureMembershipAnalyticsTables();
  const { rowCount } = await getPool().query(
    `SELECT 1
       FROM membership_analytics_daily_counts
      WHERE snapshot_date=$1::date
        AND bay_id=$2
      LIMIT 1`,
    [snapshot_date, bay_id],
  );
  return (rowCount ?? 0) > 0;
}

export default async function maintainMembershipAnalytics(): Promise<void> {
  const snapshot_date = todayUtc();
  const bay_id = getConfiguredBayId();
  if (await snapshotExists({ bay_id, snapshot_date })) {
    logger.debug("membership analytics snapshot already exists", {
      bay_id,
      snapshot_date,
    });
    return;
  }
  const rows = await snapshotMembershipAnalyticsDailyCounts({
    bay_id,
    snapshot_date,
  });
  logger.debug("membership analytics snapshot complete", {
    bay_id,
    snapshot_date,
    rows,
  });
}
