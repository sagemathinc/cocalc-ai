/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

type ProjectRehomeFenceOptions = {
  db: Queryable;
  project_id: string;
  action?: string;
};

const PROJECT_REHOME_OPERATIONS_TABLE = "project_rehome_operations";
const COLLABORATION_TRANSFERS_TABLE = "project_collaboration_rehome_transfers";

export class ProjectRehomeInProgressError extends Error {}

export async function lockProjectRehomeFence({
  db,
  project_id,
}: {
  db: Queryable;
  project_id: string;
}): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    ["project-rehome", project_id],
  );
}

async function projectRehomeTables(
  db: Queryable,
): Promise<{ operations: boolean; collaboration: boolean }> {
  const { rows } = await db.query(
    `SELECT to_regclass('public.${PROJECT_REHOME_OPERATIONS_TABLE}') AS table_name,
      to_regclass('public.${COLLABORATION_TRANSFERS_TABLE}') AS collaboration_table_name`,
  );
  return {
    operations: rows[0]?.table_name != null,
    collaboration: rows[0]?.collaboration_table_name != null,
  };
}

export async function assertProjectNotRehoming({
  db,
  project_id,
  action = "modify project metadata",
}: ProjectRehomeFenceOptions): Promise<void> {
  await lockProjectRehomeFence({ db, project_id });
  const tables = await projectRehomeTables(db);
  const { rows } = tables.operations
    ? await db.query(
        `
      SELECT op_id, source_bay_id, dest_bay_id, stage
        FROM ${PROJECT_REHOME_OPERATIONS_TABLE}
       WHERE project_id = $1
         AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1
    `,
        [project_id],
      )
    : { rows: [] };
  const active = rows[0];
  if (active)
    throw new ProjectRehomeInProgressError(
      `cannot ${action} for project ${project_id}; project rehome ${active.op_id} is running from ${active.source_bay_id} to ${active.dest_bay_id} at stage ${active.stage}`,
    );
  if (tables.collaboration) {
    // A failed source operation still owns its immutable snapshot. Likewise,
    // destination staging is not authority to serve incomplete catalog state.
    const { rows: transfers } = await db.query(
      `SELECT op_id FROM ${COLLABORATION_TRANSFERS_TABLE} WHERE project_id=$1
       AND ((direction='export' AND state IN ('exporting','exported'))
         OR (direction='import' AND state IN ('staging','ready'))) LIMIT 1`,
      [project_id],
    );
    if (transfers.length)
      throw new ProjectRehomeInProgressError(
        `cannot ${action} for project ${project_id}; collaboration handoff ${transfers[0].op_id} is frozen`,
      );
  }
}

export async function withProjectRehomeWriteFence<T>({
  project_id,
  action,
  fn,
}: {
  project_id: string;
  action?: string;
  fn: (db: Queryable) => Promise<T>;
}): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({ db: client, project_id, action });
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
