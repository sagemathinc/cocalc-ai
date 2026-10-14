/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Step 1 of approving an OAuth authorize request, on the signed-in account's home
bay: check the browser session and the verified email address, and return a
short-lived proof bound to this request. See server/auth/oauth/authorize.ts.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import assertClusterOriginMutation from "@cocalc/http-api/lib/api/assert-cluster-origin-mutation";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { assertNoImpersonationForSubjectSecurityAction } from "@cocalc/server/auth/impersonation";
import {
  authorizeParams,
  issueAuthorizeApprovalProof,
  validateAuthorizeRequest,
} from "@cocalc/server/auth/oauth/authorize";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";

export default async function oauthApprovalToken(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to approve OAuth sign-ins");
    }
    // The authorize page may be served by another bay, so this is a
    // cross-origin call within the site; it also records the approval.
    await assertClusterOriginMutation(req);
    const account_id = await getAccountId(req);
    if (!account_id || !getRememberMeHash(req)) {
      throw Error("must be signed in");
    }
    const request = await validateAuthorizeRequest(
      authorizeParams(getParams(req)),
    );
    await assertNoImpersonationForSubjectSecurityAction({
      req,
      account_id,
      action: `sign in to ${request.client.name}`,
    });
    res.json(await issueAuthorizeApprovalProof({ account_id, request }));
  } catch (err) {
    res.json({
      error: err instanceof Error ? err.message : `${err}`,
      ...((err as any)?.code != null ? { code: (err as any).code } : {}),
    });
  }
}
