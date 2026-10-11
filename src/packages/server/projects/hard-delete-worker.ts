import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { getEffectiveParallelOpsLimit } from "@cocalc/server/lro/worker-config";
import { claimLroOps, touchLro, updateLro } from "@cocalc/server/lro/lro-db";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  hardDeleteProject,
  processDueDeletedProjectBackupPurges,
  type HardDeleteProjectProgressUpdate,
} from "@cocalc/server/projects/hard-delete";
import { markProjectHardDeleteFailed } from "@cocalc/server/projects/hard-delete-state";
import { assertProjectHostsNotUnderMaintenance } from "@cocalc/server/hosts/maintenance";

const logger = getLogger("server:projects:hard-delete-worker");

const HARD_DELETE_LRO_KIND = "project-hard-delete";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 1;
const SAFE_MAX_PARALLEL = 1;
const BACKUP_PURGE_BATCH_SIZE = 1;

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  backups: 35,
  "host-cleanup": 65,
  "db-cleanup": 90,
  done: 100,
};

let running = false;
let inFlight = 0;
let tickRunning = false;
let tickRequested = false;
let tickFn: (() => Promise<void>) | undefined;

function publishSummary(summary: LroSummary) {
  return publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  });
}

function progressEvent({
  op,
  update,
}: {
  op: LroSummary;
  update: HardDeleteProjectProgressUpdate;
}) {
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: update.step,
      message: update.message,
      progress: progressSteps[update.step],
      detail: update.detail,
    },
  }).catch((err) =>
    logger.warn("failed to publish hard-delete progress", {
      op_id: op.op_id,
      step: update.step,
      err: `${err}`,
    }),
  );
}

async function publishSummarySafe(
  summary: LroSummary,
  context: string,
): Promise<void> {
  try {
    await publishSummary(summary);
  } catch (err) {
    logger.warn("failed to publish hard-delete summary", {
      context,
      op_id: summary.op_id,
      err: `${err}`,
    });
  }
}

