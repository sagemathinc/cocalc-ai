/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { finishFreshAuthPasskeyAuthentication } from "@cocalc/server/auth/passkeys";

export default async function finishPasskeyFreshAuthApi(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw new Error("must be signed in");
    }
    if (!getRememberMeHash(req)) {
      throw new Error("browser sign-in is required");
    }
    const { challenge_id, response } = getParams(req);
    res.json(
      await finishFreshAuthPasskeyAuthentication({
        req,
        account_id,
        challenge_id,
        response,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem verifying passkey fresh auth.",
    });
  }
}
