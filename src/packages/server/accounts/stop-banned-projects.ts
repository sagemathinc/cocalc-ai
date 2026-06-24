/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { stopProjectOnHost } from "@cocalc/server/project-host/control";
import { releaseProjectRuntimeSlot } from "@cocalc/server/projects/runtime-slots";
import { loadProjectRuntimeSponsor } from "@cocalc/server/projects/runtime-sponsor-db";

const logger = getLogger("server:accounts:stop-banned-projects");

type BannedAccountProjectRow = {
  project_id: string;
  state?: { state?: string } | null;
};

async function listBannedAccountRunningProjects(
  account_id: string,
): Promise<BannedAccountProjectRow[]> {
  const { rows } = await getPool("medium").query<BannedAccountProjectRow>(
    `
      SELECT project_id, state
        FROM projects
       WHERE COALESCE(deleted, false) IS NOT TRUE
         AND COALESCE(state->>'state', '') IN ('running', 'starting', 'pending')
         AND (
           COALESCE(users -> $1::text ->> 'group', '') = 'owner'
           OR usage_account_id = $1::uuid
           OR runtime_sponsor_account_id = $1::uuid
         )
    `,
    [account_id],
  );
  return rows;
}

async function stopProjectForBannedAccount({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  const sponsor = await loadProjectRuntimeSponsor(project_id);
  await stopProjectOnHost(project_id);
  await releaseProjectRuntimeSlot({
    sponsor_account_id: sponsor.sponsor_account_id,
    project_id,
    state: "released",
  }).catch((err) => {
    logger.warn("failed to release runtime slot after banning account", {
      account_id,
      project_id,
      sponsor_account_id: sponsor.sponsor_account_id,
      err: `${err}`,
    });
  });
}

export async function stopRunningProjectsForBannedAccount(
  account_id: string,
): Promise<{ stopped: number; failed: number; total: number }> {
  const projects = await listBannedAccountRunningProjects(account_id);
  let stopped = 0;
  let failed = 0;
  for (const project of projects) {
    try {
      await stopProjectForBannedAccount({
        account_id,
        project_id: project.project_id,
      });
      stopped += 1;
    } catch (err) {
      failed += 1;
      logger.warn("failed stopping project after banning account", {
        account_id,
        project_id: project.project_id,
        state: project.state?.state,
        err: `${err}`,
      });
    }
  }
  if (projects.length > 0) {
    logger.warn("stopped running projects after banning account", {
      account_id,
      stopped,
      failed,
      total: projects.length,
    });
  }
  return { stopped, failed, total: projects.length };
}
