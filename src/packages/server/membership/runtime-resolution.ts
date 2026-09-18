import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveMembershipForAccount } from "./resolve";

// Projects may execute away from their sponsor's account home. A local
// membership lookup would silently treat that sponsor as a free account.
export async function resolveRuntimeMembership(
  account_id: string,
): Promise<MembershipResolution> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (home_bay_id === getConfiguredBayId()) {
    return resolveMembershipForAccount(account_id);
  }
  if (!home_bay_id) throw new Error("runtime account home unavailable");
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).getMembership({ account_id });
}
