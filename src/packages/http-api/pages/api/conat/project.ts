/*
This is a bridge to call the Conat RPC API that is offered by projects.
This is meant to be called by either a user account or a project, so API
keys that resolve to either are allowed.
*/

import { conat } from "@cocalc/backend/conat";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import projectBridge from "@cocalc/server/api/project-bridge";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  try {
    const { account_id, project_id: project_id0 } =
      (await getAccountFromApiKey(req)) ?? {};
    if (!account_id && !project_id0) {
      throw Error("must sign in as project or account");
    }
    const { project_id = project_id0, name, args, timeout } = getParams(req);
    if (!project_id) {
      throw Error("must specify project_id or use project-specific api key");
    }
    if (project_id0) {
      if (project_id0 != project_id) {
        throw Error("project specific api key must match requested project");
      }
    }
    if (account_id) {
      if (!(await isCollaborator({ account_id, project_id }))) {
        throw Error("user must be a collaborator on the project");
      }
    }
    const resp = await projectBridge({
      project_id,
      name,
      args,
      timeout,
      client: conat(),
    });
    res.json(resp);
  } catch (err) {
    res.json({ error: err.message });
  }
}
