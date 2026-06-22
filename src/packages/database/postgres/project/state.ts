/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COMPUTE_STATES } from "@cocalc/util/schema";
import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "../project-events-outbox";
import type { PostgreSQL } from "../types";

export interface SetProjectStorageRequestOptions {
  project_id: string;
  action: string; // 'save', 'close', 'open', 'move'
  target?: string; // needed for 'open' and 'move'
}

export async function setProjectStorageRequest(
  db: PostgreSQL,
  opts: SetProjectStorageRequestOptions,
): Promise<void> {
  const x: any = {
    action: opts.action,
    requested: new Date(),
  };

  if (opts.target != null) {
    x.target = opts.target;
  }

  await db.async_query({
    query: "UPDATE projects",
    set: { "storage_request::JSONB": x },
    where: { "project_id :: UUID = $": opts.project_id },
  });
}

export interface GetProjectStorageRequestOptions {
  project_id: string;
}

export async function getProjectStorageRequest(
  db: PostgreSQL,
  opts: GetProjectStorageRequestOptions,
): Promise<any> {
  return await new Promise((resolve, reject) => {
    db._get_project_column(
      "storage_request",
      opts.project_id,
      (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      },
    );
  });
}

export interface SetProjectStateOptions {
  project_id: string;
  state: string;
  time?: Date;
  error?: string;
  ip?: string; // optional ip address
  runtime_started?: boolean;
}

export async function setProjectState(
  _db: PostgreSQL,
  opts: SetProjectStateOptions,
): Promise<void> {
  // Validate state type
  if (typeof opts.state !== "string") {
    throw new Error("invalid state type");
  }

  // Validate state value
  if (!COMPUTE_STATES[opts.state]) {
    throw new Error(`state = '${opts.state}' it not a valid state`);
  }

  const state: any = {
    state: opts.state,
    time: opts.time ?? new Date(),
  };

  if (opts.error) {
    state.error = opts.error;
  }

  if (opts.ip) {
    state.ip = opts.ip;
  }
  const runtimeStarted =
    opts.runtime_started === true && opts.state === "running";
  const startedAt = runtimeStarted
    ? (opts.time ?? new Date()).toISOString()
    : undefined;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE projects
          SET state = $2::jsonb || CASE
            WHEN $3::boolean THEN jsonb_build_object(
              'runtime_generation',
              CASE
                WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                  THEN (state->>'runtime_generation')::bigint + 1
                ELSE 1
              END,
              'started_at',
              $4::text
            )
            ELSE jsonb_strip_nulls(jsonb_build_object(
              'runtime_generation',
              CASE
                WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                  THEN (state->>'runtime_generation')::bigint
                ELSE NULL
              END,
              'started_at',
              state->>'started_at'
            ))
          END
        WHERE project_id = $1::UUID`,
      [opts.project_id, JSON.stringify(state), runtimeStarted, startedAt],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
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

export interface GetProjectStateOptions {
  project_id: string;
}

export async function getProjectState(
  db: PostgreSQL,
  opts: GetProjectStateOptions,
): Promise<any> {
  return await new Promise((resolve, reject) => {
    db._get_project_column("state", opts.project_id, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}
