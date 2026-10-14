/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The OAuth clients (e.g. Sagebrush) the signed-in account has approved a sign-in
for. The account deletion dialog offers to purge their data.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { listOAuthClientApprovals } from "@cocalc/server/auth/oauth/authorize";
import { OAUTH_CLIENTS } from "@cocalc/server/auth/oauth/clients";

export default async function oauthClientApprovals(req, res) {
  if (!isPost(req, res)) {
    return;
  }
  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to list OAuth client approvals");
    }
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw Error("must be signed in");
    }
    const clients = (await listOAuthClientApprovals(account_id))
      .filter((client_id) =>
        Object.prototype.hasOwnProperty.call(OAUTH_CLIENTS, client_id),
      )
      .map((client_id) => ({
        client_id,
        name: OAUTH_CLIENTS[client_id].name,
        homepage: OAUTH_CLIENTS[client_id].homepage,
      }));
    res.json({ clients });
  } catch (err) {
    res.json({ error: err instanceof Error ? err.message : `${err}` });
  }
}
