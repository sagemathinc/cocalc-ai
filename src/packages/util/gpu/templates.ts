/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU launch templates (GPU bring-your-own-key, step 6): CoCalc-owned, built-in
starting points for `cocalc gpu launch --template <id>`, reviewed like code.
There are no user-saved templates.

A template never holds a GPU type or a key. The GPU comes from the caller,
or else from availability (the cheapest offer with enough GPU memory); the
SSH key is made in the project at launch. Every template's spec passes
normalizeGpuLaunchSpec in a test, so a bad one can't ship.
*/

import { GPU_LAUNCH_IMAGES } from "./launch-spec";
import type { GpuLaunchSpec } from "./types";

export interface GpuTemplate {
  id: string;
  title: string;
  description: string;
  // allowlisted spec fields only
  spec: Omit<Partial<GpuLaunchSpec>, "gpu_type_id" | "ssh_public_key">;
  // make the pod's SSH key in the project (launch --ssh)
  ssh: boolean;
  // then register a remote Jupyter kernel on it (gpu connect)
  kernel: boolean;
  // when no GPU is given, the cheapest offer with at least this much memory
  min_gpu_memory_gb: number;
}

export const GPU_TEMPLATES: readonly GpuTemplate[] = [
  {
    id: "pytorch-kernel",
    title: "PyTorch with a Jupyter kernel",
    description:
      "CUDA PyTorch, reachable over SSH from this project, with a remote Jupyter kernel (reflect-<handle>) for notebooks.",
    spec: {
      image: GPU_LAUNCH_IMAGES[0],
      cloud: "SECURE",
      max_runtime_minutes: 60,
    },
    ssh: true,
    kernel: true,
    min_gpu_memory_gb: 16,
  },
  {
    id: "llm-kernel",
    title: "Large-memory GPU with a Jupyter kernel",
    description:
      "Like pytorch-kernel on a 48 GB or larger GPU with an 80 GB disk, for running or fine-tuning mid-size language models.",
    spec: {
      image: GPU_LAUNCH_IMAGES[0],
      cloud: "SECURE",
      container_disk_gb: 80,
      max_runtime_minutes: 120,
    },
    ssh: true,
    kernel: true,
    min_gpu_memory_gb: 48,
  },
  {
    id: "pytorch-ssh",
    title: "PyTorch over SSH",
    description:
      "CUDA PyTorch, reachable over SSH from this project (the alias is the pod's handle); no Jupyter kernel.",
    spec: {
      image: GPU_LAUNCH_IMAGES[0],
      cloud: "SECURE",
      max_runtime_minutes: 60,
    },
    ssh: true,
    kernel: false,
    min_gpu_memory_gb: 16,
  },
];

export function getGpuTemplate(id: string): GpuTemplate | undefined {
  return GPU_TEMPLATES.find((t) => t.id === id);
}

// The template's spec with explicit choices over it (env is merged). The
// caller still normalizes the result.
export function specFromTemplate(
  template: GpuTemplate,
  overrides: Partial<GpuLaunchSpec>,
): Partial<GpuLaunchSpec> {
  const spec: Partial<GpuLaunchSpec> = { ...template.spec };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (spec as any)[k] = v;
  }
  if (template.spec.env || overrides.env) {
    spec.env = { ...template.spec.env, ...overrides.env };
  }
  return spec;
}

// Storage, which RunPod bills per second on top of the GPUs while a pod
// exists: container and volume disk are $0.10/GB/month while running and a
// volume $0.20/GB/month while stopped (RunPod's pod pricing, 10-28). For a
// bound, every GB is counted at $0.20 over the shortest month (28 days).
export const STORAGE_USD_PER_GB_HOUR_BOUND = 0.2 / (28 * 24);

// The most a launch can cost at list price: its GPUs and all its disk for
// the whole maximum runtime (the pod is gone by then), rounded up to the cent.
export function maxLaunchCostUsd(opts: {
  price_per_gpu_hour: number;
  gpu_count: number;
  max_runtime_minutes: number;
  container_disk_gb: number;
  volume_gb: number;
}): number {
  const hours = opts.max_runtime_minutes / 60;
  const perHour =
    opts.price_per_gpu_hour * opts.gpu_count +
    (opts.container_disk_gb + opts.volume_gb) * STORAGE_USD_PER_GB_HOUR_BOUND;
  // less float noise, so an exact cent amount stays as it is
  return Math.ceil(hours * perHour * 100 - 1e-9) / 100;
}
