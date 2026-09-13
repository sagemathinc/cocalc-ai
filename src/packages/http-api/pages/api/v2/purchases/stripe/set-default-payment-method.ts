/*
Set default payment method for signed in customer.
*/

import {
  billingAuthorityErrorAttrs,
  executeBillingHttpCommand,
} from "@cocalc/server/purchases/billing-authority/client";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import throttle from "@cocalc/util/api/throttle";

export default async function handle(req, res) {
  try {
    res.json(await set(req));
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...(err?.code != null ? { code: err.code } : {}),
      ...billingAuthorityErrorAttrs(err),
    });
    return;
  }
}

async function set(req): Promise<{ success: true }> {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to modify Stripe billing details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in to set stripe default payment method");
  }
  throttle({
    account_id,
    endpoint: "purchases/stripe/set-default-payment-method",
  });
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { default_payment_method } = getParams(req);
  if (!default_payment_method) {
    throw Error("must specify the default source");
  }
  await executeBillingHttpCommand("set-default-payment-method", {
    account_id,
    default_payment_method,
  });
  return { success: true };
}
