/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { freshAuthSession } from "@cocalc/server/auth/two-factor";

export default async function freshAuth(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    if (!getRememberMeHash(req)) {
      throw new Error("browser sign-in is required");
    }
    const { current_password, method, code, duration } = getParams(req);
    res.json(
      await freshAuthSession({
        req,
        account_id,
        current_password: `${current_password ?? ""}`,
        method,
        code,
        duration,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error ? err.message : "Problem performing fresh auth.",
    });
  }
}
