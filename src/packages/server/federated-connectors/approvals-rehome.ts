/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Kept free of other dependencies: projects/rehome.ts imports it.

import type { PoolClient } from "@cocalc/database/pool";

export const SHARED_PROJECT_APPROVALS_TABLE =
  "federated_connector_shared_project_approvals";

/**
 * Ends every active shared-project approval for a project that is leaving
 * this bay. Runs in the caller's transaction, the one that hands the project
 * off, so a project that later returns here needs a new approval from a
 * current owner.
 */
export async function revokeFederatedSharedProjectApprovalsForRehome(
  db: Pick<PoolClient, "query">,
  project_id: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE ${SHARED_PROJECT_APPROVALS_TABLE}
        SET revoked_at = clock_timestamp(), revoke_reason = 'rehome'
      WHERE project_id = $1 AND revoked_at IS NULL`,
    [project_id],
  );
  return rowCount ?? 0;
}
