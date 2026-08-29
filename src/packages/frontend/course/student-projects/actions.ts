/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Actions specific to manipulating the student projects that students have in a course.
*/

import { delay, map as awaitMap } from "awaiting";
import { redux } from "@cocalc/frontend/app-framework";
import { markdown_to_html } from "@cocalc/frontend/markdown";
import { setProjectRootfsImage } from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  CourseReconfigureItemResult,
  CourseReconfigureRequest,
  ProjectCollabInviteRow,
  ProjectCollabInviteStatus,
} from "@cocalc/conat/hub/api/projects";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { ProjectEmailInviteDeliveryResult } from "@cocalc/frontend/client/project-collaborators";
import { RESEND_INVITE_INTERVAL_DAYS } from "@cocalc/util/consts/invites";
import {
  normalizeStudentProjectFunctionality,
  type CourseInfo,
} from "@cocalc/util/db-schema/projects";
import { days_ago } from "@cocalc/util/misc";
import { SITE_NAME } from "@cocalc/util/theme";
import {
  WORKSPACE_LABEL,
  WORKSPACES_LABEL,
} from "@cocalc/util/i18n/terminology";
import { CourseActions } from "../actions";
import { CourseStore } from "../store";
import { Result, run_in_all_projects } from "./run-in-all-projects";
import type { StudentRecord } from "../store";
import { configureNewCourseSshTarget } from "../configuration/course-ssh-service";
import {
  courseConfigurationErrorMessage,
  retryCourseConfigurationWrite,
} from "./configuration-retry";

// Project starts can mount RootFS overlays and update host/control-plane state.
// Keep course-wide start/stop fanout conservative for single-host Star installs.
export const MAX_PARALLEL_TASKS = 5;

export const RESEND_INVITE_BEFORE = days_ago(RESEND_INVITE_INTERVAL_DAYS);

function courseInviteTitle(title?: string): string {
  const raw = `${title ?? ""}`.trim();
  if (!raw) {
    return "your course";
  }
  const leaf = raw.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? raw;
  return leaf.replace(/\.course$/i, "").trim() || "your course";
}

export class StudentProjectsActions {
  private course_actions: CourseActions;
  private configuringAllProjects = false;
  private configureAgain = false;
  private configureAgainForce = false;

  constructor(course_actions: CourseActions) {
    this.course_actions = course_actions;
  }

  private get_store = (): CourseStore => {
    const store = this.course_actions.get_store();
    if (store == null) throw Error("no store");
    return store;
  };

  private get_managed_project_ids = (): string[] => {
    const store = this.get_store();
    const projectIds = new Set(store.get_student_project_ids());
    const sharedProjectId = store.get_shared_project_id();
    if (sharedProjectId) {
      projectIds.add(sharedProjectId);
    }
    const nbgraderProjectId = `${
      store.getIn(["settings", "nbgrader_grade_project"]) ?? ""
    }`.trim();
    if (
      nbgraderProjectId &&
      nbgraderProjectId !== store.get("course_project_id")
    ) {
      projectIds.add(nbgraderProjectId);
    }
    return [...projectIds];
  };

  ensure_course_manager_access = async ({
    project_ids,
    quiet = true,
  }: {
    project_ids?: string[];
    quiet?: boolean;
  } = {}): Promise<void> => {
    const store = this.get_store();
    const managedProjectIds = project_ids ?? this.get_managed_project_ids();
    if (managedProjectIds.length === 0) {
      return;
    }
    try {
      const results =
        await webapp_client.project_collaborators.ensure_course_manager_access({
          course_project_id: store.get("course_project_id"),
          course_path: store.get("course_filename"),
          project_ids: managedProjectIds,
        });
      const errors = results.filter((result) => result.error);
      if (!quiet && errors.length > 0) {
        this.course_actions.set_error(
          `Error configuring course manager access - ${errors
            .slice(0, 3)
            .map((result) => `${result.project_id}: ${result.error}`)
            .join("; ")}`,
        );
      }
    } catch (err) {
      if (!quiet) {
        this.course_actions.set_error(
          `Error configuring course manager access - ${err}`,
        );
      }
    }
  };

  get_student_project_rootfs = async (): Promise<
    | {
        image: string;
        image_id?: string;
      }
    | undefined
  > => {
    const store = this.get_store();
    const explicitRootfs = store.get_student_project_rootfs();
    if (explicitRootfs?.image) {
      return explicitRootfs;
    }
    const course_project_id = store.get("course_project_id");
    if (!course_project_id) {
      return;
    }
    const inheritedRootfs =
      await webapp_client.conat_client.hub.projects.getProjectRootfs({
        project_id: course_project_id,
      });
    const image = `${inheritedRootfs?.image ?? ""}`.trim();
    if (!image) {
      return;
    }
    const image_id = `${inheritedRootfs?.image_id ?? ""}`.trim();
    return {
      image,
      ...(image_id ? { image_id } : undefined),
    };
  };

