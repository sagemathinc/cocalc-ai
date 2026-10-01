/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

/** Inside the mutation transaction, before the agent-identities lock. */
export async function assertAgentIdentityProjectWritable(
  db: Pick<PoolClient, "query">,
  project_id: string,
): Promise<void> {
  await assertProjectNotRehoming({
    db,
    project_id,
    action: "modify registered agent metadata",
  });
  // A pre-chat authorization check can predate a completed cutover. Recheck
  // local ownership here and keep it stable until this mutation commits.
  const { rows } = await db.query(
    `SELECT project_id FROM projects WHERE project_id=$1
      AND COALESCE(owning_bay_id,$2)=$2 AND deleted IS NOT TRUE FOR SHARE`,
    [project_id, getConfiguredBayId()],
  );
  if (!rows.length)
    throw Error("agent identity project is no longer owned by this bay");
}
