/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { newPasswordHash } from "@cocalc/database/settings/password-kdf";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { endOtherSessionsOrExplain } from "@cocalc/server/accounts/revocation";

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
  const password_hash = await newPasswordHash(password);
  await withAccountRehomeWriteFence({
    account_id,
    action: "redeem password reset",
    fn: async (db) => {
      const result = await db.query(
        "UPDATE accounts SET password_hash=$1 WHERE account_id=$2 AND lower(email_address)=$3",
        [password_hash, account_id, expectedEmail],
      );
      if (result.rowCount !== 1) {
        throw Error("Password reset no longer valid.");
      }
    },
  });
  // A reset means the password may be known to someone else: every session
  // ends, on the hub and on project hosts, and every content link.
  await endOtherSessionsOrExplain({ account_id });
}
