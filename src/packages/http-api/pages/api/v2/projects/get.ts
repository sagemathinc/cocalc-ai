/* Get projects that the authenticated user is a collaborator on. */

import getProjects from "@cocalc/server/projects/get";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import { requireApiKeyCapability } from "@cocalc/server/api/api-key-scope";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { listProjectSummaries } from "@cocalc/server/conat/api/projects";

import {
  GetAccountProjectsInputSchema,
  GetAccountProjectsOutputSchema,
} from "@cocalc/http-api/lib/api/schema/projects/get";

async function handle(req, res) {
  const client_account_id = await getAccountId(req);
  try {
    if (client_account_id == null) {
      throw Error("Must be signed in.");
    }

    const { account_id, limit, offset, search } = getParams(req);

    if (req.header("Authorization")) {
      const principal = await getAccountFromApiKey(req);
      if (
        !principal?.account_id ||
        principal.account_id !== client_account_id
      ) {
        throw Error("must be signed in with a valid account API key");
      }
      requireApiKeyCapability(principal, "project:list");
      if (account_id && account_id !== client_account_id) {
        throw Error("API keys may only list projects for their own account");
      }
      const page = await listProjectSummaries({
        account_id: principal.account_id,
        limit: limit ?? 50,
        offset: offset ?? 0,
        search: search ?? undefined,
      });
      if (page.next_offset != null) {
        res.setHeader("X-CoCalc-Next-Offset", String(page.next_offset));
      }
      // Keep the legacy array shape; admission, ownership, and paging are shared.
      res.json(
        page.projects.map(({ project_id, title, description }) => ({
          project_id,
          title,
          description,
        })),
      );
      return;
    }

    // User must be an admin to specify account_id field
    //
    if (
      account_id &&
      account_id !== client_account_id &&
      !(await userIsInGroup(client_account_id, "admin"))
    ) {
      throw Error(
        "The `account_id` field may only be specified by account administrators.",
      );
    }

    res.json(
      await getProjects({
        account_id: account_id || client_account_id,
        limit,
        offset,
        search,
      }),
    );
  } catch (err) {
    res.json({ error: err.message });
  }
}

export default apiRoute({
  getProject: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Projects", "Admin"],
    },
  })
    .input({
      contentType: "application/json",
      body: GetAccountProjectsInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: GetAccountProjectsOutputSchema,
      },
    ])
    .handler(handle),
});
