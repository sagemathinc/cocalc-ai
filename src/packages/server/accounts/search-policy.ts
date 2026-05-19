/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";

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

function candidateAccountIds(
  rows: Pick<UserSearchResult, "account_id">[],
  account_id: string,
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => `${row.account_id ?? ""}`.trim().toLowerCase())
        .filter((id) => id !== account_id && isValidUUID(id)),
    ),
  ];
}

async function relatedAccountIdSet({
  account_id,
  account_ids,
  db,
}: {
  account_id: string;
  account_ids: string[];
  db: Queryable;
}): Promise<Set<string>> {
  if (account_ids.length === 0) {
    return new Set();
  }
  const { rows } = await db.query<{ collaborator_account_id: string }>(
    `SELECT collaborator_account_id
       FROM account_collaborator_index
      WHERE account_id=$1::uuid
        AND collaborator_account_id=ANY($2::uuid[])`,
    [account_id, account_ids],
  );
  return new Set(
    rows
      .map((row) => `${row.collaborator_account_id ?? ""}`.toLowerCase())
      .filter(isValidUUID),
  );
}

export async function filterAccountSearchResultsToRelated({
  account_id: rawAccountId,
  rows,
  db = getPool(),
}: {
  account_id: string;
  rows: UserSearchResult[];
  db?: Queryable;
}): Promise<UserSearchResult[]> {
  const account_id = normalizeAccountId(rawAccountId);
  const candidates = candidateAccountIds(rows, account_id);
  let related = new Set<string>();
  try {
    related = await relatedAccountIdSet({
      account_id,
      account_ids: candidates,
      db,
    });
  } catch (err) {
    logger.warn("failed to filter account search results by relationship", {
      account_id,
      err: `${err}`,
    });
  }

  return rows.filter((row) => {
    const id = `${row.account_id ?? ""}`.trim().toLowerCase();
    return id === account_id || related.has(id);
  });
}
