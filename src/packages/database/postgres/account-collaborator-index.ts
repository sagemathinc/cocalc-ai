/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

export interface RebuildAccountCollaboratorIndexResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_project_rows: number;
  source_collaborator_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountCollaboratorIndexRow {
  collaborator_account_id: string;
  common_project_count: number;
  display_name: string;
  avatar_ref: string | null;
  updated_at: Date | null;
}

export interface ProjectedMyCollaboratorRow {
  account_id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email_address: string | null;
  last_active: Date | null;
  shared_projects: number;
}

export interface ReplaceAccountCollaboratorIndexRowsResult {
  deleted_rows: number;
  inserted_rows: number;
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

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
  const limit = raw ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return limit;
}

export async function listProjectedCollaboratorsForAccount(opts: {
  account_id: string;
  limit?: number;
  collaborator_account_id?: string;
}): Promise<AccountCollaboratorIndexRow[]> {
  const account_id = normalizeAccountId(opts.account_id);
  const limit = normalizeLimit(opts.limit);
  const where: string[] = ["account_id = $1::UUID"];
  const params: any[] = [account_id];
  let i = params.length;
  if (opts.collaborator_account_id != null) {
    i += 1;
    where.push(`collaborator_account_id = $${i}::UUID`);
    params.push(
      normalizeUuid(opts.collaborator_account_id, "collaborator account id"),
    );
  }
  i += 1;
  params.push(limit);
  const { rows } = await getPool().query<AccountCollaboratorIndexRow>(
    `SELECT
       collaborator_account_id,
       common_project_count,
       display_name,
       avatar_ref,
       updated_at
     FROM account_collaborator_index
     WHERE ${where.join(" AND ")}
     ORDER BY common_project_count DESC, display_name ASC, collaborator_account_id ASC
     LIMIT $${i}`,
    params,
  );
  return rows;
}

