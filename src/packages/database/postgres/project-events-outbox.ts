/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const DEFAULT_SINGLE_BAY_ID = "bay-0";

export type ProjectOutboxEventType =
  | "project.created"
  | "project.summary_changed"
  | "project.membership_changed"
  | "project.state_changed"
  | "project.host_changed"
  | "project.deleted";

export interface ProjectOutboxPayload {
  project_id: string;
  owning_bay_id: string;
  host_id: string | null;
  title: string;
  description: string;
  name: string | null;
  avatar_image_tiny: string | null;
  color: string | null;
  users_summary: Record<string, any>;
  state_summary: Record<string, any>;
  last_activity_by_account: Record<string, any>;
  created_at: string | null;
  last_edited_at: string | null;
  deleted: boolean;
}

export interface ProjectOutboxEventRow {
  event_id: string;
  project_id: string;
  owning_bay_id: string;
  event_type: ProjectOutboxEventType;
  payload_json: ProjectOutboxPayload;
  created_at: Date;
  published_at: Date | null;
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function queryable(db?: Queryable): Queryable {
  return db ?? getPool();
}

function normalizeProjectId(project_id: string): string {
  const value = `${project_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw Error(`invalid project id '${project_id ?? ""}'`);
  }
  return value;
}

function normalizeBayId(value?: string | null): string {
  const bay_id = `${value ?? ""}`.trim();
  return bay_id || DEFAULT_SINGLE_BAY_ID;
}

function isoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export async function loadProjectOutboxPayload(opts: {
  project_id: string;
  db?: Queryable;
  default_bay_id?: string;
}): Promise<ProjectOutboxPayload> {
  const project_id = normalizeProjectId(opts.project_id);
  const db = queryable(opts.db);
  const default_bay_id = normalizeBayId(opts.default_bay_id);
  const result = await db.query(
    `SELECT
       project_id,
       COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $2::TEXT) AS owning_bay_id,
       host_id,
       COALESCE(title, '') AS title,
       COALESCE(description, '') AS description,
       name,
       avatar_image_tiny,
       color,
       COALESCE(users, '{}'::JSONB) AS users_summary,
       COALESCE(state, '{}'::JSONB) AS state_summary,
       COALESCE(last_active, '{}'::JSONB) AS last_activity_by_account,
       created AS created_at,
       last_edited AS last_edited_at,
       COALESCE(deleted, FALSE) AS deleted
     FROM projects
     WHERE project_id = $1
     LIMIT 1`,
    [project_id, default_bay_id],
  );
  const { rows } = result as {
    rows: Array<{
      project_id: string;
      owning_bay_id: string | null;
      host_id: string | null;
      title: string | null;
      description: string | null;
      name: string | null;
      avatar_image_tiny: string | null;
      color: string | null;
      users_summary: Record<string, any> | null;
      state_summary: Record<string, any> | null;
      last_activity_by_account: Record<string, any> | null;
      created_at: Date | null;
      last_edited_at: Date | null;
      deleted: boolean | null;
    }>;
  };
  const row = rows[0];
  if (!row) {
    throw Error(`project '${project_id}' not found`);
  }
  return {
    project_id,
    owning_bay_id: normalizeBayId(row.owning_bay_id ?? default_bay_id),
    host_id: row.host_id ?? null,
    title: row.title ?? "",
    description: row.description ?? "",
    name: row.name ?? null,
    avatar_image_tiny: row.avatar_image_tiny ?? null,
    color: row.color ?? null,
    users_summary: row.users_summary ?? {},
    state_summary: row.state_summary ?? {},
    last_activity_by_account: row.last_activity_by_account ?? {},
    created_at: isoString(row.created_at),
    last_edited_at: isoString(row.last_edited_at),
    deleted: !!row.deleted,
  };
}

export async function appendProjectOutboxEvent(opts: {
  event_type: ProjectOutboxEventType;
  payload: ProjectOutboxPayload;
  db?: Queryable;
}): Promise<string> {
  const db = queryable(opts.db);
  const result = await db.query(
    `INSERT INTO project_events_outbox
       (event_id, project_id, owning_bay_id, event_type, payload_json, created_at, published_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4::JSONB, NOW(), NULL)
     RETURNING event_id`,
    [
      opts.payload.project_id,
      normalizeBayId(opts.payload.owning_bay_id),
      opts.event_type,
      JSON.stringify(opts.payload),
    ],
  );
  const { rows } = result as { rows: Array<{ event_id: string }> };
  const event_id = `${rows[0]?.event_id ?? ""}`.trim();
  if (!event_id) {
    throw Error("failed to create project outbox event");
  }
  return event_id;
}

export async function appendProjectOutboxEventForProject(opts: {
  event_type: ProjectOutboxEventType;
  project_id: string;
  db?: Queryable;
  default_bay_id?: string;
}): Promise<string> {
  const payload = await loadProjectOutboxPayload({
    project_id: opts.project_id,
    db: opts.db,
    default_bay_id: opts.default_bay_id,
  });
  return await appendProjectOutboxEvent({
    event_type: opts.event_type,
    payload,
    db: opts.db,
  });
}
