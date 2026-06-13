import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
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
  const { checkout_session_id, payment_intent_id, strict } = getParams(req);
  const opts: {
    account_id: string;
    checkout_session_id?: string;
    payment_intent_id?: string;
    strict?: boolean;
  } = { account_id };
  if (checkout_session_id != null) {
    opts.checkout_session_id = checkout_session_id;
  }
  if (payment_intent_id != null) {
    opts.payment_intent_id = payment_intent_id;
  }
  if (strict != null) {
    opts.strict = strict === true || strict === "true";
  }
  return {
    count: await processPaymentIntents(opts),
    success: true,
  };
}
