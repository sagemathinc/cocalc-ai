import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getCheckoutSession from "@cocalc/server/purchases/stripe/get-checkout-session";
import throttle from "@cocalc/util/api/throttle";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";

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
  throttle({ account_id, endpoint: "purchases/stripe/get-checkout-session" });

  const { purpose, description, lineItems, return_url, metadata } =
    getParams(req);

  return await getCheckoutSession({
    account_id,
    purpose,
    description,
    lineItems,
    return_url,
    metadata,
  });
}
