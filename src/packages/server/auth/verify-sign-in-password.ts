/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  checkPassword,
  hashPassword,
  isStrongPasswordHash,
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

async function spendLikeARealCheck(
  password: string,
  kdf: PasswordKdf,
): Promise<void> {
  const cached = dummyHashes[kdf];
  if (cached == null) {
    const created = hashPassword(`no account ${Math.random()} ${Date.now()}`, {
      kdf,
    });
    dummyHashes[kdf] = created;
    // A failed creation (e.g. busy) must not stay cached: the next check
    // would skip the KDF and reveal that the account does not exist.
    created.catch(() => {
      if (dummyHashes[kdf] === created) delete dummyHashes[kdf];
    });
    // Creating the dummy is itself the one KDF this request pays.
    await created;
    return;
  }
  await checkPassword(password || "x", await cached);
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

  // Read once, so every branch below charges the same format.
  const kdf = await getPasswordKdf();
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT account_id, password_hash, banned, home_bay_id FROM accounts WHERE email_address=$1",
    [email],
  );
  if (rows.length == 0) {
    await spendLikeARealCheck(password, kdf);
    throw Error(`no account with email address '${email}'`);
  }
  const { account_id, password_hash, banned, home_bay_id } = rows[0];
  if (!password_hash) {
    await spendLikeARealCheck(password, kdf);
  }
  if (!(await checkPassword(password, password_hash))) {
    // While scrypt is on, a legacy (or malformed) hash fails without any
    // scrypt; pay the dummy so every failure costs one scrypt. Under legacy
    // the real check already costs what the dummy does.
    if (
      password_hash &&
      kdf === "scrypt" &&
      !isStrongPasswordHash(password_hash)
    ) {
      await spendLikeARealCheck(password, kdf);
    }
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
