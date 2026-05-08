/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { getCliAuthChallengeStatus } from "@cocalc/server/auth/cli-auth";

export default async function cliLoginStatus(req, res) {
  try {
    const { challenge_id, poll_token } = getParams(req);
    res.json(
      await getCliAuthChallengeStatus({
        challenge_id: `${challenge_id ?? ""}`,
        poll_token: `${poll_token ?? ""}`,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem loading CLI login challenge status.",
    });
  }
}
