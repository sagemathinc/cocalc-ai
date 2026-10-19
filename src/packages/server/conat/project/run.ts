/*
DEV

Start this in nodejs

   require('@cocalc/project-runner/conat/project/run').init()
*/

import { init as initProjectRunner } from "@cocalc/project-runner/run";
import { loadConatConfiguration } from "../configuration";
import { conat } from "@cocalc/backend/conat";
import getLogger from "@cocalc/backend/logger";
import { isWorkspaceProjectRuntime } from "@cocalc/project-runner/runtime-mode";
import {
  startWorkspaceFilesystem,
  workspaceProjectFilesystem,
} from "./workspace-filesystem";
import { initBoardDecideService } from "@cocalc/backend/sagebrush-board/service";

const logger = getLogger("server:conat:project:run");

const servers: any[] = [];
let workspaceFilesystem: Awaited<
  ReturnType<typeof startWorkspaceFilesystem>
> | null = null;
let workspaceBoardDecide: Awaited<
  ReturnType<typeof initBoardDecideService>
> | null = null;
export async function init(count: number = 1) {
  logger.debug("init project runner(s)", { count });
  await loadConatConfiguration();
  const client = conat();
  if (isWorkspaceProjectRuntime() && workspaceFilesystem == null) {
    workspaceFilesystem = await startWorkspaceFilesystem({ client });
    // Boards are read where their files are served: here, in this runtime
    // (on a project host otherwise, project-host/main.ts).
    workspaceBoardDecide = await initBoardDecideService(client, {
      projectFilesystem: async (project_id) =>
        workspaceProjectFilesystem({ project_id }),
    });
  }
  for (let i = 0; i < count; i++) {
    const server = await initProjectRunner({ client, id: `${i}` });
    servers.push(server);
  }
}

export function close() {
  for (const server of servers) {
    void server.close();
  }
  servers.length = 0;
  workspaceFilesystem?.close();
  workspaceFilesystem = null;
  workspaceBoardDecide?.close();
  workspaceBoardDecide = null;
}
