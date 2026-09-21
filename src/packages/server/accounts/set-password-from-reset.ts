/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import passwordHash from "@cocalc/backend/auth/password-hash";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

export default async function setPasswordFromReset({
  account_id,
  email_address,
  password,
}: {
  account_id: string;
  email_address: string;
  password: string;
}): Promise<void> {
  const expectedEmail = `${email_address ?? ""}`.trim().toLowerCase();
  if (!expectedEmail) {
    throw Error("Password reset no longer valid.");
  }
  await withAccountRehomeWriteFence({
    account_id,
    action: "redeem password reset",
    fn: async (db) => {
      const result = await db.query(
        "UPDATE accounts SET password_hash=$1 WHERE account_id=$2 AND lower(email_address)=$3",
        [passwordHash(password), account_id, expectedEmail],
      );
      if (result.rowCount !== 1) {
        throw Error("Password reset no longer valid.");
      }
    },
  });
}
