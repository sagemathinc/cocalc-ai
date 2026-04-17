/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host row normalization and availability helpers.

What belongs here:

- parsing a raw host database row into the public host API shape
- normalization helpers for host pricing, interruption policy, and tier values
- read-only operational availability checks derived from host status/heartbeat

What does not belong here:

- database loading or mutation logic
- public API handler entrypoints
- host lifecycle orchestration
- runtime deployment side effects

`hosts.ts` keeps the loader and orchestration logic while this module owns the
read-only shaping and availability rules used across that surface.
*/

import type {
  Host,
  HostBackupStatus,
  HostBootstrapLifecycle,
  HostBootstrapLifecycleItem,
  HostBootstrapStatus,
  HostCurrentMetrics,
  HostInterruptionRestorePolicy,
  HostMetricsHistory,
  HostPricingModel,
  HostStatus,
  HostMachine,
} from "@cocalc/conat/hub/api/hosts";
import { desiredHostState } from "@cocalc/server/cloud/spot-restore";
import { observedHostAgentFromMetadata } from "./hosts-runtime-observation";

const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const HOST_RUNNING_STATUSES = new Set(["running", "active"]);

export function normalizeHostPricingModel(
  value: unknown,
): HostPricingModel | undefined {
  if (value == null) return undefined;
  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "spot") return "spot";
  if (normalized === "on_demand" || normalized === "on-demand") {
    return "on_demand";
  }
  return undefined;
}

export function normalizeHostInterruptionRestorePolicy(
  value: unknown,
): HostInterruptionRestorePolicy | undefined {
  if (value == null) return undefined;
  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "immediate") return "immediate";
  if (normalized === "none") return "none";
  return undefined;
}

export function defaultInterruptionRestorePolicy(
  pricingModel?: HostPricingModel,
): HostInterruptionRestorePolicy {
  return pricingModel === "spot" ? "immediate" : "none";
}

function parseTimestampMs(value?: string): number | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function hostStatusValue(row: any): string {
  return `${row?.status ?? ""}`.trim().toLowerCase();
}

function hostLastSeenMs(row: any): number | undefined {
  if (!row?.last_seen) return undefined;
  const ts = new Date(row.last_seen as any).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

export function computeHostOperationalAvailability(row: any): {
  operational: boolean;
  online: boolean;
  status: string;
  reason_unavailable?: string;
} {
  if (!row || row.deleted) {
    return {
      operational: false,
      online: false,
      status: hostStatusValue(row),
      reason_unavailable: "Host is deleted.",
    };
  }

  const status = hostStatusValue(row);
  if (!HOST_RUNNING_STATUSES.has(status)) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: `Host is ${status || "unknown"}; it must be running.`,
    };
  }

  const seenMs = hostLastSeenMs(row);
  if (seenMs == null) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: "Host has not sent a heartbeat recently.",
    };
  }

  const online = Date.now() - seenMs <= HOST_ONLINE_WINDOW_MS;
  if (!online) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: "Host heartbeat is stale; host appears offline.",
    };
  }

  return { operational: true, online: true, status };
}

