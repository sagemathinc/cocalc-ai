/*
API endpoint to copy a path from one project to another or within a project.

This requires the user to be signed in with appropriate access.

See "@cocalc/server/projects/control/base" for params.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { isValidUUID } from "@cocalc/util/misc";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { client as filesystemClient } from "@cocalc/conat/files/file-server";
import { conat } from "@cocalc/backend/conat";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { requireApiKeyProjectCapability } from "@cocalc/server/api/api-key-scope";

export default async function handle(req, res) {
  const params = getParams(req);

  const error = checkParams(params);
  if (error) {
    res.json({ error });
    return;
  }

  const {
    path,
    src_project_id,
    target_project_id,
    target_path,
    timeout, // old timeout was in seconds.
    /*
    overwrite_newer,
    delete_missing,
    backup,
    bwlimit,
    */
  } = params;

  try {
    const account_id = await getAccountId(req);
    if (!account_id) {
      throw Error("must be signed in");
    }
    if (
      !(await isCollaborator({ account_id, project_id: target_project_id }))
    ) {
      throw Error("must be a collaborator on target project");
    }
    if (!(await isCollaborator({ account_id, project_id: src_project_id }))) {
      throw Error("must be a collaborator on source project");
    }
    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (!principal?.account_id || principal.account_id !== account_id) {
        throw Error("must be signed in with a valid account API key");
      }
      requireApiKeyProjectCapability(principal, "file:read", src_project_id);
      requireApiKeyProjectCapability(
        principal,
        "file:write",
        target_project_id,
      );
    }
    const client = filesystemClient({ client: conat() });
    await client.cp({
      src: { project_id: src_project_id, path },
      dest: { project_id: target_project_id, path: target_path ?? path },
      options: {
        timeout: timeout != null ? timeout * 1000 : undefined, // old timeout was in seconds.
        recursive: true,
      },
    });
    res.json({ status: "ok" });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}

function checkParams(obj: any): string | undefined {
  if (obj.path == null) return "path must be specified";
  if (!isValidUUID(obj.src_project_id))
    return "src_project_id must be a valid uuid";
  if (!isValidUUID(obj.target_project_id))
    return "target_project_id must be a valid uuid";
}
