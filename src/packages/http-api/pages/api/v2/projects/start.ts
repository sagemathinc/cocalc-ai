/*
API endpoint to start a project running.

This requires the user to be signed in so they are allowed to use this project.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { start as startProject } from "@cocalc/server/conat/api/projects";
import getParams from "@cocalc/http-api/lib/api/get-params";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import { OkStatus } from "@cocalc/http-api/lib/api/status";
import {
  StartProjectInputSchema,
  StartProjectOutputSchema,
} from "@cocalc/http-api/lib/api/schema/projects/start";

async function handle(req, res) {
  const { project_id } = getParams(req);
  const account_id = await getAccountId(req);

  try {
    if (!account_id) {
      throw Error("must be signed in");
    }
    await startProject({ account_id, project_id, wait: false });
    res.json(OkStatus);
  } catch (err) {
    res.json({ error: err.message });
  }
}

export default apiRoute({
  startProject: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Projects"],
    },
  })
    .input({
      contentType: "application/json",
      body: StartProjectInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: StartProjectOutputSchema,
      },
    ])
    .handler(handle),
});
