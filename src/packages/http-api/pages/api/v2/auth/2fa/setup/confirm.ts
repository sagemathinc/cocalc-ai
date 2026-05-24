/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { confirmTwoFactorSetup } from "@cocalc/server/auth/two-factor";

export default async function confirmTwoFactorSetupApi(req, res) {
  try {
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
      action: "configure two-factor authentication",
    });
    await requireFreshAuth({ req, account_id });
    const { factor_id, code } = getParams(req);
    res.json(
      await confirmTwoFactorSetup({
        req,
        account_id,
        factor_id,
        code,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem confirming two-factor setup.",
    });
  }
}
