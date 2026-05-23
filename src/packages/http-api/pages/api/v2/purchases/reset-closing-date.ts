/*
Set closing day to today (or 1 if today is >=29).
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import resetClosingDate from "@cocalc/server/purchases/reset-closing-date";
import { OkStatus } from "@cocalc/http-api/lib/api/status";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";

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
  await resetClosingDate(account_id);
  return OkStatus;
}
