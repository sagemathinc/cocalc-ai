/*
Get the *PUBLIC* profile of a user.
*/

import getPool from "@cocalc/database/pool";
import {
  displayNameFromAccount,
  legacyNamePartsFromDisplayName,
} from "@cocalc/util/accounts/display-name";
import { Profile } from "./types";

export default async function getProfile(
  account_id: string,
  noCache: boolean = false,
): Promise<Profile> {
  const pool = getPool(noCache ? undefined : "long");
  // Do not put anything private in this query!!!!
  const { rows } = await pool.query(
    "SELECT display_name, first_name, last_name, profile FROM accounts WHERE account_id=$1",
    [account_id],
  );
  if (rows.length == 0) {
    throw Error(`no account with id ${account_id}`);
  }
  const display_name = displayNameFromAccount(rows[0]) || "Anonymous User";
  const legacyNameParts = legacyNamePartsFromDisplayName(display_name);
  return {
    account_id,
    display_name,
    first_name: legacyNameParts.first_name,
    last_name: legacyNameParts.last_name,
    image: rows[0].profile?.image,
    color: rows[0].profile?.color,
  };
}
