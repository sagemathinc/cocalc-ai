/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
`cocalc gpu launch --template`: a built-in template (util/gpu/templates.ts)
with the caller's explicit choices over it. Without --gpu, the GPU is the
cheapest offer in stock now with enough GPU memory. The result is checked
against the launch allowlist here too (the server checks it again).
*/

import type { GpuApi, GpuOffer } from "@cocalc/conat/hub/api/gpu";
import {
  GPU_LAUNCH_IMAGES,
  normalizeGpuLaunchSpec,
} from "@cocalc/util/gpu/launch-spec";
import {
  GPU_TEMPLATES,
  getGpuTemplate,
  maxLaunchCostUsd,
  specFromTemplate,
  type GpuTemplate,
} from "@cocalc/util/gpu/templates";
import type { GpuLaunchSpec } from "@cocalc/util/gpu/types";

export interface GpuLaunchPlan {
  spec: GpuLaunchSpec;
  template?: GpuTemplate;
  // the offer the GPU was picked from, or priced by
  offer?: GpuOffer;
  // GPUs and disk at list price for the whole maximum runtime, when a
  // price is known (maxLaunchCostUsd)
  max_cost_usd?: number;
}

export function templateRows() {
  return GPU_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    ssh: t.ssh,
    kernel: t.kernel,
    min_gpu_memory_gb: t.min_gpu_memory_gb,
    max_runtime_minutes: t.spec.max_runtime_minutes ?? null,
    description: t.description,
  }));
}

function cheapest(offers: GpuOffer[]): GpuOffer | undefined {
  return offers
    .filter((o) => typeof o.price_per_gpu_hour === "number")
    .sort((a, b) => a.price_per_gpu_hour! - b.price_per_gpu_hour!)[0];
}

export async function planGpuLaunch(
  api: Pick<GpuApi, "availability">,
  opts: {
    template?: string;
    // only what the caller chose explicitly
    spec: Partial<GpuLaunchSpec>;
    // look up a price even when the GPU is given (for --dry-run)
    price?: boolean;
    // refuse unless the bound is known and at most this (--max-cost)
    max_cost_usd?: number;
  },
): Promise<GpuLaunchPlan> {
  let template: GpuTemplate | undefined;
  if (opts.template != null) {
    template = getGpuTemplate(opts.template);
    if (!template) {
      throw new Error(
        `no template ${JSON.stringify(opts.template)}; choose one of: ${GPU_TEMPLATES.map((t) => t.id).join(", ")}`,
      );
    }
  }
  const spec: Partial<GpuLaunchSpec> = template
    ? specFromTemplate(template, opts.spec)
    : { image: GPU_LAUNCH_IMAGES[0], ...opts.spec };
  spec.gpu_count ??= 1;
  if (spec.max_runtime_minutes == null) {
    throw new Error("--max-runtime is required (or use a --template)");
  }
  const cloud = spec.cloud ?? "SECURE";
  const filter = {
    cloud,
    min_count: spec.gpu_count,
    ...(spec.data_center_id ? { data_center: [spec.data_center_id] } : {}),
  };
  let offer: GpuOffer | undefined;
  if (!spec.gpu_type_id) {
    if (!template) throw new Error("--gpu is required (or use a --template)");
    const min = template.min_gpu_memory_gb;
    offer = cheapest(
      (await api.availability(filter)).offers.filter(
        (o) => (o.memory_gb ?? 0) >= min,
      ),
    );
    if (!offer) {
      throw new Error(
        `No GPU with at least ${min} GB is in stock on ${cloud} cloud now. Try again later, or choose one with --gpu (see cocalc gpu availability).`,
      );
    }
    spec.gpu_type_id = offer.gpu_type_id;
  } else if (opts.price || opts.max_cost_usd != null) {
    offer = cheapest(
      (await api.availability({ ...filter, gpu: [spec.gpu_type_id] })).offers,
    );
  }
  const plan: GpuLaunchPlan = { spec: normalizeGpuLaunchSpec(spec) };
  if (template) plan.template = template;
  if (offer) {
    plan.offer = offer;
    plan.max_cost_usd = maxLaunchCostUsd({
      price_per_gpu_hour: offer.price_per_gpu_hour!,
      gpu_count: plan.spec.gpu_count,
      max_runtime_minutes: plan.spec.max_runtime_minutes,
      container_disk_gb: plan.spec.container_disk_gb ?? 0,
      volume_gb: plan.spec.volume_gb ?? 0,
    });
  }
  if (opts.max_cost_usd != null) {
    if (plan.max_cost_usd == null) {
      throw new Error(
        `No list price for ${plan.spec.gpu_type_id} on ${cloud} cloud now, so the launch can't be held to --max-cost.`,
      );
    }
    if (plan.max_cost_usd > opts.max_cost_usd) {
      throw new Error(
        `This launch could cost up to $${plan.max_cost_usd.toFixed(2)}, more than --max-cost $${opts.max_cost_usd.toFixed(2)} (prices or stock changed?). Run --dry-run again.`,
      );
    }
  }
  return plan;
}

// POSIX shell quoting: one word, whatever the value holds.
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

// The launch a dry run describes, exactly: the whole normalized spec as
// explicit options (each wins over the template, so the template only keeps
// its SSH and kernel behavior), the project, how it connects, and
// --max-cost at the stated bound, so a change in prices or stock refuses
// it rather than costing more.
export function pinnedLaunchCommand(
  plan: GpuLaunchPlan,
  context: {
    project_id: string;
    template?: string;
    // --ssh without a template
    ssh?: boolean;
    // false for --no-connect
    connect?: boolean;
    wait?: number;
  },
): string | undefined {
  if (plan.max_cost_usd == null) return undefined;
  const { spec } = plan;
  const args: string[] = ["cocalc", "gpu", "launch"];
  const opt = (flag: string, value: string | number) =>
    args.push(flag, shellQuote(`${value}`));
  opt("--project", context.project_id);
  if (context.template) opt("--template", context.template);
  opt("--gpu", spec.gpu_type_id);
  opt("--count", spec.gpu_count);
  opt("--cloud", spec.cloud ?? "SECURE");
  if (spec.data_center_id) opt("--data-center", spec.data_center_id);
  opt("--image", spec.image);
  if (spec.container_disk_gb != null) opt("--disk", spec.container_disk_gb);
  if (spec.volume_gb) opt("--volume", spec.volume_gb);
  for (const port of spec.ports ?? []) opt("--port", port);
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    opt("--env", `${name}=${value}`);
  }
  opt("--max-runtime", spec.max_runtime_minutes);
  if (spec.ssh_public_key) opt("--ssh-public-key", spec.ssh_public_key);
  else if (context.ssh && !context.template) args.push("--ssh");
  if (context.connect === false) args.push("--no-connect");
  if (context.wait != null) opt("--wait", context.wait);
  opt("--max-cost", plan.max_cost_usd.toFixed(2));
  return args.join(" ");
}