  private get_student_project_course_info = ({
    student,
    courseRootfs,
    courseHostId,
  }: {
    student: StudentRecord;
    courseRootfs?: { image: string; image_id?: string };
    courseHostId?: string;
  }): CourseInfo => {
    const store = this.get_store();
    const course: CourseInfo = {
      project_id: store.get("course_project_id"),
      path: store.get("course_filename"),
      datastore: store.get_datastore(),
      type: "student",
      student_pay: !!store.getIn(["settings", "student_pay"]),
      institute_pay: !!store.getIn(["settings", "institute_pay"]),
      site_license_pay: !!store.getIn(["settings", "site_license_pay"]),
      student_project_functionality: normalizeStudentProjectFunctionality(
        store.getIn(["settings", "student_project_functionality"])?.toJS(),
      ),
    };
    const requiredMembershipClass = `${
      store.getIn(["settings", "required_membership_class"]) ?? ""
    }`.trim();
    if (requiredMembershipClass) {
      course.required_membership_class = requiredMembershipClass;
    }
    const membershipRequiredAt = `${
      store.getIn(["settings", "student_membership_required_at"]) ?? ""
    }`.trim();
    if (membershipRequiredAt) {
      course.student_membership_required_at = membershipRequiredAt;
    }
    const graceDays = Number(
      store.getIn(["settings", "student_membership_grace_days"]) ?? 14,
    );
    if (Number.isFinite(graceDays)) {
      course.student_membership_grace_days = graceDays;
    }
    const courseEndsAt = `${
      store.getIn(["settings", "course_ends_at"]) ?? ""
    }`.trim();
    if (courseEndsAt) {
      course.course_ends_at = courseEndsAt;
    }
    const studentAccountId = student.get("account_id");
    if (studentAccountId != null) {
      course.account_id = studentAccountId;
    }
    const studentEmailAddress = student.get("email_address");
    if (studentEmailAddress != null) {
      course.email_address = studentEmailAddress;
    }
    const envvars = store.get_envvars();
    if (typeof envvars?.inherit === "boolean") {
      course.envvars = envvars;
    }
    if (courseHostId?.trim()) {
      course.host_id = courseHostId.trim();
    }
    if (courseRootfs?.image?.trim()) {
      course.rootfs_image = courseRootfs.image.trim();
    }
    if (courseRootfs?.image_id?.trim()) {
      course.rootfs_image_id = courseRootfs.image_id.trim();
    }
    return course;
  };

  private set_student_project_course_info = async ({
    student_id,
    student_project_id,
    courseRootfs,
    courseHostId,
  }: {
    student_id: string;
    student_project_id: string;
    courseRootfs?: { image: string; image_id?: string };
    courseHostId?: string;
  }): Promise<void> => {
    const student = this.get_store().get_student(student_id);
    if (student == null) {
      throw new Error(`student ${student_id} not found`);
    }
    const resolvedRootfs =
      courseRootfs ?? (await this.get_student_project_rootfs());
    const resolvedHostId =
      courseHostId ?? this.get_store().get_student_project_host_id();
    const course = this.get_student_project_course_info({
      student,
      courseRootfs: resolvedRootfs,
      courseHostId: resolvedHostId,
    });
    const { project_id: course_project_id, ...courseSettings } = course;
    await redux.getActions("projects").set_project_course_info({
      project_id: student_project_id,
      course_project_id,
      ...courseSettings,
    });
  };

  // Create and configure a single student project.
  create_student_project = async (
    student_id: string,
  ): Promise<string | undefined> => {
    const { store, student } = this.course_actions.resolve({
      student_id,
      finish: this.course_actions.set_error.bind(this),
    });
    if (store == null || student == null) return;
    if (store.get("students") == null || store.get("settings") == null) {
      this.course_actions.set_error(
        "BUG: attempt to create when stores not yet initialized",
      );
      return;
    }
    if (student.get("project_id")) {
      // project already created.
      return student.get("project_id");
    }
    this.course_actions.set({
      create_project: webapp_client.server_time(),
      table: "students",
      student_id,
    });
    const id = this.course_actions.set_activity({
      desc: `Create project for ${store.get_student_name(student_id)}.`,
    });
    let project_id: string;
    const courseRootfs = await this.get_student_project_rootfs();
    const courseHostId = store.get_student_project_host_id();
    const course = this.get_student_project_course_info({
      student,
      courseRootfs,
      courseHostId,
    });
    try {
      project_id = await redux.getActions("projects").create_project({
        title: store.get("settings").get("title"),
        description: store.get("settings").get("description"),
        course,
        host_id: courseHostId,
        rootfs_image: courseRootfs?.image,
        rootfs_image_id: courseRootfs?.image_id,
      });
    } catch (err) {
      this.course_actions.set_error(
        `error creating student project for ${store.get_student_name(
          student_id,
        )} -- ${err}`,
      );
      return;
    } finally {
      this.course_actions.clear_activity(id);
    }
    this.course_actions.set({
      create_project: null,
      project_id,
      table: "students",
      student_id,
    });
    await this.configure_project({
      student_id,
      student_project_id: project_id,
    });
    if (store.getIn(["settings", "ssh_to_student_projects"]) === true) {
      try {
        await configureNewCourseSshTarget({
          course_project_id: store.get("course_project_id"),
          target_project_id: project_id,
          account_id: store.getIn([
            "settings",
            "ssh_to_student_projects_account_id",
          ]),
        });
      } catch (err) {
        this.course_actions.set_error(
          `Student project created, but course SSH setup requires synchronization in Course Configuration - ${err}`,
        );
      }
    }
    return project_id;
  };

