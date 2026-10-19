/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";

const OWNER_CHECK_TIMEOUT_MS = 5_000;

/**
 * Course access to student projects (manager access, invite account repair)
 * is vouched for by the course project's owning bay only, which has checked
 * the caller's access to the course. source_bay_id is the authenticated
 * calling bay on a multibay fabric (typed inter-bay services enforce that).
 *
 * This bay's own row for the course project is no evidence: a bay keeps the
 * row of a project that later moved on (A -> B -> C leaves A saying B). The
 * calling bay is asked instead: a bay's row for a project it owned is
 * switched to the new owner when the project moves away, so only the current
 * owner names itself.
 */
export async function assertSentByCourseBay({
  source_bay_id,
  course_project_id,
}: {
  source_bay_id?: string;
  course_project_id: string;
}): Promise<void> {
  let owner: string | undefined;
  if (source_bay_id) {
    owner = (
      await getInterBayBridge()
        .directory(source_bay_id, { timeout_ms: OWNER_CHECK_TIMEOUT_MS })
        .resolveProjectBay({ project_id: course_project_id })
    )?.bay_id;
  }
  if (!source_bay_id || owner !== source_bay_id) {
    throw Object.assign(
      new Error(
        `course access for ${course_project_id} must come from its owning bay; ${source_bay_id ?? "an unnamed bay"} does not own it (it names ${owner ?? "no owner"})`,
      ),
      { code: 403 },
    );
  }
}
