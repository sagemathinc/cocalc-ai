/*
Smoke test and verification helpers for managed RootFS rustic publish/restore.

Typical usage from a server-side REPL:

  a = require("../../dist/cloud/smoke-runner/rootfs-rustic");
  await a.runRootfsRusticPublishRestoreVerification({
    account_id,
    project_id: "<project-id>",
    destination_host_id: "<other-host-id>",
    publish: {
      label: "jupyter-smoke",
      visibility: "private",
      hidden: true,
    },
  });

  await a.runRootfsPublishParallelismSweep({
    account_id,
    workloads: [
      {
        id: "jupyter-a",
        project_id: "<project-a>",
        publish: { label: "bench-a", visibility: "private", hidden: true },
      },
      {
        id: "jupyter-b",
        project_id: "<project-b>",
        publish: { label: "bench-b", visibility: "private", hidden: true },
      },
    ],
    parallel_values: [1, 2],
  });
*/

import getLogger from "@cocalc/backend/logger";
import {
  createHostControlClient,
  type HostRootfsManifest,
} from "@cocalc/conat/project-host/api";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import { getLro } from "@cocalc/server/lro/lro-db";
import {
  clearParallelOpsLimit,
  publishProjectRootfsImage,
  setParallelOpsLimit,
} from "@cocalc/server/conat/api/system";
import type { PublishProjectRootfsBody } from "@cocalc/util/rootfs-images";

const logger = getLogger("server:cloud:smoke-runner:rootfs-rustic");

type WaitOptions = {
  intervalMs: number;
  attempts: number;
};

type SmokeLogEvent = {
  step: string;
  status: "start" | "ok" | "failed";
  message?: string;
};

type VerificationComparison = {
  name: string;
  ok: boolean;
  expected_manifest_sha256: string;
  actual_manifest_sha256: string;
  expected_hardlink_sha256: string;
  actual_hardlink_sha256: string;
  expected_entry_count: number;
  actual_entry_count: number;
  expected_hardlink_group_count: number;
  actual_hardlink_group_count: number;
  reason?: string;
};

export type RootfsRusticVerificationOptions = {
  account_id: string;
  project_id: string;
  source_host_id?: string;
  destination_host_id: string;
  publish: Omit<PublishProjectRootfsBody, "project_id">;
  log?: (event: SmokeLogEvent) => void;
  wait?: Partial<{
    publish: Partial<WaitOptions>;
    manifest: Partial<WaitOptions>;
  }>;
};

export type RootfsRusticVerificationResult = {
  ok: boolean;
  project_id: string;
  source_host_id: string;
  destination_host_id: string;
  op_id: string;
  image?: string;
  image_id?: string;
  release_id?: string;
  publish_duration_ms?: number;
  publish_phase_timings_ms?: Record<string, number>;
  source_project_manifest?: HostRootfsManifest;
  source_cached_manifest?: HostRootfsManifest;
  destination_cached_manifest?: HostRootfsManifest;
  source_pull_duration_ms?: number;
  destination_pull_duration_ms?: number;
  comparisons: VerificationComparison[];
  error?: string;
};

export type RootfsRusticWorkload = {
  id: string;
  project_id: string;
  source_host_id?: string;
  destination_host_id: string;
  publish: Omit<PublishProjectRootfsBody, "project_id">;
};

export type RootfsRusticWorkloadMatrixOptions = {
  account_id: string;
  workloads: RootfsRusticWorkload[];
  log?: (event: SmokeLogEvent & { workload_id?: string }) => void;
  wait?: RootfsRusticVerificationOptions["wait"];
};

export type RootfsRusticWorkloadMatrixResult = {
  ok: boolean;
  results: Array<
    RootfsRusticVerificationResult & {
      workload_id: string;
    }
  >;
};

export type RootfsPublishParallelismSweepOptions = {
  account_id: string;
  workloads: RootfsRusticWorkload[];
  parallel_values: number[];
  log?: (event: SmokeLogEvent & { parallel?: number }) => void;
  wait?: Partial<{
    publish: Partial<WaitOptions>;
  }>;
};

