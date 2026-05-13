import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import type { LroStatus, LroSummary } from "@cocalc/conat/hub/api/lro";
import type { CourseCollectAssignmentItem } from "@cocalc/conat/hub/api/projects";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";
import {
  createNotificationEventGraph,
  resolveNotificationTargetHomeBays,
} from "@cocalc/database/postgres/notifications-core";
import {
  claimLroOps,
  createLro,
  getLro,
  listChildLro,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { triggerCopyLroWorker } from "./copy-worker";
import { cancelCopiesByOpId } from "./copy-db";

const logger = getLogger("server:projects:course-collect-worker");

export const COURSE_COLLECT_ASSIGNMENT_LRO_KIND = "course-collect-assignment";

const OWNER_TYPE = "hub" as const;
const WORKER_ID = randomUUID();
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_ITEM_PARALLEL = 4;
const CHILD_COPY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set<LroStatus>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

type CourseCollectItemResult = {
  student_id: string;
  status: "queued" | "running" | "done" | "failed" | "canceled" | "expired";
  error?: string;
  child_op_id?: string;
};

let running = false;
let inFlight = 0;
let tickFn: (() => Promise<void>) | undefined;
let tickRunning = false;
let tickRequested = false;

function summarize(results: CourseCollectItemResult[], total: number) {
  const done = results.filter((result) => result.status === "done").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const canceled = results.filter(
    (result) => result.status === "canceled",
  ).length;
  const expired = results.filter(
    (result) => result.status === "expired",
  ).length;
  const running = results.filter(
    (result) => result.status === "running",
  ).length;
  const queued = Math.max(
    0,
    total - done - failed - canceled - expired - running,
  );
  return { total, queued, running, done, failed, canceled, expired };
}

async function publishSummarySafe(
  summary: LroSummary | undefined,
  context: { op_id: string; when: string },
) {
  if (!summary) return;
  try {
    await publishLroSummary({
      scope_type: summary.scope_type,
      scope_id: summary.scope_id,
      summary,
    });
  } catch (err) {
    logger.warn("course collect publish summary failed", {
      ...context,
      err: `${err}`,
    });
  }
}

function isTerminal(status?: string | null): status is LroStatus {
  return TERMINAL_STATUSES.has(status as LroStatus);
}

async function updateParentProgress({
  op,
  results,
}: {
  op: LroSummary;
  results: CourseCollectItemResult[];
}): Promise<LroSummary | undefined> {
  const current = await getLro(op.op_id);
  if (isTerminal(current?.status)) {
    return current;
  }
  const input = op.input ?? {};
  const total = Array.isArray(input.items) ? input.items.length : 0;
  const progress_summary = {
    phase: "collect",
    ...summarize(results, total),
  };
  const updated = await updateLro({
    op_id: op.op_id,
    status: "running",
    progress_summary,
    result: { items: results, progress_summary },
    error: null,
  });
  await publishSummarySafe(updated, {
    op_id: op.op_id,
    when: "progress",
  });
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "collect",
      message: `${progress_summary.done}/${progress_summary.total} collected`,
      progress:
        progress_summary.total > 0
          ? Math.round((100 * progress_summary.done) / progress_summary.total)
          : 100,
      detail: progress_summary,
    },
  });
  return updated;
}

async function cancelChildCopy(op_id: string): Promise<LroSummary | undefined> {
  await cancelCopiesByOpId({ op_id, include_applying: true });
  const updated = await updateLro({
    op_id,
    status: "canceled",
    error: "parent collection canceled",
  });
  await publishSummarySafe(updated, {
    op_id,
    when: "child-canceled",
  });
  return updated;
}

export async function cancelCourseCollectChildren({
  op_id,
}: {
  op_id: string;
}): Promise<void> {
  const children = await listChildLro({ parent_id: op_id });
  await Promise.all(
    children
      .filter((child) => child.kind === "copy-path-between-projects")
      .filter((child) => !isTerminal(child.status))
      .map((child) => cancelChildCopy(child.op_id)),
  );
}

