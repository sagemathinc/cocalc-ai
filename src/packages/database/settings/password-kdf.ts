/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  hashPassword,
  type PasswordKdf,
} from "@cocalc/backend/auth/password-hash";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

/** The password_kdf site setting: which format new password hashes use. */
export async function getPasswordKdf(): Promise<PasswordKdf> {
  const settings = await getServerSettings();
  return (settings as any).password_kdf === "scrypt" ? "scrypt" : "legacy";
}

/** Hash a new account password or recovery code in the configured format. */
export async function newPasswordHash(password: string): Promise<string> {
  return await hashPassword(password, { kdf: await getPasswordKdf() });
}