export async function listProjectedMyCollaboratorsForAccount(opts: {
  account_id: string;
  limit?: number;
  include_email?: boolean;
}): Promise<ProjectedMyCollaboratorRow[]> {
  const account_id = normalizeAccountId(opts.account_id);
  const limit = normalizeLimit(opts.limit);
  const include_email = opts.include_email ?? false;
  const { rows } = await getPool().query<ProjectedMyCollaboratorRow>(
    `SELECT
       aci.collaborator_account_id AS account_id,
       CASE
         WHEN a.account_id IS NULL OR a.deleted IS TRUE THEN aci.display_name
         ELSE COALESCE(NULLIF(BTRIM(a.name), ''), aci.display_name)
       END AS name,
       CASE
         WHEN a.account_id IS NULL OR a.deleted IS TRUE THEN NULL
         ELSE a.first_name
       END AS first_name,
       CASE
         WHEN a.account_id IS NULL OR a.deleted IS TRUE THEN NULL
         ELSE a.last_name
       END AS last_name,
       CASE
         WHEN $2::boolean AND a.account_id IS NOT NULL AND a.deleted IS NOT TRUE
           THEN a.email_address
         ELSE NULL
       END AS email_address,
       CASE
         WHEN a.account_id IS NULL OR a.deleted IS TRUE THEN NULL
         ELSE a.last_active
       END AS last_active,
       aci.common_project_count AS shared_projects
     FROM account_collaborator_index aci
     LEFT JOIN accounts a ON a.account_id = aci.collaborator_account_id
     WHERE aci.account_id = $1::UUID
       AND aci.collaborator_account_id <> $1::UUID
     ORDER BY
       aci.common_project_count DESC,
       COALESCE(a.last_active, aci.updated_at) DESC NULLS LAST,
       aci.collaborator_account_id ASC
     LIMIT $3`,
    [account_id, include_email, limit],
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
       FROM account_collaborator_index
      WHERE account_id = $1`,
    [account_id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function getSourceCounts(account_id: string): Promise<{
  source_project_rows: number;
  source_collaborator_rows: number;
}> {
  const { rows } = await getPool().query<{
    source_project_rows: string;
    source_collaborator_rows: string;
  }>(
    `WITH shared_projects AS (
        SELECT project_id, users
          FROM projects
         WHERE deleted IS NOT TRUE
           AND users ? $1::TEXT
      ),
      shared_collaborators AS (
        SELECT DISTINCT jsonb_object_keys(users)::UUID AS collaborator_account_id
          FROM shared_projects
      )
      SELECT
        (SELECT COUNT(*)::TEXT FROM shared_projects) AS source_project_rows,
        (SELECT COUNT(*)::TEXT FROM shared_collaborators) AS source_collaborator_rows`,
    [account_id],
  );
  return {
    source_project_rows: Number(rows[0]?.source_project_rows ?? 0),
    source_collaborator_rows: Number(rows[0]?.source_collaborator_rows ?? 0),
  };
}

export async function replaceAccountCollaboratorIndexRows(opts: {
  db: Queryable;
  account_id: string;
}): Promise<ReplaceAccountCollaboratorIndexRowsResult> {
  const account_id = normalizeAccountId(opts.account_id);
  const deleted = await opts.db.query(
    `DELETE FROM account_collaborator_index
      WHERE account_id = $1`,
    [account_id],
  );
  const inserted = await opts.db.query(
    `WITH shared AS (
        SELECT
          jsonb_object_keys(p.users)::UUID AS collaborator_account_id,
          COUNT(*)::INT AS common_project_count
        FROM projects p
        WHERE p.deleted IS NOT TRUE
          AND p.users ? $1::TEXT
        GROUP BY 1
      )
      INSERT INTO account_collaborator_index
        (account_id, collaborator_account_id, common_project_count, display_name, avatar_ref, updated_at)
      SELECT
        $1::UUID AS account_id,
        shared.collaborator_account_id,
        shared.common_project_count,
        CASE
          WHEN a.account_id IS NULL THEN 'Deleted User'
          ELSE COALESCE(
            NULLIF(
              BTRIM(
                CONCAT_WS(
                  ' ',
                  COALESCE(a.first_name, ''),
                  COALESCE(a.last_name, '')
                )
              ),
              ''
            ),
            'No Name'
          )
        END AS display_name,
        CASE
          WHEN a.account_id IS NULL THEN NULL
          ELSE NULLIF(BTRIM(a.profile ->> 'image'), '')
        END AS avatar_ref,
        NOW() AS updated_at
      FROM shared
      LEFT JOIN accounts a
        ON a.account_id = shared.collaborator_account_id
       AND (a.deleted IS NULL OR a.deleted = FALSE)
      ORDER BY
        shared.common_project_count DESC,
        display_name ASC,
        shared.collaborator_account_id ASC`,
    [account_id],
  );
  return {
    deleted_rows: deleted.rowCount ?? 0,
    inserted_rows: inserted.rowCount ?? 0,
  };
}

export async function rebuildAccountCollaboratorIndex(opts: {
  account_id: string;
  bay_id: string;
  dry_run?: boolean;
}): Promise<RebuildAccountCollaboratorIndexResult> {
  const account_id = normalizeAccountId(opts.account_id);
  const bay_id = normalizeBayId(opts.bay_id);
  const dry_run = opts.dry_run ?? true;

  await assertAccountIsHomedLocally({ account_id, bay_id });
  const existing_rows = await getExistingRowCount(account_id);
  const { source_project_rows, source_collaborator_rows } =
    await getSourceCounts(account_id);

  if (dry_run) {
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: true,
      existing_rows,
      source_project_rows,
      source_collaborator_rows,
      deleted_rows: 0,
      inserted_rows: 0,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { deleted_rows, inserted_rows } =
      await replaceAccountCollaboratorIndexRows({
        db: client,
        account_id,
      });
    await client.query("COMMIT");
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: false,
      existing_rows,
      source_project_rows,
      source_collaborator_rows,
      deleted_rows,
      inserted_rows,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
