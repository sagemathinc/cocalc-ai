/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CourseFundingCourseRequest } from "@cocalc/conat/hub/api/compute-funding";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { withProjectRehomeWriteFence } from "@cocalc/database/postgres/project-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { fundingId } from "@cocalc/util/compute-funding";
import type {
  CourseVmRecommendations,
  CourseVmTemplate,
} from "@cocalc/util/course-vm-template";
import { normalizeCourseVmTemplates } from "@cocalc/util/course-vm-template";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";

type ReadRequest = CourseFundingCourseRequest & { account_id?: string };
type WriteRequest = ReadRequest & {
  templates: CourseVmTemplate[];
  expected_version: number;
};
type ProjectRow = {
  owning_bay_id: string | null;
  role: string | null;
  recommendations: Record<string, CourseVmRecommendations> | null;
};
const MAX_COURSE_INSTANCES = 100;

function courseRequest(
  opts: CourseFundingCourseRequest,
): CourseFundingCourseRequest {
  return {
    course_project_id: fundingId(opts.course_project_id, "Course project"),
    course_instance_id: fundingId(opts.course_instance_id, "Course instance"),
  };
}

function actorRequest(opts: ReadRequest) {
  if (!opts.account_id) throw Error("must be signed in");
  return {
    ...courseRequest(opts),
    account_id: fundingId(opts.account_id, "Account"),
  };
}

async function projectDestination(course_project_id: string) {
  const ownership = await resolveProjectBay(course_project_id);
  if (!ownership) throw Error("course project not found");
  if (ownership.bay_id === getConfiguredBayId()) return;
  // This existing typed fabric service is only a transport: the destination is
  // the PROJECT owning bay, never the editor's or funding payer's account home.
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: ownership.bay_id,
    timeout: 10_000,
  });
}

function assertLocalProject(row?: ProjectRow) {
  if (!row) throw Error("course project not found");
  const owningBay =
    row.owning_bay_id ||
    (!isMultiBayCluster() ? getConfiguredBayId() : undefined);
  if (owningBay !== getConfiguredBayId())
    throw Error(
      "course recommendations require the project owning bay; reload and retry",
    );
}

function readEntry(
  row: ProjectRow,
  course_instance_id: string,
): CourseVmRecommendations {
  const entry = row.recommendations?.[course_instance_id];
  if (!entry) return { templates: [], version: 0 };
  if (!Number.isSafeInteger(entry.version) || entry.version < 0)
    throw Error("Invalid recommendation version");
  return {
    templates: normalizeCourseVmTemplates(entry.templates),
    version: entry.version,
  };
}

const READ_PROJECT = `SELECT owning_bay_id, users->$2->>'group' AS role,
  course_vm_recommendations AS recommendations FROM projects
  WHERE project_id=$1 AND deleted IS NOT TRUE`;

export async function getCourseVmRecommendations(
  opts: ReadRequest,
): Promise<CourseVmRecommendations> {
  const request = actorRequest(opts);
  const remote = await projectDestination(request.course_project_id);
  if (remote)
    return await remote.computeFundingGetCourseVmRecommendations(request);
  return await getCourseVmRecommendationsOnOwningBay(request);
}

export async function getCourseVmRecommendationsOnOwningBay(
  opts: ReadRequest,
): Promise<CourseVmRecommendations> {
  const request = actorRequest(opts);
  const {
    rows: [row],
  } = await getPool().query<ProjectRow>(READ_PROJECT, [
    request.course_project_id,
    request.account_id,
  ]);
  assertLocalProject(row);
  if (!isProjectCollaboratorRole(row.role))
    throw Error("course project collaborator access required");
  return readEntry(row, request.course_instance_id);
}

function writeRequest(opts: WriteRequest) {
  const request = actorRequest(opts);
  if (
    !Number.isSafeInteger(opts.expected_version) ||
    opts.expected_version < 0 ||
    opts.expected_version >= Number.MAX_SAFE_INTEGER
  ) {
    throw Error("Invalid expected recommendation version");
  }
  return {
    ...request,
    templates: normalizeCourseVmTemplates(opts.templates),
    expected_version: opts.expected_version,
  };
}

export async function setCourseVmRecommendations(
  opts: WriteRequest,
): Promise<CourseVmRecommendations> {
  const request = writeRequest(opts);
  const remote = await projectDestination(request.course_project_id);
  if (remote)
    return await remote.computeFundingSetCourseVmRecommendations(request);
  return await setCourseVmRecommendationsOnOwningBay(request);
}

export async function setCourseVmRecommendationsOnOwningBay(
  opts: WriteRequest,
): Promise<CourseVmRecommendations> {
  const request = writeRequest(opts);
  return await withProjectRehomeWriteFence({
    project_id: request.course_project_id,
    action: "save course VM recommendations",
    fn: async (db) => {
      // Lock and recheck ownership and collaborator access in the same transaction
      // as the versioned write, including when the caller arrived through RPC.
      const {
        rows: [row],
      } = await db.query(`${READ_PROJECT} FOR UPDATE`, [
        request.course_project_id,
        request.account_id,
      ]);
      assertLocalProject(row);
      if (!isProjectCollaboratorRole(row.role))
        throw Error("course project collaborator access required");
      const current = readEntry(row, request.course_instance_id);
      if (current.version !== request.expected_version)
        throw Error("Course VM recommendations changed; reload before saving");
      if (
        !row.recommendations?.[request.course_instance_id] &&
        Object.keys(row.recommendations ?? {}).length >= MAX_COURSE_INSTANCES
      ) {
        throw Error(
          "Too many course instances with VM recommendations in this project",
        );
      }
      const next = {
        templates: request.templates,
        version: current.version + 1,
      };
      await db.query(
        `UPDATE projects SET course_vm_recommendations =
        jsonb_set(COALESCE(course_vm_recommendations, '{}'::jsonb), $2::text[], $3::jsonb)
        WHERE project_id=$1`,
        [
          request.course_project_id,
          [request.course_instance_id],
          JSON.stringify(next),
        ],
      );
      return next;
    },
  });
}

/** Trusted inter-bay service only, not a public hub API. The payer-home source
 * discovery supplies course IDs from an authoritative beneficiary grant/pool
 * join. It publishes only allowlisted recommendation metadata to that recipient;
 * it neither impersonates the payer nor grants course-project access.
 */
export async function getPublishedCourseVmRecommendationsOnOwningBay(
  opts: CourseFundingCourseRequest,
): Promise<CourseVmRecommendations> {
  const request = courseRequest(opts);
  const {
    rows: [row],
  } = await getPool().query<ProjectRow>(READ_PROJECT, [
    request.course_project_id,
    null,
  ]);
  assertLocalProject(row);
  return readEntry(row, request.course_instance_id);
}

export async function getPublishedCourseVmRecommendations(
  opts: CourseFundingCourseRequest,
): Promise<CourseVmRecommendations> {
  const request = courseRequest(opts);
  const remote = await projectDestination(request.course_project_id);
  const result = remote
    ? await remote.computeFundingGetPublishedCourseVmRecommendations(request)
    : await getPublishedCourseVmRecommendationsOnOwningBay(request);
  return {
    templates: normalizeCourseVmTemplates(result.templates),
    version: result.version,
  };
}