export type RootfsPublishParallelismSweepResult = {
  ok: boolean;
  runs: Array<{
    parallel: number;
    ok: boolean;
    total_wall_ms: number;
    operations: Array<{
      workload_id: string;
      project_id: string;
      op_id: string;
      status: string;
      duration_ms?: number;
      image?: string;
      error?: string;
    }>;
    error?: string;
  }>;
};

const DEFAULT_PUBLISH_WAIT: WaitOptions = { intervalMs: 3000, attempts: 240 };
const DEFAULT_MANIFEST_WAIT: WaitOptions = { intervalMs: 1000, attempts: 1 };
const HOST_MANIFEST_RPC_TIMEOUT_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveWait(
  override: Partial<WaitOptions> | undefined,
  fallback: WaitOptions,
): WaitOptions {
  return {
    intervalMs: override?.intervalMs ?? fallback.intervalMs,
    attempts: override?.attempts ?? fallback.attempts,
  };
}

function verifyComparison(
  name: string,
  expected: HostRootfsManifest,
  actual: HostRootfsManifest,
): VerificationComparison {
  if (expected.manifest_sha256 === actual.manifest_sha256) {
    return {
      name,
      ok: true,
      expected_manifest_sha256: expected.manifest_sha256,
      actual_manifest_sha256: actual.manifest_sha256,
      expected_hardlink_sha256: expected.hardlink_sha256,
      actual_hardlink_sha256: actual.hardlink_sha256,
      expected_entry_count: expected.entry_count,
      actual_entry_count: actual.entry_count,
      expected_hardlink_group_count: expected.hardlink_group_count,
      actual_hardlink_group_count: actual.hardlink_group_count,
    };
  }
  const reasons: string[] = [];
  if (expected.entry_count !== actual.entry_count) {
    reasons.push(
      `entry_count ${expected.entry_count} != ${actual.entry_count}`,
    );
  }
  if (expected.hardlink_sha256 !== actual.hardlink_sha256) {
    reasons.push("hardlink topology digest differs");
  }
  if (
    expected.hardlink_group_count !== actual.hardlink_group_count ||
    expected.hardlink_member_count !== actual.hardlink_member_count
  ) {
    reasons.push(
      `hardlink counts ${expected.hardlink_group_count}/${expected.hardlink_member_count} != ${actual.hardlink_group_count}/${actual.hardlink_member_count}`,
    );
  }
  if (expected.total_regular_bytes !== actual.total_regular_bytes) {
    reasons.push(
      `total_regular_bytes ${expected.total_regular_bytes} != ${actual.total_regular_bytes}`,
    );
  }
  return {
    name,
    ok: false,
    expected_manifest_sha256: expected.manifest_sha256,
    actual_manifest_sha256: actual.manifest_sha256,
    expected_hardlink_sha256: expected.hardlink_sha256,
    actual_hardlink_sha256: actual.hardlink_sha256,
    expected_entry_count: expected.entry_count,
    actual_entry_count: actual.entry_count,
    expected_hardlink_group_count: expected.hardlink_group_count,
    actual_hardlink_group_count: actual.hardlink_group_count,
    reason: reasons.join("; ") || "manifest digest differs",
  };
}

async function waitForLroTerminal(op_id: string, opts: WaitOptions) {
  let last_status = "missing";
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    const op = await getLro(op_id);
    const status = `${op?.status ?? "missing"}`;
    last_status = status;
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "canceled" ||
      status === "expired"
    ) {
      return op;
    }
    await sleep(opts.intervalMs);
  }
  throw new Error(
    `timeout waiting for operation ${op_id} to finish (last_status=${last_status})`,
  );
}

async function resolveProjectHostId(project_id: string): Promise<string> {
  try {
    return (await getAssignedProjectHostInfo(project_id)).host_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    if (message === "workspace has no assigned host") {
      throw new Error(`project ${project_id} has no assigned host`);
    }
    if (message === "workspace bay does not match assigned host") {
      throw new Error(
        `project ${project_id} assigned host does not match owning bay`,
      );
    }
    if (message === "workspace not found") {
      throw new Error(`project ${project_id} not found`);
    }
    throw err;
  }
}

function hostClient(host_id: string) {
  return createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
    timeout: HOST_MANIFEST_RPC_TIMEOUT_MS,
  });
}

