/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import searchLocalAccounts from "@cocalc/server/accounts/search";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { AccountDirectoryEntry } from "@cocalc/conat/inter-bay/api";
import {
  ADMIN_SEARCH_LIMIT,
  USER_SEARCH_LIMIT,
  type UserSearchResult,
} from "@cocalc/util/db-schema/accounts";
import {
  cmp,
  isValidUUID,
  is_valid_email_address as isValidEmailAddress,
  parse_user_search as parseUserSearch,
} from "@cocalc/util/misc";

const logger = getLogger("server:accounts:cluster-directory");

const TABLE = "cluster_account_directory";

function normalizedEmail(value: string): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function normalizedHomeBayId(value: string): string {
  return `${value ?? ""}`.trim() || getConfiguredBayId();
}

export async function ensureClusterAccountDirectorySchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      account_id UUID PRIMARY KEY,
      email_address VARCHAR(254) NOT NULL UNIQUE,
      first_name VARCHAR(254),
      last_name VARCHAR(254),
      name VARCHAR(39),
      home_bay_id VARCHAR(64) NOT NULL,
      created TIMESTAMP NOT NULL DEFAULT NOW(),
      last_active TIMESTAMP,
      banned BOOLEAN,
      provisioned BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_home_bay_id_idx ON ${TABLE} (home_bay_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_lower_first_name_idx ON ${TABLE} (lower(first_name::text) text_pattern_ops)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_lower_last_name_idx ON ${TABLE} (lower(last_name::text) text_pattern_ops)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_lower_name_idx ON ${TABLE} (lower(name::text) text_pattern_ops)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_created_idx ON ${TABLE} (created)`,
  );
}

function canonicalLocalEntry(row: any): AccountDirectoryEntry {
  return {
    account_id: row.account_id,
    first_name: row.first_name ?? undefined,
    last_name: row.last_name ?? undefined,
    name: row.name ?? undefined,
    email_address: row.email_address ?? undefined,
    home_bay_id: `${row.home_bay_id ?? ""}`.trim() || getConfiguredBayId(),
    created:
      row.created instanceof Date
        ? row.created.valueOf()
        : (row.created ?? undefined),
    last_active:
      row.last_active instanceof Date
        ? row.last_active.valueOf()
        : (row.last_active ?? undefined),
    banned: row.banned == null ? undefined : !!row.banned,
    email_address_verified:
      row.email_address_verified == null
        ? undefined
        : !!row.email_address_verified,
  };
}

function canonicalDirectoryEntry(row: any): AccountDirectoryEntry {
  return {
    account_id: row.account_id,
    first_name: row.first_name ?? undefined,
    last_name: row.last_name ?? undefined,
    name: row.name ?? undefined,
    email_address: row.email_address ?? undefined,
    home_bay_id: normalizedHomeBayId(row.home_bay_id),
    created:
      row.created instanceof Date
        ? row.created.valueOf()
        : (row.created ?? undefined),
    last_active:
      row.last_active instanceof Date
        ? row.last_active.valueOf()
        : (row.last_active ?? undefined),
    banned: row.banned == null ? undefined : !!row.banned,
  };
}

async function getLocalAccountById(
  account_id: string,
): Promise<AccountDirectoryEntry | null> {
  if (!isValidUUID(account_id)) {
    return null;
  }
  // Direct account lookups are used for routing and write fencing, so they must
  // read the primary immediately after rehome updates rather than a possibly
  // stale read pool.
  const { rows } = await getPool().query(
    `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
            created, last_active, banned, email_address_verified
       FROM accounts
      WHERE account_id=$1
        AND (deleted IS NULL OR deleted=FALSE)
      LIMIT 1`,
    [account_id],
  );
  return rows[0] ? canonicalLocalEntry(rows[0]) : null;
}

async function getLocalAccountByEmail(
  email_address: string,
): Promise<AccountDirectoryEntry | null> {
  const email = normalizedEmail(email_address);
  if (!email) {
    return null;
  }
  // Direct account lookups are used for routing and write fencing, so they must
  // read the primary immediately after rehome updates rather than a possibly
  // stale read pool.
  const { rows } = await getPool().query(
    `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
            created, last_active, banned, email_address_verified
       FROM accounts
      WHERE email_address=$1
        AND (deleted IS NULL OR deleted=FALSE)
      LIMIT 1`,
    [email],
  );
  return rows[0] ? canonicalLocalEntry(rows[0]) : null;
}

async function getDirectoryAccountById(
  account_id: string,
): Promise<AccountDirectoryEntry | null> {
  if (!isValidUUID(account_id)) {
    return null;
  }
  await ensureClusterAccountDirectorySchema();
  // Direct directory lookups are the cluster routing source of truth.
  const { rows } = await getPool().query(
    `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
            created, last_active, banned
       FROM ${TABLE}
      WHERE account_id=$1
        AND provisioned=TRUE
      LIMIT 1`,
    [account_id],
  );
  return rows[0] ? canonicalDirectoryEntry(rows[0]) : null;
}

async function getDirectoryAccountByEmail(
  email_address: string,
): Promise<AccountDirectoryEntry | null> {
  const email = normalizedEmail(email_address);
  if (!email) {
    return null;
  }
  await ensureClusterAccountDirectorySchema();
  // Direct directory lookups are the cluster routing source of truth.
  const { rows } = await getPool().query(
    `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
            created, last_active, banned
       FROM ${TABLE}
      WHERE email_address=$1
        AND provisioned=TRUE
      LIMIT 1`,
    [email],
  );
  return rows[0] ? canonicalDirectoryEntry(rows[0]) : null;
}

async function searchDirectoryAccounts({
  query,
  limit,
  admin,
  only_email,
}: {
  query: string;
  limit: number;
  admin: boolean;
  only_email: boolean;
}): Promise<AccountDirectoryEntry[]> {
  const normalizedQuery = `${query ?? ""}`.trim().toLowerCase();
  if (!normalizedQuery || limit <= 0) {
    return [];
  }
  await ensureClusterAccountDirectorySchema();
  const pool = getPool("medium");

  if (isValidUUID(normalizedQuery)) {
    const direct = await getDirectoryAccountById(normalizedQuery);
    return direct ? [direct] : [];
  }
  if (isValidEmailAddress(normalizedQuery)) {
    const direct = await getDirectoryAccountByEmail(normalizedQuery);
    return direct ? [direct] : [];
  }

  const { string_queries, email_queries } = parseUserSearch(normalizedQuery);
  const result = new Map<string, AccountDirectoryEntry>();

  if (email_queries.length > 0) {
    const { rows } = await pool.query(
      `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
              created, last_active, banned
         FROM ${TABLE}
        WHERE provisioned=TRUE
          AND email_address = ANY($1::TEXT[])
        LIMIT $2`,
      [email_queries, limit],
    );
    for (const row of rows) {
      const entry = canonicalDirectoryEntry(row);
      result.set(entry.account_id, entry);
    }
  }

  if (!only_email) {
    const params: Array<string | number | boolean> = [limit];
    const clauses: string[] = [];
    let idx = 2;
    for (const terms of string_queries) {
      const termClauses: string[] = [];
      for (const term of terms) {
        const value = `${term ?? ""}`.trim().toLowerCase();
        if (!value) continue;
        params.push(`${value}%`);
        const param = `$${idx++}`;
        const columns = [
          `lower(first_name::text) LIKE ${param}`,
          `lower(last_name::text) LIKE ${param}`,
          `lower(name::text) LIKE ${param}`,
        ];
        if (admin) {
          columns.push(`lower(email_address::text) LIKE ${param}`);
        }
        termClauses.push(`(${columns.join(" OR ")})`);
      }
      if (termClauses.length > 0) {
        clauses.push(`(${termClauses.join(" AND ")})`);
      }
    }
    if (clauses.length > 0) {
      const { rows } = await pool.query(
        `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
                created, last_active, banned
           FROM ${TABLE}
          WHERE provisioned=TRUE
            AND (${clauses.join(" OR ")})
          ORDER BY last_active DESC NULLS LAST, created DESC NULLS LAST, account_id
          LIMIT $1`,
        params,
      );
      for (const row of rows) {
        const entry = canonicalDirectoryEntry(row);
        result.set(entry.account_id, entry);
      }
    }
  }

  return [...result.values()]
    .sort(
      (a, b) =>
        -cmp(
          Math.max(a.last_active ?? 0, a.created ?? 0),
          Math.max(b.last_active ?? 0, b.created ?? 0),
        ),
    )
    .slice(0, limit);
}

function mergeEntries(
  entries: AccountDirectoryEntry[],
): AccountDirectoryEntry[] {
  const merged = new Map<string, AccountDirectoryEntry>();
  for (const entry of entries) {
    if (!entry?.account_id) continue;
    const current = merged.get(entry.account_id);
    if (!current) {
      merged.set(entry.account_id, entry);
      continue;
    }
    merged.set(entry.account_id, {
      ...entry,
      email_address: current.email_address ?? entry.email_address,
      // The directory is the cluster routing source of truth. A stale local
      // account row on the seed must not win after an attached-bay rehome.
      home_bay_id: entry.home_bay_id ?? current.home_bay_id,
    });
  }
  return [...merged.values()];
}

export async function getClusterAccountByIdDirect(
  account_id: string,
): Promise<AccountDirectoryEntry | null> {
  const [local, remote] = await Promise.all([
    getLocalAccountById(account_id),
    getDirectoryAccountById(account_id),
  ]);
  return (
    mergeEntries(
      [local, remote].filter(Boolean) as AccountDirectoryEntry[],
    )[0] ?? null
  );
}

export async function getClusterAccountByEmailDirect(
  email_address: string,
): Promise<AccountDirectoryEntry | null> {
  const [local, remote] = await Promise.all([
    getLocalAccountByEmail(email_address),
    getDirectoryAccountByEmail(email_address),
  ]);
  return (
    mergeEntries(
      [local, remote].filter(Boolean) as AccountDirectoryEntry[],
    )[0] ?? null
  );
}

export async function getClusterAccountsByIdsDirect(
  account_ids: string[],
): Promise<AccountDirectoryEntry[]> {
  const normalized = [...new Set(account_ids.filter(isValidUUID))];
  if (normalized.length === 0) {
    return [];
  }
  const pool = getPool("medium");
  const [localRowsResult, directoryRowsResult] = await Promise.all([
    pool.query(
      `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
              created, last_active, banned, email_address_verified
         FROM accounts
        WHERE account_id = ANY($1::UUID[])
          AND (deleted IS NULL OR deleted=FALSE)`,
      [normalized],
    ),
    (async () => {
      await ensureClusterAccountDirectorySchema();
      return await pool.query(
        `SELECT account_id, first_name, last_name, name, email_address, home_bay_id,
                created, last_active, banned
           FROM ${TABLE}
          WHERE account_id = ANY($1::UUID[])
            AND provisioned=TRUE`,
        [normalized],
      );
    })(),
  ]);
  return mergeEntries([
    ...localRowsResult.rows.map(canonicalLocalEntry),
    ...directoryRowsResult.rows.map(canonicalDirectoryEntry),
  ]);
}

export async function searchClusterAccountsDirect({
  query,
  limit,
  admin,
  only_email,
}: {
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}): Promise<AccountDirectoryEntry[]> {
  const cappedLimit = Math.min(
    Math.max(1, Number(limit ?? 20) || 20),
    admin ? ADMIN_SEARCH_LIMIT : USER_SEARCH_LIMIT,
  );
  const [local, remote] = await Promise.all([
    searchLocalAccounts({
      query,
      limit: cappedLimit,
      admin,
      only_email,
    }),
    searchDirectoryAccounts({
      query,
      limit: cappedLimit,
      admin: !!admin,
      only_email: !!only_email,
    }),
  ]);
  const normalizedLocal = (local as UserSearchResult[]).map((row) => ({
    ...row,
    home_bay_id: row.home_bay_id ?? getConfiguredBayId(),
  }));
  return mergeEntries([...normalizedLocal, ...remote])
    .sort(
      (a, b) =>
        -cmp(
          Math.max(a.last_active ?? 0, a.created ?? 0),
          Math.max(b.last_active ?? 0, b.created ?? 0),
        ),
    )
    .slice(0, cappedLimit);
}

export async function getClusterAccountHomeBayCountsDirect(): Promise<
  Record<string, number>
> {
  await ensureClusterAccountDirectorySchema();
  const { rows } = await getPool("medium").query<{
    home_bay_id: string;
    count: string;
  }>(
    `SELECT home_bay_id, COUNT(*)::TEXT AS count
       FROM ${TABLE}
      WHERE provisioned=TRUE
      GROUP BY home_bay_id`,
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const bay_id = normalizedHomeBayId(row.home_bay_id);
    counts[bay_id] = Math.max(0, Number(row.count ?? 0) || 0);
  }
  return counts;
}

export async function reserveClusterAccountDirectoryEntry({
  account_id,
  email_address,
  first_name,
  last_name,
  name,
  home_bay_id,
}: {
  account_id: string;
  email_address: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  home_bay_id: string;
}): Promise<void> {
  await ensureClusterAccountDirectorySchema();
  await getPool().query(
    `INSERT INTO ${TABLE}
       (account_id, email_address, first_name, last_name, name, home_bay_id, provisioned)
     VALUES
       ($1, $2, $3, $4, $5, $6, FALSE)`,
    [
      account_id,
      normalizedEmail(email_address),
      first_name ?? null,
      last_name ?? null,
      name ?? null,
      normalizedHomeBayId(home_bay_id),
    ],
  );
}

export async function markClusterAccountProvisioned({
  account_id,
  email_address,
  first_name,
  last_name,
  name,
  home_bay_id,
}: {
  account_id: string;
  email_address: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  home_bay_id: string;
}): Promise<void> {
  await ensureClusterAccountDirectorySchema();
  await getPool().query(
    `UPDATE ${TABLE}
        SET email_address=$2,
            first_name=$3,
            last_name=$4,
            name=$5,
            home_bay_id=$6,
            provisioned=TRUE
      WHERE account_id=$1`,
    [
      account_id,
      normalizedEmail(email_address),
      first_name ?? null,
      last_name ?? null,
      name ?? null,
      normalizedHomeBayId(home_bay_id),
    ],
  );
}

export async function updateClusterAccountHomeBayDirect({
  account_id,
  home_bay_id,
}: {
  account_id: string;
  home_bay_id: string;
}): Promise<AccountDirectoryEntry> {
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  const normalizedHomeBay = normalizedHomeBayId(home_bay_id);
  const entry = await getClusterAccountByIdDirect(account_id);
  if (!entry?.account_id) {
    throw new Error(`account ${account_id} not found`);
  }
  const { rowCount } = await getPool().query(
    `UPDATE ${TABLE}
        SET home_bay_id=$2
      WHERE account_id=$1`,
    [account_id, normalizedHomeBay],
  );
  if (rowCount !== 1) {
    throw new Error(`account ${account_id} not found`);
  }
  return {
    ...entry,
    home_bay_id: normalizedHomeBay,
  };
}

export async function deleteClusterAccountDirectoryEntry(
  account_id: string,
): Promise<void> {
  if (!isValidUUID(account_id)) {
    return;
  }
  await ensureClusterAccountDirectorySchema();
  await getPool().query(`DELETE FROM ${TABLE} WHERE account_id=$1`, [
    account_id,
  ]);
}

export async function logClusterDirectoryDebugCount(): Promise<void> {
  try {
    await ensureClusterAccountDirectorySchema();
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${TABLE} WHERE provisioned=TRUE`,
    );
    logger.debug("cluster account directory rows", rows[0]?.count ?? "0");
  } catch {
    // best effort only
  }
}
