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
  // Each revocation gets its audit row (no actor: the system ended it).
  const { rowCount } = await db.query(
    `WITH revoked AS (
       UPDATE ${SHARED_PROJECT_APPROVALS_TABLE}
          SET revoked_at = clock_timestamp(), revoke_reason = 'rehome'
        WHERE project_id = $1 AND revoked_at IS NULL
        RETURNING approval_id, project_id, account_id, approver_account_id
     )
     INSERT INTO federated_connector_assignment_audit
       (id, action, actor_account_id, account_id, source_project_id,
        approval_id, before, after)
     SELECT gen_random_uuid(), 'shared-revoke', NULL, account_id, project_id,
            approval_id,
            jsonb_build_object('approver_account_id', approver_account_id),
            jsonb_build_object('reason', 'rehome')
       FROM revoked`,
    [project_id],
  );
  return rowCount ?? 0;
}
