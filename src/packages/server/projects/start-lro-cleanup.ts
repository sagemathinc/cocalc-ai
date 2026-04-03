/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { publishLroSummary } from "@cocalc/server/lro/stream";
import { updateLro } from "@cocalc/server/lro/lro-db";

const log = getLogger("server:projects:start-lro-cleanup");

const ACTIVE_START_STATUSES = ["queued", "running"] as const;

export async function supersedeOlderProjectStartLros({
  project_id,
  keep_op_id,
}: {
  project_id: string;
  keep_op_id?: string;
}): Promise<void> {
  const targetOpId = `${keep_op_id ?? ""}`.trim();
  if (!targetOpId) {
    return;
  }

  let rows:
    | Array<{
        op_id: string;
        scope_type: "project";
        scope_id: string;
        error?: string | null;
      }>
    | undefined;
  try {
    const result = await getPool().query<{
      op_id: string;
      scope_type: "project";
      scope_id: string;
      error?: string | null;
    }>(
      `
        SELECT op_id, scope_type, scope_id, error
        FROM long_running_operations
        WHERE kind='project-start'
          AND scope_type='project'
          AND scope_id=$1
          AND op_id <> $2
          AND dismissed_at IS NULL
          AND status = ANY($3::text[])
        ORDER BY created_at DESC
      `,
      [project_id, targetOpId, ACTIVE_START_STATUSES],
    );
    rows = result.rows;
  } catch (err) {
    log.warn("unable to list older project-start lros", {
      project_id,
      keep_op_id: targetOpId,
      err: `${err}`,
    });
    return;
  }

  for (const row of rows) {
    try {
      const updated = await updateLro({
        op_id: row.op_id,
        status: "canceled",
        error:
          row.error ??
          `superseded by later successful project start ${targetOpId}`,
      });
      if (updated) {
        await publishLroSummary({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
        });
      }
    } catch (err) {
      log.warn("unable to supersede older project-start lro", {
        project_id,
        old_op_id: row.op_id,
        keep_op_id: targetOpId,
        err: `${err}`,
      });
    }
  }
}