async function handleHardDeleteOp(op: LroSummary): Promise<void> {
  const input = op.input ?? {};
  const project_id = `${input.project_id ?? ""}`.trim();
  const account_id = `${op.created_by ?? input.account_id ?? ""}`.trim();
  const backup_retention_days =
    typeof input.backup_retention_days === "number"
      ? input.backup_retention_days
      : undefined;
  const purge_backups_now = !!input.purge_backups_now;

  if (!project_id || !account_id) {
    const updated = await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: "hard delete op missing project_id or account_id",
    });
    if (updated) {
      await publishSummarySafe(updated, "missing-input");
    }
    return;
  }

  const heartbeat = setInterval(() => {
    touchLro({
      op_id: op.op_id,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
    }).catch((err) =>
      logger.debug("hard-delete heartbeat failed", { op_id: op.op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastProgressKey = "";
  const progress = async (update: HardDeleteProjectProgressUpdate) => {
    const key = `${update.step}|${update.message ?? ""}|${JSON.stringify(update.detail ?? {})}`;
    if (key === lastProgressKey) {
      return;
    }
    lastProgressKey = key;
    progressEvent({ op, update });
    touchLro({
      op_id: op.op_id,
      owner_type: OWNER_TYPE,
      owner_id: WORKER_ID,
    }).catch(() => {});
    const summary = await updateLro({
      op_id: op.op_id,
      progress_summary: {
        phase: update.step,
        ...(update.detail ?? {}),
      },
    });
    if (summary) {
      await publishSummarySafe(summary, "progress");
    }
  };

  try {
    await assertProjectHostsNotUnderMaintenance({ project_ids: [project_id] });
    const runningSummary = await updateLro({
      op_id: op.op_id,
      status: "running",
      error: null,
      progress_summary: {
        phase: "validate",
        project_id,
      },
    });
    if (runningSummary) {
      await publishSummarySafe(runningSummary, "set-running");
    }

    const result = await hardDeleteProject({
      project_id,
      account_id,
      backup_retention_days,
      purge_backups_now,
      onProgress: progress,
    });

    const updated = await updateLro({
      op_id: op.op_id,
      status: "succeeded",
      result,
      error: null,
      progress_summary: {
        phase: "done",
        project_id,
      },
    });
    if (updated) {
      await publishSummarySafe(updated, "set-succeeded");
    }
    await progress({
      step: "done",
      message: "workspace permanently deleted",
      detail: { project_id },
    });
  } catch (err) {
    logger.warn("hard-delete op failed", {
      op_id: op.op_id,
      project_id,
      err: `${err}`,
    });
    const updated = await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: `${err}`,
    });
    if (updated) {
      await publishSummarySafe(updated, "set-failed");
    }
    try {
      const marked = await markProjectHardDeleteFailed({
        project_id,
        op_id: op.op_id,
        error: `${err}`,
      });
      if (marked) {
        await appendProjectOutboxEventForProject({
          event_type: "project.state_changed",
          project_id,
          default_bay_id: getConfiguredBayId(),
        });
        await publishProjectAccountFeedEventsBestEffort({
          project_id,
          default_bay_id: getConfiguredBayId(),
        });
      }
    } catch (stateErr) {
      logger.warn("failed to mark project hard-delete failure", {
        op_id: op.op_id,
        project_id,
        err: `${stateErr}`,
      });
    }
    await progress({
      step: "done",
      message: "failed",
      detail: { project_id, error: `${err}` },
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function startProjectHardDeleteWorker({
  intervalMs = TICK_MS,
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting project hard-delete worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: HARD_DELETE_LRO_KIND,
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("hard-delete limit lookup failed", { err: `${err}` });
        return;
      }
    }
    if (effectiveMaxParallel > SAFE_MAX_PARALLEL) {
      logger.warn("clamping unsafe project hard-delete concurrency", {
        configured_max_parallel: effectiveMaxParallel,
        safe_max_parallel: SAFE_MAX_PARALLEL,
      });
      effectiveMaxParallel = SAFE_MAX_PARALLEL;
    }
    let claimedOps = 0;
    if (inFlight < effectiveMaxParallel) {
      let ops: LroSummary[] = [];
      try {
        ops = await claimLroOps({
          kind: HARD_DELETE_LRO_KIND,
          owner_type: OWNER_TYPE,
          owner_id: WORKER_ID,
          limit: Math.max(1, effectiveMaxParallel - inFlight),
          lease_ms: LEASE_MS,
        });
      } catch (err) {
        logger.warn("hard-delete claim failed", { err: `${err}` });
      }
      claimedOps = ops.length;
      for (const op of ops) {
        inFlight += 1;
        void handleHardDeleteOp(op)
          .catch(async (err) => {
            logger.warn("hard-delete handler failed", {
              op_id: op.op_id,
              err: `${err}`,
            });
            const updated = await updateLro({
              op_id: op.op_id,
              status: "failed",
              error: `${err}`,
            });
            if (updated) {
              await publishSummarySafe(updated, "handler-catch");
            }
          })
          .finally(() => {
            inFlight = Math.max(0, inFlight - 1);
          });
      }
    }

    // Rustic backup scans are I/O intensive. Never overlap a deferred purge
    // with hard-delete work owned by this bay maintenance worker.
    if (inFlight > 0 || claimedOps > 0) {
      return;
    }

    try {
      const purge = await processDueDeletedProjectBackupPurges({
        limit: BACKUP_PURGE_BATCH_SIZE,
      });
      if (purge.quarantined > 0) {
        logger.warn("quarantined deleted-project backup purges", purge);
      } else if (purge.processed > 0 || purge.recovered_stale > 0) {
        logger.info("processed deferred deleted-project backup purges", purge);
      }
    } catch (err) {
      logger.warn("deleted-project backup purge pass failed", {
        err: `${err}`,
      });
    }
  };
  tickFn = tick;

  const timer = setInterval(() => {
    triggerProjectHardDeleteWorker();
  }, intervalMs);
  timer.unref?.();

  triggerProjectHardDeleteWorker();

  return () => {
    running = false;
    tickFn = undefined;
    tickRunning = false;
    tickRequested = false;
    clearInterval(timer);
  };
}

export function triggerProjectHardDeleteWorker(): void {
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
