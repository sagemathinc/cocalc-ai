/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PostgreSQL } from "../types";
import { withProjectRehomeWriteFence } from "../project-rehome-fence";

export async function setRunQuota(
  _db: PostgreSQL,
  project_id: string,
  run_quota: Record<string, unknown>,
): Promise<void> {
  await withProjectRehomeWriteFence({
    project_id,
    action: "set project run quota",
    fn: async (db) => {
      await db.query(
        `
          UPDATE projects
             SET run_quota = COALESCE(run_quota, '{}'::jsonb) || $2::jsonb
           WHERE project_id = $1::uuid
        `,
        [project_id, JSON.stringify(run_quota)],
      );
    },
  });
}
