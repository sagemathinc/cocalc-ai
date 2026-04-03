/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { BayOwnershipBackfillResult } from "@cocalc/conat/hub/api/system";

function normalizeBayId(raw: string | undefined): string {
  const bay_id = `${raw ?? ""}`.trim();
  if (!bay_id) {
    return getConfiguredBayId();
  }
  return bay_id;
}

function normalizePositiveIntegerOrNull(
  raw: number | undefined,
  field: string,
): number | null {
  if (raw == null) return null;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw Error(`${field} must be a positive integer`);
  }
  return raw;
}

async function countMissingBayOwnership(opts: {
  table: "accounts" | "projects" | "project_hosts";
  field: "home_bay_id" | "owning_bay_id" | "bay_id";
  activeWhere: string;
}): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM ${opts.table}
      WHERE ${opts.activeWhere}
        AND (${opts.field} IS NULL OR BTRIM(${opts.field}) = '')`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function backfillMissingBayOwnership(opts: {
  table: "accounts" | "projects" | "project_hosts";
  field: "home_bay_id" | "owning_bay_id" | "bay_id";
  primaryKey: "account_id" | "project_id" | "id";
  activeWhere: string;
  bay_id: string;
  limit_per_table: number | null;
}): Promise<number> {
  const { table, field, primaryKey, activeWhere, bay_id, limit_per_table } =
    opts;
  if (limit_per_table == null) {
    const { rowCount } = await getPool().query(
      `UPDATE ${table}
          SET ${field}=$1::TEXT
        WHERE ${activeWhere}
          AND (${field} IS NULL OR BTRIM(${field}) = '')`,
      [bay_id],
    );
    return rowCount ?? 0;
  }
  const { rows } = await getPool().query<{ [key: string]: string }>(
    `WITH targets AS (
        SELECT ${primaryKey}
          FROM ${table}
         WHERE ${activeWhere}
           AND (${field} IS NULL OR BTRIM(${field}) = '')
         ORDER BY ${primaryKey}
         LIMIT $2
      )
      UPDATE ${table} t
         SET ${field}=$1::TEXT
        FROM targets
       WHERE t.${primaryKey} = targets.${primaryKey}
      RETURNING t.${primaryKey}`,
    [bay_id, limit_per_table],
  );
  return rows.length;
}

export async function backfillBayOwnership(opts: {
  bay_id?: string;
  dry_run?: boolean;
  limit_per_table?: number;
}): Promise<BayOwnershipBackfillResult> {
  const { bay_id, dry_run = true, limit_per_table } = opts;
  const resolvedBayId = normalizeBayId(bay_id);
  const normalizedLimit = normalizePositiveIntegerOrNull(
    limit_per_table,
    "limit_per_table",
  );
  const accounts_missing = await countMissingBayOwnership({
    table: "accounts",
    field: "home_bay_id",
    activeWhere: "(deleted IS NULL OR deleted = FALSE)",
  });
  const projects_missing = await countMissingBayOwnership({
    table: "projects",
    field: "owning_bay_id",
    activeWhere: "deleted IS NOT TRUE",
  });
  const hosts_missing = await countMissingBayOwnership({
    table: "project_hosts",
    field: "bay_id",
    activeWhere: "deleted IS NULL",
  });
  if (dry_run) {
    return {
      bay_id: resolvedBayId,
      dry_run: true,
      limit_per_table: normalizedLimit,
      accounts_missing,
      projects_missing,
      hosts_missing,
      accounts_updated: 0,
      projects_updated: 0,
      hosts_updated: 0,
    };
  }
  const accounts_updated = await backfillMissingBayOwnership({
    table: "accounts",
    field: "home_bay_id",
    primaryKey: "account_id",
    activeWhere: "(deleted IS NULL OR deleted = FALSE)",
    bay_id: resolvedBayId,
    limit_per_table: normalizedLimit,
  });
  const projects_updated = await backfillMissingBayOwnership({
    table: "projects",
    field: "owning_bay_id",
    primaryKey: "project_id",
    activeWhere: "deleted IS NOT TRUE",
    bay_id: resolvedBayId,
    limit_per_table: normalizedLimit,
  });
  const hosts_updated = await backfillMissingBayOwnership({
    table: "project_hosts",
    field: "bay_id",
    primaryKey: "id",
    activeWhere: "deleted IS NULL",
    bay_id: resolvedBayId,
    limit_per_table: normalizedLimit,
  });
  return {
    bay_id: resolvedBayId,
    dry_run: false,
    limit_per_table: normalizedLimit,
    accounts_missing,
    projects_missing,
    hosts_missing,
    accounts_updated,
    projects_updated,
    hosts_updated,
  };
}
