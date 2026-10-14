/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
OAuth 2 token endpoint for registered clients, called server to server. It
redeems a one-time authorization code and returns the account's id, verified
email address and name; it issues no access token. See docs/sagebrush.md.
*/

import getLogger from "@cocalc/backend/logger";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import {
  exchangeAuthorizationCode,
  OAuthTokenError,
} from "@cocalc/server/auth/oauth/authorize";

const logger = getLogger("http-api:oauth-token");

export default async function oauthToken(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (!isPost(req, res)) {
    return;
  }
  try {
    const params = getParams(req);
    res.json(
      await exchangeAuthorizationCode({
        authorization: req.header("Authorization"),
        params: {
          grant_type: params.grant_type,
          code: params.code,
          redirect_uri: params.redirect_uri,
          code_verifier: params.code_verifier,
          client_id: params.client_id,
        },
      }),
    );
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      logger.debug("token request refused", {
        error: err.error,
        reason: err.message,
      });
      if (err.status === 401) {
        res.setHeader("WWW-Authenticate", 'Basic realm="oauth"');
      }
      res.status(err.status).json({ error: err.error });
      return;
    }
    logger.warn("token request failed", { err: `${err}` });
    res.status(500).json({ error: "server_error" });
  }
}
