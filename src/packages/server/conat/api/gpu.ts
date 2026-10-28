/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Hub API `gpu.*`: see @cocalc/conat/hub/api/gpu and server/gpu. Only the
// first argument is passed on: the implementations' second argument is for
// tests and must never come from a caller.

import type { GpuApi } from "@cocalc/conat/hub/api/gpu";
import {
  getGpuAvailability,
  getGpuCatalog,
  getGpuPods,
} from "@cocalc/server/gpu/read";
import {
  launchGpuPod,
  terminateGpuPod,
  whoGpuPod,
} from "@cocalc/server/gpu/pods";

export const catalog: GpuApi["catalog"] = async (opts = {}) =>
  await getGpuCatalog(opts);

export const availability: GpuApi["availability"] = async (opts = {}) =>
  await getGpuAvailability(opts);

export const pods: GpuApi["pods"] = async (opts = {}) => await getGpuPods(opts);

export async function launch(
  opts: Parameters<GpuApi["launch"]>[0],
): ReturnType<GpuApi["launch"]> {
  return await launchGpuPod({
    account_id: opts?.account_id,
    project_id: opts?.project_id,
    spec: opts?.spec,
  });
}

export async function terminate(
  opts: Parameters<GpuApi["terminate"]>[0],
): ReturnType<GpuApi["terminate"]> {
  return await terminateGpuPod({
    account_id: opts?.account_id,
    pod_id: opts?.pod_id,
  });
}

export async function who(
  opts: Parameters<GpuApi["who"]>[0],
): ReturnType<GpuApi["who"]> {
  return await whoGpuPod({ account_id: opts?.account_id, query: opts?.query });
}
