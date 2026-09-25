import getAccountId from "@cocalc/http-api/lib/account/get-account";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { assertExternalAgentLoginEnabled } from "@cocalc/server/agents/external";
import { listAgentNetworks } from "@cocalc/server/agents/personal";

export default async function externalAgentDestinations(req, res) {
  if (!isPost(req, res)) return;
  try {
    assertExternalAgentLoginEnabled();
    if (req.header("Authorization"))
      throw new Error("browser session required");
    const account_id = await getAccountId(req);
    if (!account_id || !getRememberMeHash(req))
      throw new Error("must be signed in");
    res.json(await listAgentNetworks({ account_id, limit: 100 }));
  } catch (error) {
    res.json({ error: `${error instanceof Error ? error.message : error}` });
  }
}
