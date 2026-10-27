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
  ) =>
    deps.withContext(command, `gpu ${label}`, async (ctx) =>
      fn(ctx.hub.gpu, ctx),
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
      "your pods (--id: one pod read live, with SSH endpoints and utilization)",
    )
    .option("--id <pod-id>", "one pod")
    .action(async (opts, command: Command) =>
      run(command, "pods", async (api, ctx) => {
        const result = await api.pods(opts.id ? { pod_id: opts.id } : {});
        if (isJson(ctx)) return result;
        if (opts.id) {
          if (result.pods.length === 0) throw new Error("no such pod");
          return result.pods[0];
        }
        return podRows(result);
      }),
    );

  return gpu;
}
