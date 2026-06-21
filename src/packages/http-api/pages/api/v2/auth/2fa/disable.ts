/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { disableTwoFactor } from "@cocalc/server/auth/two-factor";

export default async function disableTwoFactorApi(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    if (req.header("Authorization")) {
      throw new Error(
        "API keys are not allowed to disable two-factor authentication",
      );
    }
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    if (!getRememberMeHash(req)) {
      throw new Error("browser sign-in is required");
    }
    await assertNoImpersonationForSubjectSecurityAction({
      req,
      account_id,
      action: "disable two-factor authentication",
    });
    await disableTwoFactor({ req, account_id });
    res.json({});
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem disabling two-factor authentication.",
    });
  }
}
