/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const VISIBLE_PROJECT_GROUP_SQL = `COALESCE(
  users #>> ARRAY[$1::TEXT, 'group']::TEXT[],
  ''
) IN ('owner', 'collaborator', 'viewer')`;

export interface RebuildAccountProjectIndexResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_rows: number;
  visible_rows: number;
  hidden_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountProjectIndexProjectListRow {
  project_id: string;
  title: string;
  description: string;
  theme: Record<string, any> | null;
  labels: Record<string, string>;
  host_id: string | null;
  rootfs_image_id: string | null;
  owning_bay_id: string;
  is_hidden: boolean;
  deletion_protection: boolean;
  state_summary: Record<string, any>;
  users_summary: Record<string, any>;
  last_activity_at: Date | null;
  last_edited: Date | null;
  last_backup: Date | null;
  sort_key: Date | null;
  updated_at: Date | null;
}

export type AccountProjectIndexProjectListSort =
  | "last_edited"
  | "title"
  | "state";

function normalizeBayId(raw?: string): string {
  const bay_id = `${raw ?? ""}`.trim();
  if (!bay_id) {
    throw Error("bay_id is required");
  }
  return bay_id;
}

function normalizeUuid(raw: string | undefined, label: string): string {
  const value = `${raw ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw Error(`invalid ${label} '${raw ?? ""}'`);
  }
  return value;
}

function normalizeAccountId(raw?: string): string {
  return normalizeUuid(raw, "account id");
}

function normalizeLimit(raw?: number): number {
  const limit = raw ?? 50;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return limit;
}

function normalizeOffset(raw?: number): number {
  const offset = raw ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw Error("offset must be a nonnegative integer");
  }
  return offset;
}

function normalizeSearch(raw?: string): string | undefined {
  const search = `${raw ?? ""}`.trim();
  return search ? search : undefined;
}

function normalizeSort(
  raw?: AccountProjectIndexProjectListSort,
): AccountProjectIndexProjectListSort {
  switch (raw) {
    case "title":
    case "state":
    case "last_edited":
    case undefined:
      return raw ?? "last_edited";
    default:
      throw Error(`unsupported project list sort '${raw}'`);
  }
}

function orderBySql(sort: AccountProjectIndexProjectListSort): string {
  switch (sort) {
    case "title":
      return "LOWER(COALESCE(account_project_index.title, '')) ASC, account_project_index.sort_key DESC NULLS LAST, account_project_index.project_id ASC";
    case "state":
      return "LOWER(COALESCE(account_project_index.state_summary->>'state', '')) ASC, account_project_index.sort_key DESC NULLS LAST, account_project_index.project_id ASC";
    case "last_edited":
      return "account_project_index.sort_key DESC NULLS LAST, account_project_index.updated_at DESC NULLS LAST, account_project_index.project_id ASC";
  }
}

export async function listProjectedProjectsForAccount(opts: {
  account_id: string;
  limit?: number;
  offset?: number;
  project_id?: string;
  title?: string;
  host_id?: string | null;
  include_hidden?: boolean;
  search?: string;
  sort?: AccountProjectIndexProjectListSort;
}): Promise<AccountProjectIndexProjectListRow[]> {
  const account_id = normalizeAccountId(opts.account_id);
  const limit = normalizeLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  const search = normalizeSearch(opts.search);
  const sort = normalizeSort(opts.sort);
  const where: string[] = ["account_project_index.account_id = $1::UUID"];
  const params: any[] = [account_id];
  let i = params.length;
  if (!opts.include_hidden) {
    where.push("COALESCE(account_project_index.is_hidden, FALSE) IS NOT TRUE");
  }
  if (opts.project_id != null) {
    i += 1;
    where.push(`account_project_index.project_id = $${i}::UUID`);
    params.push(normalizeUuid(opts.project_id, "project id"));
  }
  if (opts.title != null) {
    i += 1;
    where.push(`account_project_index.title = $${i}::TEXT`);
    params.push(`${opts.title}`);
  }
  if (opts.host_id !== undefined) {
    i += 1;
    if (opts.host_id == null) {
      where.push("account_project_index.host_id IS NULL");
    } else {
      where.push(`account_project_index.host_id = $${i}::UUID`);
      params.push(normalizeUuid(opts.host_id, "host id"));
    }
  }
  if (search != null) {
    for (const word of search.split(/\s+/)) {
      const pattern = `%${word.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      i += 1;
      where.push(
        `(account_project_index.title ILIKE $${i} ESCAPE '\\' OR account_project_index.description ILIKE $${i} ESCAPE '\\' OR account_project_index.labels::TEXT ILIKE $${i} ESCAPE '\\' OR account_project_index.rootfs_image_id ILIKE $${i} ESCAPE '\\' OR account_project_index.state_summary->>'state' ILIKE $${i} ESCAPE '\\' OR rootfs_images.label ILIKE $${i} ESCAPE '\\' OR rootfs_images.version ILIKE $${i} ESCAPE '\\' OR rootfs_images.family ILIKE $${i} ESCAPE '\\')`,
      );
      params.push(pattern);
    }
  }
  i += 1;
  params.push(limit);
  i += 1;
  params.push(offset);
  const { rows } = await getPool().query<AccountProjectIndexProjectListRow>(
    `SELECT
       account_project_index.project_id,
       COALESCE(account_project_index.title, '') AS title,
       COALESCE(account_project_index.description, '') AS description,
       account_project_index.theme,
       COALESCE(account_project_index.labels, '{}'::JSONB) AS labels,
       account_project_index.host_id,
       account_project_index.rootfs_image_id,
       COALESCE(NULLIF(BTRIM(account_project_index.owning_bay_id), ''), 'bay-0') AS owning_bay_id,
       COALESCE(account_project_index.is_hidden, FALSE) AS is_hidden,
       COALESCE(account_project_index.deletion_protection, FALSE) AS deletion_protection,
       COALESCE(account_project_index.state_summary, '{}'::JSONB) AS state_summary,
       COALESCE(account_project_index.users_summary, '{}'::JSONB) AS users_summary,
       account_project_index.last_activity_at,
       account_project_index.last_edited,
       account_project_index.last_backup,
       account_project_index.sort_key,
       account_project_index.updated_at
     FROM account_project_index
     LEFT JOIN rootfs_images ON rootfs_images.image_id = account_project_index.rootfs_image_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBySql(sort)}
     LIMIT $${i - 1}
     OFFSET $${i}`,
    params,
  );
  return rows;
}

