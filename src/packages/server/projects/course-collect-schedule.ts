/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { CourseCollectAssignmentItem } from "@cocalc/conat/hub/api/projects";
import { ensureLroSchema } from "@cocalc/server/lro/lro-db";

// Same value as COURSE_COLLECT_ASSIGNMENT_LRO_KIND in course-collect-worker.
export const SCHEDULED_COLLECTION_KIND = "course-collect-assignment";

// Add students to a scheduled collection that has not started yet (support
// #20954: students who receive an assignment after its collection was
// scheduled were never collected).
//
// One conditional UPDATE: it only changes a still-queued scheduled
// collection of this course and assignment, and it keeps every student the
// collection already lists, so additions from several browsers merge. Once
// the worker claims the collection (status running), nothing changes.
export async function addStudentsToScheduledCollection({
  op_id,
  course_project_id,
  assignment_id,
  items,
  max_items,
}: {
  op_id: string;
  course_project_id: string;
  assignment_id: string;
  items: CourseCollectAssignmentItem[];
  max_items: number;
}): Promise<{ updated: boolean; item_count?: number }> {
  await ensureLroSchema();
  const { rows } = await getPool().query<{ item_count: number }>(
    `WITH current AS (
       SELECT op_id, COALESCE(input->'items', '[]'::jsonb) AS items
         FROM long_running_operations
        WHERE op_id = $1
          AND kind = $2
          AND scope_type = 'project'
          AND scope_id = $3
          AND status = 'queued'
          AND input->>'assignment_id' = $4
          AND input ? 'run_at'
          FOR UPDATE
     ), merged AS (
       SELECT c.op_id,
              c.items || COALESCE((
                SELECT jsonb_agg(n.item)
                  FROM jsonb_array_elements($5::jsonb) AS n(item)
                 WHERE NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(c.items) AS e(item)
                    WHERE e.item->>'student_id' = n.item->>'student_id'
                 )
              ), '[]'::jsonb) AS items
         FROM current c
     )
     UPDATE long_running_operations o
        SET input = jsonb_set(o.input, '{items}', m.items),
            updated_at = now()
       FROM merged m
      WHERE o.op_id = m.op_id
        AND o.status = 'queued'
        AND jsonb_array_length(m.items) <= $6
     RETURNING jsonb_array_length(o.input->'items') AS item_count`,
    [
      op_id,
      SCHEDULED_COLLECTION_KIND,
      course_project_id,
      assignment_id,
      JSON.stringify(items),
      max_items,
    ],
  );
  if (rows.length === 0) return { updated: false };
  return { updated: true, item_count: Number(rows[0].item_count) };
}
