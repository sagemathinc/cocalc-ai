/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { snapshotMembershipAnalyticsDailyCounts } from "@cocalc/server/membership/analytics";

const logger = getLogger("purchases:maintain-membership-analytics");

function yesterdayUtc(): string {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  return yesterday.toISOString().slice(0, 10);
}

export default async function maintainMembershipAnalytics(): Promise<void> {
  const snapshot_date = yesterdayUtc();
  const rows = await snapshotMembershipAnalyticsDailyCounts({ snapshot_date });
  logger.debug("membership analytics snapshot complete", {
    snapshot_date,
    rows,
  });
}
