/*
Run arbitrary shell command in a project.
DOES check auth
*/

import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  ExecuteCodeOutput,
  ExecuteCodeOptions,
} from "@cocalc/util/types/execute-code";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";

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
  await assertProjectCollaboratorAccessAllowRemote({ account_id, project_id });

  const api = projectApiClient({
    client: await getExplicitProjectRoutedClient({ project_id }),
    project_id,
    timeout: execOpts.timeout ? execOpts.timeout * 1000 + 2000 : undefined,
  });
  return await api.system.exec(execOpts);
}
