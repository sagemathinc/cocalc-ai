/* Get projects that belongs to the authenticated user.
   If the user has no projects, creates one.
   If they have projects, returns the most recently active one.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  requireApiKeyCapability,
  type ApiKeyPrincipal,
} from "@cocalc/server/api/api-key-scope";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import createProject from "@cocalc/server/projects/create";
import getProjects from "@cocalc/server/projects/get";
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
}): Promise<{ project_id: string; title?: string }> {
  requireApiKeyCapability(principal, "project:list");
  const projects = await getProjects({ account_id, limit: 1 });
  if (projects.length >= 1) {
    return projects[0];
  }
  requireApiKeyCapability(principal, "project:create");
  const title = "Untitled Project";
  return { project_id: await createProject({ account_id, title }), title };
}
