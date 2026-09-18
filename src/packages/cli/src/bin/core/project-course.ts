/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import "@cocalc/conat/sync-doc/install";
import type {
  CourseReconfigureItemResult,
  CourseReconfigureRequest,
  CourseReconfigureResult,
} from "@cocalc/conat/hub/api/projects";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  defaultCourseTitle,
  normalizeCoursePath,
} from "@cocalc/util/course-path";
import {
  normalizeStudentProjectFunctionality,
  type ProjectState,
} from "@cocalc/util/db-schema/projects";
import type { ProjectRootfsStateEntry } from "@cocalc/util/rootfs-images";

const COURSE_PRIMARY_KEYS = [
  "table",
  "handout_id",
  "student_id",
  "assignment_id",
];
const COURSE_STRING_COLUMNS = [
  "note",
  "description",
  "title",
  "email_invite",
  "display_name",
];
const TERMINAL_LRO_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

export type CourseSyncDB = {
  wait_until_ready: () => Promise<void>;
  get: () => unknown;
  get_one: (where: Record<string, unknown>) => unknown;
  set: (row: Record<string, unknown>) => void;
  commit: (opts?: { meta?: Record<string, unknown> }) => boolean;
  save: () => Promise<void>;
  save_to_disk: () => Promise<void>;
  close: () => Promise<void> | void;
  once?: (event: string, listener: (error: unknown) => void) => void;
  off?: (event: string, listener: (error: unknown) => void) => void;
};

type CourseHub = {
  system: {
    setProjectRootfsImage: (opts: {
      project_id: string;
      image: string;
      image_id?: string;
    }) => Promise<ProjectRootfsStateEntry[]>;
  };
  projects: {
    getProjectEnv: (opts: {
      project_id: string;
    }) => Promise<Record<string, unknown> | undefined>;
    reconfigureCourseProjects: (
      request: CourseReconfigureRequest,
    ) => Promise<CourseReconfigureResult>;
    getCourseReconfigureOperation: (opts: {
      course_project_id: string;
      op_id: string;
    }) => Promise<LroSummary | undefined>;
    getProjectState: (opts: { project_id: string }) => Promise<ProjectState>;
    restart: (opts: {
      project_id: string;
      restart_request_id: string;
      wait: boolean;
    }) => Promise<{ op_id: string }>;
  };
};

type RootfsSetting = {
  image: string;
  image_id?: string;
};

