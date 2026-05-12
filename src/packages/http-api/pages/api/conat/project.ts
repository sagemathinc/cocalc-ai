/*
This is a bridge to call the Conat RPC API that is offered by projects.
This is meant to be called with an account API key. Project-specific CoCalc
API keys are disabled; project-host secret-token auth is separate from this
HTTP bridge.
*/

import { conat } from "@cocalc/backend/conat";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import projectBridge from "@cocalc/server/api/project-bridge";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { assertHttpProjectApiKeyAllowed } from "@cocalc/server/api/http-api-key-policy";

export default async function handle(req, res) {
  try {
    const principal = await getAccountFromApiKey(req);
    const account_id = principal?.account_id;
    if (!account_id || !principal) {
      throw Error("must sign in with an account API key");
    }
    const { project_id, name, args, timeout } = getParams(req);
    if (!project_id) {
      throw Error("must specify project_id");
    }
    assertHttpProjectApiKeyAllowed({ principal, project_id });
    if (!(await isCollaborator({ account_id, project_id }))) {
      throw Error("user must be a collaborator on the project");
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
