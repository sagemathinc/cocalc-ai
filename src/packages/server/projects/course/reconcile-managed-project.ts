/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import centralLog from "@cocalc/database/postgres/central-log";
import { isDeepStrictEqual } from "node:util";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import type {
  ProjectCourseManagedProjectState,
  ProjectCourseManagedProjectStatesRequest,
  ProjectReconcileCourseManagedProjectRequest,
  ProjectReconcileCourseManagedProjectResult,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import {
  inviteCollaborator,
  inviteCollaboratorWithoutAccount,
} from "@cocalc/server/projects/collaborators";
import { normalizeCoursePath } from "@cocalc/util/course-path";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("projects:course:reconcile-managed-project");

type ProjectUser = {
  group?: "owner" | "collaborator" | "viewer";
  hide?: boolean;
  [key: string]: unknown;
};

interface ProjectRow {
  users: Record<string, ProjectUser> | null;
  course: Record<string, unknown> | null;
  title: string | null;
  description: string | null;
  env: Record<string, string> | null;
}

interface CourseManagedProjectPlan {
  changedFields: Set<string>;
  missingDesiredAccountIds: string[];
  nextCourse: Record<string, unknown>;
  users: Record<string, ProjectUser>;
  usersChanged: boolean;
}

const MAX_BULK_PROJECTS = 1_000;

function inviteContext(
  request: ProjectReconcileCourseManagedProjectRequest,
): Record<string, unknown> {
  return {
    course_project_id: request.course_project_id,
    course_path: request.course_path,
    student_id: request.student_id,
    student_project_id: request.project_id,
    require_invite_email_match:
      request.course.require_invite_email_match === true,
  };
}

async function updatePendingCourseEmailInvitePolicy(
  request: ProjectReconcileCourseManagedProjectRequest,
): Promise<void> {
  if (request.type !== "student" || !request.student_id) return;
  const required = request.course.require_invite_email_match === true;
  await getPool().query(
    `UPDATE project_collab_invites
        SET context=jsonb_set(
              COALESCE(context, '{}'::jsonb),
              '{require_invite_email_match}',
              to_jsonb($3::boolean),
              true
            ),
            updated=NOW()
      WHERE project_id=$1
        AND status='pending'
        AND invite_source IN ('email', 'course_email')
        AND scope='course_student'
        AND (
          context ->> 'student_id' = $2
          OR context ->> 'student_project_id' = $1::text
        )
        AND context -> 'require_invite_email_match'
              IS DISTINCT FROM to_jsonb($3::boolean)`,
    [request.project_id, request.student_id, required],
  );
}

function uniqueAccountIds(ids: string[], name: string): string[] {
  const result = new Set<string>();
  for (const raw of ids) {
    const account_id = `${raw ?? ""}`.trim();
    if (!account_id) continue;
    if (!isValidUUID(account_id)) {
      throw new Error(`invalid ${name}: ${account_id}`);
    }
    result.add(account_id);
  }
  return [...result];
}

function sameJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a ?? null, b ?? null);
}

function validateCourseManagedProjectRequest(
  request: ProjectReconcileCourseManagedProjectRequest,
): {
  desiredAccountIds: Set<string>;
  managerAccountIds: string[];
  requestedDesiredAccountIds: string[];
} {
  const { account_id, course_project_id, project_id } = request;
  if (
    !isValidUUID(account_id) ||
    !isValidUUID(course_project_id) ||
    !isValidUUID(project_id)
  ) {
    throw new Error("invalid course reconfiguration identifier");
  }
  const managerAccountIds = uniqueAccountIds(
    request.manager_account_ids,
    "manager account id",
  );
  if (!managerAccountIds.includes(account_id)) {
    throw new Error("course operation creator is no longer a course manager");
  }
  const requestedDesiredAccountIds = uniqueAccountIds(
    request.desired_account_ids,
    "desired account id",
  );
  return {
    managerAccountIds,
    requestedDesiredAccountIds,
    desiredAccountIds: new Set([
      ...managerAccountIds,
      ...requestedDesiredAccountIds,
    ]),
  };
}

