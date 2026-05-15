/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { getRememberMeHashes } from "@cocalc/server/auth/remember-me";
import getLogger from "@cocalc/backend/logger";
import isBanned from "@cocalc/server/accounts/is-banned";
import { trunc } from "@cocalc/util/misc";

const logger = getLogger("server:get-account");

// Return account_id if they are signed in.
// If not, returns undefined.
// This is determined by looking in their cookie and checking
// who it identifies in the database.
// This also uses their account API key.
export default async function getAccountId(
  req,
  opts?,
): Promise<string | undefined> {
  if (req == null) {
    return;
  }
  // caching a bit --  We thus want the query below to happen rarely.  We also
  // get expire field as well (since it is usually there) so that the result isn't empty
  // (hence not cached) when a cookie has expired.
  const hashes = getRememberMeHashes(req);
  const hash = hashes[0];
  logger.debug(
    `hash: ${trunc(hash, 10)} auth: ${trunc(req.header("Authorization"), 10)}`,
  );
  if (!hash) {
    // not signed in via a cookie.
    // What about an api key?
    if (req.header("Authorization")) {
      try {
        logger.debug("check for api key");
        const account = await getAccountFromApiKey(req);
        return account?.account_id;
      } catch (_err) {
        logger.debug("no valid api key");
        // non-fatal, at least for now...
        return;
      }
    }
    return;
  }
  for (const hash of hashes) {
    const account_id = await getAccountIdFromRememberMe(hash, opts);
    if (account_id) {
      return account_id;
    }
  }
}

export async function getAccountIdFromRememberMe(
  hash: string,
  {
    noCache,
  }: {
    noCache?: boolean;
  } = {},
) {
  if (!hash) {
    throw Error("hash must be given");
  }
  const pool = getPool(noCache ? "" : "medium");
  // important to use CHAR(127) instead of TEXT for 100x performance gain.
  const result = await pool.query(
    "SELECT account_id, expire FROM remember_me WHERE hash = $1::CHAR(127)",
    [hash],
  );
  if (result.rows.length == 0) {
    logger.debug("no known remember_me cookie with hash", hash);
    return;
  }
  const { account_id, expire } = result.rows[0];
  if (await isBanned(account_id)) {
    // banned user so do not allow  -- act of banning user should have
    // deleted all remember_me, but we put this extra check in just in case.
    return;
  }
  if (expire <= new Date()) {
    logger.debug("remember_me cookie with this hash expired already", {
      account_id,
      expire,
    });
    // expired
    return;
  }
  logger.debug("remember_me cookie valid -- sign in as ", account_id);
  return account_id;
}
