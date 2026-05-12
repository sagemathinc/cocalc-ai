import { createInterBayAuthTokenClient } from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

export async function getRequiresTokensDirect(): Promise<boolean> {
  const { public_signup_without_registration_token } =
    await getServerSettings();
  return !public_signup_without_registration_token;
}

export default async function getRequiresTokens(): Promise<boolean> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getRequiresTokensDirect();
  }
  return await createInterBayAuthTokenClient({
    client: getInterBayFabricClient(),
  }).requiresToken({});
}
