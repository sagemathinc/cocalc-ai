/*
Get information about this user's activity to help them
better find things.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { fileAccess } from "@cocalc/server/projects/document-activity";

export default async function handle(req, res) {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    // no usage to list, since not signed in.
    res.json({ files: [] });
    return;
  }

  let { interval } = getParams(req);

  try {
    const files = await fileAccess({ account_id, interval });
    res.json({ files });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
