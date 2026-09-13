/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type {
  CourseFundingCourseRequest,
  CourseFundingSourceSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { getPublishedCourseVmRecommendations } from "./course-vm-recommendations";

const logger = getLogger("compute:funding:source-vm-recommendations");

/** Input course IDs must come from the payer-home grant/pool query, never the
 * beneficiary request. Deduplicate courses and bound cross-bay concurrency.
 * Optional metadata failure must not hide a valid funding source or select a
 * different payer. Omission means unavailable; [] means no recommendations.
 */
export async function attachSourceVmRecommendations(
  entries: {
    source: CourseFundingSourceSummary;
    course: CourseFundingCourseRequest;
  }[],
): Promise<void> {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = `${entry.course.course_project_id}:${entry.course.course_instance_id}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  await mapParallelLimit(
    [...groups.values()],
    async (group) => {
      try {
        const result = await getPublishedCourseVmRecommendations(
          group[0].course,
        );
        for (const { source } of group)
          source.recommended_vm_templates = result.templates;
      } catch (err) {
        logger.warn("course VM recommendations unavailable", {
          ...group[0].course,
          err,
        });
      }
    },
    4,
  );
}
