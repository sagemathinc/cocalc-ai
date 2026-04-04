/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { validateOpts } from "./utils";
import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "../project-events-outbox";
import type { PostgreSQL } from "../types";

export interface AddUserToProjectOptions {
  project_id: string;
  account_id: string;
  group?: string; // defaults to 'collaborator'
}

export async function addUserToProject(
  _db: PostgreSQL,
  opts: AddUserToProjectOptions,
): Promise<void> {
  // Validate inputs
  validateOpts(opts);

  const group = opts.group ?? "collaborator";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET users = COALESCE(users, '{}'::JSONB) || $2::JSONB
        WHERE project_id = $1::UUID`,
      [
        opts.project_id,
        JSON.stringify({
          [opts.account_id]: {
            group,
          },
        }),
      ],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
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

export interface RemoveCollaboratorFromProjectOptions {
  project_id: string;
  account_id: string;
}

export async function removeCollaboratorFromProject(
  _db: PostgreSQL,
  opts: RemoveCollaboratorFromProjectOptions,
): Promise<void> {
  // Validate inputs
  validateOpts(opts);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET users = COALESCE(users, '{}'::JSONB) - $2::TEXT
        WHERE project_id = $1::UUID
          AND users #>> ARRAY[$2::TEXT, 'group'] != $3::TEXT`,
      [opts.project_id, opts.account_id, "owner"],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
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

export interface RemoveUserFromProjectOptions {
  project_id: string;
  account_id: string;
}

export async function removeUserFromProject(
  _db: PostgreSQL,
  opts: RemoveUserFromProjectOptions,
): Promise<void> {
  // Validate inputs
  validateOpts(opts);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET users = COALESCE(users, '{}'::JSONB) - $2::TEXT
        WHERE project_id = $1::UUID`,
      [opts.project_id, opts.account_id],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.membership_changed",
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
