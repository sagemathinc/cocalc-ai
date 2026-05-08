/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { redeemCliLoginChallenge } from "@cocalc/server/auth/cli-auth";

export default async function cliLoginRedeem(req, res) {
  try {
    const { challenge_id, redeem_token } = getParams(req);
    res.json(
      await redeemCliLoginChallenge({
        challenge_id: `${challenge_id ?? ""}`,
        redeem_token: `${redeem_token ?? ""}`,
        user_agent: req.get?.("user-agent") ?? undefined,
        ip_address: req.ip ?? undefined,
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem redeeming CLI login challenge.",
    });
  }
}
