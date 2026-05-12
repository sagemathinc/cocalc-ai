/*
This is a bridge to call the Conat RPC API that is offered by the hub.
This is meant to be called by account users, not projects, so the caller
must provide an account API key.
*/

import { conat } from "@cocalc/backend/conat";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import hubBridge from "@cocalc/server/api/hub-bridge";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { assertHttpHubApiKeyAllowed } from "@cocalc/server/api/http-api-key-policy";

export default async function handle(req, res) {
  try {
    const principal = await getAccountFromApiKey(req);
    if (!principal?.account_id) {
      throw Error(
        "must be signed in and MUST provide an api key (cookies are not allowed)",
      );
    }
    const { name, args, timeout } = getParams(req);
    assertHttpHubApiKeyAllowed({ principal, name, args });
    const resp = await hubBridge({
      account_id: principal.account_id,
      name,
      args,
      timeout,
      client: conat(),
    });
    res.json(resp);
  } catch (err) {
    res.json({ error: err.message });
  }
}
