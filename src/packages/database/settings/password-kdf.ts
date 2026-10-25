/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  hashPassword,
  type PasswordKdf,
} from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

// Once any scrypt hash exists, scrypt stays in effect even if the setting is
// set back to "legacy": every failed sign-in must keep costing one scrypt
// (see verify-sign-in-password.ts), or response time would again reveal
// which accounts exist and which have strong hashes. So the switch is
// one-way in effect.
const STRONG_CHECK_INTERVAL_MS = 10 * 60 * 1000;
let strongHashesExist = false;
let strongCheckedAt = 0;
let strongCheck: Promise<boolean> | undefined;

async function anyStrongHashExists(): Promise<boolean> {
  if (strongHashesExist) return true;
  if (Date.now() - strongCheckedAt < STRONG_CHECK_INTERVAL_MS) return false;
  strongCheck ??= (async () => {
    try {
      const { rows } = await getPool().query<{ strong: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM accounts
                         WHERE starts_with(password_hash, 'scrypt'))
             OR EXISTS (SELECT 1 FROM account_second_factor_recovery_codes
                         WHERE starts_with(code_hash, 'scrypt')) AS strong`,
      );
      strongHashesExist = rows[0]?.strong === true;
    } catch {
      // Unknown: retry on the next check rather than caching a guess.
      return false;
    } finally {
      strongCheckedAt = Date.now();
      strongCheck = undefined;
    }
    return strongHashesExist;
  })();
  return await strongCheck;
}

/** For tests. */
export function resetPasswordKdfCache(): void {
  strongHashesExist = false;
  strongCheckedAt = 0;
  strongCheck = undefined;
}

/**
 * Which format new password hashes use: the password_kdf site setting, except
 * that it stays "scrypt" once any scrypt hash exists.
 */
export async function getPasswordKdf(): Promise<PasswordKdf> {
  const settings = await getServerSettings();
  if ((settings as any).password_kdf === "scrypt") {
    strongHashesExist = true; // it writes scrypt from now on
    return "scrypt";
  }
  return (await anyStrongHashExists()) ? "scrypt" : "legacy";
}

/** Hash a new account password or recovery code in the configured format. */
export async function newPasswordHash(password: string): Promise<string> {
  return await hashPassword(password, { kdf: await getPasswordKdf() });
}
