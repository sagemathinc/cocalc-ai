/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type {
  CourseReconfigureItemResult,
  CourseReconfigureRequest,
  CourseReconfigureStudentItem,
} from "@cocalc/conat/hub/api/projects";
import type {
  ProjectCourseManagedProjectState,
  ProjectReconcileCourseManagedProjectRequest,
} from "@cocalc/conat/inter-bay/api";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { isLroTerminalStatus } from "@cocalc/conat/lro/status";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import {
  claimLroOps,
  getLro,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { createProjectWithInternalProjectId } from "@cocalc/server/projects/create";
import { getProjectUsageAccountId } from "@cocalc/server/membership/project-usage";
import {
  courseManagedProjectNeedsReconcile,
  getCourseManagedProjectStatesLocal,
  reconcileCourseManagedProjectLocal,
} from "./course/reconcile-managed-project";
import { shouldCreateCourseStudentProject } from "./course-reconfigure-plan";
import type { CourseInfo } from "@cocalc/util/db-schema/projects";

const logger = getLogger("server:projects:course-reconfigure-worker");

export const COURSE_RECONFIGURE_LRO_KIND = "course-reconfigure-projects";

const OWNER_TYPE = "hub" as const;
const WORKER_ID = randomUUID();
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_ITEM_PARALLEL = 4;
const TRANSIENT_ITEM_ATTEMPTS = 4;
const TRANSIENT_ITEM_RETRY_BASE_MS = 150;

interface NormalizedStudentItem extends CourseReconfigureStudentItem {
  project_id: string;
  create: boolean;
}

type ReconcileRequest = ProjectReconcileCourseManagedProjectRequest;

export interface CourseReconfigureLroInput extends CourseReconfigureRequest {
  account_id?: never;
  snapshot_hash: string;
  students: NormalizedStudentItem[];
}

let running = false;
let inFlight = 0;
let tickFn: (() => Promise<void>) | undefined;
let tickRunning = false;
let tickRequested = false;

function isTerminal(status?: string | null): boolean {
  return isLroTerminalStatus(status);
}

export function isTransientCourseReconfigureError(err: unknown): boolean {
  const code = `${(err as { code?: unknown } | null)?.code ?? ""}`;
  if (code === "40P01" || code === "40001") {
    return true;
  }
  const message = `${
    err instanceof Error ? err.message : ((err as any)?.message ?? err ?? "")
  }`.toLowerCase();
  return (
    message.includes("deadlock detected") ||
    message.includes("could not serialize access")
  );
}

function summarize(results: CourseReconfigureItemResult[]) {
  const done = results.filter((item) => item.status === "done").length;
  const failed = results.filter((item) => item.status === "failed").length;
  const canceled = results.filter((item) => item.status === "canceled").length;
  const running = results.filter((item) => item.status === "running").length;
  const queued = results.filter((item) => item.status === "queued").length;
  return {
    phase: "reconfigure",
    total: results.length,
    queued,
    running,
    done,
    failed,
    canceled,
  };
}

async function publishSummarySafe(summary: LroSummary | undefined) {
  if (!summary) return;
  try {
    await publishLroSummary({
      scope_type: summary.scope_type,
      scope_id: summary.scope_id,
      summary,
    });
  } catch (err) {
    logger.warn("unable to publish course reconfiguration summary", {
      op_id: summary.op_id,
      err: `${err}`,
    });
  }
}

async function updateProgress({
  op,
  results,
}: {
  op: LroSummary;
  results: CourseReconfigureItemResult[];
}): Promise<LroSummary | undefined> {
  const current = await getLro(op.op_id);
  if (isTerminal(current?.status)) return current;
  const progress_summary = summarize(results);
  const updated = await updateLro({
    op_id: op.op_id,
    status: "running",
    progress_summary,
    result: { items: results, progress_summary },
    error: null,
    if_status: ["queued", "running"],
  });
  await publishSummarySafe(updated);
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "reconfigure",
      message: `${progress_summary.done}/${progress_summary.total} projects configured`,
      progress:
        progress_summary.total > 0
          ? Math.round(
              (100 *
                (progress_summary.done +
                  progress_summary.failed +
                  progress_summary.canceled)) /
                progress_summary.total,
            )
          : 100,
      detail: progress_summary,
    },
  });
  return updated;
}

