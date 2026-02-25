import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { client as fileServerClient, type Fileserver } from "@cocalc/conat/files/file-server";
import {
  claimLroOps,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/conat/lro/stream";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";

const logger = getLogger("server:projects:restore-worker");

const RESTORE_LRO_KIND = "project-restore";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const MAX_PARALLEL = 1;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  restore: 80,
  done: 100,
};

let running = false;
let inFlight = 0;

function publishSummary(summary: LroSummary) {
  return publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  });
}

async function publishSummarySafe(
  summary: LroSummary | undefined,
  context: { op_id: string; when: string },
) {
  if (!summary) return;
  try {
    await publishSummary(summary);
  } catch (err) {
    logger.warn("restore op publish summary failed", {
      op_id: context.op_id,
      when: context.when,
      err,
    });
  }
}

function progressEvent({
  op,
  step,
  message,
  detail,
}: {
  op: LroSummary;
  step: string;
  message?: string;
  detail?: any;
}) {
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: step,
      message,
      progress: progressSteps[step],
      detail,
    },
  });
}

function fileServerClientWithTimeout(project_id: string): Fileserver {
  return fileServerClient({
    project_id,
    timeout: RESTORE_TIMEOUT_MS,
  });
}

async function ensureProjectRoute(project_id: string): Promise<void> {
  const address = await materializeProjectHost(project_id);
  if (!address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
}

async function handleRestoreOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const project_id = input.project_id;
  const backup_id = input.id;
  const path = input.path;
  const dest = input.dest;

  if (!project_id || !backup_id) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: "restore op missing project_id or backup id",
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "invalid-input",
    });
    return;
  }

  logger.info("restore op start", { op_id, project_id, backup_id });

  const heartbeat = setInterval(() => {
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      (err) => logger.debug("restore op heartbeat failed", { op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastProgressKey: string | null = null;
  const progress = (update: {
    step: string;
    message?: string;
    detail?: any;
  }) => {
    let detailKey = "";
    if (update.detail !== undefined) {
      try {
        detailKey = JSON.stringify(update.detail);
      } catch {
        detailKey = String(update.detail);
      }
    }
    const progressKey = `${update.step}|${update.message ?? ""}|${detailKey}`;
    if (progressKey === lastProgressKey) {
      return;
    }
    lastProgressKey = progressKey;
    logger.info("restore op step", {
      op_id,
      step: update.step,
      message: update.message,
      detail: update.detail,
    });
    progressEvent({ op, ...update });
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      () => {},
    );
  };

  try {
    const running = await updateLro({
      op_id,
      status: "running",
      error: null,
      progress_summary: { phase: "validate" },
    });
    await publishSummarySafe(running, {
      op_id,
      when: "set-running",
    });
    progress({
      step: "validate",
      message: "starting restore",
      detail: { project_id, backup_id },
    });

    const started = Date.now();
    progress({
      step: "restore",
      message: "restoring backup",
      detail: { backup_id, path, dest },
    });

    await ensureProjectRoute(project_id);
    const client = fileServerClientWithTimeout(project_id);
    await client.restoreBackup({
      project_id,
      id: backup_id,
      path,
      dest,
      lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
    });
    const duration_ms = Date.now() - started;

    logger.info("restore op done", {
      op_id,
      project_id,
      backup_id,
      duration_ms,
    });

    const updated = await updateLro({
      op_id,
      status: "succeeded",
      result: { id: backup_id, path, dest, duration_ms },
      progress_summary: {
        phase: "done",
        id: backup_id,
        path,
        dest,
        duration_ms,
      },
      error: null,
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "set-succeeded",
    });
    progress({
      step: "done",
      message: "restore complete",
      detail: { backup_id, path, dest, duration_ms },
    });
  } catch (err) {
    logger.warn("restore op failed", { op_id, err: `${err}` });
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${err}`,
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "set-failed",
    });
    progress({ step: "done", message: "failed" });
  } finally {
    clearInterval(heartbeat);
    logger.info("restore op cleanup", { op_id });
  }
}

export function startRestoreLroWorker({
  intervalMs = TICK_MS,
  maxParallel = MAX_PARALLEL,
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting restore LRO worker", { worker_id: WORKER_ID });

  const tick = async () => {
    if (inFlight >= maxParallel) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimLroOps({
        kind: RESTORE_LRO_KIND,
        owner_type: OWNER_TYPE,
        owner_id: WORKER_ID,
        limit: Math.max(1, maxParallel - inFlight),
        lease_ms: LEASE_MS,
      });
    } catch (err) {
      logger.warn("restore op claim failed", { err });
      return;
    }

    for (const op of ops) {
      inFlight += 1;
      void handleRestoreOp(op)
        .catch(async (err) => {
          logger.warn("restore op handler failed", { op_id: op.op_id, err });
          const updated = await updateLro({
            op_id: op.op_id,
            status: "failed",
            error: `${err}`,
          });
          await publishSummarySafe(updated, {
            op_id: op.op_id,
            when: "handler-catch",
          });
        })
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1);
        });
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  void tick();

  return () => {
    running = false;
    clearInterval(timer);
  };
}
