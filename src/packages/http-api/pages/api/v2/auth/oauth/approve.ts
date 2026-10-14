/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Step 2 of approving an OAuth authorize request, on the bay serving the
authorize page: check the home bay's proof, issue a one-time code and return
the client redirect URL. See server/auth/oauth/authorize.ts.
*/

import assertSameOriginMutation from "@cocalc/http-api/lib/api/assert-same-origin-mutation";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  approveAuthorizeRequest,
  authorizeParams,
  validateAuthorizeRequest,
} from "@cocalc/server/auth/oauth/authorize";

export default async function oauthApprove(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to approve OAuth sign-ins");
    }
    assertSameOriginMutation(req);
    const params = getParams(req);
    const request = await validateAuthorizeRequest(authorizeParams(params));
    res.json(
      await approveAuthorizeRequest({
        request,
        approval_token: `${params.approval_token ?? ""}`.trim(),
        approval_home_bay_id: `${params.approval_home_bay_id ?? ""}`.trim(),
      }),
    );
  } catch (err) {
    res.json({ error: err instanceof Error ? err.message : `${err}` });
  }
}
