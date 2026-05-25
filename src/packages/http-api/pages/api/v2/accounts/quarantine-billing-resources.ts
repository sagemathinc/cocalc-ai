/*
Quarantine a user's billing and paid resources. This is ONLY allowed for admins.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { quarantineClusterAccountBillingResources } from "@cocalc/server/inter-bay/accounts";
import { getCurrentAuthSession } from "@cocalc/server/auth/auth-sessions";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import {
  QuarantineBillingResourcesInputSchema,
  QuarantineBillingResourcesOutputSchema,
} from "@cocalc/http-api/lib/api/schema/accounts/quarantine-billing-resources";

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
  if (!(await userIsInGroup(account_id0, "admin"))) {
    throw Error("only admins can quarantine account billing/resources");
  }
  const session = await getCurrentAuthSession({ req, account_id: account_id0 });
  await requireDangerousSessionAuth({
    account_id: account_id0,
    session_hash: session.session_hash,
    require_second_factor: true,
  });

  const { account_id, reason } = getParams(req);
  const result = await quarantineClusterAccountBillingResources({
    account_id,
    actor_account_id: account_id0,
    reason,
  });
  return { status: "success", result };
}

export default apiRoute({
  quarantineBillingResources: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Accounts", "Admin"],
    },
  })
    .input({
      contentType: "application/json",
      body: QuarantineBillingResourcesInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: QuarantineBillingResourcesOutputSchema,
      },
    ])
    .handler(handle),
});
