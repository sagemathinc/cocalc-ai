/*
Resume a subscription.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import resumeSubscription from "@cocalc/server/purchases/resume-subscription";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { OkStatus } from "@cocalc/http-api/lib/api/status";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req) {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  const { subscription_id } = getParams(req);
  await resumeSubscription({ account_id, subscription_id });
  return OkStatus;
}
