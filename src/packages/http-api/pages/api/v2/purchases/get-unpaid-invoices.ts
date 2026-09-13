/*
Get all unpaid invoices
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { executeBillingHttpCommand } from "@cocalc/server/purchases/billing-authority/client";

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
    throw Error("API keys are not allowed to access billing account details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  return await executeBillingHttpCommand("get-unpaid-invoices", {
    account_id,
  });
}
