/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

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
  host_id: string | null;
  owning_bay_id: string;
  is_hidden: boolean;
  sort_key: Date | null;
  updated_at: Date | null;
}

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

export async function listProjectedProjectsForAccount(opts: {
  account_id: string;
  limit?: number;
  project_id?: string;
  title?: string;
  host_id?: string | null;
  include_hidden?: boolean;
}): Promise<AccountProjectIndexProjectListRow[]> {
  const account_id = normalizeAccountId(opts.account_id);
  const limit = normalizeLimit(opts.limit);
  const where: string[] = ["account_id = $1::UUID"];
  const params: any[] = [account_id];
  let i = params.length;
  if (!opts.include_hidden) {
    where.push("COALESCE(is_hidden, FALSE) IS NOT TRUE");
  }
  if (opts.project_id != null) {
    i += 1;
    where.push(`project_id = $${i}::UUID`);
    params.push(normalizeUuid(opts.project_id, "project id"));
  }
  if (opts.title != null) {
    i += 1;
    where.push(`title = $${i}::TEXT`);
    params.push(`${opts.title}`);
  }
  if (opts.host_id !== undefined) {
    i += 1;
    if (opts.host_id == null) {
      where.push("host_id IS NULL");
    } else {
      where.push(`host_id = $${i}::UUID`);
      params.push(normalizeUuid(opts.host_id, "host id"));
    }
  }
  i += 1;
  params.push(limit);
  const { rows } = await getPool().query<AccountProjectIndexProjectListRow>(
    `SELECT
       project_id,
       COALESCE(title, '') AS title,
       COALESCE(description, '') AS description,
       host_id,
       COALESCE(NULLIF(BTRIM(owning_bay_id), ''), 'bay-0') AS owning_bay_id,
       COALESCE(is_hidden, FALSE) AS is_hidden,
       sort_key,
       updated_at
     FROM account_project_index
     WHERE ${where.join(" AND ")}
     ORDER BY sort_key DESC NULLS LAST, updated_at DESC NULLS LAST, project_id ASC
     LIMIT $${i}`,
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
          WHERE NOT COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          )
        )::TEXT AS visible_rows,
        COUNT(*) FILTER (
          WHERE COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          )
        )::TEXT AS hidden_rows
      FROM projects
      WHERE deleted IS NOT TRUE
        AND users ? $1::TEXT`,
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
    const deleted = await client.query(
      `DELETE FROM account_project_index
        WHERE account_id = $1`,
      [account_id],
    );
    const inserted = await client.query(
      `INSERT INTO account_project_index (
          account_id,
          project_id,
          owning_bay_id,
          host_id,
          title,
          description,
          users_summary,
          state_summary,
          last_activity_at,
          last_opened_at,
          is_hidden,
          sort_key,
          updated_at
        )
        SELECT
          $1::UUID AS account_id,
          project_id,
          COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $2::TEXT) AS owning_bay_id,
          host_id,
          COALESCE(title, '') AS title,
          COALESCE(description, '') AS description,
          COALESCE(users, '{}'::JSONB) AS users_summary,
          COALESCE(state, '{}'::JSONB) AS state_summary,
          (last_active #>> ARRAY[$1::TEXT]::TEXT[])::TIMESTAMP AS last_activity_at,
          NULL::TIMESTAMP AS last_opened_at,
          COALESCE(
            (users #>> ARRAY[$1::TEXT, 'hide']::TEXT[])::BOOLEAN,
            FALSE
          ) AS is_hidden,
          COALESCE(
            (last_active #>> ARRAY[$1::TEXT]::TEXT[])::TIMESTAMP,
            last_edited,
            created,
            NOW()
          ) AS sort_key,
          NOW() AS updated_at
        FROM projects
        WHERE deleted IS NOT TRUE
          AND users ? $1::TEXT`,
      [account_id, bay_id],
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
