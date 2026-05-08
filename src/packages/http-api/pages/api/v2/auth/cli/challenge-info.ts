/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { getCliAuthApprovalInfo } from "@cocalc/server/auth/cli-auth";

export default async function cliChallengeInfo(req, res) {
  try {
    const { challenge_id } = getParams(req);
    res.json(
      await getCliAuthApprovalInfo({
        challenge_id: `${challenge_id ?? ""}`,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem loading CLI auth challenge.",
    });
  }
}