function studentCourseInfo({
  input,
  student,
}: {
  input: CourseReconfigureLroInput;
  student: NormalizedStudentItem;
}): CourseInfo {
  const { settings } = input;
  return {
    project_id: input.course_project_id,
    path: input.course_path,
    type: "student",
    datastore: settings.datastore,
    student_pay: !!settings.student_pay,
    institute_pay: !!settings.institute_pay,
    site_license_pay: !!settings.site_license_pay,
    ...(settings.required_membership_class
      ? { required_membership_class: settings.required_membership_class }
      : {}),
    ...(settings.student_membership_required_at
      ? {
          student_membership_required_at:
            settings.student_membership_required_at,
        }
      : {}),
    ...(settings.student_membership_grace_days != null
      ? {
          student_membership_grace_days: settings.student_membership_grace_days,
        }
      : {}),
    ...(settings.course_ends_at
      ? { course_ends_at: settings.course_ends_at }
      : {}),
    ...(student.account_id ? { account_id: student.account_id } : {}),
    ...(student.email_address ? { email_address: student.email_address } : {}),
    ...(settings.student_project_functionality
      ? {
          student_project_functionality: settings.student_project_functionality,
        }
      : {}),
    ...(settings.envvars ? { envvars: settings.envvars } : {}),
    ...(settings.student_project_host_id
      ? { host_id: settings.student_project_host_id }
      : {}),
    ...(settings.student_project_rootfs_image
      ? { rootfs_image: settings.student_project_rootfs_image }
      : {}),
    ...(settings.student_project_rootfs_image_id
      ? { rootfs_image_id: settings.student_project_rootfs_image_id }
      : {}),
  };
}

function simpleCourseInfo({
  input,
  type,
}: {
  input: CourseReconfigureLroInput;
  type: "shared" | "nbgrader";
}): CourseInfo {
  return {
    project_id: input.course_project_id,
    path: input.course_path,
    type,
    datastore: input.settings.datastore,
    ...(input.settings.envvars ? { envvars: input.settings.envvars } : {}),
  };
}

async function reconcileOnOwningBay(
  request: ReconcileRequest,
  knownBayId?: string,
) {
  const bay_id =
    knownBayId ?? (await resolveProjectBay(request.project_id))?.bay_id;
  if (!bay_id) throw new Error(`project ${request.project_id} not found`);
  if (bay_id === getConfiguredBayId()) {
    return await reconcileCourseManagedProjectLocal(request);
  }
  return await getInterBayBridge()
    .projectCollabInvite(bay_id)
    .reconcileCourseManagedProject(request);
}

async function ensureStudentProject({
  input,
  student,
  creatorAccountId,
  knownBayId,
}: {
  input: CourseReconfigureLroInput;
  student: NormalizedStudentItem;
  creatorAccountId: string;
  knownBayId?: string;
}): Promise<{ created: boolean; bay_id?: string }> {
  if (
    !shouldCreateCourseStudentProject({
      knownBayId,
      admissionCreate: student.create,
    })
  ) {
    return { created: false, bay_id: knownBayId };
  }
  const course = studentCourseInfo({ input, student });
  await createProjectWithInternalProjectId({
    project_id: student.project_id,
    account_id: creatorAccountId,
    title: `${student.name} - ${input.settings.title}`,
    description: input.settings.description,
    course,
    ...(input.settings.student_project_host_id
      ? { host_id: input.settings.student_project_host_id }
      : {}),
    ...(input.settings.student_project_rootfs_image
      ? { rootfs_image: input.settings.student_project_rootfs_image }
      : {}),
    ...(input.settings.student_project_rootfs_image_id
      ? {
          rootfs_image_id: input.settings.student_project_rootfs_image_id,
        }
      : {}),
  });
  return { created: true, bay_id: getConfiguredBayId() };
}

