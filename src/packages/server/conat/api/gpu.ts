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

export const catalog: GpuApi["catalog"] = async (opts = {}) =>
  await getGpuCatalog(opts);

export const availability: GpuApi["availability"] = async (opts = {}) =>
  await getGpuAvailability(opts);

export const pods: GpuApi["pods"] = async (opts = {}) => await getGpuPods(opts);
