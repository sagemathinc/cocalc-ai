/*
An admin can cancel anybody's payment intent, whereas a user can only cancel their own.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { executeBillingHttpCommand } from "@cocalc/server/purchases/billing-authority/client";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getCurrentAuthSession } from "@cocalc/server/auth/auth-sessions";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import throttle from "@cocalc/util/api/throttle";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
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
    endpoint: "purchases/stripe/cancel-payment-intent",
  });
  const { id, reason } = getParams(req);
  const owner_id = await executeBillingHttpCommand<string>(
    "get-payment-intent-account-id",
    { id },
  );
  if (owner_id != account_id) {
    if (!(await userIsInGroup(account_id, "admin"))) {
      throw Error("only admins can cancel other user's payment intents");
    }
    const session = await getCurrentAuthSession({ req, account_id });
    await requireDangerousSessionAuth({
      account_id,
      session_hash: session.session_hash,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  }
  await executeBillingHttpCommand("cancel-payment-intent", {
    id,
    reason,
    ...(owner_id === account_id ? { expected_account_id: account_id } : {}),
  });
  return { success: true };
}
