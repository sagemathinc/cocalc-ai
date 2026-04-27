import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  ensureLroSchema,
  getLro,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import {
  getEffectiveParallelOpsLimit,
  getEffectiveParallelOpsLimits,
} from "@cocalc/server/lro/worker-config";
import { getParallelOpsWorkerRegistration } from "@cocalc/server/lro/worker-registry";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";
import {
  MOVE_CANCELED_CODE,
  moveProjectToHost,
  type MoveProjectProgressUpdate,
} from "./move";
import {
  computeAvailableMoveHostSlots,
  selectMoveClaimCandidates,
  type MoveActiveDestinationHost,
} from "./move-admission";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const logger = getLogger("server:projects:move-worker");
const pool = () => getPool();

const MOVE_LRO_KIND = "project-move";
const MOVE_SOURCE_HOST_WORKER_KIND = "project-move-source-host";
const MOVE_DESTINATION_HOST_WORKER_KIND = "project-move-destination-host";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 1;

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  "stop-source": 15,
  backup: 55,
  placement: 70,
  "start-dest": 85,
  "revert-placement": 88,
  "cleanup-dest": 90,
  cleanup: 95,
  done: 100,
};

const progressRanges: Record<string, { start: number; end: number }> = {
  "start-dest": {
    start: progressSteps["start-dest"],
    end: progressSteps.cleanup,
  },
};

let running = false;
let inFlight = 0;

type MoveTopologyRow = {
  source_host_id: string | null;
  dest_host_id: string | null;
};

type MoveClaimCandidateRecord = LroSummary & {
  source_host_id: string | null;
  dest_host_id: string | null;
  project_region: string | null;
};

export function createNonOverlappingAsyncRunner(
  run: () => Promise<void>,
): () => Promise<boolean> {
  let active: Promise<void> | undefined;
  return async () => {
    if (active) return false;
    active = (async () => {
      try {
        await run();
      } finally {
        active = undefined;
      }
    })();
    await active;
    return true;
  };
}

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
    logger.warn("move op publish summary failed", {
      op_id: context.op_id,
      when: context.when,
      err,
    });
  }
}

function progressEvent({
  op,
  update,
}: {
  op: LroSummary;
  update: MoveProjectProgressUpdate;
}) {
  let progress = progressSteps[update.step];
  if (update.progress != null) {
    const range = progressRanges[update.step];
    if (range) {
      const clamped = Math.max(0, Math.min(100, update.progress));
      progress = Math.round(
        range.start + (clamped / 100) * (range.end - range.start),
      );
    } else {
      progress = Math.round(Math.max(0, Math.min(100, update.progress)));
    }
  }
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: update.step,
      message: update.message,
      progress,
      detail: update.detail,
    },
  }).catch((err) =>
    logger.debug("move op progress event publish failed", {
      op_id: op.op_id,
      err,
    }),
  );
}

async function updateProgressSummary(
  op: LroSummary,
  update: MoveProjectProgressUpdate,
) {
  const updated = await updateLro({
    op_id: op.op_id,
    progress_summary: {
      phase: update.message ?? update.step,
      ...(update.detail ?? {}),
    },
  });
  await publishSummarySafe(updated, {
    op_id: op.op_id,
    when: "progress",
  });
}

