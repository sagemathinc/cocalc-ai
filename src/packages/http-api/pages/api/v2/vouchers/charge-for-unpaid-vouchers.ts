import chargeForUnpaidVouchers from "@cocalc/server/vouchers/charge-for-unpaid-vouchers";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { requireFreshAuth } from "@cocalc/server/auth/auth-sessions";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";

export default async function handle(req, res) {
  try {
    const result = await doIt(req);
    res.json({ ...result, success: true });
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...(err?.code != null ? { code: err.code } : {}),
    });
    return;
  }
}

async function doIt(req) {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to manage voucher codes");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in to charge for unpaid vouchers");
  }
  if (!(await userIsInGroup(account_id, "admin"))) {
    throw Error("only admins can initiate the charge for unpaid vouchers");
  }
  await requireFreshAuth({ req, account_id, allow_actor_impersonation: false });

  return await chargeForUnpaidVouchers();
}