function runTag(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function withSmokePublishDefaults(
  publish: Omit<PublishProjectRootfsBody, "project_id">,
  suffix: string,
): Omit<PublishProjectRootfsBody, "project_id"> {
  return {
    ...publish,
    label: `${publish.label} ${suffix}`.trim(),
    visibility: publish.visibility ?? "private",
    hidden: publish.hidden ?? true,
  };
}

export async function runRootfsRusticPublishRestoreVerification(
  opts: RootfsRusticVerificationOptions,
): Promise<RootfsRusticVerificationResult> {
  const waitPublish = resolveWait(opts.wait?.publish, DEFAULT_PUBLISH_WAIT);
  const waitManifest = resolveWait(opts.wait?.manifest, DEFAULT_MANIFEST_WAIT);
  const source_host_id =
    opts.source_host_id ?? (await resolveProjectHostId(opts.project_id));
  const destination_host_id = opts.destination_host_id;
  const source = hostClient(source_host_id);
  const destination = hostClient(destination_host_id);
  const result: RootfsRusticVerificationResult = {
    ok: false,
    project_id: opts.project_id,
    source_host_id,
    destination_host_id,
    op_id: "",
    comparisons: [],
  };
  const publish_input = withSmokePublishDefaults(opts.publish, runTag());
  try {
    opts.log?.({
      step: "source-manifest",
      status: "start",
      message: `building source project manifest on ${source_host_id}`,
    });
    const source_project_manifest = await source.buildProjectRootfsManifest({
      project_id: opts.project_id,
    });
    result.source_project_manifest = source_project_manifest;
    opts.log?.({
      step: "source-manifest",
      status: "ok",
      message: source_project_manifest.manifest_sha256,
    });
    await sleep(waitManifest.intervalMs);

    opts.log?.({
      step: "publish",
      status: "start",
      message: publish_input.label,
    });
    const op = await publishProjectRootfsImage({
      account_id: opts.account_id,
      project_id: opts.project_id,
      ...publish_input,
    });
    result.op_id = op.op_id;
    const summary = await waitForLroTerminal(op.op_id, waitPublish);
    if (summary?.status !== "succeeded") {
      throw new Error(
        `publish failed for ${opts.project_id}: ${summary?.error ?? summary?.status ?? "missing summary"}`,
      );
    }
    result.image = summary.result?.image;
    result.image_id = summary.result?.image_id;
    result.release_id = summary.result?.release_id;
    result.publish_duration_ms = summary.result?.duration_ms;
    result.publish_phase_timings_ms = summary.result?.publish_phase_timings_ms;
    opts.log?.({
      step: "publish",
      status: "ok",
      message: result.image,
    });
    const image = `${result.image ?? ""}`.trim();
    if (!image) {
      throw new Error(`publish ${op.op_id} did not return an image`);
    }

    opts.log?.({
      step: "source-pull",
      status: "start",
      message: image,
    });
    let started = Date.now();
    await source.pullRootfsImage({ image });
    result.source_pull_duration_ms = Date.now() - started;
    const source_cached_manifest = await source.buildRootfsImageManifest({
      image,
    });
    result.source_cached_manifest = source_cached_manifest;
    opts.log?.({
      step: "source-pull",
      status: "ok",
      message: `${result.source_pull_duration_ms}ms`,
    });

    opts.log?.({
      step: "destination-pull",
      status: "start",
      message: image,
    });
    started = Date.now();
    await destination.pullRootfsImage({ image });
    result.destination_pull_duration_ms = Date.now() - started;
    const destination_cached_manifest =
      await destination.buildRootfsImageManifest({ image });
    result.destination_cached_manifest = destination_cached_manifest;
    opts.log?.({
      step: "destination-pull",
      status: "ok",
      message: `${result.destination_pull_duration_ms}ms`,
    });

    result.comparisons.push(
      verifyComparison(
        "source project -> source cached image",
        source_project_manifest,
        source_cached_manifest,
      ),
    );
    result.comparisons.push(
      verifyComparison(
        "source project -> destination cached image",
        source_project_manifest,
        destination_cached_manifest,
      ),
    );
    result.comparisons.push(
      verifyComparison(
        "source cached image -> destination cached image",
        source_cached_manifest,
        destination_cached_manifest,
      ),
    );
    result.ok = result.comparisons.every((comparison) => comparison.ok);
    if (!result.ok) {
      throw new Error(
        result.comparisons
          .filter((comparison) => !comparison.ok)
          .map(
            (comparison) =>
              `${comparison.name}: ${comparison.reason ?? "manifest mismatch"}`,
          )
          .join("; "),
      );
    }
    return result;
  } catch (err) {
    result.error = `${err}`;
    logger.warn("rootfs rustic verification failed", {
      project_id: opts.project_id,
      source_host_id,
      destination_host_id,
      err: result.error,
    });
    return result;
  }
}

export async function runRootfsRusticWorkloadMatrix({
  account_id,
  workloads,
  log,
  wait,
}: RootfsRusticWorkloadMatrixOptions): Promise<RootfsRusticWorkloadMatrixResult> {
  const results: RootfsRusticWorkloadMatrixResult["results"] = [];
  for (const workload of workloads) {
    const prefix = `[${workload.id}]`;
    const result = await runRootfsRusticPublishRestoreVerification({
      account_id,
      project_id: workload.project_id,
      source_host_id: workload.source_host_id,
      destination_host_id: workload.destination_host_id,
      publish: workload.publish,
      wait,
      log: (event) =>
        log?.({
          ...event,
          workload_id: workload.id,
          message: event.message ? `${prefix} ${event.message}` : prefix,
        }),
    });
    results.push({
      ...result,
      workload_id: workload.id,
    });
  }
  return {
    ok: results.every((item) => item.ok),
    results,
  };
}

export async function runRootfsPublishParallelismSweep({
  account_id,
  workloads,
  parallel_values,
  log,
  wait,
}: RootfsPublishParallelismSweepOptions): Promise<RootfsPublishParallelismSweepResult> {
  const waitPublish = resolveWait(wait?.publish, DEFAULT_PUBLISH_WAIT);
  const runs: RootfsPublishParallelismSweepResult["runs"] = [];
  try {
    for (const parallel of parallel_values) {
      const started = Date.now();
      log?.({
        step: "parallel-limit",
        status: "start",
        parallel,
        message: `${parallel}`,
      });
      await setParallelOpsLimit({
        account_id,
        worker_kind: "project-rootfs-publish",
        scope_type: "global",
        limit_value: parallel,
        note: `rootfs-rustic smoke sweep ${runTag()}`,
      });
      log?.({
        step: "parallel-limit",
        status: "ok",
        parallel,
        message: `${parallel}`,
      });

      const launches = await Promise.all(
        workloads.map(async (workload, index) => {
          const publish_input = withSmokePublishDefaults(
            workload.publish,
            `bench-p${parallel}-${index + 1}-${runTag()}`,
          );
          const op = await publishProjectRootfsImage({
            account_id,
            project_id: workload.project_id,
            ...publish_input,
          });
          return { workload, op_id: op.op_id };
        }),
      );

      const operations = await Promise.all(
        launches.map(async ({ workload, op_id }) => {
          const summary = await waitForLroTerminal(op_id, waitPublish);
          return {
            workload_id: workload.id,
            project_id: workload.project_id,
            op_id,
            status: `${summary?.status ?? "missing"}`,
            duration_ms: summary?.result?.duration_ms,
            image: summary?.result?.image,
            error: summary?.error ?? undefined,
          };
        }),
      );

      runs.push({
        parallel,
        ok: operations.every((op) => op.status === "succeeded"),
        total_wall_ms: Date.now() - started,
        operations,
      });
    }
  } catch (err) {
    runs.push({
      parallel: -1,
      ok: false,
      total_wall_ms: 0,
      operations: [],
      error: `${err}`,
    });
  } finally {
    await clearParallelOpsLimit({
      account_id,
      worker_kind: "project-rootfs-publish",
      scope_type: "global",
    }).catch((err) => {
      logger.warn("unable to clear rootfs publish parallel override", {
        err: `${err}`,
      });
    });
  }
  return {
    ok: runs.every((run) => run.ok),
    runs,
  };
}
