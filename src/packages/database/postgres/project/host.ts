/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "../project-events-outbox";
import type { PostgreSQL } from "../types";

export interface SetProjectHostOptions {
  project_id: string;
  host_id: string;
}

export async function setProjectHost(
  _db: PostgreSQL,
  opts: SetProjectHostOptions,
): Promise<Date> {
  const assigned = new Date();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET host_id = $2
        WHERE project_id = $1::UUID`,
      [opts.project_id, opts.host_id],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.host_changed",
      project_id: opts.project_id,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return assigned;
}

export interface UnsetProjectHostOptions {
  project_id: string;
}

export async function unsetProjectHost(
  _db: PostgreSQL,
  opts: UnsetProjectHostOptions,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET host_id = NULL
        WHERE project_id = $1::UUID`,
      [opts.project_id],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.host_changed",
      project_id: opts.project_id,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface GetProjectHostOptions {
  project_id: string;
}

export async function getProjectHost(
  db: PostgreSQL,
  opts: GetProjectHostOptions,
): Promise<string | undefined> {
  const { rows } = await db.async_query({
    query: "SELECT host_id FROM projects",
    where: { "project_id :: UUID = $": opts.project_id },
  });

  if (!rows || rows.length === 0) {
    return undefined;
  }

  const host = rows[0].host_id;
  // SQL returns null for missing values, but we want undefined
  return host ?? undefined;
}
