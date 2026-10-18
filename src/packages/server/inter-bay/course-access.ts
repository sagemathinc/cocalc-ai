/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";

/**
 * Course access to student projects (manager access, invite account repair)
 * is vouched for by the course project's owning bay only, which has checked
 * the caller's access to the course. source_bay_id is the authenticated
 * calling bay (typed inter-bay services enforce that); it must own the course
 * project.
 */
export async function assertSentByCourseBay({
  source_bay_id,
  course_project_id,
}: {
  source_bay_id?: string;
  course_project_id: string;
}): Promise<void> {
  const owner = (await resolveProjectBay(course_project_id))?.bay_id;
  if (!source_bay_id || owner !== source_bay_id) {
    throw Object.assign(
      new Error(
        `course access for ${course_project_id} must come from its owning bay (${owner ?? "unknown"}), not ${source_bay_id ?? "an unnamed bay"}`,
      ),
      { code: 403 },
    );
  }
}
