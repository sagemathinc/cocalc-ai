/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import {
  getGlobalConfigPropagationStatusOnSeed,
  SERVER_SETTINGS_CONFIG_SCOPE,
  syncSiteSettingsToBaysOnSeed,
} from "@cocalc/server/conat/api/system";
import type {
  GlobalConfigPropagationScopeStatus,
  SiteSettingsSyncResult,
} from "@cocalc/conat/hub/api/system";

const logger = getLogger("server:global-config-mirror-maintenance");

const ENABLED =
  `${process.env.COCALC_GLOBAL_CONFIG_MIRROR_REPAIR_ENABLED ?? "true"}`
    .trim()
    .toLowerCase() !== "false";
const INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.COCALC_GLOBAL_CONFIG_MIRROR_REPAIR_INTERVAL_MS ?? 60_000),
);

let timer: NodeJS.Timeout | undefined;
let running = false;

export interface GlobalConfigMirrorRepairPassResult {
  scope: string;
  skipped:
    | false
    | "not-seed"
    | "unversioned"
    | "unsupported-scope"
    | "already-current";
  repaired: boolean;
  stale_bays: string[];
  sync?: SiteSettingsSyncResult;
}

function staleBaysForScope(
  scopeStatus: GlobalConfigPropagationScopeStatus | undefined,
): string[] {
  if (scopeStatus?.seed_version == null) {
    return [];
  }
  return scopeStatus.bays
    .filter(({ status }) => status !== "current")
    .map(({ bay_id }) => bay_id)
    .sort();
}

export async function runGlobalConfigMirrorRepairPass({
  scope = SERVER_SETTINGS_CONFIG_SCOPE,
}: {
  scope?: string;
} = {}): Promise<GlobalConfigMirrorRepairPassResult> {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    return {
      scope,
      skipped: "not-seed",
      repaired: false,
      stale_bays: [],
    };
  }
  if (scope !== SERVER_SETTINGS_CONFIG_SCOPE) {
    return {
      scope,
      skipped: "unsupported-scope",
      repaired: false,
      stale_bays: [],
    };
  }
  const status = await getGlobalConfigPropagationStatusOnSeed({ scope });
  const scopeStatus = status.scopes.find((entry) => entry.scope === scope);
  if (scopeStatus?.seed_version == null) {
    return {
      scope,
      skipped: "unversioned",
      repaired: false,
      stale_bays: [],
    };
  }
  const stale_bays = staleBaysForScope(scopeStatus);
  if (!stale_bays.length) {
    return {
      scope,
      skipped: "already-current",
      repaired: false,
      stale_bays,
    };
  }
  const sync = await syncSiteSettingsToBaysOnSeed();
  return {
    scope,
    skipped: false,
    repaired: true,
    stale_bays,
    sync,
  };
}

export async function runGlobalConfigMirrorRepairMaintenanceTick(): Promise<GlobalConfigMirrorRepairPassResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await runGlobalConfigMirrorRepairPass();
    if (result.repaired || result.skipped === "unsupported-scope") {
      logger.info("global config mirror repair maintenance tick", result);
    }
    return result;
  } catch (err) {
    logger.warn("global config mirror repair maintenance failed", {
      err: `${err}`,
    });
    throw err;
  } finally {
    running = false;
  }
}

export function startGlobalConfigMirrorRepairMaintenance(): void {
  if (!ENABLED) {
    logger.info("global config mirror repair maintenance disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void runGlobalConfigMirrorRepairMaintenanceTick();
  }, INTERVAL_MS);
  timer.unref?.();
  void runGlobalConfigMirrorRepairMaintenanceTick();
  logger.info("global config mirror repair maintenance started", {
    interval_ms: INTERVAL_MS,
  });
}

export function stopGlobalConfigMirrorRepairMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

export function resetGlobalConfigMirrorRepairMaintenanceStateForTests(): void {
  stopGlobalConfigMirrorRepairMaintenance();
  running = false;
}