export function normalizeHostTier(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseRow(
  row: any,
  opts: {
    scope?: Host["scope"];
    can_start?: boolean;
    can_place?: boolean;
    reason_unavailable?: string;
    backup_status?: HostBackupStatus;
    starred?: boolean;
    metrics_history?: HostMetricsHistory;
  } = {},
): Host {
  const parsePositiveInt = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
  };
  const parseNonNegativeNumber = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  };
  const normalizeBootstrap = (
    bootstrap: HostBootstrapStatus | undefined,
    lifecycle: HostBootstrapLifecycle | undefined,
  ): HostBootstrapStatus | undefined => {
    if (!bootstrap || !lifecycle) return bootstrap;
    const bootstrapUpdatedMs = parseTimestampMs(bootstrap.updated_at);
    const lifecycleStartedMs = parseTimestampMs(
      lifecycle.last_reconcile_started_at,
    );
    const lifecycleFinishedMs = parseTimestampMs(
      lifecycle.last_reconcile_finished_at,
    );
    if (
      lifecycle.summary_status === "in_sync" &&
      lifecycleFinishedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs <= lifecycleFinishedMs)
    ) {
      return {
        ...bootstrap,
        status: "done",
        updated_at:
          lifecycle.last_reconcile_finished_at ?? bootstrap.updated_at,
        message:
          lifecycle.summary_message ??
          bootstrap.message ??
          "Host software is in sync",
      };
    }
    if (
      lifecycle.summary_status === "reconciling" &&
      lifecycleStartedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs < lifecycleStartedMs)
    ) {
      return {
        ...bootstrap,
        status: "running",
        updated_at: lifecycle.last_reconcile_started_at ?? bootstrap.updated_at,
        message:
          lifecycle.summary_message ??
          bootstrap.message ??
          "Reconciling host software",
      };
    }
    return bootstrap;
  };
  const metadata = row.metadata ?? {};
  const software = metadata.software ?? {};
  const machine: HostMachine | undefined = metadata.machine;
  const rawCurrentMetrics = metadata.metrics?.current;
  const currentMetrics: HostCurrentMetrics | undefined =
    rawCurrentMetrics && typeof rawCurrentMetrics === "object"
      ? {
          ...(typeof rawCurrentMetrics.collected_at === "string"
            ? { collected_at: rawCurrentMetrics.collected_at }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.cpu_percent) != null
            ? {
                cpu_percent: parseNonNegativeNumber(
                  rawCurrentMetrics.cpu_percent,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_1) != null
            ? { load_1: parseNonNegativeNumber(rawCurrentMetrics.load_1) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_5) != null
            ? { load_5: parseNonNegativeNumber(rawCurrentMetrics.load_5) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_15) != null
            ? { load_15: parseNonNegativeNumber(rawCurrentMetrics.load_15) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_total_bytes) !=
          null
            ? {
                memory_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_used_bytes) !=
          null
            ? {
                memory_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.memory_available_bytes,
          ) != null
            ? {
                memory_available_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_available_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_used_percent) !=
          null
            ? {
                memory_used_percent: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_used_percent,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.swap_total_bytes) != null
            ? {
                swap_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.swap_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.swap_used_bytes) != null
            ? {
                swap_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.swap_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_device_total_bytes,
          ) != null
            ? {
                disk_device_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_device_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_device_used_bytes,
          ) != null
            ? {
                disk_device_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_device_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_unallocated_bytes,
          ) != null
            ? {
                disk_unallocated_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_unallocated_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_data_total_bytes,
          ) != null
            ? {
                btrfs_data_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_data_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.btrfs_data_used_bytes) !=
          null
            ? {
                btrfs_data_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_data_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_metadata_total_bytes,
          ) != null
            ? {
                btrfs_metadata_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_metadata_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_metadata_used_bytes,
          ) != null
            ? {
                btrfs_metadata_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_metadata_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_system_total_bytes,
          ) != null
            ? {
                btrfs_system_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_system_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_system_used_bytes,
          ) != null
            ? {
                btrfs_system_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_system_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_global_reserve_total_bytes,
          ) != null
            ? {
                btrfs_global_reserve_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_global_reserve_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_global_reserve_used_bytes,
          ) != null
            ? {
                btrfs_global_reserve_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_global_reserve_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_available_conservative_bytes,
          ) != null
            ? {
                disk_available_conservative_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_available_conservative_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_available_for_admission_bytes,
          ) != null
            ? {
                disk_available_for_admission_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_available_for_admission_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.reservation_bytes) !=
          null
            ? {
                reservation_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.reservation_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.assigned_project_count,
          ) != null
            ? {
                assigned_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.assigned_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.running_project_count) !=
          null
            ? {
                running_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.running_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.starting_project_count,
          ) != null
            ? {
                starting_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.starting_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.stopping_project_count,
          ) != null
            ? {
                stopping_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.stopping_project_count,
                ),
              }
            : {}),
        }
      : undefined;
  const rawBootstrap = metadata.bootstrap;
  const bootstrap: HostBootstrapStatus | undefined =
    rawBootstrap && typeof rawBootstrap === "object"
      ? {
          ...(typeof rawBootstrap.status === "string"
            ? { status: rawBootstrap.status }
            : {}),
          ...(typeof rawBootstrap.updated_at === "string"
            ? { updated_at: rawBootstrap.updated_at }
            : {}),
          ...(typeof rawBootstrap.message === "string"
            ? { message: rawBootstrap.message }
            : {}),
        }
      : undefined;
  const rawBootstrapLifecycle = metadata.bootstrap_lifecycle;
  const bootstrapLifecycle: HostBootstrapLifecycle | undefined =
    rawBootstrapLifecycle && typeof rawBootstrapLifecycle === "object"
      ? (() => {
          const parseLifecycleValue = (
            value: unknown,
          ): string | boolean | number | null | undefined => {
            if (typeof value === "string") {
              const trimmed = value.trim();
              return trimmed || undefined;
            }
            if (typeof value === "boolean") return value;
            if (typeof value === "number" && Number.isFinite(value)) {
              return value;
            }
            if (value === null) return null;
            return undefined;
          };
          const parseLifecycleStatus = (
            value: unknown,
          ):
            | HostBootstrapLifecycle["summary_status"]
            | HostBootstrapLifecycleItem["status"]
            | undefined => {
            const status = `${value ?? ""}`.trim();
            if (
              status === "in_sync" ||
              status === "drifted" ||
              status === "reconciling" ||
              status === "error" ||
              status === "unknown" ||
              status === "match" ||
              status === "drift" ||
              status === "missing" ||
              status === "disabled"
            ) {
              return status as
                | HostBootstrapLifecycle["summary_status"]
                | HostBootstrapLifecycleItem["status"];
            }
            return undefined;
          };
          const items = Array.isArray(rawBootstrapLifecycle.items)
            ? rawBootstrapLifecycle.items
                .map((item): HostBootstrapLifecycleItem | undefined => {
                  if (!item || typeof item !== "object") return undefined;
                  const key =
                    typeof item.key === "string" ? item.key.trim() : "";
                  const label =
                    typeof item.label === "string" ? item.label.trim() : "";
                  const status = parseLifecycleStatus(item.status);
                  if (!key || !label || !status) return undefined;
                  return {
                    key,
                    label,
                    status: status as HostBootstrapLifecycleItem["status"],
                    ...(parseLifecycleValue(item.desired) !== undefined
                      ? { desired: parseLifecycleValue(item.desired) }
                      : {}),
                    ...(parseLifecycleValue(item.installed) !== undefined
                      ? { installed: parseLifecycleValue(item.installed) }
                      : {}),
                    ...(typeof item.message === "string" && item.message.trim()
                      ? { message: item.message.trim() }
                      : {}),
                  };
                })
                .filter(
                  (item): item is HostBootstrapLifecycleItem =>
                    item !== undefined,
                )
            : [];
          const summaryStatus = parseLifecycleStatus(
            rawBootstrapLifecycle.summary_status,
          ) as HostBootstrapLifecycle["summary_status"] | undefined;
          if (!summaryStatus) return undefined;
          return {
            ...(typeof rawBootstrapLifecycle.bootstrap_dir === "string" &&
            rawBootstrapLifecycle.bootstrap_dir.trim()
              ? { bootstrap_dir: rawBootstrapLifecycle.bootstrap_dir.trim() }
              : {}),
            ...(typeof rawBootstrapLifecycle.desired_recorded_at === "string"
              ? {
                  desired_recorded_at:
                    rawBootstrapLifecycle.desired_recorded_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.installed_recorded_at === "string"
              ? {
                  installed_recorded_at:
                    rawBootstrapLifecycle.installed_recorded_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.current_operation === "string"
              ? { current_operation: rawBootstrapLifecycle.current_operation }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_result === "string"
              ? {
                  last_provision_result:
                    rawBootstrapLifecycle.last_provision_result,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_started_at ===
            "string"
              ? {
                  last_provision_started_at:
                    rawBootstrapLifecycle.last_provision_started_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_finished_at ===
            "string"
              ? {
                  last_provision_finished_at:
                    rawBootstrapLifecycle.last_provision_finished_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_result === "string"
              ? {
                  last_reconcile_result:
                    rawBootstrapLifecycle.last_reconcile_result,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_started_at ===
            "string"
              ? {
                  last_reconcile_started_at:
                    rawBootstrapLifecycle.last_reconcile_started_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_finished_at ===
            "string"
              ? {
                  last_reconcile_finished_at:
                    rawBootstrapLifecycle.last_reconcile_finished_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_error === "string" &&
            rawBootstrapLifecycle.last_error.trim()
              ? { last_error: rawBootstrapLifecycle.last_error.trim() }
              : {}),
            summary_status: summaryStatus,
            ...(typeof rawBootstrapLifecycle.summary_message === "string" &&
            rawBootstrapLifecycle.summary_message.trim()
              ? {
                  summary_message: rawBootstrapLifecycle.summary_message.trim(),
                }
              : {}),
            drift_count:
              parseNonNegativeNumber(rawBootstrapLifecycle.drift_count) ?? 0,
            items,
          };
        })()
      : undefined;
  const rawStatus = String(row.status ?? "");
  const normalizedStatus =
    rawStatus === "active" ? "running" : rawStatus || "off";
  const normalizedBootstrap = normalizeBootstrap(bootstrap, bootstrapLifecycle);
  const pricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const interruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(pricingModel);
  const desiredState = desiredHostState({
    status: normalizedStatus,
    metadata,
  });
  return {
    id: row.id,
    name: row.name ?? "Host",
    owner: metadata.owner ?? "",
    region: row.region ?? "",
    size: metadata.size ?? "",
    host_cpu_count: parsePositiveInt(metadata.host_cpu_count),
    host_ram_gb: parsePositiveInt(metadata.host_ram_gb),
    gpu: !!metadata.gpu,
    status: normalizedStatus as HostStatus,
    reprovision_required: !!metadata.reprovision_required,
    version: row.version ?? software.project_host,
    project_host_build_id: software.project_host_build_id,
    project_bundle_version: software.project_bundle,
    project_bundle_build_id: software.project_bundle_build_id,
    tools_version: software.tools,
    host_session_id: metadata.host_session_id,
    host_session_started_at: metadata.host_session_started_at,
    metrics:
      currentMetrics || opts.metrics_history
        ? {
            ...(currentMetrics ? { current: currentMetrics } : {}),
            ...(opts.metrics_history ? { history: opts.metrics_history } : {}),
          }
        : undefined,
    machine,
    public_ip: metadata.runtime?.public_ip,
    last_error: metadata.last_error,
    last_error_at: metadata.last_error_at,
    projects: row.capacity?.projects ?? 0,
    last_seen: row.last_seen
      ? new Date(row.last_seen).toISOString()
      : undefined,
    tier: normalizeHostTier(row.tier),
    scope: opts.scope,
    can_start: opts.can_start,
    can_place: opts.can_place,
    reason_unavailable: opts.reason_unavailable,
    starred: opts.starred,
    pricing_model: pricingModel,
    interruption_restore_policy: interruptionRestorePolicy,
    desired_state: desiredState,
    last_action: metadata.last_action,
    last_action_at: metadata.last_action_at,
    last_action_status: metadata.last_action_status,
    last_action_error: metadata.last_action_error,
    provider_observed_at: metadata.runtime?.observed_at,
    observed_host_agent: observedHostAgentFromMetadata(row),
    deleted: row.deleted ? new Date(row.deleted).toISOString() : undefined,
    backup_status: opts.backup_status,
    bootstrap: normalizedBootstrap,
    bootstrap_lifecycle: bootstrapLifecycle,
  };
}
