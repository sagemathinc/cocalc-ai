/*
API endpoint to create a new project.

This requires the user to be signed in so they are allowed to create a project.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import create from "@cocalc/server/projects/create";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { assertHttpHubApiKeyAllowed } from "@cocalc/server/api/http-api-key-policy";

export default async function handle(req, res) {
  const { title, description } = getParams(req);
  const account_id = await getAccountId(req);
  try {
    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (!principal?.account_id || principal.account_id !== account_id) {
        throw Error("must be signed in with a valid account API key");
      }
      assertHttpHubApiKeyAllowed({
        principal,
        name: "projects.createProject",
      });
    }
    const project_id = await createProject(account_id, title, description);
    res.json({ project_id });
  } catch (err) {
    res.json({ error: err.message });
  }
}

async function createProject(account_id, title, description): Promise<string> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return await create({
    account_id,
    title,
    description,
  });
}
