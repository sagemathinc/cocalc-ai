// Bridge project calls through the server-side Conat client.

import { projectSubject } from "@cocalc/conat/names";
import { conat } from "@cocalc/backend/conat";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
const DEFAULT_TIMEOUT = 15000;

let defaultClient: ConatClient | null = null;
export function getDefaultServerProjectConatClient(): ConatClient {
  defaultClient ??= conat();
  return defaultClient;
}

export default async function projectBridge({
  project_id,
  name,
  args,
  timeout,
  client,
}: {
  project_id: string;
  name: string;
  args?: any[];
  timeout?: number;
  client?: ConatClient;
}) {
  return await callProject({
    client: client ?? getDefaultServerProjectConatClient(),
    project_id,
    name,
    args,
    timeout,
  });
}

async function callProject({
  client,
  project_id,
  name,
  args = [],
  timeout = DEFAULT_TIMEOUT,
}: {
  client: ConatClient;
  project_id: string;
  name: string;
  args?: any[];
  timeout?: number;
}) {
  const subject = projectSubject({
    project_id,
    service: "api",
  });
  try {
    const data = { name, args };
    // we use waitForInterest because often the project hasn't
    // quite fully started.
    const resp = await client.request(subject, data, {
      timeout,
      waitForInterest: true,
    });
    return resp.data;
  } catch (err) {
    err.message = `${err.message} - callHub: subject='${subject}', name='${name}', code='${err.code}' `;
    throw err;
  }
}