function planCourseManagedProjectReconciliation(
  request: ProjectReconcileCourseManagedProjectRequest,
  row: ProjectRow,
): CourseManagedProjectPlan {
  const { account_id, course_project_id, type } = request;
  const { desiredAccountIds, managerAccountIds, requestedDesiredAccountIds } =
    validateCourseManagedProjectRequest(request);
  let course = {
    ...request.course,
    project_id: course_project_id,
    path: normalizeCoursePath(request.course_path),
  };
  const users = { ...(row.users ?? {}) };
  const currentCourse = row.course;
  const currentCourseProjectId = `${currentCourse?.project_id ?? ""}`;
  if (currentCourseProjectId && currentCourseProjectId !== course_project_id) {
    throw new Error("project belongs to a different course project");
  }
  const knownManagerOwnsProject = managerAccountIds.some((id) => {
    const group = users[id]?.group;
    return group === "owner" || group === "collaborator";
  });
  if (!currentCourseProjectId && !knownManagerOwnsProject) {
    throw new Error(
      "cannot repair course metadata because no current course manager has project access",
    );
  }

  const preserveStudentCourse =
    type === "nbgrader" && currentCourse?.type === "student";
  let resolvedStudentAccountId: string | undefined;
  if (type === "student" && request.student_deleted !== true) {
    if (requestedDesiredAccountIds.length > 1) {
      throw new Error(
        "a student project cannot have multiple assigned students",
      );
    }
    const requestedCourseAccountId = `${course.account_id ?? ""}`.trim();
    const requestedDesiredAccountId = requestedDesiredAccountIds[0];
    if (
      isValidUUID(requestedCourseAccountId) &&
      requestedDesiredAccountId &&
      requestedCourseAccountId !== requestedDesiredAccountId
    ) {
      throw new Error("student account bindings do not match");
    }
    const requestedStudentAccountId =
      (isValidUUID(requestedCourseAccountId)
        ? requestedCourseAccountId
        : undefined) ?? requestedDesiredAccountId;
    const currentStudentAccountId = `${currentCourse?.account_id ?? ""}`.trim();
    if (
      requestedStudentAccountId &&
      isValidUUID(currentStudentAccountId) &&
      requestedStudentAccountId !== currentStudentAccountId
    ) {
      // The project is already bound to a (possibly just-accepted) student.
      // A request naming someone else is stale or conflicting; never let it
      // reassign the project and remove the bound student (support #20986).
      throw new Error(
        "student account binding conflict: the project is bound to a different student account",
      );
    }
    if (requestedStudentAccountId) {
      resolvedStudentAccountId = requestedStudentAccountId;
      desiredAccountIds.add(requestedStudentAccountId);
    } else if (isValidUUID(currentStudentAccountId)) {
      // Accepting a course email invite records the student account on the
      // authoritative project before the collaborative course document may
      // observe it. Do not let that stale roster snapshot erase the binding.
      resolvedStudentAccountId = currentStudentAccountId;
      course = { ...course, account_id: currentStudentAccountId };
      desiredAccountIds.add(currentStudentAccountId);
    }
    if (
      resolvedStudentAccountId &&
      managerAccountIds.includes(resolvedStudentAccountId)
    ) {
      throw new Error(
        "a course manager cannot also be assigned as a student; use a separate student account",
      );
    }
  }
  if (type === "student" && request.student_deleted === true) {
    // Deleting a student removes their access (below, subject to the
    // collaborator policy), but must not rewrite who the project belongs to.
    // The roster entry may never have learned the account that accepted the
    // invite; erasing the binding then would leave a restored (undeleted)
    // student with no way back into their project.
    const requestedCourseAccountId = `${course.account_id ?? ""}`.trim();
    const currentStudentAccountId = `${currentCourse?.account_id ?? ""}`.trim();
    if (isValidUUID(currentStudentAccountId)) {
      if (
        isValidUUID(requestedCourseAccountId) &&
        requestedCourseAccountId !== currentStudentAccountId
      ) {
        throw new Error(
          "student account binding conflict: the project is bound to a different student account",
        );
      }
      course = { ...course, account_id: currentStudentAccountId };
    }
  }
  const nextCourse = preserveStudentCourse ? currentCourse : course;
  const hasResolvedStudentAccount = resolvedStudentAccountId != null;
  const missingDesiredAccountIds = [...desiredAccountIds].filter(
    (desiredAccountId) =>
      !managerAccountIds.includes(desiredAccountId) &&
      users[desiredAccountId] == null,
  );
  const changedFields = new Set<string>();
  if (!sameJson(row.course, nextCourse)) {
    changedFields.add("course");
  }

  let usersChanged = false;
  for (const managerAccountId of managerAccountIds) {
    const group = users[managerAccountId]?.group;
    if (group !== "owner" && group !== "collaborator") {
      users[managerAccountId] = {
        ...(users[managerAccountId] ?? {}),
        group: "collaborator",
      };
      usersChanged = true;
    }
  }
  if (users[account_id] && users[account_id].hide !== true) {
    users[account_id] = { ...users[account_id], hide: true };
    usersChanged = true;
  }
  // A student may accept an email invite before the collaborative course
  // roster observes their account id. Until identity resolves, preserving
  // extra collaborators is safer than removing the newly accepted student.
  const mayRemoveUnexpectedCollaborators =
    type !== "student" ||
    request.student_deleted === true ||
    hasResolvedStudentAccount;
  const removeUnexpectedCollaborators =
    mayRemoveUnexpectedCollaborators &&
    (!request.allow_collabs ||
      (type === "student" &&
        request.course.student_project_functionality?.disableCollaborators ===
          true));
  if (removeUnexpectedCollaborators) {
    for (const [existingAccountId, info] of Object.entries(users)) {
      if (
        info?.group !== "owner" &&
        !desiredAccountIds.has(existingAccountId)
      ) {
        delete users[existingAccountId];
        usersChanged = true;
      }
    }
  }

  if (request.title !== undefined && row.title !== request.title) {
    changedFields.add("title");
  }
  if (
    request.description !== undefined &&
    row.description !== request.description
  ) {
    changedFields.add("description");
  }
  if (request.env !== undefined && !sameJson(row.env, request.env)) {
    changedFields.add("env");
  }
  return {
    changedFields,
    missingDesiredAccountIds,
    nextCourse,
    users,
    usersChanged,
  };
}

