/*
v2 API endpoint for managing your api keys
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import manageApiKeys from "@cocalc/server/api/manage";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  try {
    if (req.header("Authorization")) {
      throw Error("API keys cannot manage account API keys");
    }
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw Error("must be signed in");
    }
    const { action, name, expire, capabilities, allowed_project_ids, id } =
      getParams(req);
    if (action !== "get") {
      throw Error("legacy HTTP API key mutations are disabled");
    }
    const response = await manageApiKeys({
      account_id,
      action,
      name,
      expire,
      capabilities,
      allowed_project_ids,
      id,
    });
    res.json({ response });
  } catch (err) {
    res.json({ error: err.message });
  }
}
