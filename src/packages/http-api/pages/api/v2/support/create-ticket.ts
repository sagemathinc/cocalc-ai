/*
Create a support ticket.
*/

import createSupportTicket from "@cocalc/server/support/create-ticket";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";

export default async function handle(req, res) {
  const { options } = getParams(req);

  let url;
  try {
    if (req.header("Authorization")) {
      throw Error("API keys are not allowed to create support tickets");
    }
    const account_id = await getAccountId(req);
    url = await createSupportTicket({
      ...(options ?? {}),
      account_id,
      ip_address: req.ip ?? req.socket?.remoteAddress,
    });
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
  res.json({ url });
}
