// If no such account or no name set, returns "Unknown User".
// Answers are cached for a while.

import getPool from "@cocalc/database/pool";
import {
  getClusterAccountByEmail,
  getClusterAccountById,
  getClusterAccountsByIds,
} from "@cocalc/server/inter-bay/accounts";
import {
  displayNameFromAccount,
  legacyNamePartsFromDisplayName,
} from "@cocalc/util/accounts/display-name";
import { isValidUUID } from "@cocalc/util/misc";
import { MAX_GET_NAMES_ACCOUNT_IDS } from "@cocalc/util/security-limits";
export { MAX_GET_NAMES_ACCOUNT_IDS };

export default async function getName(
  account_id: string,
): Promise<string | undefined> {
  const cluster = await getClusterAccountById(account_id);
  if (cluster?.account_id) {
    return rowsToName([cluster]);
  }
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT display_name, first_name, last_name FROM accounts WHERE account_id=$1",
    [account_id],
  );
  return rowsToName(rows);
}

export async function getNameByEmail(
  email_address: string,
): Promise<string | undefined> {
  const cluster = await getClusterAccountByEmail(email_address);
  if (cluster?.account_id) {
    return rowsToName([cluster]);
  }
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT display_name, first_name, last_name FROM accounts WHERE email_address=$1",
    [email_address],
  );
  return rowsToName(rows);
}

function rowsToName(rows): string | undefined {
  if (rows.length == 0) return;
  return displayNameFromAccount(rows[0]) || undefined;
}

type Names = {
  [account_id: string]: {
    display_name: string;
    first_name: string;
    last_name: string;
    profile?;
  };
};

export function validateGetNamesAccountIds(account_ids: unknown): string[] {
  if (!Array.isArray(account_ids)) {
    throw Error("account_ids must be an array");
  }
  if (account_ids.length > MAX_GET_NAMES_ACCOUNT_IDS) {
    throw Error(
      `at most ${MAX_GET_NAMES_ACCOUNT_IDS} account_ids may be requested`,
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < account_ids.length; i += 1) {
    const account_id = `${account_ids[i] ?? ""}`.trim();
    if (!isValidUUID(account_id)) {
      throw Error(`account_ids[${i}] must be a valid uuid`);
    }
    if (!seen.has(account_id)) {
      normalized.push(account_id);
      seen.add(account_id);
    }
  }
  return normalized;
}

function canonicalName(row) {
  // some accounts have these null for some reason sometimes, but it is nice if client code can assume not null.
  let { display_name = "", profile } = row;
  display_name = displayNameFromAccount({
    display_name,
    first_name: row.first_name,
    last_name: row.last_name,
  });
  if (!display_name) {
    display_name = "No Name";
  }
  const { first_name, last_name } =
    legacyNamePartsFromDisplayName(display_name);
  return { display_name, first_name, last_name, profile };
}

function rowsToNames(rows, account_ids): Names {
  const x: Names = {};
  const known = new Set<string>();
  for (const row of rows) {
    x[row.account_id] = canonicalName(row);
    known.add(row.account_id);
  }
  for (const account_id of account_ids) {
    // Any names not present above must be from deleted accounts or possibly invalid UUID's, which
    // might be the ame thing at some point.
    if (!known.has(account_id)) {
      x[account_id] = {
        display_name: "Deleted User",
        first_name: "Deleted",
        last_name: "User",
      };
    }
  }
  return x;
}

// This also includes the user's profile info, e.g., color or gravatar or image

export async function getNames(account_ids: string[]): Promise<Names> {
  account_ids = validateGetNamesAccountIds(account_ids);
  if (account_ids.length === 0) {
    return {};
  }
  const cluster = await getClusterAccountsByIds(account_ids);
  if (cluster.length > 0) {
    return rowsToNames(cluster, account_ids);
  }
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT account_id, display_name, first_name, last_name, profile FROM accounts WHERE account_id=ANY($1::UUID[]) AND (deleted IS NULL OR deleted = false)",
    [account_ids],
  );
  return rowsToNames(rows, account_ids);
}
