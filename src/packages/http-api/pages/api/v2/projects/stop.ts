/*
API endpoint to stop a project running.

This requires the user to be signed in so they are allowed to use this project.
*/
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { stop as stopProject } from "@cocalc/server/conat/api/projects";
import getParams from "@cocalc/http-api/lib/api/get-params";

import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import {
  StopProjectInputSchema,
  StopProjectOutputSchema,
} from "@cocalc/http-api/lib/api/schema/projects/stop";
import { OkStatus } from "../../../../lib/api/status";

async function handle(req, res) {
  const { project_id } = getParams(req);
  const account_id = await getAccountId(req);

  try {
    if (!account_id) {
      throw Error("must be signed in");
    }
    await stopProject({ account_id, project_id });
    res.json(OkStatus);
  } catch (err) {
    res.json({ error: err.message });
  }
}

export default apiRoute({
  stopProject: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Projects"],
    },
  })
    .input({
      contentType: "application/json",
      body: StopProjectInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: StopProjectOutputSchema,
      },
    ])
    .handler(handle),
});
