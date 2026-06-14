import getAccountId from "@cocalc/http-api/lib/account/get-account";
import createSetupIntent from "@cocalc/server/purchases/stripe/create-setup-intent";
import getParams from "@cocalc/http-api/lib/api/get-params";
import throttle from "@cocalc/util/api/throttle";

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
  throttle({ account_id, endpoint: "purchases/stripe/create-setup-intent" });
  const { description } = getParams(req);
  return await createSetupIntent({
    account_id,
    description,
  });
}
