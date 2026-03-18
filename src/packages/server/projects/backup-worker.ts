import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import { envToInt } from "@cocalc/backend/misc/env-to-number";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import getPool from "@cocalc/database/pool";
import { getEffectiveParallelOpsLimit } from "@cocalc/server/lro/worker-config";
import { getParallelOpsWorkerRegistration } from "@cocalc/server/lro/worker-registry";
import {
  ensureLroSchema,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/conat/lro/stream";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { withTimeout } from "@cocalc/util/async-utils";
import {
  computeHostAvailableBackupSlots,
  selectBackupClaimCandidateIds,
} from "./backup-admission";
import {
  BACKUP_LRO_KIND,
  BACKUP_TIMEOUT_MS,
  isBackupOpTimedOut,
} from "./backup-lro";
import {
  assertBackupTargetHostAvailable,
  watchBackupTargetHostAvailability,
} from "./backup-target-health";
import {
  listActiveProjectHosts,
  listHostLocalBackupStatuses,
} from "./backup-host-status";

const logger = getLogger("server:projects:backup-worker");
const pool = () => getPool();

const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = Math.max(
  1,
  Math.min(100, envToInt("COCALC_BACKUP_LRO_MAX_PARALLEL", 10)),
);
const MAX_BACKUPS_PER_PROJECT = 30;
const HOST_LOCAL_BACKUP_WORKER_KIND = "project-host-backup-execution";

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  backup: 80,
  done: 100,
};

let running = false;
let inFlight = 0;

type BackupClaimCandidateRow = LroSummary & {
  host_id: string | null;
};

function publishSummary(summary: LroSummary) {
  return publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  });
}

