/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import passwordHash from "@cocalc/backend/auth/password-hash";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

export default async function setPasswordFromReset({
  account_id,
  password,
}: {
  account_id: string;
  password: string;
}): Promise<void> {
  await withAccountRehomeWriteFence({
    account_id,
    action: "redeem password reset",
    fn: async (db) => {
      await db.query(
        "UPDATE accounts SET password_hash=$1 WHERE account_id=$2",
        [passwordHash(password), account_id],
      );
    },
  });
}
