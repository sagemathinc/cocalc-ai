/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Redeeming a password reset works as follows:

1. check that the password reset id is valid still; error if not
2. check that the password is valid; error if not
3. invalidate password reset id by writing that it is used to the database
4. write hash of new password to the database
5. respond success and sign user in.
*/

import redeemPasswordReset from "@cocalc/server/auth/redeem-password-reset";
import { signUserIn } from "./sign-in";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import {
  issueHomeBayRetryToken,
  verifyHomeBayRetryToken,
} from "@cocalc/server/auth/home-bay-retry-token";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

export default async function redeemPasswordResetAPIEndPoint(req, res) {
  const { password, passwordResetId, retry_token } = getParams(req);
  let account_id: string;
  try {
    const retryToken = `${retry_token ?? ""}`.trim();
    if (retryToken) {
      const claims = verifyHomeBayRetryToken({
        token: retryToken,
        home_bay_id: getConfiguredBayId(),
        purpose: "password-reset",
      });
      if (!claims.account_id) {
        throw new Error("invalid password reset sign-in token");
      }
      account_id = claims.account_id;
    } else {
      account_id = await redeemPasswordReset(password, passwordResetId);
    }
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (homeBayId && homeBayId !== getConfiguredBayId()) {
    const retry = issueHomeBayRetryToken({
      account_id,
      home_bay_id: homeBayId,
      purpose: "password-reset",
    });
    res.json({
      wrong_bay: true,
      home_bay_id: homeBayId,
      home_bay_url: await getBayPublicOriginForRequest(req, homeBayId),
      retry_token: retry.token,
    });
    return;
  }
  await signUserIn(req, res, account_id);
  return;
}
