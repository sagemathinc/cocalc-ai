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
  // list price x GPUs x maximum runtime, when a price is known
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
  } else if (opts.price) {
    offer = cheapest(
      (await api.availability({ ...filter, gpu: [spec.gpu_type_id] })).offers,
    );
  }
  const plan: GpuLaunchPlan = { spec: normalizeGpuLaunchSpec(spec) };
  if (template) plan.template = template;
  if (offer) {
    plan.offer = offer;
    // rounded up to the cent: it is a bound (less float noise)
    const usd = maxLaunchCostUsd(
      offer.price_per_gpu_hour!,
      plan.spec.gpu_count,
      plan.spec.max_runtime_minutes,
    );
    plan.max_cost_usd = Math.ceil(usd * 100 - 1e-9) / 100;
  }
  return plan;
}
