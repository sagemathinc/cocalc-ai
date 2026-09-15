import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import {
  assertExternalAgentLoginEnabled,
  externalStore,
} from "@cocalc/server/agents/external";

/** Human account-home management only. Revocation narrows authority immediately. */
export default async function externalAgentInstallations(req, res) {
  if (!isPost(req, res)) return;
  try {
    if (req.header("Authorization"))
      throw new Error("browser session required");
    const account_id = await getAccountId(req);
    if (!account_id || !getRememberMeHash(req))
      throw new Error("must be signed in");
    const { action = "list", installation_id } = getParams(req);
    if (
      action === "list" &&
      process.env.COCALC_AGENT_EXTERNAL_LOGIN_ENABLED !== "1"
    ) {
      res.json({ enabled: false, installations: [] });
      return;
    }
    assertExternalAgentLoginEnabled();
    const store = externalStore();
    if (action === "revoke") await store.revoke(account_id, installation_id);
    else if (action !== "list")
      throw new Error("unsupported installation action");
    res.json({ enabled: true, installations: await store.list(account_id) });
  } catch (error) {
    res.json({ error: `${error instanceof Error ? error.message : error}` });
  }
}
