/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* api call to unlink a specific single sign on for the currently authenticated user */

import unlinkStrategy from "@cocalc/server/auth/sso/unlink-strategy";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { OkStatus } from "@cocalc/http-api/lib/api/status";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";

export default async function handle(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw Error("must be signed in");
    }
    if (!getRememberMeHash(req)) {
      throw Error("browser sign-in is required");
    }
    await requireFreshAuth({ req, account_id });
    await assertNoImpersonationForSubjectSecurityAction({
      req,
      account_id,
      action: "unlink single sign-on",
    });
    const { name } = getParams(req);
    await unlinkStrategy({ account_id, name });
    res.json(OkStatus);
  } catch (err) {
    res.json({ error: err.message });
  }
}
