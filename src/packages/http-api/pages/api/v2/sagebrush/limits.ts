/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
An account's upload limits for sagebrush.space, for the Sagebrush Worker,
server to server: GET ?account_id=<uuid> with the Sagebrush client's Basic
credentials. See docs/sagebrush.md.
*/

import getLogger from "@cocalc/backend/logger";
import { authenticateOAuthClient } from "@cocalc/server/auth/oauth/clients";
import { getSagebrushLimits } from "@cocalc/server/sagebrush/limits";

const logger = getLogger("http-api:sagebrush-limits");

export default async function sagebrushLimits(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (`${req.method ?? ""}`.toUpperCase() !== "GET") {
    res.setHeader("Allow", "GET");
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
    const account_id = req.query?.account_id;
    if (typeof account_id !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const limits = await getSagebrushLimits(account_id);
    if (limits == null) {
      res.status(404).json({ error: "no_account" });
      return;
    }
    res.json(limits);
  } catch (err) {
    logger.warn("limits request failed", { err: `${err}` });
    res.status(500).json({ error: "server_error" });
  }
}