  // if student is an email address, invite via email – otherwise, if account_id, invite via standard collaborator invite
  invite_student_to_project = async (props: {
    student_id: string;
    student: string; // could be account_id or email_address
    student_project_id?: string;
  }): Promise<ProjectEmailInviteDeliveryResult | undefined> => {
    const { student_id, student, student_project_id } = props;
    if (student_project_id == null) return;

    // console.log("invite", x, " to ", student_project_id);
    if (student.includes("@")) {
      const store = this.get_store();
      if (store == null) return;
      const account_store = redux.getStore("account");
      const name = account_store.get_fullname() || "Your instructor";
      const replyto = account_store.get_email_address();
      const title = courseInviteTitle(store.get("settings").get("title"));
      const site_name =
        redux.getStore("customize").get("site_name") ?? SITE_NAME;
      const subject = `${site_name} course invitation: ${title}`;
      let body = store.get_email_invite();
      body = body.replace(/{title}/g, title).replace(/{name}/g, name);
      const message = body;
      const email = markdown_to_html(body);
      const result = await webapp_client.project_collaborators.invite_noncloud({
        project_id: student_project_id,
        title,
        link2proj: "",
        replyto,
        replyto_name: name,
        to: student,
        email,
        subject,
        message,
        invite_context: {
          course_path: store.get("course_filename"),
          course_project_id: store.get("course_project_id"),
          student_id,
          student_project_id,
        },
        invite_scope: "course_student",
      });
      this.course_actions.set({
        table: "students",
        student_id,
        last_email_invite: webapp_client.server_time(),
      });
      return result;
    } else {
      await webapp_client.project_collaborators.invite({
        project_id: student_project_id,
        account_id: student,
        invite_context: {
          course_path: this.get_store()?.get("course_filename"),
          course_project_id: this.get_store()?.get("course_project_id"),
          student_id,
          student_project_id,
        },
        invite_scope: "course_student",
      });
    }
  };

  private configure_project_users = async (props: {
    student_project_id: string;
    student_id: string;
    force_send_invite_by_email?: boolean;
  }): Promise<void> => {
    const {
      student_project_id,
      student_id,
      force_send_invite_by_email = false,
    } = props;
    //console.log("configure_project_users", student_project_id, student_id)
    // Add student and all collaborators on this project to the project with given project_id.
    // users = who is currently a user of the student's project?
    const users = redux.getStore("projects").get_users(student_project_id); // immutable.js map
    if (users == null) return; // can't do anything if this isn't known...

    const s = this.get_store();
    if (s == null) return;
    const student = s.get_student(student_id);
    if (student == null) return; // no such student..

    // Make sure the student is on the student's project:
    const student_account_id = student.get("account_id");
    if (student_account_id == null) {
      // No known account yet, so invite by email.
      // This is done once and then on demand by the teacher – only limited to once per day or less
      const last_email_invite = student.get("last_email_invite");
      if (force_send_invite_by_email || !last_email_invite) {
        const email_address = student.get("email_address");
        if (email_address) {
          await this.invite_student_to_project({
            student_id,
            student: email_address,
            student_project_id,
          });
          this.course_actions.set({
            table: "students",
            student_id,
            last_email_invite: webapp_client.server_time(),
          });
        }
      }
    } else if (
      (users != null ? users.get(student_account_id) : undefined) == null
    ) {
      // users might not be set yet if project *just* created
      await this.invite_student_to_project({
        student_id,
        student: student_account_id,
        student_project_id,
      });
    }

    // Use the authoritative course repair path rather than generic invites.
    // The latter can apply child-project limits using stale Redux state.
    await this.ensure_course_manager_access({
      project_ids: [student_project_id],
      quiet: false,
    });

    const course_collaborators = redux
      .getStore("projects")
      .get_users(s.get("course_project_id"));
    if (course_collaborators == null) {
      // console.log("projects store isn't sufficiently initialized yet...");
      return;
    }
    // Regarding student_account_id !== undefined below, see https://github.com/sagemathinc/cocalc/pull/3259
    // The problem is that student_account_id might not yet be known to the .course, even though
    // the student has been added and the account_id exists, and is known to the account opening
    // the .course file.  This is just due to a race condition somewhere else.  For now -- before
    // just factoring out and rewriting all this code better -- we at least make this one change
    // so the student isn't "brutally" kicked out of the course.
    if (
      s.get("settings") != undefined &&
      !s.get_allow_collabs() &&
      student_account_id != undefined
    ) {
      // Remove anybody extra on the student project
      for (const account_id of users.keys()) {
        if (
          !course_collaborators.has(account_id) &&
          account_id !== student_account_id
        ) {
          await webapp_client.project_collaborators.remove({
            project_id: student_project_id,
            account_id,
          });
        }
      }
    }
  };

  private configure_project_visibility = async (
    student_project_id: string,
  ): Promise<void> => {
    const users_of_student_project = redux
      .getStore("projects")
      .get_users(student_project_id);
    if (users_of_student_project == null) {
      // e.g., not defined in admin view mode
      return;
    }
    const account_id = webapp_client.account_id;
    if (!account_id) {
      return;
    }
    const x = users_of_student_project.get(account_id);
    if (x != null && !x.get("hide")) {
      await webapp_client.conat_client.hub.projects.setProjectHidden({
        project_id: student_project_id,
        hide: true,
      });
    }
  };

