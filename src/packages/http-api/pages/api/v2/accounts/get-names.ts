/*
Get first and last name for a list of account_id's.

The output is an object {names:{[account_id]:{first_name:string;last_name:string}}},
where the value for a given account_id is not given if that account does not
exist or was deleted (instead of an error).

There is about 30s of caching if you call this with the same input twice.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { requireApiKeyCapability } from "@cocalc/server/api/api-key-scope";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import {
  getNames,
  validateGetNamesAccountIds,
} from "@cocalc/server/accounts/get-name";

export default async function handle(req, res) {
  try {
    let account_id: string | undefined;
    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (principal != null) {
        requireApiKeyCapability(principal, "account:read");
        account_id = principal.account_id;
      }
    } else {
      account_id = await getAccountId(req);
    }
    if (account_id == null) {
      res.json({ error: "must be signed in" });
      return;
    }

    const account_ids = validateGetNamesAccountIds(getParams(req).account_ids);
    const names = await getNames(account_ids);
    res.json({ names });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
