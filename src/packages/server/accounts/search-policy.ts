/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import {
  isValidUUID,
  is_valid_email_address as isValidEmailAddress,
  parse_user_search as parseUserSearch,
} from "@cocalc/util/misc";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { ensureClusterAccountDirectorySchema } from "@cocalc/server/accounts/cluster-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { toEpoch } from "@cocalc/database/postgres/utils/to-epoch";

const logger = getLogger("accounts/search-policy");

type Queryable = {
  query: <T = any>(
    sql: string,
    params?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

function normalizeAccountId(account_id: string | undefined): string {
  const value = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(value)) {
    throw new Error("account_id must be a valid uuid");
  }
  return value;
}

function sanitizeRelatedResult(
  user: UserSearchResult,
  includeEmail: boolean,
): UserSearchResult {
  const result: UserSearchResult = { ...user };
  if (
    result.email_address &&
    result.email_address_verified != null &&
    typeof result.email_address_verified == "object"
  ) {
    result.email_address_verified =
      (result.email_address_verified as any)[result.email_address] != null;
  }
  if (!includeEmail) {
    delete result.email_address;
  }
  delete result.banned;
  return result;
}

function addStringQueryClauses({
  string_queries,
  params,
}: {
  string_queries: string[][];
  params: (string | number | string[])[];
}): string[] {
  const clauses: string[] = [];
  for (const terms of string_queries) {
    const termClauses: string[] = [];
    for (const term of terms) {
      params.push(`%${term}%`);
      const pos = params.length;
      termClauses.push(
        `(lower(first_name) LIKE $${pos}::TEXT OR lower(last_name) LIKE $${pos}::TEXT OR '@' || lower(name) LIKE $${pos}::TEXT)`,
      );
    }
    if (termClauses.length > 0) {
      clauses.push(`(${termClauses.join(" AND ")})`);
    }
  }
  return clauses;
}

export async function searchRelatedClusterAccounts({
  account_id: rawAccountId,
  query,
  limit = 20,
  only_email,
  db = getPool(),
  ensureDirectorySchema = ensureClusterAccountDirectorySchema,
}: {
  account_id: string;
  query: string;
  limit?: number;
  only_email?: boolean;
  db?: Queryable;
  ensureDirectorySchema?: () => Promise<void>;
}): Promise<UserSearchResult[]> {
  const account_id = normalizeAccountId(rawAccountId);
  const cappedLimit = Math.max(0, Math.min(Number(limit) || 20, 50));
  if (cappedLimit <= 0) {
    return [];
  }

  const trimmedQuery = `${query ?? ""}`.trim().toLowerCase();
  const params: (string | number | string[])[] = [account_id];
  const where: string[] = [];
  const emailMatch: string[] = [];

  if (isValidUUID(trimmedQuery)) {
    params.push(trimmedQuery);
    where.push(`account_id=$${params.length}::uuid`);
  } else if (isValidEmailAddress(trimmedQuery)) {
    params.push(trimmedQuery);
    const clause = `lower(email_address)=$${params.length}::TEXT`;
    where.push(clause);
    emailMatch.push(clause);
  } else {
    const { string_queries, email_queries } = parseUserSearch(trimmedQuery);
    if (email_queries.length > 0) {
      params.push(email_queries.map((email) => email.toLowerCase()));
      const clause = `lower(email_address)=ANY($${params.length}::TEXT[])`;
      where.push(clause);
      emailMatch.push(clause);
    }
    if (!only_email) {
      where.push(...addStringQueryClauses({ string_queries, params }));
    }
  }

  if (where.length === 0) {
    return [];
  }
  const emailMatchSql =
    emailMatch.length > 0
      ? emailMatch.map((clause) => `(${clause})`).join(" OR ")
      : "FALSE";

  params.push(cappedLimit);
  const limitParam = params.length;

  try {
    await ensureDirectorySchema();
  } catch (err) {
    logger.warn("failed to ensure cluster account directory for search", {
      err: `${err}`,
    });
  }

  const fields = `
    account_id,
    first_name,
    last_name,
    name,
    email_address,
    home_bay_id,
    created,
    last_active,
    banned,
    email_address_verified
  `;
  const { rows } = await db.query<UserSearchResult>(
    `
      WITH related AS (
        SELECT $1::uuid AS account_id
        UNION
        SELECT collaborator_account_id
          FROM account_collaborator_index
         WHERE account_id=$1::uuid
      ),
      candidates AS (
        SELECT ${fields}, 0 AS source_rank
          FROM accounts
          JOIN related USING (account_id)
         WHERE deleted IS NOT TRUE
        UNION ALL
        SELECT
          cluster_account_directory.account_id,
          first_name,
          last_name,
          name,
          email_address,
          COALESCE(home_bay_id, $${params.length + 1}::TEXT) AS home_bay_id,
          created,
          last_active,
          banned,
          NULL AS email_address_verified,
          1 AS source_rank
          FROM cluster_account_directory
          JOIN related ON related.account_id=cluster_account_directory.account_id
         WHERE provisioned=TRUE
      ),
      deduped AS (
        SELECT DISTINCT ON (account_id)
          ${fields},
          source_rank,
          (${emailMatchSql}) AS matched_email
          FROM candidates
         WHERE ${where.map((clause) => `(${clause})`).join(" OR ")}
         ORDER BY account_id, source_rank
      )
      SELECT ${fields}, matched_email
        FROM deduped
       ORDER BY COALESCE(last_active, created) DESC NULLS LAST
       LIMIT $${limitParam}::INTEGER
    `,
    [...params, getConfiguredBayId()],
  );
  return rows.map((row: any) => {
    const result = sanitizeRelatedResult(row, !!row.matched_email);
    delete (result as any).matched_email;
    toEpoch(result as any, ["last_active", "created"]);
    return result;
  });
}
