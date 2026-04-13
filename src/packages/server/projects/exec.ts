/*
Run arbitrary shell command in a project.
DOES check auth
*/

import { conatServer } from "@cocalc/backend/data";
import { connect as connectConat, type Client } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  ExecuteCodeOutput,
  ExecuteCodeOptions,
} from "@cocalc/util/types/execute-code";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import {
  issueProjectHostAuthToken,
  resolveHostConnection,
} from "@cocalc/server/conat/api/hosts";

function localProxyProjectHostAddress(
  apiBaseUrl: string,
  routeId: string,
): string {
  const url = new URL(apiBaseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${routeId}`.replace(/\/+/g, "/");
  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function connectProjectHostClient({
  account_id,
  host_id,
  project_id,
}: {
  account_id: string;
  host_id: string;
  project_id: string;
}): Promise<Client> {
  const connection = await resolveHostConnection({ account_id, host_id });
  const address = connection.local_proxy
    ? localProxyProjectHostAddress(conatServer, project_id)
    : `${connection.connect_url ?? ""}`.trim();
  if (!address) {
    throw new Error(
      `host '${host_id}' has no connect_url and is not local_proxy`,
    );
  }
  const issued = await issueProjectHostAuthToken({
    account_id,
    host_id,
    project_id,
  });
  const client = connectConat({
    address,
    noCache: true,
    forceNew: true,
    reconnection: false,
    inboxPrefix: inboxPrefix({ account_id }),
    auth: async (cb) => cb({ bearer: issued.token }),
  });
  await client.waitUntilSignedIn({ timeout: 30_000 });
  return client;
}

// checks auth and runs code
export default async function exec({
  account_id,
  project_id,
  execOpts,
}: {
  account_id: string;
  project_id: string;
  execOpts: ExecuteCodeOptions;
}): Promise<ExecuteCodeOutput> {
  const reference = await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id,
  });
  if (!reference.host_id) {
    throw new Error(`project ${project_id} has no assigned host`);
  }
  const client = await connectProjectHostClient({
    account_id,
    host_id: reference.host_id,
    project_id,
  });

  try {
    const api = projectApiClient({
      client,
      project_id,
      timeout: execOpts.timeout ? execOpts.timeout * 1000 + 2000 : undefined,
    });
    return await api.system.exec(execOpts);
  } finally {
    client.close();
  }
}
