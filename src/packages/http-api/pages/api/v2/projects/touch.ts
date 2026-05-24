/*
API endpoint to touch a project, thus updating the last_edited (and last_active
timestamps), and ensure the project is running.

This requires the user to be signed in so they are allowed to use this project.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { start as startProject } from "@cocalc/server/conat/api/projects";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { assertHttpProjectApiKeyAllowed } from "@cocalc/server/api/http-api-key-policy";

export default async function handle(req, res) {
  const account_id = await getAccountId(req);
  const { project_id } = getParams(req);

  try {
    if (!account_id) {
      throw Error("must be signed in");
    }
    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (!principal?.account_id || principal.account_id !== account_id) {
        throw Error("must be signed in with a valid account API key");
      }
      assertHttpProjectApiKeyAllowed({
        principal,
        project_id,
      });
    }
    await startProject({ account_id, project_id, wait: false });
    res.json({});
  } catch (err) {
    res.json({ error: err.message });
  }
}
