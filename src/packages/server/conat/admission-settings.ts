/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  setServiceAdmissionLimitOverrides,
  setServiceAdmissionNearLimitConfig,
  type ServiceAdmissionNearLimitConfig,
  type ServiceAdmissionLimitOverrides,
} from "@cocalc/conat/admission/limits";

const logger = getLogger("server:conat:admission-settings");

const REFRESH_MS = 30_000;

let refreshStarted = false;

const SETTINGS_TO_LIMITS: Record<string, keyof ServiceAdmissionLimitOverrides> =
  {
    conat_admission_hub_api_max_active: "hub_conat_api_max_active",
    conat_admission_service_max_parallel_active:
      "conat_service_max_parallel_active",
    conat_admission_max_connections: "conat_max_connections",
    conat_admission_max_connections_per_user: "conat_max_connections_per_user",
    conat_admission_max_connections_per_hub_user:
      "conat_max_connections_per_hub_user",
    conat_admission_inbound_events_per_socket_window:
      "conat_inbound_events_per_socket_window",
    conat_admission_inbound_events_per_identity_window:
      "conat_inbound_events_per_identity_window",
    conat_admission_inbound_event_window_ms: "conat_inbound_event_window_ms",
    conat_admission_inbound_event_block_ms: "conat_inbound_event_block_ms",
    conat_admission_app_proxy_max_active_websockets_total:
      "app_proxy_max_active_websockets_total",
    conat_admission_app_proxy_max_active_websockets_per_target:
      "app_proxy_max_active_websockets_per_target",
    conat_admission_project_exec_stream_max_active:
      "project_exec_stream_max_active",
  };

function optionalPositiveInteger(value: unknown): number | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

export async function getConatAdmissionConfig(): Promise<{
  limits: ServiceAdmissionLimitOverrides;
  near_limit: ServiceAdmissionNearLimitConfig;
}> {
  const settings = await getServerSettings();
  const limits: ServiceAdmissionLimitOverrides = {};
  for (const [settingKey, limitKey] of Object.entries(SETTINGS_TO_LIMITS)) {
    const value = optionalPositiveInteger((settings as any)[settingKey]);
    if (value != null) {
      limits[limitKey] = value;
    }
  }
  return {
    limits,
    near_limit: {
      thresholdPercent:
        optionalPositiveInteger(
          (settings as any).conat_admission_near_limit_percent,
        ) ?? 80,
      logIntervalMs:
        optionalPositiveInteger(
          (settings as any).conat_admission_near_limit_log_interval_ms,
        ) ?? 60_000,
    },
  };
}

export async function refreshConatAdmissionSettings(): Promise<void> {
  const config = await getConatAdmissionConfig();
  setServiceAdmissionLimitOverrides(config.limits);
  setServiceAdmissionNearLimitConfig({
    thresholdPercent: optionalPositiveInteger(
      config.near_limit.thresholdPercent,
    ),
    logIntervalMs: optionalPositiveInteger(config.near_limit.logIntervalMs),
  });
}

export function startConatAdmissionSettingsRefresh(): void {
  if (refreshStarted) {
    return;
  }
  refreshStarted = true;
  const refresh = () => {
    void refreshConatAdmissionSettings().catch((err) => {
      logger.warn("failed to refresh Conat admission settings", {
        err: `${err}`,
      });
    });
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
}
