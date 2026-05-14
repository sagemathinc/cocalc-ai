/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { startPasskeySetup } from "@cocalc/server/auth/passkeys";

export default async function startPasskeySetupApi(req, res) {
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
    const { label } = getParams(req);
    res.json(
      await startPasskeySetup({
        req,
        account_id,
        label,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error ? err.message : "Problem starting passkey setup.",
    });
  }
}
