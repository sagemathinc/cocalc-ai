/*
Run arbitrary shell command in a project.
DOES check auth
*/

import { projectApiClient } from "@cocalc/conat/project/api";
import type {
  ExecuteCodeOutput,
  ExecuteCodeOptions,
} from "@cocalc/util/types/execute-code";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";
import isCollaborator from "@cocalc/server/projects/is-collaborator";

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
  if (!(await isCollaborator({ account_id, project_id }))) {
    throw Error("user must be collaborator on project");
  }

  await materializeProjectHost(project_id);
  const api = projectApiClient({
    client: conatWithProjectRouting(),
    project_id,
    timeout: execOpts.timeout ? execOpts.timeout * 1000 + 2000 : undefined,
  });
  return await api.system.exec(execOpts);
}