  private configure_project_title = async (
    student_project_id: string,
    student_id: string,
  ): Promise<void> => {
    const store = this.get_store();
    if (store == null) {
      return;
    }
    const title = `${store.get_student_name(student_id)} - ${store
      .get("settings")
      .get("title")}`;
    await this.set_project_fields(student_project_id, { title });
  };

  // start or stop projects of all (non-deleted) students running
  action_all_student_projects = async (
    action: "start" | "stop",
  ): Promise<void> => {
    if (!["start", "stop"].includes(action)) {
      throw new Error(`unknown desired project_action ${action}`);
    }
    const a2s = { start: "starting", stop: "stopping" } as const;
    const state: "starting" | "stopping" = a2s[action];

    this.course_actions.setState({ action_all_projects_state: state });
    this.course_actions.shared_project.action_shared_project(action);

    const store = this.get_store();
    const studentProjectIds = store.get_student_project_ids();
    await this.ensure_course_manager_access({
      project_ids: studentProjectIds,
    });

    const projects_actions = redux.getActions("projects");
    if (projects_actions == null) {
      throw Error("projects actions must be defined");
    }

    const selectedAction = (function () {
      switch (action) {
        case "start":
          return projects_actions.start_project.bind(projects_actions);
        case "stop":
          return projects_actions.stop_project.bind(projects_actions);
      }
    })();

    const task = async (student_project_id) => {
      if (!student_project_id) return;
      // abort if canceled
      if (store.get("action_all_projects_state") !== state) return;
      // returns true/false, could be useful some day
      if (action === "start") {
        await selectedAction(student_project_id, { waitForStart: true });
      } else {
        await selectedAction(student_project_id);
      }
    };

    await awaitMap(studentProjectIds, MAX_PARALLEL_TASKS, task);
  };

  cancel_action_all_student_projects = (): void => {
    this.course_actions.setState({ action_all_projects_state: "any" });
  };

  run_in_all_student_projects = async ({
    command,
    args,
    timeout,
    log,
  }: {
    command: string;
    args?: string[];
    timeout?: number;
    log?: Function;
  }): Promise<Result[]> => {
    // in case "stop all projects" is running
    this.cancel_action_all_student_projects();

    const store = this.get_store();
    const student_project_ids = store.get_student_project_ids();
    await this.ensure_course_manager_access({
      project_ids: student_project_ids,
    });
    // calling start also deals with possibility that it's in stop state.
    const id = this.course_actions.set_activity({
      desc: `Running a command across all student ${WORKSPACES_LABEL.toLowerCase()}…`,
    });
    let id1: number | undefined = this.course_actions.set_activity({
      desc: `Starting ${WORKSPACES_LABEL.toLowerCase()}…`,
    });
    let i = 0;
    const num = student_project_ids.length;

    const clear_id1 = () => {
      if (id1 != null) {
        this.course_actions.set_activity({ id: id1 });
      }
    };

    const done = (result: Result) => {
      i += 1;
      log?.(result);
      clear_id1();
      id1 = this.course_actions.set_activity({
        desc: `${WORKSPACE_LABEL} ${i}/${num} finished…`,
      });
    };

    try {
      return await run_in_all_projects(
        // as string[] is right since map option isn't set (make typescript happy)
        student_project_ids,
        command,
        args,
        timeout,
        done,
      );
    } finally {
      this.course_actions.set_activity({ id });
      clear_id1();
    }
  };

  set_all_student_project_titles = async (title: string): Promise<void> => {
    const store = this.get_store();
    for (const student of store.get_students().valueSeq().toArray()) {
      const student_project_id = student.get("project_id");
      const project_title = `${store.get_student_name(
        student.get("student_id"),
      )} - ${title}`;
      if (student_project_id != null) {
        await this.set_project_fields(student_project_id, {
          title: project_title,
        });
        if (this.course_actions.is_closed()) return;
      }
    }
  };

  private configure_project_description = async (
    student_project_id: string,
  ): Promise<void> => {
    const store = this.get_store();
    await this.set_project_fields(student_project_id, {
      description: store.getIn(["settings", "description"]),
    });
  };

  private set_project_fields = async (
    project_id: string,
    fields: { title?: string; description?: string },
  ): Promise<void> => {
    await retryCourseConfigurationWrite(async () => {
      await webapp_client.async_query({
        query: {
          projects: { project_id, ...fields },
        },
      });
    });
  };

  set_all_student_project_descriptions = async (
    description: string,
  ): Promise<void> => {
    const store = this.get_store();
    for (const student of store.get_students().valueSeq().toArray()) {
      const student_project_id = student.get("project_id");
      if (student_project_id != null) {
        await this.set_project_fields(student_project_id, { description });
        if (this.course_actions.is_closed()) return;
      }
    }
  };

