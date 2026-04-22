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

async function projectRehomeOperationsTableExists(
  db: Queryable,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT to_regclass('public.${PROJECT_REHOME_OPERATIONS_TABLE}') AS table_name`,
  );
  return rows[0]?.table_name != null;
}

export async function assertProjectNotRehoming({
  db,
  project_id,
  action = "modify project metadata",
}: ProjectRehomeFenceOptions): Promise<void> {
  await lockProjectRehomeFence({ db, project_id });
  if (!(await projectRehomeOperationsTableExists(db))) {
    return;
  }
  const { rows } = await db.query(
    `
      SELECT op_id, source_bay_id, dest_bay_id, stage
        FROM ${PROJECT_REHOME_OPERATIONS_TABLE}
       WHERE project_id = $1
         AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1
    `,
    [project_id],
  );
  const active = rows[0];
  if (!active) return;
  throw new Error(
    `cannot ${action} for project ${project_id}; project rehome ${active.op_id} is running from ${active.source_bay_id} to ${active.dest_bay_id} at stage ${active.stage}`,
  );
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