async function waitForChildCopy({
  parent_op_id,
  child_op_id,
}: {
  parent_op_id: string;
  child_op_id: string;
}): Promise<LroSummary> {
  const deadline = Date.now() + CHILD_COPY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const parent = await getLro(parent_op_id);
    if (parent?.status === "canceled" || parent?.status === "expired") {
      const canceled = await cancelChildCopy(child_op_id);
      if (canceled) return canceled;
      throw new Error("parent collection canceled");
    }
    const summary = await getLro(child_op_id);
    if (summary && TERMINAL_STATUSES.has(summary.status)) {
      return summary;
    }
    await delay(1000);
  }
  throw new Error("timeout waiting for student copy");
}

async function writeStudentMarker({
  course_project_id,
  dest_path,
  student_name,
}: {
  course_project_id: string;
  dest_path: string;
  student_name?: string;
}): Promise<void> {
  if (!student_name) return;
  const fs = (
    await getExplicitProjectRoutedClient({
      project_id: course_project_id,
    })
  ).fs({ project_id: course_project_id });
  await fs.writeFile(
    `${dest_path}/STUDENT - ${student_name}.txt`,
    `This student is ${student_name}.`,
  );
}

async function notifyStudentAssignmentCollected({
  op,
  item,
}: {
  op: LroSummary;
  item: CourseCollectAssignmentItem;
}): Promise<void> {
  const target_account_id = `${item.student_account_id ?? ""}`.trim();
  if (!target_account_id) return;
  const source_bay_id = getConfiguredBayId();
  const targetHomeBays = await resolveNotificationTargetHomeBays({
    account_ids: [target_account_id],
    default_bay_id: source_bay_id,
  });
  const assignmentTitle =
    `${item.assignment_title ?? ""}`.trim() || item.src_path;
  const body_markdown = `Your work for **${assignmentTitle}** has been collected by your instructor.`;
  await createNotificationEventGraph({
    kind: "account_notice",
    source_bay_id,
    source_project_id: item.student_project_id,
    source_path: item.src_path,
    actor_account_id: op.created_by,
    origin_kind: "project",
    payload_json: {
      severity: "info",
      title: "Assignment collected",
      body_markdown,
      origin_label: "Course",
      action_label: "Open assignment",
      notice_type: "course_assignment_collected",
      assignment_id: op.input?.assignment_id ?? null,
      course_project_id: op.input?.course_project_id ?? op.scope_id,
      collection_op_id: op.op_id,
    },
    targets: [
      {
        target_account_id,
        target_home_bay_id: targetHomeBays[target_account_id],
        dedupe_key: [
          "course_assignment_collected",
          op.op_id,
          item.student_id,
          target_account_id,
        ].join(":"),
        summary_json: {
          title: "Assignment collected",
          body_markdown,
          severity: "info",
          origin_label: "Course",
          action_label: "Open assignment",
          notice_type: "course_assignment_collected",
          path: item.src_path,
          assignment_id: op.input?.assignment_id ?? null,
          course_project_id: op.input?.course_project_id ?? op.scope_id,
          collection_op_id: op.op_id,
        },
      },
    ],
  });
}

async function collectOne({
  op,
  item,
}: {
  op: LroSummary;
  item: CourseCollectAssignmentItem;
}): Promise<CourseCollectItemResult> {
  const input = op.input ?? {};
  const course_project_id = `${input.course_project_id ?? op.scope_id}`;
  const child = await createLro({
    kind: "copy-path-between-projects",
    scope_type: "project",
    scope_id: item.student_project_id,
    created_by: op.created_by ?? undefined,
    routing: "hub",
    parent_id: op.op_id,
    input: {
      src: {
        project_id: item.student_project_id,
        path: item.src_path,
      },
      dests: [
        {
          project_id: course_project_id,
          path: item.dest_path,
          metadata: {
            student_id: item.student_id,
            course_item_id: `${input.assignment_id ?? ""}`,
          },
        },
      ],
      options: input.options ?? { recursive: true },
    },
    status: "queued",
  } as any);
  await publishSummarySafe(child, {
    op_id: child.op_id,
    when: "child-created",
  });
  triggerCopyLroWorker();
  const summary = await waitForChildCopy({
    parent_op_id: op.op_id,
    child_op_id: child.op_id,
  });
  if (summary.status === "succeeded") {
    await writeStudentMarker({
      course_project_id,
      dest_path: item.dest_path,
      student_name: item.student_name,
    });
    await notifyStudentAssignmentCollected({ op, item }).catch((err) =>
      logger.warn("course collect notification failed", {
        op_id: op.op_id,
        student_id: item.student_id,
        err: `${err}`,
      }),
    );
    return {
      student_id: item.student_id,
      status: "done",
      child_op_id: child.op_id,
    };
  }
  return {
    student_id: item.student_id,
    status:
      summary.status === "expired"
        ? "expired"
        : summary.status === "canceled"
          ? "canceled"
          : "failed",
    error: summary.error ?? summary.status,
    child_op_id: child.op_id,
  };
}

