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
5. respond success; the user must sign in through the normal auth flow.
*/

import redeemPasswordReset from "@cocalc/server/auth/redeem-password-reset";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";

export default async function redeemPasswordResetAPIEndPoint(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  const { password, passwordResetId } = getParams(req);
  try {
    await redeemPasswordReset(password, passwordResetId);
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
  res.json({
    success:
      "Password reset successfully. Please sign in with your new password.",
  });
}
