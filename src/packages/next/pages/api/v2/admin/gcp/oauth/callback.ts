import getAccountId from "lib/account/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getOauthCache } from "@cocalc/database/postgres/passport-store";
import siteUrl from "@cocalc/server/hub/site-url";
import {
  getGoogleCloudOAuthClient,
  getGoogleCloudOAuthRedirectUri,
  setServerSetting,
} from "@cocalc/server/cloud/gcp-oauth";

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>${title}</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
<h2>${title}</h2>
<div>${body}</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).send("method_not_allowed");
      return;
    }
    await handle(req, res);
  } catch (err: any) {
    const message = err?.message ?? `${err}`;
    await setServerSetting("google_cloud_oauth_last_error", message);
    res
      .status(500)
      .send(htmlPage("Google Cloud OAuth failed", message));
  }
}

async function handle(req, res) {
  const account_id = await getAccountId(req);
  if (!account_id) {
    throw new Error("must be signed in");
  }
  if (!(await userIsInGroup(account_id, "admin"))) {
    throw new Error("only admins can connect Google Cloud");
  }

  const errorParam =
    typeof req.query.error === "string" ? req.query.error : "";
  const errorDesc =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : "";
  if (errorParam) {
    const msg = errorDesc || errorParam;
    await setServerSetting("google_cloud_oauth_last_error", msg);
    res
      .status(400)
      .send(htmlPage("Google Cloud OAuth failed", msg));
    return;
  }

  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!state || !code) {
    throw new Error("missing OAuth state or code");
  }
  const oauthCache = getOauthCache("gcp-launchpad");
  const cached = await oauthCache.getAsync(state);
  if (!cached) {
    throw new Error("OAuth state is invalid or expired");
  }
  await oauthCache.removeAsync(state);

  const { clientId, clientSecret } = await getGoogleCloudOAuthClient();
  const redirectUri = await getGoogleCloudOAuthRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const payload = await tokenResp.json();
  if (!tokenResp.ok) {
    const msg = payload?.error_description ?? payload?.error ?? "token_error";
    await setServerSetting("google_cloud_oauth_last_error", msg);
    throw new Error(msg);
  }
  const refreshToken = payload?.refresh_token ?? "";
  if (!refreshToken) {
    const msg =
      "No refresh token returned. Revoke the app in Google Account security and retry.";
    await setServerSetting("google_cloud_oauth_last_error", msg);
    throw new Error(msg);
  }

  const now = new Date().toISOString();
  await setServerSetting("google_cloud_oauth_refresh_token", refreshToken);
  await setServerSetting("google_cloud_oauth_connected_at", now);
  await setServerSetting("google_cloud_oauth_last_error", "");

  const adminUrl = await siteUrl("admin");
  res
    .status(200)
    .send(
      htmlPage(
        "Google Cloud OAuth connected",
        `OAuth connection saved. Return to <a href="${adminUrl}">Admin Settings</a>.`,
      ),
    );
}
