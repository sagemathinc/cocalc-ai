import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import getPool from "@cocalc/database/pool";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import {
  ensureLroSchema,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import {
  getEffectiveParallelOpsLimit,
  getEffectiveParallelOpsLimitsByDefaultMap,
} from "@cocalc/server/lro/worker-config";
import { getProjectHostDefaultParallelLimits } from "@cocalc/server/lro/project-host-defaults";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { publishProjectRootfsCatalogEntry } from "@cocalc/server/rootfs/catalog";
import { withTimeout } from "@cocalc/util/async-utils";
import {
  computeAvailableRootfsPublishHostSlots,
  selectRootfsPublishClaimCandidates,
} from "./rootfs-publish-admission";
import {
  issueRootfsReleaseArtifactUpload,
  upsertPublishedRootfsRelease,
} from "@cocalc/server/rootfs/releases";

const logger = getLogger("server:projects:rootfs-publish-worker");

const ROOTFS_PUBLISH_LRO_KIND = "project-rootfs-publish";
const ROOTFS_PUBLISH_HOST_WORKER_KIND = "project-rootfs-publish-host";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 250;
const ROOTFS_PUBLISH_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  validate: 5,
  publish: 75,
  upload: 88,
  replicate: 92,
  catalog: 96,
  done: 100,
};

let running = false;
let inFlight = 0;

type RootfsPublishTopologyRow = {
  project_host_id: string | null;
};

type RootfsPublishClaimCandidateRecord = LroSummary & {
  project_host_id: string | null;
};

function createNonOverlappingAsyncRunner(
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

function createPhaseTimingRecorder() {
  const phase_timings_ms: Record<string, number> = {};
  return {
    phase_timings_ms,
    async measure<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        phase_timings_ms[phase] = Date.now() - started;
      }
    },
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
  void publishSummary(summary).catch((err) => {
    logger.warn("rootfs publish op publish summary failed", {
      op_id: context.op_id,
      when: context.when,
      err,
    });
  });
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
    logger.warn("rootfs publish op progress failed", {
      op_id: op.op_id,
      step,
      err,
    });
  });
}

async function loadProjectHostId(project_id: string): Promise<string> {
  const { rows } = await getPool("medium").query<{ host_id: string | null }>(
    "SELECT host_id FROM projects WHERE project_id=$1",
    [project_id],
  );
  const host_id = `${rows[0]?.host_id ?? ""}`.trim();
  if (!host_id) {
    throw new Error(`project ${project_id} is not assigned to a host`);
  }
  return host_id;
}

async function listFreshRunningRootfsPublishTopologyRows({
  lease_ms,
}: {
  lease_ms: number;
}): Promise<RootfsPublishTopologyRow[]> {
  const { rows } = await getPool("medium").query<RootfsPublishTopologyRow>(
    `
      SELECT COALESCE(NULLIF(l.input->>'project_host_id', ''), p.host_id::text) AS project_host_id
      FROM long_running_operations l
      JOIN projects p ON p.project_id = l.scope_id::uuid
      WHERE l.kind = $1
        AND l.dismissed_at IS NULL
        AND l.status = 'running'
        AND l.heartbeat_at IS NOT NULL
        AND l.heartbeat_at >= now() - ($2::text || ' milliseconds')::interval
    `,
    [ROOTFS_PUBLISH_LRO_KIND, lease_ms],
  );
  return rows;
}