async function publishSummarySafe(
  summary: LroSummary,
  context: string,
): Promise<void> {
  try {
    await publishSummary(summary);
  } catch (err) {
    logger.warn("failed to publish backup LRO summary", {
      context,
      op_id: summary.op_id,
      err: `${err}`,
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
  }).catch((err) => {
    logger.warn("failed to publish backup LRO progress", {
      op_id: op.op_id,
      step,
      message,
      err: `${err}`,
    });
  });
}

async function handleBackupOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const project_id = input.project_id;
  const tags = Array.isArray(input.tags) ? input.tags : undefined;

  if (!project_id) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: "backup op missing project_id",
    });
    if (updated) {
      await publishSummarySafe(updated, "missing-project-id");
    }
    return;
  }

  if (isBackupOpTimedOut(op)) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `backup op exceeded timeout of ${BACKUP_TIMEOUT_MS}ms before execution`,
    });
    if (updated) {
      await publishSummarySafe(updated, "timed-out-before-start");
    }
    return;
  }

  const target = await assertBackupTargetHostAvailable({
    project_id,
    phase: "validate",
  });

  logger.info("backup op start", {
    op_id,
    project_id,
    host_id: target.host_id,
  });

  const heartbeat = setInterval(() => {
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      (err) => logger.debug("backup op heartbeat failed", { op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const hostWatch = watchBackupTargetHostAvailability({
    project_id,
    phase: "backup",
    pollMs: HEARTBEAT_MS,
  });
  const hostWatchFailure = new Promise<never>((_resolve, reject) => {
    hostWatch.promise.catch(reject);
  });

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
    logger.info("backup op step", {
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
    if (running) {
      await publishSummarySafe(running, "set-running");
    }
    progress({
      step: "validate",
      message: "starting backup",
      detail: { project_id },
    });

    const started = Date.now();
    progress({
      step: "backup",
      message: "creating backup snapshot",
      detail: { tags },
    });

    const backup = await Promise.race([
      withTimeout(
        (async () => {
          const client = await getProjectFileServerClient({
            project_id,
            timeout: BACKUP_TIMEOUT_MS,
          });
          return await client.createBackup({
            project_id,
            limit: MAX_BACKUPS_PER_PROJECT,
            tags,
            lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
          });
        })(),
        BACKUP_TIMEOUT_MS,
      ),
      hostWatchFailure,
    ]);
    const duration_ms = Date.now() - started;
    const backup_time =
      backup.time instanceof Date
        ? backup.time.toISOString()
        : new Date(backup.time as any).toISOString();

    logger.info("backup op done", {
      op_id,
      project_id,
      backup_id: backup.id,
      duration_ms,
    });

    const updated = await updateLro({
      op_id,
      status: "succeeded",
      result: { id: backup.id, time: backup_time, duration_ms },
      progress_summary: {
        phase: "done",
        id: backup.id,
        time: backup_time,
        duration_ms,
      },
      error: null,
    });
    if (updated) {
      await publishSummarySafe(updated, "set-succeeded");
    }
    progress({
      step: "done",
      message: "backup complete",
      detail: { backup_id: backup.id, duration_ms },
    });
  } catch (err) {
    logger.warn("backup op failed", { op_id, err: `${err}` });
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${err}`,
    });
    if (updated) {
      await publishSummarySafe(updated, "set-failed");
    }
    progress({ step: "done", message: "failed" });
  } finally {
    hostWatch.stop();
    clearInterval(heartbeat);
    logger.info("backup op cleanup", { op_id });
  }
}

async function listFreshRunningBackupCountsByHost({
  lease_ms = LEASE_MS,
}: {
  lease_ms?: number;
} = {}): Promise<Map<string, number>> {
  const { rows } = await pool().query<{
    host_id: string;
    count: string | number;
  }>(
    `
      SELECT p.host_id::text AS host_id, COUNT(*) AS count
      FROM long_running_operations l
      JOIN projects p ON p.project_id = l.scope_id::uuid
      WHERE l.kind = $1
        AND l.dismissed_at IS NULL
        AND l.status = 'running'
        AND l.heartbeat_at IS NOT NULL
        AND l.heartbeat_at >= now() - ($2::text || ' milliseconds')::interval
        AND p.host_id IS NOT NULL
      GROUP BY p.host_id
    `,
    [BACKUP_LRO_KIND, lease_ms],
  );
  return new Map(
    rows.map(({ host_id, count }) => [host_id, Number(count) || 0] as const),
  );
}

async function claimBackupLroOps({
  owner_type,
  owner_id,
  limit,
  lease_ms = LEASE_MS,
}: {
  owner_type: "hub";
  owner_id: string;
  limit: number;
  lease_ms?: number;
}): Promise<LroSummary[]> {
  if (limit <= 0) return [];
  const hostStatuses = await listHostLocalBackupStatuses();
  const freshRunningCounts = await listFreshRunningBackupCountsByHost({
    lease_ms,
  });
  const fallbackMaxParallelByHost = new Map<string, number>();
  if (hostStatuses.unreachable_hosts > 0 || hostStatuses.rows.length === 0) {
    const hostRegistration = getParallelOpsWorkerRegistration(
      HOST_LOCAL_BACKUP_WORKER_KIND,
    );
    const defaultHostLimit =
      hostRegistration?.getLimitSnapshot().default_limit ??
      DEFAULT_MAX_PARALLEL;
    const reportedHostIds = new Set(
      hostStatuses.rows.map(({ host_id }) => host_id),
    );
    for (const { id } of await listActiveProjectHosts()) {
      if (reportedHostIds.has(id)) continue;
      const { value } = await getEffectiveParallelOpsLimit({
        worker_kind: HOST_LOCAL_BACKUP_WORKER_KIND,
        default_limit: defaultHostLimit,
        scope_type: "project_host",
        scope_id: id,
      });
      fallbackMaxParallelByHost.set(id, value);
    }
    if (fallbackMaxParallelByHost.size > 0) {
      logger.warn("backup admission falling back to configured host limits", {
        reachable_hosts: hostStatuses.rows.length,
        unreachable_hosts: hostStatuses.unreachable_hosts,
        fallback_hosts: Array.from(fallbackMaxParallelByHost.keys()),
      });
    }
  }
  const availableByHost = computeHostAvailableBackupSlots({
    hostStatuses: hostStatuses.rows,
    freshRunningCounts,
    fallbackMaxParallelByHost,
  });
  if (!Array.from(availableByHost.values()).some((slots) => slots > 0)) {
    return [];
  }

  await ensureLroSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<BackupClaimCandidateRow>(
      `
        SELECT l.*, p.host_id::text AS host_id
        FROM long_running_operations l
        LEFT JOIN projects p ON p.project_id = l.scope_id::uuid
        WHERE l.kind = $1
          AND (
            l.status = 'queued'
            OR (
              l.status = 'running'
              AND (l.heartbeat_at IS NULL OR l.heartbeat_at < now() - ($2::text || ' milliseconds')::interval)
            )
          )
        ORDER BY
          CASE WHEN l.status = 'queued' THEN 0 ELSE 1 END,
          l.updated_at
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      `,
      [BACKUP_LRO_KIND, lease_ms, Math.max(limit * 4, 50)],
    );
    const opIds = selectBackupClaimCandidateIds({
      candidates: rows.map(({ op_id, host_id }) => ({ op_id, host_id })),
      availableByHost,
      limit,
    });
    if (opIds.length === 0) {
      await client.query("ROLLBACK");
      return [];
    }
    const claimed = await client.query<LroSummary>(
      `
        UPDATE long_running_operations
        SET owner_type = $2,
            owner_id = $3,
            heartbeat_at = now(),
            status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
            started_at = COALESCE(started_at, now()),
            attempt = attempt + 1,
            updated_at = now()
        WHERE op_id = ANY($1::uuid[])
        RETURNING *
      `,
      [opIds, owner_type, owner_id],
    );
    await client.query("COMMIT");
    return claimed.rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function startBackupLroWorker({
  intervalMs = TICK_MS,
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting backup LRO worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: BACKUP_LRO_KIND,
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("backup op limit lookup failed", { err });
        return;
      }
    }
    if (inFlight >= effectiveMaxParallel) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimBackupLroOps({
        owner_type: OWNER_TYPE,
        owner_id: WORKER_ID,
        limit: Math.max(1, effectiveMaxParallel - inFlight),
        lease_ms: LEASE_MS,
      });
    } catch (err) {
      logger.warn("backup op claim failed", { err });
      return;
    }

    for (const op of ops) {
      inFlight += 1;
      void handleBackupOp(op)
        .catch(async (err) => {
          logger.warn("backup op handler failed", { op_id: op.op_id, err });
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
