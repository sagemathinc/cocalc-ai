/* API endpoint to determine whether or not the currently authenticated
user has a passport. */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import hasPassword from "@cocalc/server/auth/has-password";

export default async function handle(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to inspect password status");
    }
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw Error("must be signed in");
    }
    res.json({ hasPassword: await hasPassword(account_id) });
  } catch (err) {
    res.json({ error: err.message });
  }
}
