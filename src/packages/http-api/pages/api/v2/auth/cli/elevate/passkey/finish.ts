/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { finishCliElevatePasskeyChallenge } from "@cocalc/server/auth/cli-auth";

export default async function cliElevatePasskeyFinish(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (!account_id || !getRememberMeHash(req)) {
      throw new Error("must be signed in");
    }
    const { challenge_id, passkey_challenge_id, response } = getParams(req);
    res.json(
      await finishCliElevatePasskeyChallenge({
        req,
        challenge_id: `${challenge_id ?? ""}`,
        passkey_challenge_id: `${passkey_challenge_id ?? ""}`,
        account_id,
        response,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem verifying CLI passkey elevation challenge.",
    });
  }
}
