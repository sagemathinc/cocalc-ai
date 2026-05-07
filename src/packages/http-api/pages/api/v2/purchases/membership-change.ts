/*
Apply a membership change using account balance (no external payment).
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import { applyMembershipChange } from "@cocalc/server/purchases/membership-change";

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
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: true });
  const { class: targetClass, interval, allow_downgrade } = req.body ?? {};
  if (!targetClass) {
    throw Error("membership class is required");
  }
  if (interval !== "month" && interval !== "year") {
    throw Error("interval must be 'month' or 'year'");
  }

  return await applyMembershipChange({
    account_id,
    targetClass,
    interval,
    allowDowngrade: !!allow_downgrade,
    storeVisibleOnly: true,
    requireNoPayment: true,
  });
}
