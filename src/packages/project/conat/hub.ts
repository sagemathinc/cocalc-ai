/*
Calling the hub's conat api from a project.

The hub api is primarily for users, so most functions will give an error.
However, there are a few endpoints aimed at projects.
*/

import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { initHubApi } from "@cocalc/conat/hub/api";
import { project_id } from "@cocalc/project/data";
import { getProjectConatClient } from "./runtime-client";

async function callHub({
  client,
  service = "api",
  name,
  args = [],
  timeout,
}: {
  client: ConatClient;
  service?: string;
  name: string;
  args: any[];
  timeout?: number;
}) {
  const subject = `hub.project.${project_id}.${service}`;
  const resp = await client.request(subject, { name, args }, { timeout });
  return resp.data;
}

export function hubApi(client: ConatClient) {
  return initHubApi((opts) => callHub({ ...opts, client }));
}

export function getProjectHubApi() {
  return hubApi(getProjectConatClient());
}
