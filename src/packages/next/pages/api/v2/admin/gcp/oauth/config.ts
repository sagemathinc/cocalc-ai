import getAccountId from "lib/account/get-account";
import getParams from "lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { setServerSetting } from "@cocalc/server/cloud/gcp-oauth";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    res.json(await store(req));
  } catch (err: any) {
    res.json({ error: err?.message ?? `${err}` });
  }
}

async function store(req) {
  const account_id = await getAccountId(req);
  if (!account_id) {
    throw new Error("must be signed in");
  }
  if (!(await userIsInGroup(account_id, "admin"))) {
    throw new Error("only admins can update Google Cloud settings");
  }
  const { project_id, service_account_email } = getParams(req);
  const projectId = (project_id ?? "").trim();
  const serviceAccountEmail = (service_account_email ?? "").trim();
  if (!projectId) {
    throw new Error("project_id is required");
  }
  if (!serviceAccountEmail) {
    throw new Error("service_account_email is required");
  }
  await setServerSetting("google_cloud_project_id", projectId);
  await setServerSetting("google_cloud_service_account_email", serviceAccountEmail);
  return { ok: true };
}