async function handleCourseCollectOp(op: LroSummary): Promise<void> {
  const input = op.input ?? {};
  const items: CourseCollectAssignmentItem[] = Array.isArray(input.items)
    ? input.items
    : [];
  const results: CourseCollectItemResult[] = [];
  if (!items.length) {
    const updated = await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: "no students to collect",
    });
    await publishSummarySafe(updated, {
      op_id: op.op_id,
      when: "invalid-input",
    });
    return;
  }

  const heartbeat = setInterval(() => {
    touchLro({
      op_id: op.op_id,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
    }).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await updateParentProgress({ op, results });
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const current = await getLro(op.op_id);
        if (current?.status === "canceled" || current?.status === "expired") {
          return;
        }
        const item = items[next++];
        const runningResult: CourseCollectItemResult = {
          student_id: item.student_id,
          status: "running",
        };
        results.push(runningResult);
        await updateParentProgress({ op, results });
        const finalResult = await collectOne({ op, item }).catch((err) => ({
          student_id: item.student_id,
          status: "failed" as const,
          error: `${err}`,
        }));
        Object.assign(runningResult, finalResult);
        await updateParentProgress({ op, results });
      }
    }
    const parallel = Math.max(1, Math.min(DEFAULT_ITEM_PARALLEL, items.length));
    await Promise.all(Array.from({ length: parallel }, () => worker()));

    const current = await getLro(op.op_id);
    if (current?.status === "canceled" || current?.status === "expired") {
      await cancelCourseCollectChildren({ op_id: op.op_id });
      await publishSummarySafe(current, {
        op_id: op.op_id,
        when: "preserve-terminal-status",
      });
      return;
    }

    const progress_summary = summarize(results, items.length);
    const failed =
      progress_summary.failed +
      progress_summary.canceled +
      progress_summary.expired;
    const updated = await updateLro({
      op_id: op.op_id,
      status: failed > 0 ? "failed" : "succeeded",
      progress_summary,
      result: { items: results, progress_summary },
      error:
        failed > 0
          ? (results.find((result) => result.error)?.error ??
            "collection failed")
          : null,
    });
    await publishSummarySafe(updated, {
      op_id: op.op_id,
      when: "done",
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function startCourseCollectLroWorker({
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
      kind: COURSE_COLLECT_ASSIGNMENT_LRO_KIND,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
      limit: Math.max(1, maxParallel - inFlight),
      lease_ms: LEASE_MS,
      input_not_before_key: "run_at",
    });
    for (const op of ops) {
      inFlight += 1;
      void handleCourseCollectOp(op)
        .catch((err) =>
          logger.warn("course collect op crashed", {
            op_id: op.op_id,
            err: `${err}`,
          }),
        )
        .finally(() => {
          inFlight -= 1;
        });
    }
  };
  tickFn = tick;
  const timer = setInterval(triggerCourseCollectLroWorker, intervalMs);
  timer.unref?.();
  triggerCourseCollectLroWorker();
  return () => {
    running = false;
    tickFn = undefined;
    tickRunning = false;
    tickRequested = false;
    clearInterval(timer);
  };
}

export function triggerCourseCollectLroWorker(): void {
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

export function courseCollectLroResponse(op: LroSummary) {
  return {
    op_id: op.op_id,
    scope_type: "project" as const,
    scope_id: op.scope_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}