  set_all_student_project_course_info = async (): Promise<void> => {
    const store = this.get_store();
    if (store == null) return;
    const courseRootfs = await this.get_student_project_rootfs();
    const courseHostId = store.get_student_project_host_id();
    const id = this.course_actions.set_activity({
      desc: "Updating project course info...",
    });
    try {
      for (const student of store.get_students().valueSeq().toArray()) {
        const student_project_id = student.get("project_id");
        if (student_project_id == null) continue;
        await this.set_student_project_course_info({
          student_id: student.get("student_id"),
          student_project_id,
          courseRootfs,
          courseHostId,
        });
      }
    } finally {
      this.course_actions.set_activity({ id });
    }
  };

  private configure_project = async (props: {
    student_id;
    student_project_id?: string;
    force_send_invite_by_email?: boolean;
  }): Promise<void> => {
    const { student_id, force_send_invite_by_email } = props;
    let student_project_id = props.student_project_id;

    // student_project_id is optional. Will be used instead of from student_id store if provided.
    // Configure project for the given student so that it has the right title,
    // description, and collaborators for belonging to the indicated student.
    // - Add student and collaborators on project containing this course to the new project.
    // - Hide project from owner/collabs of the project containing the course.
    // - Set the title to [Student name] + [course title] and description to course description.
    // console.log("configure_project", student_id);
    const store = this.get_store();
    if (student_project_id == null) {
      student_project_id = store.getIn(["students", student_id, "project_id"]);
    }
    // console.log("configure_project", student_id, student_project_id);
    if (student_project_id == null) {
      await this.create_student_project(student_id);
    } else {
      // The course link authorizes manager repair and must exist before the
      // other configuration operations run.
      await this.set_student_project_course_info({
        student_id,
        student_project_id,
      });
      await Promise.all([
        this.configure_project_users({
          student_project_id,
          student_id,
          force_send_invite_by_email,
        }),
        this.configure_project_visibility(student_project_id),
        this.configure_project_title(student_project_id, student_id),
        this.configure_project_description(student_project_id),
        this.configure_project_envvars(student_project_id),
      ]);
    }
  };

  private configure_project_envvars = async (
    student_project_id: string,
  ): Promise<void> => {
    const store = this.get_store();
    if (!store?.get_envvars()?.inherit) {
      return;
    }
    const env =
      (await webapp_client.conat_client.hub.projects.getProjectEnv({
        project_id: store.get("course_project_id"),
      })) ?? {};
    await webapp_client.conat_client.hub.projects.setProjectEnv({
      project_id: student_project_id,
      env: Object.fromEntries(
        Object.entries(env).map(([key, value]) => [key, `${value}`]),
      ),
    });
  };

  set_all_student_project_rootfs = async (): Promise<void> => {
    const store = this.get_store();
    const courseRootfs = await this.get_student_project_rootfs();
    if (!courseRootfs?.image) {
      throw Error("No course RootFS image is configured.");
    }
    const studentProjectIds = store.get_student_project_ids();
    const sharedProjectId = store.get_shared_project_id();
    const project_ids = sharedProjectId
      ? [...studentProjectIds, sharedProjectId]
      : studentProjectIds;
    if (project_ids.length === 0) {
      return;
    }
    const projectsActions = redux.getActions("projects");
    const overallId = this.course_actions.set_activity({
      desc: `Changing RootFS image for ${project_ids.length} course projects...`,
    });
    try {
      let i = 0;
      for (const project_id of project_ids) {
        if (this.course_actions.is_closed()) return;
        i += 1;
        const activityId = this.course_actions.set_activity({
          desc: `Changing RootFS image for course project ${i} of ${project_ids.length}`,
        });
        try {
          await setProjectRootfsImage({
            project_id,
            image: courseRootfs.image,
            image_id: courseRootfs.image_id,
          });
          if (redux.getStore("projects").get_state(project_id) === "running") {
            await projectsActions.restart_project(project_id);
          }
        } finally {
          this.course_actions.set_activity({ id: activityId });
        }
        await delay(0);
      }
      await this.set_all_student_project_course_info();
    } catch (err) {
      this.course_actions.set_error(
        `Error changing course project RootFS images - ${err}`,
      );
      throw err;
    } finally {
      this.course_actions.set_activity({ id: overallId });
    }
  };

  private delete_student_project = async (
    student_id: string,
  ): Promise<void> => {
    const store = this.get_store();
    const student_project_id = store.getIn([
      "students",
      student_id,
      "project_id",
    ]);
    if (student_project_id == null) return;
    const student_account_id = store.getIn([
      "students",
      student_id,
      "account_id",
    ]);
    if (student_account_id != undefined) {
      redux
        .getActions("projects")
        .remove_collaborator(student_project_id, student_account_id);
    }
    await redux.getActions("projects").hard_delete_project(student_project_id);
    this.course_actions.set({
      create_project: null,
      project_id: null,
      table: "students",
      student_id,
    });
  };

