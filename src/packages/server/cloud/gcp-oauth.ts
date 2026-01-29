import { db } from "@cocalc/database";
import { getServerSettings, resetServerSettingsCache } from "@cocalc/database/settings/server-settings";
import { callback2 } from "@cocalc/util/async-utils";
import siteUrl from "@cocalc/server/hub/site-url";

export interface GoogleCloudOAuthClient {
  clientId: string;
  clientSecret: string;
}

function clean(val?: string | null): string {
  return (val ?? "").trim();
}

export async function getGoogleCloudOAuthClient(): Promise<GoogleCloudOAuthClient> {
  const envClientId = clean(process.env.COCALC_GOOGLE_CLOUD_OAUTH_CLIENT_ID ?? "");
  const envClientSecret = clean(
    process.env.COCALC_GOOGLE_CLOUD_OAUTH_CLIENT_SECRET ?? "",
  );
  const settings = await getServerSettings();
  const clientId =
    envClientId || clean(settings.google_cloud_oauth_client_id ?? "");
  const clientSecret =
    envClientSecret ||
    clean(settings.google_cloud_oauth_client_secret ?? "");
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google Cloud OAuth client not configured (missing client id/secret)",
    );
  }
  return { clientId, clientSecret };
}

export async function getGoogleCloudOAuthRedirectUri(): Promise<string> {
  return await siteUrl("api/v2/admin/gcp/oauth/callback");
}

export async function setServerSetting(
  name: string,
  value: string,
): Promise<void> {
  await callback2(db().set_server_setting, { name, value });
  resetServerSettingsCache();
}