function buildReconcileRequest({
  op,
  input,
  result,
  managerAccountIds,
  activeStudentAccountIds,
  studentsById,
}: {
  op: LroSummary;
  input: CourseReconfigureLroInput;
  result: CourseReconfigureItemResult;
  managerAccountIds: string[];
  activeStudentAccountIds: string[];
  studentsById: Map<string, NormalizedStudentItem>;
}): ReconcileRequest {
  const account_id = op.created_by!;
  if (result.type === "student") {
    const student = studentsById.get(result.student_id ?? "");
    if (!student) throw new Error(`student ${result.student_id} not found`);
    return {
      account_id,
      course_project_id: input.course_project_id,
      course_path: input.course_path,
      manager_account_ids: managerAccountIds,
      project_id: student.project_id,
      type: "student",
      course: studentCourseInfo({ input, student }),
      title: `${student.name} - ${input.settings.title}`,
      description: input.settings.description,
      env: input.settings.envvars?.inherit
        ? input.settings.inherited_env
        : undefined,
      allow_collabs: input.settings.allow_collabs,
      desired_account_ids:
        !student.deleted && student.account_id ? [student.account_id] : [],
      student_id: student.student_id,
      student_email_address: student.email_address,
      send_email_invite: !student.deleted && student.send_email_invite === true,
      invite: input.settings.invite,
    };
  }

  const isShared = result.type === "shared";
  return {
    account_id,
    course_project_id: input.course_project_id,
    course_path: input.course_path,
    manager_account_ids: managerAccountIds,
    project_id: result.project_id,
    type: result.type,
    course: simpleCourseInfo({ input, type: result.type }),
    ...(isShared
      ? {
          title: `Shared Project -- ${input.settings.title}`,
          description: `${input.settings.description}\n\n---\n\nThis project is shared with all students in the course.`,
        }
      : {}),
    env: input.settings.envvars?.inherit
      ? input.settings.inherited_env
      : undefined,
    allow_collabs: input.settings.allow_collabs,
    desired_account_ids: isShared ? activeStudentAccountIds : [],
  };
}

async function resolveCourseManagedProjectBays(
  projectIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Map();
  const localBayId = getConfiguredBayId();
  const { rows } = await getPool().query<{
    project_id: string;
    bay_id: string;
  }>(
    `SELECT project_id::text,
            COALESCE(owning_bay_id, $2) AS bay_id
       FROM projects
      WHERE project_id=ANY($1::uuid[])`,
    [ids, localBayId],
  );
  const result = new Map(rows.map((row) => [row.project_id, row.bay_id]));
  const missing = ids.filter((project_id) => !result.has(project_id));
  await Promise.all(
    missing.map(async (project_id) => {
      const ownership = await resolveProjectBay(project_id);
      if (ownership) result.set(project_id, ownership.bay_id);
    }),
  );
  return result;
}

async function getCourseManagedProjectStatesByBay(
  projectBays: Map<string, string>,
): Promise<Map<string, ProjectCourseManagedProjectState>> {
  const projectIdsByBay = new Map<string, string[]>();
  for (const [project_id, bay_id] of projectBays) {
    const ids = projectIdsByBay.get(bay_id) ?? [];
    ids.push(project_id);
    projectIdsByBay.set(bay_id, ids);
  }
  const localBayId = getConfiguredBayId();
  const states = new Map<string, ProjectCourseManagedProjectState>();
  await Promise.all(
    [...projectIdsByBay].map(async ([bay_id, project_ids]) => {
      try {
        const rows =
          bay_id === localBayId
            ? await getCourseManagedProjectStatesLocal({ project_ids })
            : await getInterBayBridge()
                .projectCollabInvite(bay_id)
                .getCourseManagedProjectStates({ project_ids });
        for (const row of rows) states.set(row.project_id, row);
      } catch (err) {
        // A failed optimization must not prevent the locked repair path.
        logger.warn("unable to bulk inspect course-managed projects", {
          bay_id,
          project_count: project_ids.length,
          err: `${err}`,
        });
      }
    }),
  );
  return states;
}

async function reconcileOne({
  input,
  result,
  studentsById,
  request,
  knownBayId,
  creatorAccountId,
}: {
  input: CourseReconfigureLroInput;
  result: CourseReconfigureItemResult;
  studentsById: Map<string, NormalizedStudentItem>;
  request: ReconcileRequest;
  knownBayId?: string;
  creatorAccountId: string;
}): Promise<CourseReconfigureItemResult> {
  if (result.type === "student") {
    const student = studentsById.get(result.student_id ?? "");
    if (!student) throw new Error(`student ${result.student_id} not found`);
    const ensured = await ensureStudentProject({
      input,
      student,
      creatorAccountId,
      knownBayId,
    });
    const response = await reconcileOnOwningBay(request, ensured.bay_id);
    return {
      ...result,
      status: "done",
      ...(ensured.created ? { created: true } : {}),
      ...(response.email_invited_at
        ? { email_invited_at: response.email_invited_at }
        : {}),
      error: undefined,
    };
  }
  const response = await reconcileOnOwningBay(request, knownBayId);
  return { ...result, status: "done", ...response, error: undefined };
}

