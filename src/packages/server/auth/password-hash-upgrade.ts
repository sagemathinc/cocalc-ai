/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  hashPassword,
  passwordNeedsRehash,
} from "@cocalc/backend/auth/password-hash";
import getLogger from "@cocalc/backend/logger";
import { getPasswordKdf } from "@cocalc/database/settings/password-kdf";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

const logger = getLogger("server:auth:password-hash-upgrade");

/**
 * After a successful sign-in, replace an older password hash with one in the
 * configured format. Compare-and-set on the exact old value: a concurrent
 * password change always wins. Best effort: never fails the sign-in.
 */
export async function upgradePasswordHashAfterSignIn({
  account_id,
  password,
  password_hash,
}: {
  account_id: string;
  password: string;
  password_hash: string;
}): Promise<boolean> {
  try {
    const kdf = await getPasswordKdf();
    if (!passwordNeedsRehash(password_hash, { kdf })) return false;
    const upgraded = await hashPassword(password, { kdf });
    const rowCount = await withAccountRehomeWriteFence({
      account_id,
      action: "upgrade password hash",
      fn: async (db) =>
        (
          await db.query(
            "UPDATE accounts SET password_hash=$1 WHERE account_id=$2 AND password_hash=$3",
            [upgraded, account_id, password_hash],
          )
        ).rowCount,
    });
    if ((rowCount ?? 0) > 0) {
      logger.info("upgraded password hash after sign-in", { account_id });
      return true;
    }
  } catch (err) {
    logger.warn("password hash upgrade failed", { account_id, err: `${err}` });
  }
  return false;
}
