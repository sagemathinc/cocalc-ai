import getAccountId from "@cocalc/http-api/lib/account/get-account";
import processPaymentIntents from "@cocalc/server/purchases/stripe/process-payment-intents";
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
    endpoint: "purchases/stripe/process-payment-intents",
  });
  return { count: await processPaymentIntents({ account_id }), success: true };
}
