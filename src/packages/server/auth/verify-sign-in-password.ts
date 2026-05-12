/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { verifyPassword } from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { MAX_PASSWORD_LENGTH } from "@cocalc/util/auth";

export interface SignInPasswordVerification {
  account_id: string;
  home_bay_id: string;
}

export async function verifyLocalSignInPassword({
  email_address,
  password,
}: {
  email_address: string;
  password: string;
}): Promise<SignInPasswordVerification> {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be shorter than ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id, password_hash, banned, home_bay_id FROM accounts WHERE email_address=$1",
    [email],
  );
  if (rows.length == 0) {
    throw Error(`no account with email address '${email}'`);
  }
  const { account_id, password_hash, banned, home_bay_id } = rows[0];
  if (!verifyPassword(password, password_hash)) {
    throw Error(`password for '${email}' is incorrect`);
  }
  if (banned) {
    throw Error(
      `'${email}' is banned -- if you think this is a mistake, please email help@cocalc.com and explain.`,
    );
  }
  return {
    account_id,
    home_bay_id: `${home_bay_id ?? ""}`.trim() || getConfiguredBayId(),
  };
}
