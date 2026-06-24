/*
Similar to the public profile, but also get additional information
that shouldn't be made available to anybody who knows this account_id.

Only call this for the account_id of the signed in user.
*/

import getPool from "@cocalc/database/pool";
import {
  displayNameFromAccount,
  legacyNamePartsFromDisplayName,
} from "@cocalc/util/accounts/display-name";
import { Profile } from "./types";

export default async function getPrivateProfile(
  account_id: string,
  noCache: boolean = false,
): Promise<Profile> {
  const pool = getPool(noCache ? undefined : "medium");
  const { rows } = await pool.query(
    "SELECT display_name, first_name, last_name, profile, groups, email_address FROM accounts WHERE account_id=$1",
    [account_id],
  );
  if (rows.length == 0) {
    throw Error(`no account with id ${account_id}`);
  }
  const is_admin = !!rows[0].groups?.includes("admin");

  const is_partner = !!rows[0].groups?.includes("partner");

  const display_name = displayNameFromAccount(rows[0]) || "Anonymous User";
  const legacyNameParts = legacyNamePartsFromDisplayName(display_name);
  return {
    account_id,
    display_name,
    first_name: legacyNameParts.first_name,
    last_name: legacyNameParts.last_name,
    image: rows[0].profile?.image,
    color: rows[0].profile?.color,
    is_admin,
    is_partner,
    email_address: rows[0].email_address,
  };
}
