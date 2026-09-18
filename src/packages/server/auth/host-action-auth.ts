import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireFreshAuthForSessionHash } from "./auth-sessions";
import { getImpersonationSessionBySessionHash } from "./impersonation";

type Request = { account_id: string; session_hash: string };

async function home(account_id: string): Promise<string> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  if (!home_bay_id) throw new Error("host action account home unavailable");
  return home_bay_id;
}

// Only exposed on the trusted inter-bay fabric. Return a decision, not the
// session record, and reject stale routes rather than consulting a replica.
export async function validateHostActionAuthLocal(opts: Request) {
  if ((await home(opts.account_id)) !== getConfiguredBayId()) {
    throw new Error("host action auth reached a non-home bay");
  }
  await requireFreshAuthForSessionHash({
    ...opts,
    allow_actor_impersonation: true,
  });
  const impersonation = await getImpersonationSessionBySessionHash({
    session_hash: opts.session_hash,
    subject_account_id: opts.account_id,
  });
  return { allow_second_factor_override: !!impersonation };
}

export async function validateHostActionAuth(opts: Request) {
  const home_bay_id = await home(opts.account_id);
  if (home_bay_id === getConfiguredBayId()) {
    return validateHostActionAuthLocal(opts);
  }
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).validateHostActionAuth(opts);
}
