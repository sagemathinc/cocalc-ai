/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getParams from "@cocalc/http-api/lib/api/get-params";
import { verifySignInSecondFactorChallenge } from "@cocalc/server/auth/two-factor";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import { signUserIn } from "./sign-in";

export default async function verifySecondFactor(req, res) {
  const { challenge_id, method, code } = getParams(req);
  try {
    const result = await verifySignInSecondFactorChallenge({
      challenge_id,
      method,
      code,
    });
    await signUserIn(req, res, result.account_id, {
      authenticated_at: new Date(),
      password_verified_at: result.password_verified_at,
      factor_verified_at: result.factor_verified_at,
      factor_level: result.factor_level,
      fresh_auth_until: result.fresh_auth_until,
    });
  } catch (err) {
    res.json({
      error:
        err instanceof Error ? err.message : "Problem verifying second factor.",
      home_bay_id: getConfiguredBayId(),
      home_bay_url: await getBayPublicOriginForRequest(
        req,
        getConfiguredBayId(),
      ),
    });
  }
}
