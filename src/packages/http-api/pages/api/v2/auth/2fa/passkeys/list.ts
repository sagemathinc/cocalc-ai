/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { listPasskeys } from "@cocalc/server/auth/passkeys";

export default async function listPasskeysApi(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    if (!getRememberMeHash(req)) {
      throw new Error("browser sign-in is required");
    }
    res.json(await listPasskeys({ account_id }));
  } catch (err) {
    res.json({
      error: err instanceof Error ? err.message : "Problem loading passkeys.",
    });
  }
}