  reinvite_oustanding_students = async (): Promise<void> => {
    const store = this.get_store();
    if (store == null) return;
    const id = this.course_actions.set_activity({
      desc: "Reinviting students...",
    });
    try {
      this.course_actions.setState({ reinviting_students: true });
      const ids = store.get_student_ids({ deleted: false });
      if (ids == undefined) return;
      let i = 0;

      for (const student_id of ids) {
        if (this.course_actions.is_closed()) return;
        i += 1;
        const student = store.get_student(student_id);
        if (student == null) continue; // weird
        const student_account_id = student.get("account_id");
        if (student_account_id != null) continue; // already has an account – no need to reinvite.

        const id1: number = this.course_actions.set_activity({
          desc: `Progress ${Math.round((100 * i) / ids.length)}%...`,
        });
        const last_email_invite = student.get("last_email_invite");
        if (
          !last_email_invite ||
          new Date(last_email_invite) < RESEND_INVITE_BEFORE
        ) {
          const email_address = student.get("email_address");
          if (email_address) {
            await this.invite_student_to_project({
              student_id,
              student: email_address,
              student_project_id: store.get_student_project_id(student_id),
            });
          }
        }
        this.course_actions.set_activity({ id: id1 });
        await delay(0); // give UI, etc. a solid chance to render
      }
    } catch (err) {
      this.course_actions.set_error(`Error reinviting students - ${err}`);
    } finally {
      if (this.course_actions.is_closed()) return;
      this.course_actions.setState({ reinviting_students: false });
      this.course_actions.set_activity({ id });
    }
  };

  get_pending_student_invite_links = async (): Promise<string> => {
    const store = this.get_store();
    if (store == null) return "";
    const ids = store.get_student_ids({ deleted: false });
    if (ids == undefined) return "";
    await this.ensure_course_manager_access({
      project_ids: store.get_student_project_ids(),
    });

    const lines: string[] = [];
    for (const student_id of ids) {
      if (this.course_actions.is_closed()) return lines.join("\n");
      const student = store.get_student(student_id);
      if (student == null || student.get("account_id") != null) continue;
      const student_project_id = store.get_student_project_id(student_id);
      if (!student_project_id) continue;
      const invite = await this.get_course_invite({
        student_id,
        student_project_id,
        email_address: student.get("email_address"),
        status: "pending",
      });
      if (invite == null) continue;
      const result =
        await webapp_client.project_collaborators.copy_email_invite_link({
          invite_id: invite.invite_id,
          project_id: student_project_id,
        });
      const email = `${student.get("email_address") ?? ""}`.trim();
      const label = email
        ? `${store.get_student_name(student_id)} <${email}>`
        : store.get_student_name(student_id);
      lines.push(`${label}: ${result.invite_url}`);
      await delay(0);
    }
    return lines.join("\n");
  };

  copy_pending_student_invite_link = async ({
    student_id,
  }: {
    student_id: string;
  }): Promise<string> => {
    const store = this.get_store();
    const student = store.get_student(student_id);
    const student_project_id = store.get_student_project_id(student_id);
    if (student == null || !student_project_id) {
      throw new Error("Student project has not been created yet.");
    }
    await this.ensure_course_manager_access({
      project_ids: [student_project_id],
      quiet: false,
    });
    const invite = await this.get_course_invite({
      student_id,
      student_project_id,
      email_address: student.get("email_address"),
      status: "pending",
    });
    if (invite == null) {
      throw new Error(
        "No pending course invite link was found. Send an invitation first.",
      );
    }
    const result =
      await webapp_client.project_collaborators.copy_email_invite_link({
        invite_id: invite.invite_id,
        project_id: student_project_id,
      });
    return result.invite_url;
  };

  get_student_course_invite = async ({
    student_id,
    status,
  }: {
    student_id: string;
    status?: ProjectCollabInviteStatus;
  }): Promise<ProjectCollabInviteRow | undefined> => {
    const store = this.get_store();
    const student = store.get_student(student_id);
    const student_project_id = store.get_student_project_id(student_id);
    if (student == null || !student_project_id) {
      return;
    }
    return await this.get_course_invite({
      student_id,
      student_project_id,
      email_address: student.get("email_address"),
      status,
    });
  };

  revoke_pending_student_invite_link = async ({
    student_id,
  }: {
    student_id: string;
  }): Promise<void> => {
    const store = this.get_store();
    const student = store.get_student(student_id);
    const student_project_id = store.get_student_project_id(student_id);
    if (student == null || !student_project_id) {
      throw new Error("Student project has not been created yet.");
    }
    await this.ensure_course_manager_access({
      project_ids: [student_project_id],
      quiet: false,
    });
    const invite = await this.get_course_invite({
      student_id,
      student_project_id,
      email_address: student.get("email_address"),
      status: "pending",
    });
    if (invite == null) {
      throw new Error(
        "No pending course invite link was found. Send an invitation first.",
      );
    }
    await webapp_client.project_collaborators.respond_invite({
      invite_id: invite.invite_id,
      project_id: student_project_id,
      action: "revoke",
    });
    this.course_actions.set({
      table: "students",
      student_id,
      last_email_invite: undefined,
    });
  };

  private get_course_invite = async ({
    student_id,
    student_project_id,
    email_address,
    status,
  }: {
    student_id: string;
    student_project_id: string;
    email_address?: string;
    status?: ProjectCollabInviteStatus;
  }): Promise<ProjectCollabInviteRow | undefined> => {
    const rows = await this.get_course_invites({
      student_id,
      student_project_id,
      email_address,
      status,
    });
    const email = `${email_address ?? ""}`.trim().toLowerCase();
    return (
      rows.find((row) => row.context?.student_id === student_id) ??
      rows.find(
        (row) => row.context?.student_project_id === student_project_id,
      ) ??
      rows.find(
        (row) =>
          !!email && `${row.target_email ?? ""}`.trim().toLowerCase() === email,
      )
    );
  };

