import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import type { SnapshotRestoreMode } from "@cocalc/conat/files/file-server";
import { getEffectiveParallelOpsLimit } from "@cocalc/server/lro/worker-config";
import { claimLroOps, touchLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/conat/lro/stream";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import { getProject } from "@cocalc/server/projects/control";
import { replaceProjectRootfsStates } from "@cocalc/server/projects/rootfs-state";

const logger = getLogger("server:projects:restore-worker");

const RESTORE_LRO_KIND = "project-restore";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 1;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  stop: 15,
  snapshot: 30,
  restore: 80,
  start: 90,
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

function defaultSafetySnapshotName(snapshot: string): string {
  return `restore-safety-${snapshot}-${new Date().toISOString()}`;
}

async function getSnapshotRestoreImage({
  client,
  project_id,
  snapshot,
  mode,
}: {
  client: Awaited<ReturnType<typeof getProjectFileServerClient>>;
  project_id: string;
  snapshot: string;
  mode: SnapshotRestoreMode;
}): Promise<string | undefined> {
  if (mode === "home") return;
  try {
    const preview = await client.getSnapshotFileText({
      project_id,
      snapshot,
      path: `${PROJECT_IMAGE_PATH}/current-image.txt`,
      max_bytes: 4096,
    });
    const image = preview.content.trim();
    return image.length > 0 ? image : undefined;
  } catch {
    return undefined;
  }
}

async function setProjectRestoreImage({
  project_id,
  image,
}: {
  project_id: string;
  image?: string;
}): Promise<void> {
  if (!image) return;
  await replaceProjectRootfsStates({
    project_id,
    current: { image },
  });
}

async function handleRestoreOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const project_id = input.project_id;
  const backup_id = input.id;
  const restoreType = input.restore_type;
  const snapshot = input.snapshot;
  const path = input.path;
  const dest = input.dest;

  if (!project_id || (!backup_id && !snapshot)) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: "restore op missing project_id and restore target",
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
      detail: {
        project_id,
        restore_type: restoreType ?? (snapshot ? "snapshot" : "backup"),
        backup_id,
        snapshot,
      },
    });

    const started = Date.now();
    const client = await getProjectFileServerClient({
      project_id,
      timeout: RESTORE_TIMEOUT_MS,
    });
    await ensureProjectFileServerClientReady({
      project_id,
      client,
      maxWait: FILE_SERVER_READY_TIMEOUT_MS,
    });
    let result: Record<string, unknown>;
    if (restoreType === "snapshot" || snapshot) {
      if (!snapshot) {
        throw new Error("snapshot restore op missing snapshot name");
      }
      const mode = (input.mode ?? "both") as SnapshotRestoreMode;
      if (!["both", "home", "rootfs"].includes(mode)) {
        throw new Error(`invalid snapshot restore mode: ${mode}`);
      }
      const safetySnapshotName =
        input.safety_snapshot_name ?? defaultSafetySnapshotName(snapshot);
      const restoreImage = await getSnapshotRestoreImage({
        client,
        project_id,
        snapshot,
        mode,
      });
      const project = getProject(project_id);

      progress({
        step: "stop",
        message: "stopping project",
        detail: { project_id },
      });
      await project.stop();

      progress({
        step: "snapshot",
        message: "creating safety snapshot",
        detail: { safety_snapshot_name: safetySnapshotName },
      });
      await client.createSnapshot({
        project_id,
        name: safetySnapshotName,
      });

      progress({
        step: "restore",
        message: "restoring snapshot",
        detail: { snapshot, mode },
      });
      await client.restoreSnapshot({
        project_id,
        snapshot,
        mode,
        safety_snapshot_name: safetySnapshotName,
        lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
      });
      await setProjectRestoreImage({ project_id, image: restoreImage });

      progress({
        step: "start",
        message: "starting project",
        detail: { project_id },
      });
      await project.start({ lro_op_id: op_id });
      result = {
        restore_type: "snapshot",
        snapshot,
        mode,
        safety_snapshot_name: safetySnapshotName,
      };
    } else {
      if (!backup_id) {
        throw new Error("backup restore op missing backup id");
      }
      progress({
        step: "restore",
        message: "restoring backup",
        detail: { backup_id, path, dest },
      });
      await client.restoreBackup({
        project_id,
        id: backup_id,
        path,
        dest,
        lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
      });
      result = {
        restore_type: "backup",
        id: backup_id,
        path,
        dest,
      };
    }
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
      result: { ...result, duration_ms },
      progress_summary: {
        phase: "done",
        ...result,
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
      detail: { ...result, duration_ms },
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
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting restore LRO worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: RESTORE_LRO_KIND,
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("restore op limit lookup failed", { err });
        return;
      }
    }
    if (inFlight >= effectiveMaxParallel) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimLroOps({
        kind: RESTORE_LRO_KIND,
        owner_type: OWNER_TYPE,
        owner_id: WORKER_ID,
        limit: Math.max(1, effectiveMaxParallel - inFlight),
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
