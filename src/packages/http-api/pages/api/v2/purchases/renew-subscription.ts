/*
Renew one of your subscriptions.  Returns {purchase_id:number|nill} for the purchase of the next interval of the subscription.
Null if nothing needed to be done.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import renewSubscription from "@cocalc/server/purchases/renew-subscription";

// User-facing unpaid subscription renewal route. Keep the frontend caller wired
// through useFreshAuthAction/FreshAuthModal when this requires fresh auth.
export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...(err?.code != null ? { code: err.code } : {}),
    });
    return;
  }
}

async function get(req) {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { subscription_id } = getParams(req);
  return {
    purchase_id: await renewSubscription({
      account_id,
      subscription_id,
    }),
  };
}
