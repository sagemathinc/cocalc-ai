/*
API endpoint to touch a project, thus updating the last_edited (and last_active
timestamps), and ensure the project is running.

This requires the user to be signed in so they are allowed to use this project.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { start as startProject } from "@cocalc/server/conat/api/projects";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  const account_id = await getAccountId(req);
  const { project_id } = getParams(req);

  try {
    if (!account_id) {
      throw Error("must be signed in");
    }
    await startProject({ account_id, project_id, wait: false });
    res.json({});
  } catch (err) {
    res.json({ error: err.message });
  }
}
