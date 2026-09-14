/*
Resume a subscription.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  billingAuthorityErrorAttrs,
  executeBillingHttpCommand,
} from "@cocalc/server/purchases/billing-authority/client";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { OkStatus } from "@cocalc/http-api/lib/api/status";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";

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
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { subscription_id } = getParams(req);
  await executeBillingHttpCommand("resume-subscription", {
    account_id,
    subscription_id,
  });
  return OkStatus;
}