async function handleMoveOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const project_id = input.project_id;
  const dest_host_id = input.dest_host_id;
  const account_id = op.created_by ?? input.account_id;

  if (!project_id || !account_id) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: "move op missing project_id or account",
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "invalid-input",
    });
    return;
  }

  logger.info("move op start", {
    op_id,
    project_id,
    dest_host_id,
  });

  const heartbeat = setInterval(() => {
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      (err) => logger.debug("move op heartbeat failed", { op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastProgressKey: string | null = null;
  const progress = async (update: MoveProjectProgressUpdate) => {
    let detailKey = "";
    if (update.detail !== undefined) {
      try {
        detailKey = JSON.stringify(update.detail);
      } catch {
        detailKey = String(update.detail);
      }
    }
    const progressKey = `${update.step}|${update.message ?? ""}|${detailKey}|${
      update.progress ?? ""
    }`;
    if (progressKey === lastProgressKey) {
      return;
    }
    lastProgressKey = progressKey;
    const log = update.progress != null ? logger.debug : logger.info;
    log("move op step", {
      op_id,
      step: update.step,
      message: update.message,
      detail: update.detail,
      progress: update.progress,
    });
    progressEvent({ op, update });
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      () => {},
    );
    await updateProgressSummary(op, update).catch(() => {});
  };

  try {
    let canceled = false;
    const shouldAbort = async () => {
      if (canceled) return true;
      const current = await getLro(op_id);
      if (current?.status === "canceled" || current?.status === "expired") {
        canceled = true;
        return true;
      }
      return false;
    };
    await progress({
      step: "validate",
      message: "starting move",
      detail: { dest_host_id },
    });
    await moveProjectToHost(
      {
        project_id,
        dest_host_id,
        account_id,
        allow_offline: input.allow_offline,
      },
      { progress, shouldCancel: shouldAbort, op_id },
    );

    const updated = await updateLro({
      op_id,
      status: "succeeded",
      progress_summary: { phase: "done" },
      result: { project_id, dest_host_id },
      error: null,
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "succeeded",
    });
  } catch (err) {
    const isCanceled = (err as any)?.code === MOVE_CANCELED_CODE;
    if (isCanceled) {
      logger.info("move op canceled", { op_id });
      const updated = await updateLro({
        op_id,
        status: "canceled",
        error: "canceled",
      });
      await publishSummarySafe(updated, {
        op_id,
        when: "canceled",
      });
      await progress({ step: "done", message: "canceled" });
      return;
    }
    logger.warn("move op failed", { op_id, err: `${err}` });
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${err}`,
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "failed",
    });
    await progress({
      step: "done",
      message: "failed",
      detail: { error: `${err}` },
    });
  } finally {
    clearInterval(heartbeat);
    logger.info("move op done", { op_id });
  }
}

async function markMoveOpFailedFromWorker({
  op_id,
  err,
}: {
  op_id: string;
  err: unknown;
}): Promise<void> {
  try {
    const current = await getLro(op_id);
    if (current?.status === "succeeded" || current?.status === "canceled") {
      logger.warn(
        "move op worker error ignored because op is already terminal",
        {
          op_id,
          status: current.status,
          err,
        },
      );
      return;
    }
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${err}`,
    });
    if (updated) {
      try {
        await publishSummary(updated);
      } catch (publishErr) {
        logger.warn("move op publish summary failed after worker error", {
          op_id,
          err: publishErr,
        });
      }
    }
  } catch (updateErr) {
    logger.error("move op worker failure handling failed", {
      op_id,
      err: updateErr,
      original_error: `${err}`,
    });
  }
}

async function listFreshRunningMoveTopologyRows({
  lease_ms,
}: {
  lease_ms: number;
}): Promise<MoveTopologyRow[]> {
  const { rows } = await pool().query<MoveTopologyRow>(
    `
      SELECT
        CASE
          WHEN NULLIF(l.input->>'source_host_id', '') IS NOT NULL
            THEN NULLIF(l.input->>'source_host_id', '')
          WHEN COALESCE(p.owning_bay_id, $3) = COALESCE(ph.bay_id, $3)
            THEN p.host_id::text
          ELSE NULL
        END AS source_host_id,
        NULLIF(l.input->>'dest_host_id', '') AS dest_host_id
      FROM long_running_operations l
      JOIN projects p ON p.project_id = l.scope_id::uuid
      LEFT JOIN project_hosts ph
        ON ph.id = p.host_id
       AND ph.deleted IS NULL
      WHERE l.kind = $1
        AND l.dismissed_at IS NULL
        AND l.status = 'running'
        AND l.heartbeat_at IS NOT NULL
        AND l.heartbeat_at >= now() - ($2::text || ' milliseconds')::interval
    `,
    [MOVE_LRO_KIND, lease_ms, getConfiguredBayId()],
  );
  return rows;
}

async function listActiveMoveDestinationHosts(): Promise<
  MoveActiveDestinationHost[]
> {
  const { rows } = await pool().query<{ id: string; region: string | null }>(
    `
      SELECT id, region
      FROM project_hosts
      WHERE status = 'running'
        AND deleted IS NULL
        AND last_seen > now() - interval '2 minutes'
      ORDER BY id
    `,
  );
  return rows.map(({ id, region }) => ({
    host_id: id,
    project_region: mapCloudRegionToR2Region(region),
  }));
}

