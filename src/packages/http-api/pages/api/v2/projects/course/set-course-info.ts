import getAccountId from "@cocalc/http-api/lib/account/get-account";
import setCourseInfo from "@cocalc/server/projects/course/set-course-info";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireApiKeyProjectCapability } from "@cocalc/server/api/api-key-scope";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req) {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  const { course, project_id } = getParams(req);

  if (req.header("Authorization")) {
    const principal = await getAccountFromApiKey(req);
    if (!principal?.account_id || principal.account_id !== account_id) {
      throw Error("must be signed in with a valid account API key");
    }
    requireApiKeyProjectCapability(principal, "project:write", project_id);
  }

  return await setCourseInfo({ account_id, project_id, course });
}
