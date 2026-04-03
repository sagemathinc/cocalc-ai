/*
Run arbitrary shell command in a project.
DOES check auth
*/

import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  ExecuteCodeOutput,
  ExecuteCodeOptions,
} from "@cocalc/util/types/execute-code";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";

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
  await assertLocalProjectCollaborator({ account_id, project_id });

  await materializeProjectHost(project_id);
  const api = projectApiClient({
    client: conatWithProjectRouting(),
    project_id,
    timeout: execOpts.timeout ? execOpts.timeout * 1000 + 2000 : undefined,
  });
  return await api.system.exec(execOpts);
}
