/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  checkPassword,
  hashPassword,
  type PasswordKdf,
} from "@cocalc/backend/auth/password-hash";
import { getPasswordKdf } from "@cocalc/database/settings/password-kdf";
import { upgradePasswordHashAfterSignIn } from "@cocalc/server/auth/password-hash-upgrade";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { MAX_PASSWORD_LENGTH } from "@cocalc/util/auth";

export interface SignInPasswordVerification {
  account_id: string;
  home_bay_id: string;
}

// A hash of a random secret in each format, computed once per process. Checking
// a password against it when there is no account (or no password) costs what a
// real check costs, so response time does not reveal whether an account exists.
const dummyHashes: Partial<Record<PasswordKdf, Promise<string>>> = {};

async function spendLikeARealCheck(password: string): Promise<void> {
  const kdf = await getPasswordKdf();
  let dummy = dummyHashes[kdf];
  if (dummy == null) {
    const created = hashPassword(`no account ${Math.random()} ${Date.now()}`, {
      kdf,
    });
    dummyHashes[kdf] = dummy = created;
    // A failed creation (e.g. busy) must not stay cached: the next check
    // would skip the KDF and reveal that the account does not exist.
    created.catch(() => {
      if (dummyHashes[kdf] === created) delete dummyHashes[kdf];
    });
  }
  await checkPassword(password || "x", await dummy);
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
    await spendLikeARealCheck(password);
    throw Error(`no account with email address '${email}'`);
  }
  const { account_id, password_hash, banned, home_bay_id } = rows[0];
  if (!password_hash) {
    await spendLikeARealCheck(password);
  }
  if (!(await checkPassword(password, password_hash))) {
    throw Error(`password for '${email}' is incorrect`);
  }
  if (banned) {
    throw Error(
      `'${email}' is banned -- if you think this is a mistake, please email help@cocalc.ai and explain.`,
    );
  }
  await upgradePasswordHashAfterSignIn({ account_id, password, password_hash });
  return {
    account_id,
    home_bay_id: `${home_bay_id ?? ""}`.trim() || getConfiguredBayId(),
  };
}
