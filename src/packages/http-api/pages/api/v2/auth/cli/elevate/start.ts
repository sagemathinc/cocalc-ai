/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { startCliElevateChallenge } from "@cocalc/server/auth/cli-auth";

export default async function cliElevateStart(req, res) {
  try {
    const account_id = await getAccountId(req);
    const session_hash = getRememberMeHash(req);
    if (!account_id || !session_hash) {
      throw new Error("interactive CLI sign-in is required");
    }
    const { duration } = getParams(req);
    res.json(
      await startCliElevateChallenge({
        req,
        account_id,
        session_hash,
        duration:
          `${duration ?? ""}`.trim() === "extended" ? "extended" : "default",
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem starting CLI elevation challenge.",
    });
  }
}
