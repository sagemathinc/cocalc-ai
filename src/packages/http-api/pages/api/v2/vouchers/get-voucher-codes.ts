import getVoucherCodes from "@cocalc/server/vouchers/get-voucher-codes";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  try {
    const result = await doIt(req);
    res.json({ ...result, success: true });
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function doIt(req) {
  const { id } = getParams(req);
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  return { codes: await getVoucherCodes({ account_id, id }) };
}
