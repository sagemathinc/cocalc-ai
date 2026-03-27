import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import getPool from "@cocalc/database/pool";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { claimLroOps, touchLro, updateLro } from "@cocalc/server/lro/lro-db";
import { getEffectiveParallelOpsLimit } from "@cocalc/server/lro/worker-config";
import { publishLroEvent, publishLroSummary } from "@cocalc/conat/lro/stream";
import { publishProjectRootfsCatalogEntry } from "@cocalc/server/rootfs/catalog";
import { withTimeout } from "@cocalc/util/async-utils";
import {
  ensureRootfsReleaseR2ReplicaForHost,
  hasStoredRootfsArtifact,
  issueRootfsReleaseArtifactUpload,
  upsertReleaseArtifactReplica,
  upsertPublishedRootfsRelease,
} from "@cocalc/server/rootfs/releases";

const logger = getLogger("server:projects:rootfs-publish-worker");

const ROOTFS_PUBLISH_LRO_KIND = "project-rootfs-publish";
const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 1;
const ROOTFS_PUBLISH_TIMEOUT_MS = 6 * 60 * 60 * 1000;

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
    const artifact = await timings.measure("publish", async () => {
      return await withTimeout(
        client.publishRootfsImage({
          project_id,
          lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
        }),
        ROOTFS_PUBLISH_TIMEOUT_MS,
      );
    });

    const host_id = await loadProjectHostId(project_id);
    let uploadedDirectToR2 = false;
    let uploadedToRustic = false;
    let uploadResult:
      | Awaited<ReturnType<typeof client.uploadRootfsReleaseArtifact>>
      | undefined;
    const upload = await issueRootfsReleaseArtifactUpload({
      host_id,
      content_key: artifact.content_key,
      artifact_kind: "full",
    });
    if (
      upload.backend === "rustic" ||
      !(await hasStoredRootfsArtifact(artifact.content_key))
    ) {
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
        message:
          upload.backend === "rustic"
            ? "saving RootFS release to rustic storage"
            : "uploading RootFS release artifact",
        detail: {
          image: artifact.image,
          content_key: artifact.content_key,
          backend: upload.backend,
        },
      });
      const result = await timings.measure("upload", async () => {
        return await withTimeout(
          client.uploadRootfsReleaseArtifact({
            project_id,
            image: artifact.image,
            parent_image: artifact.parent_image,
            upload,
            lro: { op_id, scope_type: op.scope_type, scope_id: op.scope_id },
          }),
          ROOTFS_PUBLISH_TIMEOUT_MS,
        );
      });
      uploadResult = result;
      uploadedDirectToR2 = result.backend === "r2";
      uploadedToRustic = result.backend === "rustic";
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

    if (uploadedDirectToR2 && uploadResult?.backend === "r2") {
      await timings.measure("replicate", async () => {
        await upsertReleaseArtifactReplica({
          release_id: release.release_id,
          content_key: artifact.content_key,
          backend: "r2",
          region: uploadResult.region,
          bucket: {
            id: uploadResult.bucket_id ?? "",
            name: uploadResult.bucket_name,
            purpose: uploadResult.bucket_purpose ?? null,
            region: uploadResult.region,
            endpoint: null,
            access_key_id: null,
            secret_access_key: null,
            status: "ready",
          },
          artifact_kind: release.artifact_kind,
          artifact_format: release.artifact_format,
          artifact_path: uploadResult.artifact_path,
          artifact_sha256: uploadResult.artifact_sha256,
          artifact_bytes: uploadResult.artifact_bytes,
          status: "ready",
          error: null,
        });
      });
    } else if (!uploadedToRustic) {
      const replicateOp = await updateLro({
        op_id,
        progress_summary: {
          phase: "replicate",
          image: artifact.image,
          content_key: artifact.content_key,
          release_id: release.release_id,
        },
      });
      await publishSummarySafe(replicateOp, {
        op_id,
        when: "set-replicate-phase",
      });
      progress({
        step: "replicate",
        message: "replicating RootFS release artifact to regional R2 storage",
        detail: { image: artifact.image, content_key: artifact.content_key },
      });
      await timings.measure("replicate", async () => {
        await ensureRootfsReleaseR2ReplicaForHost({
          host_id,
          release,
        });
      });
    }

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

  const tick = async () => {
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
      ops = await claimLroOps({
        kind: ROOTFS_PUBLISH_LRO_KIND,
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
