import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  billingAuthorityErrorAttrs,
  executeBillingHttpCommand,
} from "@cocalc/server/purchases/billing-authority/client";
import throttle from "@cocalc/util/api/throttle";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...billingAuthorityErrorAttrs(err),
    });
    return;
  }
}

async function get(req) {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to access Stripe billing details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  throttle({ account_id, endpoint: "purchases/stripe/get-payment-methods" });

  const { user_account_id, ending_before, starting_after, limit } =
    getParams(req);
  if (user_account_id) {
    // This user MUST be an admin:
    if (!(await userIsInGroup(account_id, "admin"))) {
      throw Error("only admins can get other user's payment methods");
    }
    return await executeBillingHttpCommand("get-payment-methods", {
      account_id: user_account_id,
      actor_account_id: account_id,
      ending_before,
      starting_after,
      limit,
    });
  }

  return await executeBillingHttpCommand("get-payment-methods", {
    account_id,
    ending_before,
    starting_after,
    limit,
  });
}
