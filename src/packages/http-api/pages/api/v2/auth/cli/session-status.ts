/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { getCliAuthSessionStatus } from "@cocalc/server/auth/cli-auth";

export default async function cliSessionStatus(req, res) {
  try {
    const account_id = await getAccountId(req);
    const session_hash = getRememberMeHash(req);
    if (!account_id || !session_hash) {
      throw new Error("interactive CLI sign-in is required");
    }
    res.json(
      await getCliAuthSessionStatus({
        account_id,
        session_hash,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem loading CLI session status.",
    });
  }
}
