/*
Let user set one of their purchase quotas.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import {
  setPurchaseQuota,
  getPurchaseQuotas,
  PurchaseQuotas,
} from "@cocalc/server/purchases/purchase-quotas";

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

async function get(req): Promise<PurchaseQuotas> {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { service, value } = getParams(req);
  await setPurchaseQuota({ account_id, service, value: parseFloat(value) });
  // it worked, so we return the new quotas
  return await getPurchaseQuotas(account_id);
}