async function reconcileOneWithTransientRetry(
  opts: Parameters<typeof reconcileOne>[0],
): Promise<CourseReconfigureItemResult> {
  let knownBayId = opts.knownBayId;
  for (let attempt = 1; attempt <= TRANSIENT_ITEM_ATTEMPTS; attempt += 1) {
    try {
      return await reconcileOne({ ...opts, knownBayId });
    } catch (err) {
      if (
        attempt === TRANSIENT_ITEM_ATTEMPTS ||
        !isTransientCourseReconfigureError(err)
      ) {
        throw err;
      }
      logger.warn("retrying transient course project reconciliation failure", {
        project_id: opts.request.project_id,
        attempt,
        err: `${err}`,
      });
      await delay(TRANSIENT_ITEM_RETRY_BASE_MS * 2 ** (attempt - 1));
      // Project creation can commit before a later step deadlocks. Refreshing
      // ownership makes the retry reconcile that project instead of recreating it.
      knownBayId = (
        await resolveProjectBay(opts.request.project_id).catch(() => undefined)
      )?.bay_id;
    }
  }
  throw new Error("unreachable course project retry state");
}

function buildInitialResults(
  input: CourseReconfigureLroInput,
  existing: CourseReconfigureItemResult[],
): CourseReconfigureItemResult[] {
  const existingByKey = new Map(existing.map((item) => [item.key, item]));
  const results: CourseReconfigureItemResult[] = input.students.map(
    (student) => {
      const key = `student:${student.student_id}`;
      return (
        existingByKey.get(key) ?? {
          key,
          type: "student",
          student_id: student.student_id,
          project_id: student.project_id,
          status: "queued",
        }
      );
    },
  );
  const extras = [
    ["shared", input.settings.shared_project_id],
    ["nbgrader", input.settings.nbgrader_project_id],
  ] as const;
  const studentProjectIds = new Set(
    input.students.map((student) => student.project_id),
  );
  for (const [type, project_id] of extras) {
    if (!project_id || project_id === input.course_project_id) continue;
    if (studentProjectIds.has(project_id)) continue;
    const key = `${type}:${project_id}`;
    results.push(
      existingByKey.get(key) ?? {
        key,
        type,
        project_id,
        status: "queued",
      },
    );
  }
  return results.map((item) =>
    item.status === "running" ? { ...item, status: "queued" } : item,
  );
}

async function handleCourseReconfigureOpUnlocked(
  op: LroSummary,
): Promise<void> {
  const input = op.input as CourseReconfigureLroInput;
  if (!op.created_by) {
    await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: "course reconfiguration is missing its creator",
      if_status: ["queued", "running"],
    });
    return;
  }
  const parent = await assertProjectCollaboratorAccessAllowRemote({
    account_id: op.created_by,
    project_id: input.course_project_id,
  });
  const managers = Object.entries(parent.users ?? {}).filter(
    ([, info]) => info?.group === "owner" || info?.group === "collaborator",
  );
  const managerAccountIds = managers.map(([account_id]) => account_id);
  if (managerAccountIds.length === 0) {
    throw new Error("course project has no managers");
  }
  const creatorAccountId = await getProjectUsageAccountId(
    input.course_project_id,
  );
  if (!creatorAccountId) {
    throw new Error("course project has no usage owner");
  }
  const activeStudentAccountIds = input.students
    .filter((student) => !student.deleted && student.account_id)
    .map((student) => student.account_id!);
  const existingItems = Array.isArray(op.result?.items)
    ? (op.result.items as CourseReconfigureItemResult[])
    : [];
  const results = buildInitialResults(input, existingItems);

  await updateProgress({ op, results });
  const studentsById = new Map(
    input.students.map((student) => [student.student_id, student]),
  );
  const requestsByKey = new Map<string, ReconcileRequest>();
  for (const result of results) {
    if (result.status === "done") continue;
    try {
      requestsByKey.set(
        result.key,
        buildReconcileRequest({
          op,
          input,
          result,
          managerAccountIds,
          activeStudentAccountIds,
          studentsById,
        }),
      );
    } catch (err) {
      result.status = "failed";
      result.error = `${err}`;
    }
  }
  const projectBays = await resolveCourseManagedProjectBays(
    [...requestsByKey.values()].map(({ project_id }) => project_id),
  );
  const projectStates = await getCourseManagedProjectStatesByBay(projectBays);
  for (const result of results) {
    const request = requestsByKey.get(result.key);
    if (!request || result.status === "done") continue;
    const state = projectStates.get(request.project_id);
    if (state && !courseManagedProjectNeedsReconcile(request, state)) {
      result.status = "done";
      result.error = undefined;
    }
  }
  await updateProgress({ op, results });

  await mapParallelLimit(
    results,
    async (result) => {
      if (result.status === "done") return;
      const request = requestsByKey.get(result.key);
      if (!request) return;
      const current = await getLro(op.op_id);
      if (current?.status === "canceled" || current?.status === "expired") {
        result.status = "canceled";
        return;
      }
      result.status = "running";
      result.error = undefined;
      await updateProgress({ op, results });
      try {
        Object.assign(
          result,
          await reconcileOneWithTransientRetry({
            input,
            result,
            studentsById,
            request,
            knownBayId: projectBays.get(request.project_id),
            creatorAccountId,
          }),
        );
      } catch (err) {
        result.status = "failed";
        result.error = `${err}`;
      }
      await updateProgress({ op, results });
    },
    DEFAULT_ITEM_PARALLEL,
  );
  const current = await getLro(op.op_id);
  if (current?.status === "canceled" || current?.status === "expired") {
    await publishSummarySafe(current);
    return;
  }
  const progress_summary = summarize(results);
  const failed = progress_summary.failed + progress_summary.canceled;
  const updated = await updateLro({
    op_id: op.op_id,
    status: failed > 0 ? "failed" : "succeeded",
    progress_summary,
    result: { items: results, progress_summary },
    error:
      failed > 0
        ? (results.find((item) => item.error)?.error ??
          `${failed} project configurations failed`)
        : null,
    if_status: ["queued", "running"],
  });
  await publishSummarySafe(updated);
}

