/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ServiceAdmissionLimitKey =
  | "hub_conat_api_max_active"
  | "conat_service_max_parallel_active"
  | "conat_max_connections"
  | "conat_max_connections_per_user"
  | "conat_max_connections_per_hub_user"
  | "conat_inbound_events_per_socket_window"
  | "conat_inbound_events_per_identity_window"
  | "conat_inbound_event_window_ms"
  | "conat_inbound_event_block_ms"
  | "app_proxy_max_active_websockets_total"
  | "app_proxy_max_active_websockets_per_target"
  | "project_exec_stream_max_active";

type LimitDefinition = {
  env: string;
  fallback: number;
  minimum?: number;
};

export type ServiceAdmissionLimitOverrides = Partial<
  Record<ServiceAdmissionLimitKey, number>
>;

const DEFINITIONS: Record<ServiceAdmissionLimitKey, LimitDefinition> = {
  hub_conat_api_max_active: {
    env: "COCALC_HUB_CONAT_API_MAX_ACTIVE",
    fallback: 1000,
  },
  conat_service_max_parallel_active: {
    env: "COCALC_CONAT_SERVICE_MAX_PARALLEL_ACTIVE",
    fallback: 128,
  },
  conat_max_connections: {
    env: "COCALC_CONAT_MAX_CONNECTIONS",
    fallback: 10_000,
  },
  conat_max_connections_per_user: {
    env: "COCALC_CONAT_MAX_CONNECTIONS_PER_USER",
    fallback: 100,
  },
  conat_max_connections_per_hub_user: {
    env: "COCALC_CONAT_MAX_CONNECTIONS_PER_HUB_USER",
    fallback: 1_000,
  },
  conat_inbound_events_per_socket_window: {
    env: "COCALC_CONAT_MAX_INBOUND_EVENTS_PER_SOCKET_WINDOW",
    fallback: 10_000,
  },
  conat_inbound_events_per_identity_window: {
    env: "COCALC_CONAT_MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW",
    fallback: 50_000,
  },
  conat_inbound_event_window_ms: {
    env: "COCALC_CONAT_INBOUND_EVENT_WINDOW_MS",
    fallback: 10_000,
    minimum: 1_000,
  },
  conat_inbound_event_block_ms: {
    env: "COCALC_CONAT_INBOUND_EVENT_BLOCK_MS",
    fallback: 10_000,
    minimum: 1_000,
  },
  app_proxy_max_active_websockets_total: {
    env: "COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_TOTAL",
    fallback: 256,
  },
  app_proxy_max_active_websockets_per_target: {
    env: "COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_PER_TARGET",
    fallback: 64,
  },
  project_exec_stream_max_active: {
    env: "COCALC_PROJECT_EXEC_STREAM_MAX_ACTIVE",
    fallback: 16,
  },
};

let overrides: ServiceAdmissionLimitOverrides = {};

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

export function serviceAdmissionLimitEnvName(
  key: ServiceAdmissionLimitKey,
): string {
  return DEFINITIONS[key].env;
}

export function serviceAdmissionLimitDefault(
  key: ServiceAdmissionLimitKey,
): number {
  const definition = DEFINITIONS[key];
  const fromEnv = positiveInteger(process.env[definition.env]);
  return Math.max(definition.minimum ?? 1, fromEnv ?? definition.fallback);
}

export function setServiceAdmissionLimitOverrides(
  next: ServiceAdmissionLimitOverrides = {},
): void {
  const cleaned: ServiceAdmissionLimitOverrides = {};
  for (const key of Object.keys(DEFINITIONS) as ServiceAdmissionLimitKey[]) {
    const value = positiveInteger(next[key]);
    if (value != null) {
      cleaned[key] = Math.max(DEFINITIONS[key].minimum ?? 1, value);
    }
  }
  overrides = cleaned;
}

export function getServiceAdmissionLimit(
  key: ServiceAdmissionLimitKey,
): number {
  return overrides[key] ?? serviceAdmissionLimitDefault(key);
}

export type ServiceAdmissionNearLimitConfig = {
  thresholdPercent: number;
  logIntervalMs: number;
};

const DEFAULT_NEAR_LIMIT_CONFIG: ServiceAdmissionNearLimitConfig = {
  thresholdPercent: 80,
  logIntervalMs: 60_000,
};

let nearLimitConfig: ServiceAdmissionNearLimitConfig = {
  ...DEFAULT_NEAR_LIMIT_CONFIG,
};

export function setServiceAdmissionNearLimitConfig(
  next: Partial<ServiceAdmissionNearLimitConfig> = {},
): void {
  const thresholdPercent = positiveInteger(next.thresholdPercent);
  const logIntervalMs = positiveInteger(next.logIntervalMs);
  nearLimitConfig = {
    thresholdPercent: Math.min(
      100,
      Math.max(
        1,
        thresholdPercent ?? DEFAULT_NEAR_LIMIT_CONFIG.thresholdPercent,
      ),
    ),
    logIntervalMs: Math.max(
      1_000,
      logIntervalMs ?? DEFAULT_NEAR_LIMIT_CONFIG.logIntervalMs,
    ),
  };
}

export function getServiceAdmissionNearLimitConfig(): ServiceAdmissionNearLimitConfig {
  return nearLimitConfig;
}
