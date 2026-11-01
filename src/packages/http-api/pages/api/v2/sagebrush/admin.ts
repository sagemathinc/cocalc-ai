/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Whether an account may see Sagebrush's admin page, for the Sagebrush Worker,
server to server: POST JSON {account_id, grant?} with the Sagebrush
client's Basic credentials. The answer is the contract's
(server/sagebrush/cocalc-admin-contract.json), read live on the account's
home bay every call; nothing is cached. See docs/sagebrush.md.
*/

import getParams from "@cocalc/http-api/lib/api/get-params";
import getLogger from "@cocalc/backend/logger";
import { authenticateOAuthClient } from "@cocalc/server/auth/oauth/clients";
import { getSagebrushAdminAnswer } from "@cocalc/server/sagebrush/admin-grant";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("http-api:sagebrush-admin");

export default async function sagebrushAdmin(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (`${req.method ?? ""}`.toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  try {
    const client = await authenticateOAuthClient(req.header("Authorization"));
    if (client?.client_id !== "sagebrush") {
      res.setHeader("WWW-Authenticate", 'Basic realm="oauth"');
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    const params = getParams(req);
    const account_id = params.account_id;
    const grant = params.grant;
    if (
      typeof account_id !== "string" ||
      !isValidUUID(account_id) ||
      (grant != null && typeof grant !== "string")
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    res.json(
      await getSagebrushAdminAnswer({ account_id, grant: grant ?? null }),
    );
  } catch {
    // (routing or lookup failures: never an answer Sagebrush could admit on)
    logger.warn("admin check failed");
    res.status(500).json({ error: "server_error" });
  }
}
