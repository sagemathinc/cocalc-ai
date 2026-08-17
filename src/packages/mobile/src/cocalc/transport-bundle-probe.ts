/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// These value imports intentionally stay in the production graph. They are the
// Phase 0 feasibility gate: Metro must be able to bundle the exact Conat, DKV,
// and SyncDoc surfaces used by native chat without importing the web frontend.
import { connect } from "@cocalc/conat/core/client";
import { initHubApi } from "@cocalc/conat/hub/api";
import { dkv } from "@cocalc/conat/sync/dkv";
import "@cocalc/conat/sync-doc/install";

export const transportBundleProbe = Object.freeze({
  connect,
  dkv,
  initHubApi,
});