async function claimRootfsPublishLroOps({
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
  const runningRows = await listFreshRunningRootfsPublishTopologyRows({
    lease_ms,
  });
  const runningCounts = new Map<string, number>();
  for (const row of runningRows) {
    if (!row.project_host_id) continue;
    runningCounts.set(
      row.project_host_id,
      (runningCounts.get(row.project_host_id) ?? 0) + 1,
    );
  }

  await ensureLroSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<RootfsPublishClaimCandidateRecord>(
      `
        SELECT
          l.*,
          COALESCE(NULLIF(l.input->>'project_host_id', ''), p.host_id::text) AS project_host_id
        FROM long_running_operations l
        JOIN projects p ON p.project_id = l.scope_id::uuid
        WHERE l.kind = $1
          AND l.dismissed_at IS NULL
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
      [ROOTFS_PUBLISH_LRO_KIND, lease_ms, Math.max(limit * 8, 50)],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return [];
    }

    const hostIds = Array.from(
      new Set(
        [
          ...runningRows.map(({ project_host_id }) => project_host_id),
          ...rows.map(({ project_host_id }) => project_host_id),
        ].filter(Boolean) as string[],
      ),
    );
    const hostDefaultLimits = await getProjectHostDefaultParallelLimits({
      host_ids: hostIds,
    });
    const hostLimits = await getEffectiveParallelOpsLimitsByDefaultMap({
      worker_kind: ROOTFS_PUBLISH_HOST_WORKER_KIND,
      default_limits: hostDefaultLimits,
      scope_type: "project_host",
    });
    const limitByHost = new Map(
      hostIds.map((host_id) => [
        host_id,
        hostLimits.get(host_id)?.value ?? hostDefaultLimits.get(host_id) ?? 1,
      ]),
    );
    const selected = selectRootfsPublishClaimCandidates({
      candidates: rows.map(({ op_id, project_host_id }) => ({
        op_id,
        project_host_id,
      })),
      availableByHost: computeAvailableRootfsPublishHostSlots({
        runningCounts,
        limitByHost,
      }),
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
                COALESCE(input, '{}'::jsonb),
                '{project_host_id}',
                to_jsonb($4::text),
                true
              )
          WHERE op_id = $1
          RETURNING *
        `,
        [selection.op_id, owner_type, owner_id, selection.project_host_id],
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

async function handleRootfsPublishOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const project_id = `${input.project_id ?? ""}`.trim();
  const created_by = `${op.created_by ?? ""}`.trim();

  if (!project_id || !created_by) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: "rootfs publish op missing project_id or created_by",
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "invalid-input",
    });
    return;
  }

  logger.info("rootfs publish op start", { op_id, project_id });

  const heartbeat = setInterval(() => {
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      (err) =>
        logger.debug("rootfs publish op heartbeat failed", { op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastProgressKey: string | null = null;
  const timings = createPhaseTimingRecorder();
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
    logger.info("rootfs publish op step", {
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
    const runningOp = await updateLro({
      op_id,
      status: "running",
      error: null,
      progress_summary: { phase: "validate" },
    });
    await publishSummarySafe(runningOp, {
      op_id,
      when: "set-running",
    });
    progress({
      step: "validate",
      message: "starting RootFS publish",
      detail: { project_id },
    });

    const started = Date.now();
    const client = await timings.measure("validate", async () => {
      return await getProjectFileServerClient({
        project_id,
        timeout: ROOTFS_PUBLISH_TIMEOUT_MS,
      });
    });
    await timings.measure("validate_file_server", async () => {
      await ensureProjectFileServerClientReady({
        project_id,
        client,
        maxWait: FILE_SERVER_READY_TIMEOUT_MS,
      });
    });

    const publishingOp = await updateLro({
      op_id,
      progress_summary: { phase: "publish" },
    });
    await publishSummarySafe(publishingOp, {
      op_id,
      when: "set-publish-phase",
    });
    progress({
      step: "publish",
      message: "publishing project filesystem state",
      detail: { project_id },
    });
    const host_id = await loadProjectHostId(project_id);
    const publishUpload = await issueRootfsReleaseArtifactUpload({
      host_id,
      artifact_kind: "full",
    });
    const artifact = await timings.measure("publish", async () => {
      return await withTimeout(
        client.publishRootfsImage({
          project_id,
          upload: publishUpload,
          lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
        }),
        ROOTFS_PUBLISH_TIMEOUT_MS,
      );
    });

    let uploadResult:
      | Awaited<ReturnType<typeof client.uploadRootfsReleaseArtifact>>
      | undefined = artifact.upload_result;
    if (uploadResult == null) {
      const uploadOp = await updateLro({
        op_id,
        progress_summary: {
          phase: "upload",
          image: artifact.image,
          content_key: artifact.content_key,
        },
      });
      await publishSummarySafe(uploadOp, {
        op_id,
        when: "set-upload-phase",
      });
      progress({
        step: "upload",
        message: "saving RootFS release to rustic storage",
        detail: {
          image: artifact.image,
          content_key: artifact.content_key,
          backend: publishUpload.backend,
        },
      });
      const result = await timings.measure("upload", async () => {
        return await withTimeout(
          client.uploadRootfsReleaseArtifact({
            project_id,
            image: artifact.image,
            upload: publishUpload,
            lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
          }),
          ROOTFS_PUBLISH_TIMEOUT_MS,
        );
      });
      uploadResult = result;
    }

    const release = await timings.measure("register_release", async () => {
      return await upsertPublishedRootfsRelease({
        artifact: {
          ...artifact,
          artifact_kind: uploadResult?.artifact_kind ?? "full",
        },
        upload: uploadResult,
      });
    });

    const catalogOp = await updateLro({
      op_id,
      progress_summary: {
        phase: "catalog",
        image: artifact.image,
        content_key: artifact.content_key,
        release_id: release.release_id,
      },
    });
    await publishSummarySafe(catalogOp, {
      op_id,
      when: "set-catalog-phase",
    });
    progress({
      step: "catalog",
      message: "saving published image to catalog",
      detail: { image: artifact.image, content_key: artifact.content_key },
    });
    const entry = await timings.measure("catalog_entry", async () => {
      return await publishProjectRootfsCatalogEntry({
        account_id: created_by,
        body: {
          project_id,
          label: input.label,
          family: input.family,
          version: input.version,
          channel: input.channel,
          supersedes_image_id: input.supersedes_image_id,
          description: input.description,
          visibility: input.visibility,
          tags: Array.isArray(input.tags) ? input.tags : undefined,
          theme: input.theme,
          official: input.official,
          prepull: input.prepull,
          hidden: input.hidden,
          source_mode: input.source_mode,
        },
        artifact,
        release_id: release.release_id,
      });
    });

    const duration_ms = Date.now() - started;
    const result = {
      project_id,
      image_id: entry.id,
      release_id: release.release_id,
      image: artifact.image,
      content_key: artifact.content_key,
      digest: artifact.digest,
      snapshot: artifact.snapshot,
      created_snapshot: artifact.created_snapshot,
      duration_ms,
      phase_timings_ms: {
        ...timings.phase_timings_ms,
        total: duration_ms,
      },
      publish_phase_timings_ms: artifact.phase_timings_ms,
      upload_phase_timings_ms: uploadResult?.phase_timings_ms,
    };

    const updated = await updateLro({
      op_id,
      status: "succeeded",
      result,
      progress_summary: {
        phase: "done",
        image_id: entry.id,
        image: artifact.image,
        duration_ms,
        phase_timings_ms: result.phase_timings_ms,
      },
      error: null,
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "set-succeeded",
    });
    progress({
      step: "done",
      message: "RootFS image published",
      detail: result,
    });
  } catch (err) {
    logger.warn("rootfs publish op failed", { op_id, err: `${err}` });
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${err}`,
      progress_summary: {
        phase: "failed",
        phase_timings_ms: timings.phase_timings_ms,
      },
    });
    await publishSummarySafe(updated, {
      op_id,
      when: "set-failed",
    });
    progress({ step: "done", message: "failed" });
  } finally {
    clearInterval(heartbeat);
    logger.info("rootfs publish op cleanup", { op_id });
  }
}

export function startRootfsPublishLroWorker({
  intervalMs = TICK_MS,
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting rootfs publish LRO worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = createNonOverlappingAsyncRunner(async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: ROOTFS_PUBLISH_LRO_KIND,
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("rootfs publish op limit lookup failed", { err });
        return;
      }
    }
    if (inFlight >= effectiveMaxParallel) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimRootfsPublishLroOps({
        owner_type: OWNER_TYPE,
        owner_id: WORKER_ID,
        limit: Math.max(1, effectiveMaxParallel - inFlight),
        lease_ms: LEASE_MS,
      });
    } catch (err) {
      logger.warn("rootfs publish op claim failed", { err });
      return;
    }

    for (const op of ops) {
      inFlight += 1;
      void handleRootfsPublishOp(op)
        .catch(async (err) => {
          logger.warn("rootfs publish op handler failed", {
            op_id: op.op_id,
            err,
          });
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