export function courseManagedProjectNeedsReconcile(
  request: ProjectReconcileCourseManagedProjectRequest,
  state: ProjectCourseManagedProjectState,
): boolean {
  if (request.send_email_invite) return true;
  try {
    const plan = planCourseManagedProjectReconciliation(request, state);
    return (
      plan.usersChanged ||
      plan.changedFields.size > 0 ||
      plan.missingDesiredAccountIds.length > 0
    );
  } catch {
    // The locked reconciliation path reports validation and ownership errors.
    return true;
  }
}

export async function getCourseManagedProjectStatesLocal({
  project_ids,
}: ProjectCourseManagedProjectStatesRequest): Promise<
  ProjectCourseManagedProjectState[]
> {
  const ids = uniqueAccountIds(project_ids, "project id");
  if (ids.length > MAX_BULK_PROJECTS) {
    throw new Error(
      `too many course-managed projects (${ids.length}/${MAX_BULK_PROJECTS})`,
    );
  }
  if (ids.length === 0) return [];
  const bay_id = getConfiguredBayId();
  const { rows } = await getPool().query<ProjectCourseManagedProjectState>(
    `SELECT project_id::text, users, course, title, description, env
      FROM projects
      WHERE project_id=ANY($1::uuid[])
        AND deleted IS NULL
        AND COALESCE(owning_bay_id, $2)=$2`,
    [ids, bay_id],
  );
  return rows;
}

