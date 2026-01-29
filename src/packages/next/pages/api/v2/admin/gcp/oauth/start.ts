import { v4 as uuidv4 } from "uuid";
import getAccountId from "lib/account/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getOauthCache } from "@cocalc/database/postgres/passport-store";
import {
  getGoogleCloudOAuthClient,
  getGoogleCloudOAuthRedirectUri,
} from "@cocalc/server/cloud/gcp-oauth";

const OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    res.json(await start(req));
  } catch (err: any) {
    res.json({ error: err?.message ?? `${err}` });
  }
}

async function start(req) {
  const account_id = await getAccountId(req);
  if (!account_id) {
    throw new Error("must be signed in");
  }
  if (!(await userIsInGroup(account_id, "admin"))) {
    throw new Error("only admins can connect Google Cloud");
  }
  const { clientId, clientSecret } = await getGoogleCloudOAuthClient();
  if (!clientId || !clientSecret) {
    throw new Error("missing Google Cloud OAuth client configuration");
  }
  const redirectUri = await getGoogleCloudOAuthRedirectUri();
  const state = uuidv4();
  const oauthCache = getOauthCache("gcp-launchpad");
  await oauthCache.saveAsync(
    state,
    JSON.stringify({ account_id, ts: Date.now() }),
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return { url: url.toString() };
}
