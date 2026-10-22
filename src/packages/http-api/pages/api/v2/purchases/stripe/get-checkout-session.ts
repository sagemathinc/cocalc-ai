import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  billingAuthorityErrorAttrs,
  executeBillingHttpCommand,
} from "@cocalc/server/purchases/billing-authority/client";
import throttle from "@cocalc/util/api/throttle";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { assertInteractivePaymentPurpose } from "@cocalc/server/purchases/stripe/util";

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
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  throttle({ account_id, endpoint: "purchases/stripe/get-checkout-session" });

  const { purpose, description, lineItems, metadata, checkout_instance_id } =
    getParams(req);
  assertInteractivePaymentPurpose(purpose);

  return await executeBillingHttpCommand("get-checkout-session", {
    account_id,
    purpose,
    description,
    lineItems,
    metadata,
    checkout_instance_id,
    // Cloudflare's country for this request, so a customer without a billing
    // address in or near the EU or UK must enter one before checkout.
    request_country: req.headers["cf-ipcountry"],
  });
}