async function handleCourseReconfigureOp(op: LroSummary): Promise<void> {
  const input = op.input as CourseReconfigureLroInput;
  const client = await getPool().connect();
  const heartbeat = setInterval(() => {
    touchLro({
      op_id: op.op_id,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
    }).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
      input.course_project_id,
      input.course_path,
    ]);
    const current = await getLro(op.op_id);
    if (isTerminal(current?.status)) return;
    await handleCourseReconfigureOpUnlocked(op);
  } finally {
    clearInterval(heartbeat);
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
        [input.course_project_id, input.course_path],
      );
    } catch {}
    client.release();
  }
}

export function startCourseReconfigureLroWorker({
  intervalMs = TICK_MS,
  maxParallel = DEFAULT_MAX_PARALLEL,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  const tick = async () => {
    if (inFlight >= maxParallel) return;
    const ops = await claimLroOps({
      kind: COURSE_RECONFIGURE_LRO_KIND,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
      limit: Math.max(1, maxParallel - inFlight),
      lease_ms: LEASE_MS,
    });
    for (const op of ops) {
      inFlight += 1;
      void handleCourseReconfigureOp(op)
        .catch(async (err) => {
          logger.warn("course reconfiguration op crashed", {
            op_id: op.op_id,
            err: `${err}`,
          });
          const current = await getLro(op.op_id).catch(() => undefined);
          if (!isTerminal(current?.status)) {
            const updated = await updateLro({
              op_id: op.op_id,
              status: "failed",
              error: `${err}`,
              if_status: ["queued", "running"],
            });
            await publishSummarySafe(updated);
          }
        })
        .finally(() => {
          inFlight -= 1;
        });
    }
  };
  tickFn = tick;
  const timer = setInterval(triggerCourseReconfigureLroWorker, intervalMs);
  timer.unref?.();
  triggerCourseReconfigureLroWorker();
  return () => {
    running = false;
    tickFn = undefined;
    tickRunning = false;
    tickRequested = false;
    clearInterval(timer);
  };
}

export function triggerCourseReconfigureLroWorker(): void {
  if (!running || !tickFn) return;
  tickRequested = true;
  if (tickRunning) return;
  tickRunning = true;
  void (async () => {
    try {
      while (tickRequested && running && tickFn) {
        tickRequested = false;
        await tickFn();
      }
    } finally {
      tickRunning = false;
    }
  })();
}

export function courseReconfigureLroResponse(op: LroSummary) {
  return {
    op_id: op.op_id,
    scope_type: "project" as const,
    scope_id: op.scope_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}
