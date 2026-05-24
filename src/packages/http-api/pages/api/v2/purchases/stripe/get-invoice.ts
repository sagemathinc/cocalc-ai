/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getInvoice } from "@cocalc/server/purchases/stripe/invoices";
import throttle from "@cocalc/util/api/throttle";

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req): Promise<object> {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to access Stripe billing details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  throttle({ account_id, endpoint: "purchases/stripe/get-invoice" });
  const { invoice_id } = getParams(req);
  if (!invoice_id) {
    throw Error("invoice_id must be specified");
  }
  return await getInvoice({ account_id, invoice_id });
}
