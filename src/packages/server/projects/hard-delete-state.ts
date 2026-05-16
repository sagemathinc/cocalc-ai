/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ConatError } from "@cocalc/conat/core/client";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function db(opts?: { db?: Queryable }): Queryable {
  return opts?.db ?? getPool();
}

function assertUuid(value: string, label: string): void {
  if (!isValidUUID(value)) {
    throw new Error(`${label} must be a valid uuid`);
  }
}

export function projectHardDeleteInProgressMessage(): string {
  return "This project is being permanently deleted. It cannot be opened or started.";
}

export async function markProjectHardDeleteAccepted({
  project_id,
  op_id,
  db: queryDb,
}: {
  project_id: string;
  op_id: string;
  db?: Queryable;
}): Promise<boolean> {
  assertUuid(project_id, "project_id");
  assertUuid(op_id, "op_id");
  const { rowCount } = await db({ db: queryDb }).query(
    `
      UPDATE projects
         SET state = COALESCE(state, '{}'::jsonb) || jsonb_build_object(
           'state', 'deleting',
           'time', NOW(),
           'hard_delete_op_id', $2
         )
       WHERE project_id = $1
         AND deleted IS NOT TRUE
    `,
    [project_id, op_id],
  );
  return (rowCount ?? 0) > 0;
}

export async function markProjectHardDeleteFailed({
  project_id,
  op_id,
  error,
  db: queryDb,
}: {
  project_id: string;
  op_id: string;
  error: string;
  db?: Queryable;
}): Promise<boolean> {
  assertUuid(project_id, "project_id");
  assertUuid(op_id, "op_id");
  const { rowCount } = await db({ db: queryDb }).query(
    `
      UPDATE projects
         SET state = COALESCE(state, '{}'::jsonb) || jsonb_build_object(
           'state', 'delete_failed',
           'time', NOW(),
           'hard_delete_op_id', $2,
           'hard_delete_error', $3
         )
       WHERE project_id = $1
         AND deleted IS NOT TRUE
         AND state ->> 'hard_delete_op_id' = $2
    `,
    [project_id, op_id, error],
  );
  return (rowCount ?? 0) > 0;
}

export async function assertProjectNotHardDeleting({
  project_id,
  db: queryDb,
}: {
  project_id: string;
  db?: Queryable;
}): Promise<void> {
  const result = await db({ db: queryDb }).query(
    `
      SELECT state ->> 'state' AS state
        FROM projects
       WHERE project_id = $1
       LIMIT 1
    `,
    [project_id],
  );
  const rows = result?.rows ?? [];
  if (rows[0]?.state === "deleting") {
    throw new ConatError(projectHardDeleteInProgressMessage(), {
      code: "project_delete_in_progress",
    });
  }
}