function asRows(value: unknown): Record<string, any>[] {
  const rows =
    typeof (value as any)?.toJS === "function" ? (value as any).toJS() : value;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, any> =>
          row != null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function settingsRow(rows: Record<string, any>[]): Record<string, any> {
  return rows.find((row) => row.table === "settings") ?? { table: "settings" };
}

function rootfsFromSettings(
  settings: Record<string, any>,
): RootfsSetting | undefined {
  const image = `${settings.student_project_rootfs_image ?? ""}`.trim();
  const image_id = `${settings.student_project_rootfs_image_id ?? ""}`.trim();
  if (!image) return;
  return { image, ...(image_id ? { image_id } : undefined) };
}

export function courseRootfsProjectIds({
  course_project_id,
  rows,
}: {
  course_project_id: string;
  rows: Record<string, any>[];
}): string[] {
  const settings = settingsRow(rows);
  const projectIds = new Set<string>();
  for (const student of rows) {
    if (student.table !== "students" || student.deleted) continue;
    const projectId = `${student.project_id ?? ""}`.trim();
    if (projectId) projectIds.add(projectId);
  }
  const sharedProjectId = `${settings.shared_project_id ?? ""}`.trim();
  if (sharedProjectId) projectIds.add(sharedProjectId);
  projectIds.delete(course_project_id);
  return [...projectIds].sort();
}

export function courseSettingsHash(settings: Record<string, unknown>): string {
  const json = JSON.stringify(canonicalize(settings));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export function summarizeCourseRows({
  project_id,
  path,
  rows,
}: {
  project_id: string;
  path: string;
  rows: Record<string, any>[];
}): Record<string, unknown> {
  const settings = settingsRow(rows);
  const students = rows.filter((row) => row.table === "students");
  const activeStudents = students.filter((student) => !student.deleted);
  const managedProjectIds = new Set<string>();
  for (const student of students) {
    const projectId = `${student.project_id ?? ""}`.trim();
    if (projectId) managedProjectIds.add(projectId);
  }
  for (const value of [
    settings.shared_project_id,
    settings.nbgrader_grade_project,
  ]) {
    const projectId = `${value ?? ""}`.trim();
    if (projectId) managedProjectIds.add(projectId);
  }
  return {
    project_id,
    path,
    settings_hash: courseSettingsHash(settings),
    settings,
    rootfs: rootfsFromSettings(settings) ?? null,
    students: {
      total: students.length,
      active: activeStudents.length,
      deleted: students.length - activeStudents.length,
      with_project: students.filter((student) => !!student.project_id).length,
    },
    managed_project_ids: [...managedProjectIds].sort(),
  };
}

export async function applyCourseRootfsToManagedProjects({
  hub,
  course_project_id,
  rows,
}: {
  hub: CourseHub;
  course_project_id: string;
  rows: Record<string, any>[];
}): Promise<Record<string, unknown>> {
  const rootfs = rootfsFromSettings(settingsRow(rows));
  if (!rootfs) {
    throw new Error("No course RootFS image is configured");
  }
  const projectIds = courseRootfsProjectIds({ course_project_id, rows });
  const projectStates = new Map<string, string>();
  for (const project_id of projectIds) {
    const state = await hub.projects.getProjectState({ project_id });
    projectStates.set(project_id, `${state?.state ?? ""}`.trim());
  }
  const projects: Array<Record<string, unknown>> = [];
  for (const project_id of projectIds) {
    const stateBefore = projectStates.get(project_id) ?? "";
    const states = await hub.system.setProjectRootfsImage({
      project_id,
      image: rootfs.image,
      image_id: rootfs.image_id,
    });
    const active = stateBefore === "running" || stateBefore === "starting";
    const restart = active
      ? await hub.projects.restart({
          project_id,
          restart_request_id: randomUUID(),
          wait: true,
        })
      : undefined;
    projects.push({
      project_id,
      state_before: stateBefore || null,
      rootfs_states: states,
      restarted: active,
      restart_op_id: restart?.op_id ?? null,
    });
  }
  return {
    course_project_id,
    rootfs,
    project_count: projects.length,
    restarted_count: projects.filter((project) => project.restarted).length,
    projects,
  };
}

export async function openCourseSyncDB({
  client,
  project_id,
  path,
}: {
  client: any;
  project_id: string;
  path: string;
}): Promise<{ path: string; syncdb: CourseSyncDB }> {
  const normalizedPath = normalizeCoursePath(path);
  const syncdb = client.sync.db({
    project_id,
    path: normalizedPath,
    primary_keys: COURSE_PRIMARY_KEYS,
    string_cols: COURSE_STRING_COLUMNS,
    change_throttle: 500,
  }) as CourseSyncDB;

  let errorListener: ((error: unknown) => void) | undefined;
  const error = new Promise<never>((_resolve, reject) => {
    if (typeof syncdb.once !== "function") return;
    errorListener = (err) =>
      reject(err instanceof Error ? err : new Error(`${err}`));
    syncdb.once("error", errorListener);
  });
  try {
    await Promise.race([syncdb.wait_until_ready(), error]);
  } catch (err) {
    await syncdb.close();
    throw err;
  } finally {
    if (errorListener && typeof syncdb.off === "function") {
      syncdb.off("error", errorListener);
    }
  }
  return { path: normalizedPath, syncdb };
}

export function readCourseRows(syncdb: CourseSyncDB): Record<string, any>[] {
  return asRows(syncdb.get());
}

export async function setCourseRootfs({
  syncdb,
  project_id,
  path,
  image,
  image_id,
  expected_settings_hash,
  account_id,
}: {
  syncdb: CourseSyncDB;
  project_id: string;
  path: string;
  image: string;
  image_id?: string;
  expected_settings_hash?: string;
  account_id?: string;
}): Promise<Record<string, unknown>> {
  const normalizedImage = `${image ?? ""}`.trim();
  if (!normalizedImage) {
    throw new Error("RootFS image must be non-empty");
  }
  const rowsBefore = readCourseRows(syncdb);
  const settingsBefore = settingsRow(rowsBefore);
  const beforeHash = courseSettingsHash(settingsBefore);
  const expectedHash = `${expected_settings_hash ?? ""}`.trim();
  if (expectedHash && expectedHash !== beforeHash) {
    throw new Error(
      `course settings changed (expected ${expectedHash}, found ${beforeHash}); inspect the course and retry`,
    );
  }
  const beforeRootfs = rootfsFromSettings(settingsBefore);
  const normalizedImageId = `${image_id ?? ""}`.trim();
  syncdb.set({
    table: "settings",
    student_project_rootfs_image: normalizedImage,
    student_project_rootfs_image_id: normalizedImageId || null,
  });
  const changed = syncdb.commit({
    meta: {
      action: "cli.course.config.set-rootfs",
      project_id,
      course_path: path,
      account_id: account_id ?? null,
      previous_image: beforeRootfs?.image ?? null,
      previous_image_id: beforeRootfs?.image_id ?? null,
      image: normalizedImage,
      image_id: normalizedImageId || null,
    },
  });
  await syncdb.save();
  await syncdb.save_to_disk();

  const rowsAfter = readCourseRows(syncdb);
  const settingsAfter = settingsRow(rowsAfter);
  const afterRootfs = rootfsFromSettings(settingsAfter);
  if (
    afterRootfs?.image !== normalizedImage ||
    (afterRootfs.image_id ?? "") !== normalizedImageId
  ) {
    throw new Error("course RootFS setting did not persist as requested");
  }
  return {
    project_id,
    path,
    changed,
    before: beforeRootfs ?? null,
    after: afterRootfs,
    before_settings_hash: beforeHash,
    settings_hash: courseSettingsHash(settingsAfter),
  };
}

function studentName(student: Record<string, any>): string {
  const displayName = `${student.display_name ?? ""}`.trim();
  if (displayName) return displayName;
  const legacyName = [student.first_name, student.last_name]
    .map((value) => `${value ?? ""}`.trim())
    .filter(Boolean)
    .join(" ");
  return (
    legacyName || `${student.email_address ?? ""}`.trim() || "Unknown Student"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

export async function buildCourseReconfigureRequest({
  hub,
  project_id,
  path,
  rows,
}: {
  hub: CourseHub;
  project_id: string;
  path: string;
  rows: Record<string, any>[];
}): Promise<CourseReconfigureRequest> {
  const settings = settingsRow(rows);
  const title = `${settings.title ?? ""}`.trim() || defaultCourseTitle(path);
  const inviteTitle =
    title.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "your course";
  const inviteMessage = `${
    settings.email_invite ??
    "Hello,\n\nCourse staff invited you to join **{title}** on CoCalc.\n\nUse the invitation link to review and accept the invitation."
  }`
    .replace(/{title}/g, inviteTitle)
    .replace(/{name}/g, "Course staff");
  const envvars =
    settings.envvars != null && typeof settings.envvars === "object"
      ? settings.envvars
      : undefined;
  const inherited_env = envvars?.inherit
    ? Object.fromEntries(
        Object.entries(
          (await hub.projects.getProjectEnv({ project_id })) ?? {},
        ).map(([key, value]) => [key, `${value}`]),
      )
    : undefined;
  const rootfs = rootfsFromSettings(settings);
  const datastore =
    typeof settings.datastore === "boolean" || Array.isArray(settings.datastore)
      ? settings.datastore
      : undefined;

  return {
    course_project_id: project_id,
    course_path: path,
    settings: {
      title,
      description: `${settings.description ?? "No description"}`,
      allow_collabs:
        settings.allow_collabs == null ? true : !!settings.allow_collabs,
      datastore,
      student_pay: !!settings.student_pay,
      institute_pay: !!settings.institute_pay,
      site_license_pay: !!settings.site_license_pay,
      required_membership_class:
        `${settings.required_membership_class ?? ""}`.trim() || undefined,
      student_membership_required_at:
        `${settings.student_membership_required_at ?? ""}`.trim() || undefined,
      student_membership_grace_days: settings.student_membership_grace_days,
      course_ends_at: `${settings.course_ends_at ?? ""}`.trim() || undefined,
      require_invite_email_match: !!settings.require_invite_email_match,
      student_project_functionality: normalizeStudentProjectFunctionality(
        settings.student_project_functionality,
      ),
      envvars,
      inherited_env,
      student_project_host_id:
        `${settings.student_project_host_id ?? ""}`.trim() || undefined,
      student_project_rootfs_image: rootfs?.image,
      student_project_rootfs_image_id: rootfs?.image_id,
      shared_project_id:
        `${settings.shared_project_id ?? ""}`.trim() || undefined,
      nbgrader_project_id:
        `${settings.nbgrader_grade_project ?? ""}`.trim() || undefined,
      invite: {
        subject: `CoCalc course invitation: ${inviteTitle}`,
        message: inviteMessage,
        email_html: escapeHtml(inviteMessage),
      },
    },
    students: rows
      .filter(
        (row) => row.table === "students" && (!row.deleted || row.project_id),
      )
      .map((student) => ({
        student_id: `${student.student_id ?? ""}`,
        name: studentName(student),
        project_id: `${student.project_id ?? ""}`.trim() || undefined,
        account_id: `${student.account_id ?? ""}`.trim() || undefined,
        email_address: `${student.email_address ?? ""}`.trim() || undefined,
        deleted: !!student.deleted,
        send_email_invite: false,
      }))
      .filter((student) => !!student.student_id),
  };
}

async function waitForCourseOperation({
  hub,
  project_id,
  op_id,
  timeout_ms,
  poll_ms,
}: {
  hub: CourseHub;
  project_id: string;
  op_id: string;
  timeout_ms: number;
  poll_ms: number;
}): Promise<LroSummary> {
  const deadline = Date.now() + timeout_ms;
  while (true) {
    const summary = await hub.projects.getCourseReconfigureOperation({
      course_project_id: project_id,
      op_id,
    });
    if (summary && TERMINAL_LRO_STATUSES.has(summary.status)) return summary;
    if (Date.now() >= deadline) {
      throw new Error(`course reconfiguration timed out (op=${op_id})`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, poll_ms)));
  }
}

async function applyCourseReconfigureResult({
  syncdb,
  project_id,
  path,
  summary,
  account_id,
}: {
  syncdb: CourseSyncDB;
  project_id: string;
  path: string;
  summary: LroSummary;
  account_id?: string;
}): Promise<boolean> {
  const items: CourseReconfigureItemResult[] = Array.isArray(
    summary.result?.items,
  )
    ? summary.result.items
    : [];
  let changed = false;
  for (const item of items) {
    if (item.type !== "student" || item.status !== "done" || !item.student_id) {
      continue;
    }
    const current = syncdb.get_one({
      table: "students",
      student_id: item.student_id,
    });
    const row =
      typeof (current as any)?.toJS === "function"
        ? (current as any).toJS()
        : current;
    if (!row) continue;
    const patch: Record<string, unknown> = {
      table: "students",
      student_id: item.student_id,
      project_id: item.project_id,
      create_project: null,
    };
    if (item.email_invited_at) {
      patch.last_email_invite = new Date(item.email_invited_at).valueOf();
    }
    syncdb.set(patch);
    changed = true;
  }
  if (!changed) return false;
  syncdb.commit({
    meta: {
      action: "cli.course.reconfigure.apply-result",
      project_id,
      course_path: path,
      account_id: account_id ?? null,
      op_id: summary.op_id,
    },
  });
  await syncdb.save();
  await syncdb.save_to_disk();
  return true;
}

export async function reconfigureCourseProjects({
  hub,
  syncdb,
  project_id,
  path,
  account_id,
  timeout_ms,
  poll_ms,
}: {
  hub: CourseHub;
  syncdb: CourseSyncDB;
  project_id: string;
  path: string;
  account_id?: string;
  timeout_ms: number;
  poll_ms: number;
}): Promise<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const request = await buildCourseReconfigureRequest({
      hub,
      project_id,
      path,
      rows: readCourseRows(syncdb),
    });
    const operation = await hub.projects.reconfigureCourseProjects(request);
    const summary = await waitForCourseOperation({
      hub,
      project_id,
      op_id: operation.op_id,
      timeout_ms,
      poll_ms,
    });
    const courseUpdated = await applyCourseReconfigureResult({
      syncdb,
      project_id,
      path,
      summary,
      account_id,
    });
    const stale =
      operation.requested_snapshot_hash !== operation.operation_snapshot_hash;
    operations.push({
      op_id: operation.op_id,
      status: summary.status,
      attempt,
      requested_snapshot_hash: operation.requested_snapshot_hash,
      operation_snapshot_hash: operation.operation_snapshot_hash,
      stale,
      course_document_updated: courseUpdated,
      progress: summary.progress_summary ?? null,
      items: summary.result?.items ?? [],
      error: summary.error ?? null,
    });
    if (summary.status !== "succeeded") {
      if (stale && attempt < 5) continue;
      throw new Error(
        `course reconfiguration failed (op=${operation.op_id}, status=${summary.status}): ${summary.error ?? "unknown error"}`,
      );
    }
    if (!stale) {
      return {
        project_id,
        path,
        status: "succeeded",
        op_id: operation.op_id,
        attempts: attempt,
        operations,
      };
    }
  }
  throw new Error(
    "course configuration kept changing while reconfiguration was running; retry",
  );
}
