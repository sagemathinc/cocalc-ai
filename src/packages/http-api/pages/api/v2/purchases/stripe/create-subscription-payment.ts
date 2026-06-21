import getAccountId from "@cocalc/http-api/lib/account/get-account";
import createSubscriptionPayment from "@cocalc/server/purchases/stripe/create-subscription-payment";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import throttle from "@cocalc/util/api/throttle";
import { assertPaymentCheckoutAllowed } from "@cocalc/server/launch/kill-switches";

// Legacy/manual Stripe subscription-payment route. The user-facing React unpaid
// subscription banner calls /api/v2/purchases/renew-subscription instead.
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
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to modify Stripe billing details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  throttle({
    account_id,
    endpoint: "purchases/stripe/create-subscription-payment",
  });
  await assertPaymentCheckoutAllowed();
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { subscription_id } = getParams(req);
  await createSubscriptionPayment({
    account_id,
    subscription_id,
  });
  return { success: true };
}
