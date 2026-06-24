/*
Set account {user/first/last} name.
*/

import userQuery from "@cocalc/database/user-query";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getCurrentAuthSession } from "@cocalc/server/auth/auth-sessions";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import { SuccessStatus } from "@cocalc/http-api/lib/api/status";
import {
  SetAccountNameInputSchema,
  SetAccountNameOutputSchema,
} from "@cocalc/http-api/lib/api/schema/accounts/set-name";
import {
  displayNameFromParts,
  normalizeDisplayName,
} from "@cocalc/util/accounts/display-name";

async function handle(req, res) {
  try {
    await get(req);
    res.json(SuccessStatus);
  } catch (err) {
    res.json({ error: `${err.message ? err.message : err}` });
    return;
  }
}

async function get(req) {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to edit account names");
  }

  const client_account_id = await getAccountId(req);

  if (client_account_id == null) {
    throw Error("Must be signed in to edit account name.");
  }

  const { display_name, first_name, last_name, account_id } = getParams(req);

  // This user MUST be an admin:
  if (account_id) {
    if (!(await userIsInGroup(client_account_id, "admin"))) {
      throw Error(
        "The `account_id` field may only be specified by account administrators.",
      );
    }
    const session = await getCurrentAuthSession({
      req,
      account_id: client_account_id,
    });
    await requireDangerousSessionAuth({
      account_id: client_account_id,
      session_hash: session.session_hash,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  }

  const displayName =
    normalizeDisplayName(display_name) ||
    displayNameFromParts({ first_name, last_name });
  if (!displayName) {
    throw Error("display_name must be nonempty");
  }

  return userQuery({
    account_id: account_id || client_account_id,
    query: {
      accounts: {
        display_name: displayName,
      },
    },
  });
}

export default apiRoute({
  setName: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Accounts", "Admin"],
    },
  })
    .input({
      contentType: "application/json",
      body: SetAccountNameInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: SetAccountNameOutputSchema,
      },
    ])
    .handler(handle),
});
