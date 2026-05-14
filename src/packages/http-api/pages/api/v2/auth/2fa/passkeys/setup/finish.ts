/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { finishPasskeySetup } from "@cocalc/server/auth/passkeys";

export default async function finishPasskeySetupApi(req, res) {
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
      action: "configure passkeys",
    });
    const { challenge_id, response, label } = getParams(req);
    res.json(
      await finishPasskeySetup({
        req,
        account_id,
        challenge_id,
        response,
        label,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error ? err.message : "Problem finishing passkey setup.",
    });
  }
}
