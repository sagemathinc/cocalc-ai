/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which conat client reaches a project's board-decide service
// (conat/project/board-decide.ts), from the project's owning bay, where
// system.boardDecide runs (conat/hub/api/routes.ts).
//
// The service is served where the project's files are: on its project host,
// or, in the workspace runtime, by this bay's own file server
// (server/conat/project/run.ts). So: the bay's own client in the workspace
// runtime, and otherwise a client routed explicitly to the project's host,
// as the hub's other project-file calls do (conat/api/projects.ts projectFs).
// Never the cached default client: nothing guarantees it is routed, and a
// request on it would stay on the bay and time out (Codex on #1134).

import type { Client } from "@cocalc/conat/core/client";
import { conat } from "@cocalc/backend/conat";
import { isWorkspaceProjectRuntime } from "@cocalc/project-runner/runtime-mode";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";

export async function boardDecideClient(project_id: string): Promise<Client> {
  if (isWorkspaceProjectRuntime()) return await conat();
  return await getExplicitProjectRoutedClient({ project_id });
}