export async function reconcileCourseManagedProjectLocal(
  request: ProjectReconcileCourseManagedProjectRequest,
): Promise<ProjectReconcileCourseManagedProjectResult> {
  const { account_id, project_id } = request;
  validateCourseManagedProjectRequest(request);
  const client = await getPool().connect();
  let usersChanged = false;
  let removedAccountIds: string[] = [];
  let previousCourse: any = null;
  let missingDesiredAccountIds: string[] = [];
  const changedFields = new Set<string>();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "reconfigure managed course project",
    });
    const { rows } = await client.query<ProjectRow>(
      `SELECT users, course, title, description, env
         FROM projects
        WHERE project_id=$1
          AND deleted IS NULL
        FOR UPDATE`,
      [project_id],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`project ${project_id} not found on its owning bay`);
    }
    const plan = planCourseManagedProjectReconciliation(request, row);
    removedAccountIds = Object.keys(row.users ?? {}).filter(
      (id) => plan.users[id] == null,
    );
    previousCourse = row.course ?? null;
    usersChanged = plan.usersChanged;
    missingDesiredAccountIds = plan.missingDesiredAccountIds;
    for (const field of plan.changedFields) changedFields.add(field);
    if (usersChanged || changedFields.size > 0) {
      await client.query(
        `UPDATE projects
            SET users=$2::jsonb,
                course=$3::jsonb,
                title=COALESCE($4::text, title),
                description=COALESCE($5::text, description),
                env=CASE WHEN $6::boolean THEN $7::jsonb ELSE env END
          WHERE project_id=$1`,
        [
          project_id,
          JSON.stringify(plan.users),
          JSON.stringify(plan.nextCourse),
          request.title ?? null,
          request.description ?? null,
          request.env !== undefined,
          JSON.stringify(request.env ?? null),
        ],
      );
    }
    if (usersChanged) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.membership_changed",
        project_id,
      });
    }
    if (changedFields.has("title") || changedFields.has("description")) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.summary_changed",
        project_id,
      });
    }
    await client.query("COMMIT");
    if (removedAccountIds.length > 0) {
      // Membership removals must be traceable (support #20986: a student
      // vanished from a project after accepting its invite, with no record).
      await centralLog({
        event: "project_collaborator_removed",
        value: {
          via: "course-reconcile",
          project_id,
          actor_account_id: account_id,
          removed_account_ids: removedAccountIds,
          course_project_id: request.course_project_id,
          type: request.type,
          student_id: request.student_id,
          student_deleted: request.student_deleted === true,
          previous_course_type: previousCourse?.type ?? null,
          previous_course_account_id: previousCourse?.account_id ?? null,
          requested_course_account_id: request.course?.account_id ?? null,
          requested_desired_account_ids: request.desired_account_ids ?? [],
          allow_collabs: request.allow_collabs ?? null,
          disable_collaborators:
            request.course?.student_project_functionality
              ?.disableCollaborators ?? null,
        },
      }).catch(() => undefined);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (changedFields.size > 0) {
    await publishProjectDetailInvalidationBestEffort({
      project_id,
      fields: [...changedFields] as any,
    });
  }
  if (
    usersChanged ||
    changedFields.has("title") ||
    changedFields.has("description")
  ) {
    await publishProjectAccountFeedEventsBestEffort({ project_id });
  }
  if (usersChanged) {
    try {
      await syncProjectUsersOnHost({ project_id });
    } catch (err) {
      logger.warn("unable to sync users after course reconfiguration", {
        project_id,
        err: `${err}`,
      });
    }
  }

  await updatePendingCourseEmailInvitePolicy(request);

  for (const desiredAccountId of missingDesiredAccountIds) {
    const courseStudentInvite =
      request.type === "student" && request.student_id != null;
    await inviteCollaborator({
      account_id,
      opts: {
        project_id,
        account_id: desiredAccountId,
        ...(courseStudentInvite
          ? {
              invite_scope: "course_student",
              invite_context: inviteContext(request),
            }
          : undefined),
      },
    });
  }

  let email_invited_at: string | undefined;
  if (
    request.send_email_invite &&
    request.student_email_address &&
    request.invite
  ) {
    const result = await inviteCollaboratorWithoutAccount({
      account_id,
      opts: {
        project_id,
        title: request.title ?? "Course project",
        link2proj: "",
        to: request.student_email_address,
        email: request.invite.email_html,
        subject: request.invite.subject,
        message: request.invite.message,
        replyto: request.invite.reply_to,
        replyto_name: request.invite.reply_to_name,
        invite_base_url: request.invite.base_url,
        invite_scope: "course_student",
        require_email_match: request.course.require_invite_email_match === true,
        invite_context: inviteContext(request),
      },
    });
    if (result.invites.length > 0) {
      email_invited_at = new Date().toISOString();
    }
  }
  return { project_id, ...(email_invited_at ? { email_invited_at } : {}) };
}
