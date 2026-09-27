/* Get projects that belongs to the authenticated user.
   Browser sessions retain legacy implicit creation; API keys only read.
   If they have projects, returns the most recently active one.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  requireApiKeyCapability,
  type ApiKeyPrincipal,
} from "@cocalc/server/api/api-key-scope";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { listProjectSummaries } from "@cocalc/server/conat/api/projects";
import getOneProject from "@cocalc/server/projects/get-one";

export default async function handle(req, res) {
  const account_id = await getAccountId(req);
  try {
    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (!principal?.account_id || principal.account_id !== account_id) {
        throw Error("must be signed in with a valid account API key");
      }
      res.json(await getOneProjectForApiKey({ account_id, principal }));
      return;
    }
    res.json(await getOneProject(account_id));
  } catch (err) {
    res.json({ error: err.message });
  }
}

async function getOneProjectForApiKey({
  account_id,
  principal,
}: {
  account_id: string;
  principal: ApiKeyPrincipal;
}): Promise<{ project_id: string; title?: string; description?: string }> {
  requireApiKeyCapability(principal, "project:list");
  const { projects } = await listProjectSummaries({ account_id, limit: 1 });
  if (projects.length >= 1) {
    const { project_id, title, description } = projects[0];
    return { project_id, title, description };
  }
  // Projection absence is not authoritative absence, especially across bays.
  // Creating must be an explicit caller operation, not a side effect of a read.
  throw Error(
    "No project is currently visible in the account index; retry later or explicitly create a project",
  );
}