async function assertAccountIsHomedLocally(opts: {
  account_id: string;
  bay_id: string;
}): Promise<void> {
  const { rows } = await getPool().query<{
    account_id: string;
    home_bay_id: string;
  }>(
    `SELECT
        account_id,
        COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) AS home_bay_id
       FROM accounts
      WHERE account_id = $1
        AND (deleted IS NULL OR deleted = FALSE)
      LIMIT 1`,
    [opts.account_id, opts.bay_id],
  );
  const row = rows[0];
  if (!row?.account_id) {
    throw Error(`account '${opts.account_id}' not found`);
  }
  if (row.home_bay_id !== opts.bay_id) {
    throw Error(
      `account '${opts.account_id}' is not homed in bay '${opts.bay_id}'`,
    );
  }
}

async function getExistingRowCount(account_id: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM account_project_index
      WHERE account_id = $1`,
    [account_id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function getSourceCounts(account_id: string): Promise<{
  source_rows: number;
  visible_rows: number;
  hidden_rows: number;
}> {
  const { rows } = await getPool().query<{
    source_rows: string;
    visible_rows: string;
    hidden_rows: string;
  }>(
    `SELECT
        COUNT(*)::TEXT AS source_rows,
        COUNT(*) FILTER (
          WHERE ${VISIBLE_PROJECT_GROUP_SQL}
            AND NOT COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          )
        )::TEXT AS visible_rows,
        COUNT(*) FILTER (
          WHERE ${VISIBLE_PROJECT_GROUP_SQL}
            AND COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          )
        )::TEXT AS hidden_rows
      FROM projects
      WHERE deleted IS NOT TRUE
        AND users ? $1::TEXT
        AND ${VISIBLE_PROJECT_GROUP_SQL}`,
    [account_id],
  );
  return {
    source_rows: Number(rows[0]?.source_rows ?? 0),
    visible_rows: Number(rows[0]?.visible_rows ?? 0),
    hidden_rows: Number(rows[0]?.hidden_rows ?? 0),
  };
}

export async function rebuildAccountProjectIndex(opts: {
  account_id: string;
  bay_id: string;
  dry_run?: boolean;
}): Promise<RebuildAccountProjectIndexResult> {
  const account_id = normalizeAccountId(opts.account_id);
  const bay_id = normalizeBayId(opts.bay_id);
  const dry_run = opts.dry_run ?? true;

  await assertAccountIsHomedLocally({ account_id, bay_id });
  const existing_rows = await getExistingRowCount(account_id);
  const { source_rows, visible_rows, hidden_rows } =
    await getSourceCounts(account_id);

  if (dry_run) {
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: true,
      existing_rows,
      source_rows,
      visible_rows,
      hidden_rows,
      deleted_rows: 0,
      inserted_rows: 0,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const preservedRows = await client.query<{
      project_id: string;
      last_opened_at: Date | null;
    }>(
      `SELECT project_id, last_opened_at
         FROM account_project_index
        WHERE account_id = $1`,
      [account_id],
    );
    const preservedLastOpenedAt = new Map(
      preservedRows.rows.map((row) => [row.project_id, row.last_opened_at]),
    );
    const deleted = await client.query(
      `DELETE FROM account_project_index
        WHERE account_id = $1`,
      [account_id],
    );
    const inserted = await client.query(
      `WITH previous_rows(project_id, last_opened_at) AS (
         SELECT * FROM unnest($4::UUID[], $3::TIMESTAMP[])
       )
       INSERT INTO account_project_index (
          account_id,
          project_id,
          owning_bay_id,
          host_id,
          rootfs_image_id,
          title,
          description,
          theme,
          labels,
          users_summary,
          state_summary,
          last_edited,
          last_backup,
          last_activity_at,
          last_opened_at,
          is_hidden,
          deletion_protection,
          sort_key,
          updated_at
        )
        SELECT
          $1::UUID AS account_id,
          project_id,
          COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $2::TEXT) AS owning_bay_id,
          host_id,
          rootfs_image_id,
          COALESCE(title, '') AS title,
          COALESCE(description, '') AS description,
          COALESCE(theme, '{}'::JSONB) AS theme,
          COALESCE((
            SELECT jsonb_object_agg(project_labels.key, project_labels.value ORDER BY project_labels.key)
            FROM project_labels
            WHERE project_labels.project_id = projects.project_id
          ), '{}'::JSONB) AS labels,
          COALESCE(users, '{}'::JSONB) AS users_summary,
          COALESCE(state, '{}'::JSONB) AS state_summary,
          last_edited,
          last_backup,
          (last_active #>> ARRAY[$1::TEXT]::TEXT[])::TIMESTAMP AS last_activity_at,
          previous_rows.last_opened_at,
          COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          ) AS is_hidden,
          COALESCE(deletion_protection, FALSE) AS deletion_protection,
          COALESCE(
            (last_active #>> ARRAY[$1::TEXT]::TEXT[])::TIMESTAMP,
            last_edited,
            created,
            NOW()
          ) AS sort_key,
          NOW() AS updated_at
        FROM projects
        LEFT JOIN previous_rows USING (project_id)
        WHERE deleted IS NOT TRUE
          AND users ? $1::TEXT
          AND ${VISIBLE_PROJECT_GROUP_SQL}`,
      [
        account_id,
        bay_id,
        Array.from(preservedLastOpenedAt.values()),
        Array.from(preservedLastOpenedAt.keys()),
      ],
    );
    await client.query("COMMIT");
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: false,
      existing_rows,
      source_rows,
      visible_rows,
      hidden_rows,
      deleted_rows: deleted.rowCount ?? 0,
      inserted_rows: inserted.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