async function claimMoveLroOps({
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
  const [runningRows, activeDestinationHosts] = await Promise.all([
    listFreshRunningMoveTopologyRows({ lease_ms }),
    listActiveMoveDestinationHosts(),
  ]);
  const sourceRunningCounts = new Map<string, number>();
  const destRunningCounts = new Map<string, number>();
  for (const row of runningRows) {
    if (row.source_host_id) {
      sourceRunningCounts.set(
        row.source_host_id,
        (sourceRunningCounts.get(row.source_host_id) ?? 0) + 1,
      );
    }
    if (row.dest_host_id) {
      destRunningCounts.set(
        row.dest_host_id,
        (destRunningCounts.get(row.dest_host_id) ?? 0) + 1,
      );
    }
  }

  await ensureLroSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<MoveClaimCandidateRecord>(
      `
        SELECT
          l.*,
          CASE
            WHEN NULLIF(l.input->>'source_host_id', '') IS NOT NULL
              THEN NULLIF(l.input->>'source_host_id', '')
            WHEN COALESCE(p.owning_bay_id, $4) = COALESCE(ph.bay_id, $4)
              THEN p.host_id::text
            ELSE NULL
          END AS source_host_id,
          NULLIF(l.input->>'dest_host_id', '') AS dest_host_id,
          p.region AS project_region
        FROM long_running_operations l
        JOIN projects p ON p.project_id = l.scope_id::uuid
        LEFT JOIN project_hosts ph
          ON ph.id = p.host_id
         AND ph.deleted IS NULL
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
        FOR UPDATE OF l SKIP LOCKED
        LIMIT $3
      `,
      [MOVE_LRO_KIND, lease_ms, Math.max(limit * 8, 50), getConfiguredBayId()],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return [];
    }

    const sourceHostIds = Array.from(
      new Set(
        rows
          .map(({ source_host_id }) => source_host_id)
          .filter(Boolean) as string[],
      ),
    );
    const destHostIds = Array.from(
      new Set([
        ...rows.map(({ dest_host_id }) => dest_host_id).filter(Boolean),
        ...activeDestinationHosts.map(({ host_id }) => host_id),
      ] as string[]),
    );
    const sourceRegistration = getParallelOpsWorkerRegistration(
      MOVE_SOURCE_HOST_WORKER_KIND,
    );
    const destRegistration = getParallelOpsWorkerRegistration(
      MOVE_DESTINATION_HOST_WORKER_KIND,
    );
    const defaultSourceLimit =
      sourceRegistration?.getLimitSnapshot().default_limit ?? 1;
    const defaultDestLimit =
      destRegistration?.getLimitSnapshot().default_limit ?? 1;
    const [sourceLimits, destLimits] = await Promise.all([
      getEffectiveParallelOpsLimits({
        worker_kind: MOVE_SOURCE_HOST_WORKER_KIND,
        default_limit: defaultSourceLimit,
        scope_type: "project_host",
        scope_ids: sourceHostIds,
      }),
      getEffectiveParallelOpsLimits({
        worker_kind: MOVE_DESTINATION_HOST_WORKER_KIND,
        default_limit: defaultDestLimit,
        scope_type: "project_host",
        scope_ids: destHostIds,
      }),
    ]);
    const sourceLimitByHost = new Map(
      sourceHostIds.map((host_id) => [
        host_id,
        sourceLimits.get(host_id)?.value ?? defaultSourceLimit,
      ]),
    );
    const destLimitByHost = new Map(
      destHostIds.map((host_id) => [
        host_id,
        destLimits.get(host_id)?.value ?? defaultDestLimit,
      ]),
    );
    const selected = selectMoveClaimCandidates({
      candidates: rows.map(
        ({ op_id, source_host_id, dest_host_id, project_region }) => ({
          op_id,
          source_host_id,
          dest_host_id,
          project_region: parseR2Region(project_region) ?? DEFAULT_R2_REGION,
        }),
      ),
      sourceAvailableByHost: computeAvailableMoveHostSlots({
        runningCounts: sourceRunningCounts,
        limitByHost: sourceLimitByHost,
      }),
      destAvailableByHost: computeAvailableMoveHostSlots({
        runningCounts: destRunningCounts,
        limitByHost: destLimitByHost,
      }),
      activeDestinationHosts,
      limit,
    });
    if (selected.length === 0) {
      await client.query("ROLLBACK");
      return [];
    }

    const claimed: LroSummary[] = [];
    for (const selection of selected) {
      const updated = await client.query<LroSummary>(
        `
          UPDATE long_running_operations
          SET owner_type = $2,
              owner_id = $3,
              heartbeat_at = now(),
              status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
              started_at = COALESCE(started_at, now()),
              attempt = attempt + 1,
              updated_at = now(),
              input = jsonb_set(
                jsonb_set(
                  COALESCE(input, '{}'::jsonb),
                  '{source_host_id}',
                  to_jsonb($4::text),
                  true
                ),
                '{dest_host_id}',
                to_jsonb($5::text),
                true
              )
          WHERE op_id = $1
          RETURNING *
        `,
        [
          selection.op_id,
          owner_type,
          owner_id,
          selection.source_host_id,
          selection.dest_host_id,
        ],
      );
      if (updated.rows[0]) {
        claimed.push(updated.rows[0]);
      }
    }

    await client.query("COMMIT");
    return claimed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function startMoveLroWorker({
  intervalMs = TICK_MS,
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting move LRO worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = createNonOverlappingAsyncRunner(async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: MOVE_LRO_KIND,
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("move op limit lookup failed", { err });
        return;
      }
    }
    if (inFlight >= effectiveMaxParallel) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimMoveLroOps({
        owner_type: OWNER_TYPE,
        owner_id: WORKER_ID,
        limit: Math.max(1, effectiveMaxParallel - inFlight),
        lease_ms: LEASE_MS,
      });
    } catch (err) {
      logger.warn("move op claim failed", { err });
      return;
    }

    for (const op of ops) {
      inFlight += 1;
      void handleMoveOp(op)
        .catch((err) => {
          logger.warn("move op handler failed", { op_id: op.op_id, err });
          void markMoveOpFailedFromWorker({ op_id: op.op_id, err });
        })
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1);
        });
    }
  });

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