  private get_course_invites = async ({
    student_id,
    student_project_id,
    email_address,
    status,
  }: {
    student_id: string;
    student_project_id: string;
    email_address?: string;
    status?: ProjectCollabInviteStatus;
  }): Promise<ProjectCollabInviteRow[]> => {
    const rows = await webapp_client.project_collaborators.list_invites({
      project_id: student_project_id,
      direction: "outbound",
      status,
      limit: 1000,
      projectWide: true,
    });
    const email = `${email_address ?? ""}`.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (row.invite_source === "email" ||
          row.invite_source === "course_email") &&
        row.scope === "course_student" &&
        (row.context?.student_id === student_id ||
          row.context?.student_project_id === student_project_id ||
          (!!email &&
            `${row.target_email ?? ""}`.trim().toLowerCase() === email)),
    );
  };

  private build_course_reconfigure_request = async ({
    force_send_invite_by_email,
  }: {
    force_send_invite_by_email: boolean;
  }): Promise<CourseReconfigureRequest> => {
    const store = this.get_store();
    const settings = store.get("settings");
    const courseRootfs = await this.get_student_project_rootfs();
    const envvars = store.get_envvars();
    const inherited_env = envvars?.inherit
      ? Object.fromEntries(
          Object.entries(
            (await webapp_client.conat_client.hub.projects.getProjectEnv({
              project_id: store.get("course_project_id"),
            })) ?? {},
          ).map(([key, value]) => [key, `${value}`]),
        )
      : undefined;

    const accountStore = redux.getStore("account");
    const replyToName = accountStore.get_fullname() || "Your instructor";
    const replyTo = accountStore.get_email_address();
    const inviteTitle = courseInviteTitle(settings.get("title"));
    const siteName = redux.getStore("customize").get("site_name") ?? SITE_NAME;
    let inviteMessage = store.get_email_invite();
    inviteMessage = inviteMessage
      .replace(/{title}/g, inviteTitle)
      .replace(/{name}/g, replyToName);

    const students = store
      .get_students()
      .valueSeq()
      .toArray()
      .filter((student) => !student.get("deleted") || student.get("project_id"))
      .map((student) => {
        const deleted = !!student.get("deleted");
        const account_id = student.get("account_id");
        const email_address = student.get("email_address");
        return {
          student_id: student.get("student_id"),
          name: store.get_student_name(student.get("student_id")),
          project_id: student.get("project_id"),
          account_id,
          email_address,
          deleted,
          send_email_invite:
            !deleted &&
            !account_id &&
            !!email_address &&
            (force_send_invite_by_email || !student.get("last_email_invite")),
        };
      });

    return {
      course_project_id: store.get("course_project_id"),
      course_path: store.get("course_filename"),
      settings: {
        title: settings.get("title") ?? "",
        description: settings.get("description") ?? "",
        allow_collabs: store.get_allow_collabs(),
        datastore: store.get_datastore(),
        student_pay: !!settings.get("student_pay"),
        institute_pay: !!settings.get("institute_pay"),
        site_license_pay: !!settings.get("site_license_pay"),
        required_membership_class:
          settings.get("required_membership_class") || undefined,
        student_membership_required_at:
          settings.get("student_membership_required_at") || undefined,
        student_membership_grace_days: settings.get(
          "student_membership_grace_days",
        ),
        course_ends_at: settings.get("course_ends_at") || undefined,
        student_project_functionality: normalizeStudentProjectFunctionality(
          settings.get("student_project_functionality")?.toJS(),
        ),
        envvars,
        inherited_env,
        student_project_host_id: store.get_student_project_host_id(),
        student_project_rootfs_image: courseRootfs?.image,
        student_project_rootfs_image_id: courseRootfs?.image_id,
        shared_project_id: store.get_shared_project_id(),
        nbgrader_project_id:
          `${settings.get("nbgrader_grade_project") ?? ""}`.trim() || undefined,
        invite: {
          subject: `${siteName} course invitation: ${inviteTitle}`,
          message: inviteMessage,
          email_html: markdown_to_html(inviteMessage),
          reply_to: replyTo,
          reply_to_name: replyToName,
          base_url:
            typeof window === "undefined" ? undefined : window.location.origin,
        },
      },
      students,
    };
  };

  private apply_course_reconfigure_result = (summary: LroSummary): void => {
    if (this.course_actions.is_closed()) return;
    const items = Array.isArray(summary.result?.items)
      ? (summary.result.items as CourseReconfigureItemResult[])
      : [];
    for (const item of items) {
      if (
        item.type !== "student" ||
        item.status !== "done" ||
        !item.student_id
      ) {
        continue;
      }
      const student = this.get_store().get_student(item.student_id);
      if (!student) continue;
      this.course_actions.set({
        table: "students",
        student_id: item.student_id,
        project_id: item.project_id,
        create_project: null,
        ...(item.email_invited_at
          ? { last_email_invite: new Date(item.email_invited_at).valueOf() }
          : undefined),
      });
    }
  };

  cancel_configure_all_projects = async (): Promise<void> => {
    const store = this.get_store();
    const op_id = store.get("configuring_projects_op_id");
    if (!op_id) return;
    await webapp_client.project_client.cancelCourseReconfigureOperation({
      course_project_id: store.get("course_project_id"),
      op_id,
    });
  };

  configure_all_projects = async (force: boolean = false): Promise<void> => {
    const store = this.get_store();
    if (store == null) {
      return;
    }
    if (this.configuringAllProjects) {
      this.configureAgain = true;
      this.configureAgainForce ||= force;
      return;
    }

    let id: number = -1;
    try {
      this.configuringAllProjects = true;
      this.course_actions.setState({
        configuring_projects: true,
        configuring_projects_progress: undefined,
      });
      id = this.course_actions.set_activity({
        desc: "Ensuring all projects are configured...",
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (this.course_actions.is_closed()) return;
        const request = await this.build_course_reconfigure_request({
          force_send_invite_by_email: attempt === 0 && force,
        });
        const op =
          await webapp_client.project_client.reconfigureCourseProjects(request);

        this.course_actions.setState({
          configuring_projects_op_id: op.op_id,
        });
        const summary = await webapp_client.conat_client.lroWait({
          op_id: op.op_id,
          scope_type: op.scope_type,
          scope_id: op.scope_id,
          timeout_ms: 2 * 60 * 60 * 1000,
          getSummary: async () => {
            try {
              const local = await webapp_client.conat_client.hub.lro.get({
                op_id: op.op_id,
              });
              if (local) return local;
            } catch {
              // The operation may be owned by another bay.
            }
            return await webapp_client.project_client.getCourseReconfigureOperation(
              {
                course_project_id: request.course_project_id,
                op_id: op.op_id,
              },
            );
          },
          onSummary: (current) => {
            if (this.course_actions.is_closed()) return;
            const progress = current.progress_summary;
            this.course_actions.setState({
              configuring_projects_progress: progress,
            });
            if (progress?.total) {
              this.course_actions.set_activity({
                id,
                desc: `Configuring projects (${progress.done ?? 0}/${progress.total} done)`,
              });
            }
          },
        });
        this.apply_course_reconfigure_result(summary);
        if (summary.status !== "succeeded") {
          const staleOperation =
            op.requested_snapshot_hash !== op.operation_snapshot_hash;
          if (staleOperation && attempt < 4) {
            continue;
          }
          const itemErrors = (summary.result?.items ?? [])
            .filter((item) => item?.error)
            .slice(0, 3)
            .map((item) => `${item.project_id}: ${item.error}`)
            .join("; ");
          throw new Error(
            itemErrors || summary.error || `operation ${summary.status}`,
          );
        }
        if (op.requested_snapshot_hash === op.operation_snapshot_hash) {
          break;
        }
        if (attempt === 4) {
          throw new Error(
            "course configuration kept changing while it was running; please retry",
          );
        }
      }
    } catch (err) {
      console.warn(err);
      this.course_actions.set_error(courseConfigurationErrorMessage(err));
    } finally {
      this.configuringAllProjects = false;
      const configureAgain = this.configureAgain;
      const configureAgainForce = this.configureAgainForce;
      this.configureAgain = false;
      this.configureAgainForce = false;
      if (!this.course_actions.is_closed()) {
        this.course_actions.setState({
          configuring_projects: false,
          configuring_projects_op_id: undefined,
          configuring_projects_progress: undefined,
        });
        this.course_actions.set_activity({ id });
        if (configureAgain) {
          void this.configure_all_projects(configureAgainForce);
        }
      }
    }
  };

  // Deletes student projects and removes students from those projects
  deleteAllStudentProjects = async (): Promise<void> => {
    const store = this.get_store();

    const id = this.course_actions.set_activity({
      desc: "Deleting all student projects...",
    });
    try {
      const ids = store.get_student_ids({ deleted: false });
      if (ids == undefined) {
        return;
      }
      for (const student_id of ids) {
        await this.delete_student_project(student_id);
      }
    } catch (err) {
      this.course_actions.set_error(
        `error deleting a student project... ${err}`,
      );
    } finally {
      this.course_actions.set_activity({ id });
    }
  };

  removeFromAllStudentProjects = async (student: StudentRecord) => {
    /*
    - Remove student from their project
    - Remove student from shared project
    - Revoke any outstanding course invite
    */
    const shared_id = this.get_store()?.get_shared_project_id();
    const account_id = student.get("account_id");
    const project_id = student.get("project_id");
    if (project_id) {
      await this.ensure_course_manager_access({
        project_ids: [project_id],
        quiet: false,
      });
      const invites = await this.get_course_invites({
        student_id: student.get("student_id"),
        student_project_id: project_id,
        email_address: student.get("email_address"),
        status: "pending",
      });
      await awaitMap(invites, MAX_PARALLEL_TASKS, async (invite) => {
        await webapp_client.project_collaborators.respond_invite({
          invite_id: invite.invite_id,
          project_id,
          action: "revoke",
        });
      });
    }
    if (account_id) {
      if (project_id) {
        // remove them from their project
        await redux
          .getActions("projects")
          .remove_collaborator(project_id, account_id);
      }

      if (shared_id) {
        // remove them from shared project
        await redux
          .getActions("projects")
          .remove_collaborator(shared_id, account_id);
      }
    }
  };
}
