import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  billingAuthorityErrorAttrs,
  executeBillingHttpCommand,
} from "@cocalc/server/purchases/billing-authority/client";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import throttle from "@cocalc/util/api/throttle";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...(err?.code != null ? { code: err.code } : {}),
      ...billingAuthorityErrorAttrs(err),
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
  throttle({ account_id, endpoint: "purchases/stripe/set-customer" });
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { changes } = getParams(req);
  await executeBillingHttpCommand("set-customer", { account_id, changes });
  return { success: true };
}
