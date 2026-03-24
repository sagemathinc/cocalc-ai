/*
Remove ban from a user.  This is ONLY allowed for admins.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { removeUserBan } from "@cocalc/server/accounts/ban";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import { SuccessStatus } from "@cocalc/http-api/lib/api/status";
import {
  RemoveAccountBanInputSchema,
  RemoveAccountBanOutputSchema,
} from "@cocalc/http-api/lib/api/schema/accounts/remove-ban";

async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req) {
  const account_id0 = await getAccountId(req);
  if (account_id0 == null) {
    throw Error("must be signed in");
  }
  // This user MUST be an admin:
  if (!(await userIsInGroup(account_id0, "admin"))) {
    throw Error("only admins can ban users");
  }

  const { account_id } = getParams(req);
  await removeUserBan(account_id);
  return SuccessStatus;
}

export default apiRoute({
  removeBan: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Accounts", "Admin"],
    },
  })
    .input({
      contentType: "application/json",
      body: RemoveAccountBanInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: RemoveAccountBanOutputSchema,
      },
    ])
    .handler(handle),
});
