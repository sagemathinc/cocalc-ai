/*
Search for accounts matching a given query.

If user is signed in, then their account_id is used to prioritize the search.
*/

import { searchClusterAccounts } from "@cocalc/server/inter-bay/accounts";
import type { UserSearchResult as User } from "@cocalc/util/db-schema/accounts";
import getParams from "@cocalc/http-api/lib/api/get-params";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import {
  AccountSearchInputSchema,
  AccountSearchOutputSchema,
} from "@cocalc/http-api/lib/api/schema/accounts/search";

async function handle(req, res) {
  try {
    return res.json(await doUserSearch(req));
  } catch (err) {
    res.json({ error: err.message });
  }
}

async function doUserSearch(req): Promise<User[]> {
  const { query } = getParams(req);
  return await searchClusterAccounts({ query });
}

export default apiRoute({
  search: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Accounts"],
    },
  })
    .input({
      contentType: "application/json",
      body: AccountSearchInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: AccountSearchOutputSchema,
      },
    ])
    .handler(handle),
});
