import getAccountId from "lib/account/get-account";
import getParams from "lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  parseGoogleOAuthClientJson,
  setServerSetting,
} from "@cocalc/server/cloud/gcp-oauth";

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
  const {
    project_id,
    service_account_email,
    client_json,
    client_id,
    client_secret,
  } = getParams(req);
  const projectId = (project_id ?? "").trim();
  const serviceAccountEmail = (service_account_email ?? "").trim();
  const clientJson = (client_json ?? "").trim();
  const clientId = (client_id ?? "").trim();
  const clientSecret = (client_secret ?? "").trim();
  if (!projectId) {
    throw new Error("project_id is required");
  }
  if (!serviceAccountEmail) {
    throw new Error("service_account_email is required");
  }
  if (clientJson || clientId || clientSecret) {
    if (clientJson) {
      const parsed = parseGoogleOAuthClientJson(clientJson);
      await setServerSetting("google_cloud_oauth_client_id", parsed.clientId);
      await setServerSetting(
        "google_cloud_oauth_client_secret",
        parsed.clientSecret,
      );
    } else {
      if (!clientId || !clientSecret) {
        throw new Error("client_id and client_secret are required");
      }
      await setServerSetting("google_cloud_oauth_client_id", clientId);
      await setServerSetting("google_cloud_oauth_client_secret", clientSecret);
    }
  }
  await setServerSetting("google_cloud_project_id", projectId);
  await setServerSetting("google_cloud_service_account_email", serviceAccountEmail);
  return { ok: true };
}
