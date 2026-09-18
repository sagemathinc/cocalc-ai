import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import {
  assertExternalAgentLoginEnabled,
  externalStore,
} from "@cocalc/server/agents/external";
import { AgentStore } from "@cocalc/server/agents/store";
import assertSameOriginMutation from "@cocalc/http-api/lib/api/assert-same-origin-mutation";

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
    if (action !== "list" && action !== "revoke")
      throw new Error("unsupported installation action");
    if (action === "revoke") assertSameOriginMutation(req);
    // The store still fences account-home ownership and account security.
    // Inspection/revocation must survive disabling new external admissions.
    const store = externalStore(new AgentStore());
    if (action === "revoke") await store.revoke(account_id, installation_id);
    let enabled = true;
    try {
      assertExternalAgentLoginEnabled();
    } catch {
      enabled = false;
    }
    res.json({ enabled, installations: await store.list(account_id) });
  } catch (error) {
    res.json({ error: `${error instanceof Error ? error.message : error}` });
  }
}
