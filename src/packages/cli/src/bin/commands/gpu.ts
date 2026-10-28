/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc gpu ...`: GPUs on your own provider account (RunPod), with the key
// connected in Settings → Connectors. Tables show a summary; --json gives
// the full provider detail.

import { Command } from "commander";
import type {
  GpuApi,
  GpuAvailabilityFilter,
  GpuCatalogResult,
  GpuPodsResult,
} from "@cocalc/conat/hub/api/gpu";
import type { GpuLaunchSpec, GpuPodSummary } from "@cocalc/util/gpu/types";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import {
  GPU_POD_WRITE_RPC_TIMEOUT_MS,
  GPU_READ_TIMEOUT_MS,
} from "@cocalc/util/gpu/runpod";

// A GPU read may take GPU_READ_TIMEOUT_MS on the key owner's home bay; wait a
// little longer, so the server's own deadline (and its clear error) comes
// first rather than the CLI abandoning a read that is still running.
export const GPU_CLI_RPC_TIMEOUT_MS = GPU_READ_TIMEOUT_MS + 15_000;

// Raise the context's timeouts for one GPU call, then restore them.
export async function withGpuReadTimeout<T>(
  ctx: any,
  fn: () => Promise<T>,
  timeoutMs = GPU_CLI_RPC_TIMEOUT_MS,
): Promise<T> {
  const prevTimeoutMs = ctx.timeoutMs;
  const prevRpcTimeoutMs = ctx.rpcTimeoutMs;
  ctx.timeoutMs = Math.max(prevTimeoutMs ?? 0, timeoutMs);
  ctx.rpcTimeoutMs = Math.max(prevRpcTimeoutMs ?? 0, timeoutMs);
  try {
    return await fn();
  } finally {
    ctx.timeoutMs = prevTimeoutMs;
    ctx.rpcTimeoutMs = prevRpcTimeoutMs;
  }
}

export interface GpuCommandDeps {
  withContext: any;
}

function collect(value: string, values: string[] = []): string[] {
  for (const v of value.split(",")) {
    if (v.trim()) values.push(v.trim());
  }
  return values;
}

function positiveNumber(flag: string, integer = false) {
  return (raw: string) => {
    const n = Number(raw);
    if (!(Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)))) {
      throw new Error(
        `${flag} must be a positive ${integer ? "integer" : "number"}`,
      );
    }
    return n;
  };
}

function isJson(ctx: any): boolean {
  return !!(ctx.globals?.json || ctx.globals?.output === "json");
}

export function catalogRows(result: GpuCatalogResult) {
  return result.catalog.gpuTypes.map((t) => ({
    id: t.id,
    name: t.name,
    memory_gb: t.memoryGb ?? null,
    secure_price: t.secure?.price ?? null,
    secure_stock: t.secure ? (t.secure.availability ?? null) : "not offered",
    community_price: t.community?.price ?? null,
    community_stock: t.community
      ? (t.community.availability ?? null)
      : "not offered",
  }));
}

export function dataCenterRows(result: GpuCatalogResult) {
  return result.catalog.dataCenters.map((dc) => ({
    id: dc.id,
    name: dc.name ?? null,
    region: dc.region ?? null,
    compliance: dc.compliance.join(","),
  }));
}

// The pods CoCalc started, with RunPod's live status where it has one.
export function managedPodRows(result: GpuPodsResult) {
  const live = new Map(result.pods.map((p) => [p.id, p]));
  return (result.records ?? []).map((r) => podRecordRow(r, live));
}

export function podRecordRow(
  r: GpuPodSummary,
  live = new Map<string, { status?: string }>(),
) {
  return {
    handle: r.handle,
    state: r.state,
    status: (r.provider_pod_id && live.get(r.provider_pod_id)?.status) || null,
    gpu: r.gpu_type_id,
    count: r.gpu_count,
    cost_per_hr: r.cost_per_hr ?? null,
    cloud: r.cloud,
    deadline: r.deadline,
    pod_id: r.provider_pod_id ?? null,
    reason: r.reason ?? null,
  };
}

export function podRows(result: GpuPodsResult) {
  return result.pods.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    status: p.status ?? null,
    gpu: p.gpuTypeId ?? p.cpuFlavorId ?? null,
    count: p.gpuCount ?? null,
    cost_per_hr: p.cost ?? null,
    cloud: p.cloud ?? null,
    data_center: p.dataCenterId ?? null,
    created: p.createdAt ?? null,
  }));
}

export function registerGpuCommand(
  program: Command,
  deps: GpuCommandDeps,
): Command {
  const gpu = program
    .command("gpu")
    .description(
      "GPUs on your own RunPod account (connect a key in Settings → Connectors)",
    );
  const run = (
    command: Command,
    label: string,
    fn: (api: GpuApi, ctx: any) => Promise<unknown>,
    timeoutMs = GPU_CLI_RPC_TIMEOUT_MS,
  ) =>
    deps.withContext(command, `gpu ${label}`, async (ctx) =>
      withGpuReadTimeout(ctx, () => fn(ctx.hub.gpu, ctx), timeoutMs),
    );

  gpu
    .command("catalog")
    .description(
      "GPU types with list prices and stock per cloud tier (--json: full detail, including stock per data center)",
    )
    .option("--data-centers", "list data centers instead of GPU types")
    .action(async (opts, command: Command) =>
      run(command, "catalog", async (api, ctx) => {
        const result = await api.catalog({});
        if (isJson(ctx)) return result;
        return opts.dataCenters ? dataCenterRows(result) : catalogRows(result);
      }),
    );

  gpu
    .command("availability")
    .description(
      "where each GPU type is in stock now: one row per GPU type, cloud and data center, cheapest first",
    )
    .option(
      "--gpu <id-or-name>",
      "GPU type id or name (repeatable or comma-separated)",
      collect,
    )
    .option("--cloud <cloud>", "SECURE or COMMUNITY")
    .option(
      "--data-center <id>",
      "data center id, e.g. US-TX-3 (repeatable)",
      collect,
    )
    .option(
      "--region <region>",
      "e.g. NORTH_AMERICA, EUROPE (repeatable)",
      collect,
    )
    .option("--min-stock <level>", "LOW, MEDIUM or HIGH")
    .option(
      "--max-price <usd>",
      "maximum list price per GPU-hour",
      positiveNumber("--max-price"),
    )
    .option(
      "--min-count <n>",
      "GPU types allowing at least this many GPUs on one pod",
      positiveNumber("--min-count", true),
    )
    .action(async (opts, command: Command) =>
      run(command, "availability", async (api, ctx) => {
        const filter: GpuAvailabilityFilter = {};
        if (opts.gpu) filter.gpu = opts.gpu;
        if (opts.cloud) filter.cloud = `${opts.cloud}`.toUpperCase() as any;
        if (opts.dataCenter) filter.data_center = opts.dataCenter;
        if (opts.region) filter.region = opts.region;
        if (opts.minStock) {
          filter.min_stock = `${opts.minStock}`.toUpperCase() as any;
        }
        if (opts.maxPrice != null)
          filter.max_price_per_gpu_hour = opts.maxPrice;
        if (opts.minCount != null) filter.min_count = opts.minCount;
        const result = await api.availability(filter);
        return isJson(ctx) ? result : result.offers;
      }),
    );

  gpu
    .command("pods")
    .description(
      "the pods CoCalc started for you (--id: one pod read live, with SSH endpoints and utilization; --all: every pod in your RunPod account)",
    )
    .option("--id <pod>", "one pod: its handle or RunPod pod id")
    .option("--ended", "also pods that ended in the last 30 days")
    .option(
      "--all",
      "every pod in your RunPod account, including ones CoCalc didn't start",
    )
    .action(async (opts, command: Command) =>
      run(command, "pods", async (api, ctx) => {
        const result = await api.pods({
          ...(opts.id ? { pod_id: opts.id } : {}),
          ...(opts.all ? { scope: "account" as const } : {}),
          ...(opts.ended ? { include_ended: true } : {}),
        });
        if (isJson(ctx)) return result;
        if (opts.all) {
          if (opts.id) {
            if (result.pods.length === 0) throw new Error("no such pod");
            return result.pods[0];
          }
          return podRows(result);
        }
        if (opts.id) {
          const record = result.records?.[0];
          if (!record) throw new Error("no such pod");
          return { ...record, live: result.pods[0] ?? null };
        }
        return managedPodRows(result);
      }),
    );

  gpu
    .command("launch")
    .description(
      "start a pod on your RunPod key; it is terminated after --max-runtime minutes at the latest (once budgets land; until then, terminate it yourself)",
    )
    .requiredOption("--gpu <id>", 'GPU type id, e.g. "NVIDIA GeForce RTX 4090"')
    .requiredOption(
      "--max-runtime <minutes>",
      "maximum runtime in minutes (5 to 1440)",
      positiveNumber("--max-runtime", true),
    )
    .option(
      "--project <project-id>",
      "the project it is for (default: this project)",
    )
    .option(
      "--count <n>",
      "GPUs on the pod (default 1)",
      positiveNumber("--count", true),
    )
    .option("--cloud <cloud>", "SECURE (default) or COMMUNITY")
    .option("--data-center <id>", "data center id, e.g. US-TX-3")
    .option("--image <image>", "container image (one of the allowed images)")
    .option(
      "--disk <gb>",
      "container disk in GB (default 20)",
      positiveNumber("--disk", true),
    )
    .option(
      "--volume <gb>",
      "persistent volume at /workspace, in GB",
      positiveNumber("--volume", true),
    )
    .option(
      "--port <port>",
      'exposed port, e.g. "8888/http" (repeatable)',
      collect,
    )
    .option(
      "--env <NAME=value>",
      "non-secret environment variable (repeatable)",
      (v: string, a: string[] = []) => [...a, v],
    )
    .option("--ssh-public-key <key>", "the pod's own ssh-ed25519 public key")
    .action(async (opts, command: Command) =>
      run(
        command,
        "launch",
        async (api, ctx) => {
          const project_id = opts.project ?? process.env.COCALC_PROJECT_ID;
          if (!project_id) {
            throw new Error("--project is required outside a project");
          }
          const pod = await api.launch({
            project_id,
            spec: launchSpecFromOptions(opts),
          });
          return isJson(ctx) ? pod : podRecordRow(pod);
        },
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("terminate <pod>")
    .description(
      "terminate a pod CoCalc started (its handle or RunPod pod id); this ends its billing, including storage",
    )
    .action(async (pod: string, _opts, command: Command) =>
      run(
        command,
        "terminate",
        async (api) => await api.terminate({ pod_id: pod }),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("who <query>")
    .description(
      "who is responsible for a pod, and what was done to it: a handle, RunPod pod id or IP address",
    )
    .action(async (query: string, _opts, command: Command) =>
      run(command, "who", async (api, ctx) => {
        const result = await api.who({ query });
        if (isJson(ctx)) return result;
        return result.map(({ pod, events }) => ({
          ...podRecordRow(pod),
          beneficiary: pod.beneficiary_account_id,
          key_owner: pod.key_owner_account_id,
          project: pod.project_id ?? null,
          events: events
            .map((e) => `${e.at} ${e.actor_kind} ${e.action}`)
            .join("; "),
        }));
      }),
    );

  return gpu;
}

// The CLI's options as a launch spec; the server checks it against the
// allowlist.
export function launchSpecFromOptions(opts: any): GpuLaunchSpec {
  const spec: GpuLaunchSpec = {
    gpu_type_id: opts.gpu,
    gpu_count: opts.count ?? 1,
    image: opts.image ?? GPU_LAUNCH_IMAGES[0],
    max_runtime_minutes: opts.maxRuntime,
  };
  if (opts.cloud) spec.cloud = `${opts.cloud}`.toUpperCase() as any;
  if (opts.dataCenter) spec.data_center_id = opts.dataCenter;
  if (opts.disk != null) spec.container_disk_gb = opts.disk;
  if (opts.volume != null) spec.volume_gb = opts.volume;
  if (opts.port) spec.ports = opts.port;
  if (opts.env) {
    spec.env = {};
    for (const kv of opts.env as string[]) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new Error(`--env must be NAME=value, not ${kv}`);
      spec.env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  if (opts.sshPublicKey) spec.ssh_public_key = opts.sshPublicKey;
  return spec;
}
