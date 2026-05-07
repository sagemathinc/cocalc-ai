/*
Cancels any configured automatic billing subscription.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { cancelUsageSubscription } from "@cocalc/server/purchases/stripe-usage-based-subscription";

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
  await requireFreshAuth({ req, account_id });
  await cancelUsageSubscription(account_id);
  return { success: true };
}
