/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Check an OAuth authorize request for the authorize page, and return what the
page shows: the client and where Deny sends the browser. An invalid request is
an error and the page never redirects.
*/

import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  authorizeParams,
  authorizeRequestInfo,
  denyRedirectUrl,
  validateAuthorizeRequest,
} from "@cocalc/server/auth/oauth/authorize";

export default async function oauthAuthorizeInfo(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to use OAuth authorization");
    }
    const request = await validateAuthorizeRequest(
      authorizeParams(getParams(req)),
    );
    res.json({
      ...authorizeRequestInfo(request),
      deny_url: denyRedirectUrl(request),
    });
  } catch (err) {
    res.json({ error: err instanceof Error ? err.message : `${err}` });
  }
}
