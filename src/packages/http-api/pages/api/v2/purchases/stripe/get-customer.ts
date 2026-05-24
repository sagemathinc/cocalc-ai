import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { getCustomer } from "@cocalc/server/purchases/stripe/customer";
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
    throw Error("API keys are not allowed to access Stripe billing details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  throttle({ account_id, endpoint: "purchases/stripe/get-customer" });
  return await getCustomer(account_id);
}
