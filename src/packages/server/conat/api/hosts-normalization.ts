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
  HostMachine,
  HostPressureState,
  HostInterruptionRestorePolicy,
  HostMetricsHistory,
  HostPricingModel,
  HostPressureZone,
  HostRuntimeExceptionSummary,
  HostSpotRecoveryPolicy,
  HostSpotRecoveryState,
  HostStatus,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentStatus,
  ManagedComponentKind,
  ManagedComponentRuntimeState,
  ManagedComponentUpgradePolicy,
  ManagedComponentVersionState,
} from "@cocalc/conat/project-host/api";
import {
  defaultInterruptionRestorePolicy as defaultSpotInterruptionRestorePolicy,
  desiredHostState,
  desiredPricingModel as desiredPricingModelFromHost,
  effectivePricingModel as effectivePricingModelFromHost,
  spotRecoveryPolicy as spotRecoveryPolicyFromHost,
  spotRecoveryState as spotRecoveryStateFromHost,
} from "@cocalc/server/cloud/spot-restore";
import { observedHostAgentFromMetadata } from "./hosts-runtime-observation";

const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const HOST_RUNNING_STATUSES = new Set(["running", "active"]);
const MANAGED_COMPONENT_KINDS = new Set<ManagedComponentKind>([
  "project-host",
  "conat-router",
  "conat-persist",
  "acp-worker",
]);

function normalizeManagedComponentUpgradePolicy(
  value: unknown,
): ManagedComponentUpgradePolicy | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "restart_now":
    case "drain_then_replace":
      return `${value}`.trim() as ManagedComponentUpgradePolicy;
    default:
      return undefined;
  }
}

function normalizeManagedComponentRuntimeState(
  value: unknown,
): ManagedComponentRuntimeState | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "running":
    case "stopped":
    case "disabled":
    case "unknown":
      return `${value}`.trim() as ManagedComponentRuntimeState;
    default:
      return undefined;
  }
}

function normalizeManagedComponentVersionState(
  value: unknown,
): ManagedComponentVersionState | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "aligned":
    case "drifted":
    case "mixed":
    case "unknown":
      return `${value}`.trim() as ManagedComponentVersionState;
    default:
      return undefined;
  }
}

function normalizeObservedComponents(
  value: unknown,
): HostManagedComponentStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const components: HostManagedComponentStatus[] = [];
  for (const entry of value) {
    const normalized = (() => {
      const component =
        `${entry?.component ?? ""}`.trim() as ManagedComponentKind;
      if (!MANAGED_COMPONENT_KINDS.has(component)) {
        return undefined;
      }
      const upgrade_policy = normalizeManagedComponentUpgradePolicy(
        entry?.upgrade_policy,
      );
      const runtime_state = normalizeManagedComponentRuntimeState(
        entry?.runtime_state,
      );
      const version_state = normalizeManagedComponentVersionState(
        entry?.version_state,
      );
      if (!upgrade_policy || !runtime_state || !version_state) {
        return undefined;
      }
      return {
        component,
        artifact: "project-host",
        upgrade_policy,
        enabled: entry?.enabled !== false,
        managed: entry?.managed !== false,
        desired_version: `${entry?.desired_version ?? ""}`.trim() || undefined,
        runtime_state,
        version_state,
        running_versions: Array.isArray(entry?.running_versions)
          ? entry.running_versions
              .map((version: any) => `${version ?? ""}`.trim())
              .filter((version: string) => !!version)
          : [],
        running_pids: Array.isArray(entry?.running_pids)
          ? entry.running_pids
              .map((pid: any) => Number(pid))
              .filter((pid: number) => Number.isInteger(pid) && pid > 0)
          : [],
      } satisfies HostManagedComponentStatus;
    })();
    if (normalized) {
      components.push(normalized);
    }
  }
  return components.length ? components : undefined;
}

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
  return defaultSpotInterruptionRestorePolicy(pricingModel);
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
    runtime_exception_summary?: HostRuntimeExceptionSummary;
    runtime_desired_artifacts?: {
      project_host?: string;
      project_bundle?: string;
      tools?: string;
      updated_at?: string;
    };
  } = {},
): Host {
  const metadata = row.metadata ?? {};
  const software = metadata.software ?? {};
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
  const normalizePressureZone = (
    value: unknown,
  ): HostPressureZone | undefined => {
    switch (`${value ?? ""}`.trim()) {
      case "normal":
      case "observe":
      case "pressure":
      case "emergency":
        return `${value}`.trim() as HostPressureZone;
      default:
        return undefined;
    }
  };
  const normalizeHostPressureState = (
    value: unknown,
  ): HostPressureState | undefined => {
    const zone = normalizePressureZone((value as any)?.zone);
    if (!zone) return undefined;
    const normalized: HostPressureState = { zone };
    const reason = `${(value as any)?.reason ?? ""}`.trim();
    if (reason) {
      normalized.reason = reason;
    }
    const since_ms = parseNonNegativeNumber((value as any)?.since_ms);
    if (since_ms != null) {
      normalized.since_ms = since_ms;
    }
    const evaluated_at_ms = parseNonNegativeNumber(
      (value as any)?.evaluated_at_ms,
    );
    if (evaluated_at_ms != null) {
      normalized.evaluated_at_ms = evaluated_at_ms;
    }
    const candidate_count = parseNonNegativeNumber(
      (value as any)?.candidate_count,
    );
    if (candidate_count != null) {
      normalized.candidate_count = candidate_count;
    }
    const settle_until_ms = parseNonNegativeNumber(
      (value as any)?.settle_until_ms,
    );
    if (settle_until_ms != null) {
      normalized.settle_until_ms = settle_until_ms;
    }
    const recent_pressure_stop_count = parseNonNegativeNumber(
      (value as any)?.recent_pressure_stop_count,
    );
    if (recent_pressure_stop_count != null) {
      normalized.recent_pressure_stop_count = recent_pressure_stop_count;
    }
    const last_action_at_ms = parseNonNegativeNumber(
      (value as any)?.last_action_at_ms,
    );
    if (last_action_at_ms != null) {
      normalized.last_action_at_ms = last_action_at_ms;
    }
    const last_action_project_id =
      `${(value as any)?.last_action_project_id ?? ""}`.trim();
    if (last_action_project_id) {
      normalized.last_action_project_id = last_action_project_id;
    }
    switch (`${(value as any)?.last_action_status ?? ""}`.trim()) {
      case "stopped":
      case "stop_failed":
      case "cooldown":
      case "no_candidates":
        normalized.last_action_status =
          `${(value as any)?.last_action_status}`.trim() as HostPressureState["last_action_status"];
        break;
    }
    const last_action_reason =
      `${(value as any)?.last_action_reason ?? ""}`.trim();
    if (last_action_reason) {
      normalized.last_action_reason = last_action_reason;
    }
    return normalized;
  };
  const lifecycleValueText = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${value}`;
    }
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    return undefined;
  };
  const maxTimestamp = (left?: string, right?: string): string | undefined => {
    const leftMs = parseTimestampMs(left);
    const rightMs = parseTimestampMs(right);
    if (leftMs == null) return right;
    if (rightMs == null) return left;
    return leftMs >= rightMs ? left : right;
  };
  const compareNumericVersionLike = (
    left?: string,
    right?: string,
  ): number | undefined => {
    const a = `${left ?? ""}`.trim();
    const b = `${right ?? ""}`.trim();
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return undefined;
    const leftValue = BigInt(a);
    const rightValue = BigInt(b);
    if (leftValue === rightValue) return 0;
    return leftValue > rightValue ? 1 : -1;
  };
  const isBuildIdLike = (value?: string): boolean =>
    /^\d{8}T\d{6}Z-[a-z0-9]+(?:-dirty)?-[a-z0-9]+$/i.test(
      `${value ?? ""}`.trim(),
    );
  const chooseDesiredRuntimeArtifactVersion = (
    desiredVersion: string | undefined,
    installedVersion: string | undefined,
  ): string | undefined => {
    const desired = `${desiredVersion ?? ""}`.trim() || undefined;
    const installed = `${installedVersion ?? ""}`.trim() || undefined;
    if (!desired) return installed;
    if (!installed) return desired;
    if (isBuildIdLike(desired) && /^\d+$/.test(installed)) {
      return installed;
    }
    const comparison = compareNumericVersionLike(desired, installed);
    if (comparison != null && comparison < 0) {
      return installed;
    }
    return desired;
  };
  const normalizeLifecycleAgainstDesiredArtifacts = (
    lifecycle: HostBootstrapLifecycle | undefined,
  ): HostBootstrapLifecycle | undefined => {
    if (!lifecycle || !opts.runtime_desired_artifacts) return lifecycle;
    const overrides = new Map<string, string>();
    const desiredProjectHost = chooseDesiredRuntimeArtifactVersion(
      `${opts.runtime_desired_artifacts.project_host ?? ""}`.trim() ||
        undefined,
      `${software.project_host ?? ""}`.trim() || undefined,
    );
    const desiredProjectBundle = chooseDesiredRuntimeArtifactVersion(
      `${opts.runtime_desired_artifacts.project_bundle ?? ""}`.trim() ||
        undefined,
      `${software.project_bundle ?? ""}`.trim() || undefined,
    );
    const desiredTools = chooseDesiredRuntimeArtifactVersion(
      `${opts.runtime_desired_artifacts.tools ?? ""}`.trim() || undefined,
      `${software.tools ?? ""}`.trim() || undefined,
    );
    if (desiredProjectHost) {
      overrides.set("project_host_bundle", desiredProjectHost);
    }
    if (desiredProjectBundle) {
      overrides.set("project_bundle", desiredProjectBundle);
    }
    if (desiredTools) {
      overrides.set("tools_bundle", desiredTools);
    }
    if (overrides.size === 0) return lifecycle;
    let changed = false;
    const items = lifecycle.items.map((item) => {
      const nextDesired = overrides.get(item.key);
      if (!nextDesired) return item;
      const currentDesired = lifecycleValueText(item.desired);
      if (currentDesired === nextDesired) return item;
      changed = true;
      const installed = lifecycleValueText(item.installed);
      const nextItem: HostBootstrapLifecycleItem = {
        ...item,
        desired: nextDesired,
      };
      if (installed && installed === nextDesired) {
        nextItem.status = "match";
        delete nextItem.message;
        return nextItem;
      }
      if (installed) {
        nextItem.status = "drift";
        nextItem.message = `installed bundle ${installed} does not match desired ${nextDesired}`;
        return nextItem;
      }
      if (
        item.status === "match" ||
        /newer than desired/i.test(`${item.message ?? ""}`)
      ) {
        nextItem.status = "drift";
        nextItem.message = `installed bundle does not match desired ${nextDesired}`;
      }
      return nextItem;
    });
    if (!changed) return lifecycle;
    const driftCount = items.filter(
      (item) => item.status === "drift" || item.status === "missing",
    ).length;
    const summary_status =
      lifecycle.summary_status === "reconciling"
        ? "reconciling"
        : driftCount > 0
          ? "drifted"
          : "in_sync";
    const desired_recorded_at = maxTimestamp(
      lifecycle.desired_recorded_at,
      opts.runtime_desired_artifacts.updated_at,
    );
    return {
      ...lifecycle,
      ...(desired_recorded_at ? { desired_recorded_at } : {}),
      summary_status,
      drift_count: driftCount,
      summary_message:
        summary_status === "reconciling"
          ? lifecycle.summary_message
          : summary_status === "drifted"
            ? driftCount === 1
              ? "1 drift item detected"
              : `${driftCount} drift items detected`
            : "desired and installed software are aligned",
      items,
    };
  };
  const normalizeBootstrap = (
    bootstrap: HostBootstrapStatus | undefined,
    lifecycle: HostBootstrapLifecycle | undefined,
  ): HostBootstrapStatus | undefined => {
    if (!bootstrap || !lifecycle) return bootstrap;
    const bootstrapUpdatedMs = parseTimestampMs(bootstrap.updated_at);
    const lifecycleDesiredMs = parseTimestampMs(lifecycle.desired_recorded_at);
    const lifecycleStartedMs = parseTimestampMs(
      lifecycle.last_reconcile_started_at,
    );
    const lifecycleFinishedMs = parseTimestampMs(
      lifecycle.last_reconcile_finished_at,
    );
    if (
      lifecycle.summary_status === "in_sync" &&
      ((lifecycleFinishedMs != null &&
        (bootstrapUpdatedMs == null ||
          bootstrapUpdatedMs <= lifecycleFinishedMs)) ||
        (lifecycleDesiredMs != null &&
          (bootstrapUpdatedMs == null ||
            bootstrapUpdatedMs <= lifecycleDesiredMs)))
    ) {
      return {
        ...bootstrap,
        status: "done",
        updated_at:
          maxTimestamp(
            lifecycle.last_reconcile_finished_at,
            lifecycle.desired_recorded_at,
          ) ?? bootstrap.updated_at,
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
  const normalizedBootstrapLifecycle =
    normalizeLifecycleAgainstDesiredArtifacts(bootstrapLifecycle);
  const normalizedBootstrap = normalizeBootstrap(
    bootstrap,
    normalizedBootstrapLifecycle,
  );
  const pricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const desiredPricingModel = desiredPricingModelFromHost({
    status: normalizedStatus,
    metadata,
  });
  const effectivePricingModel = effectivePricingModelFromHost({
    status: normalizedStatus,
    metadata,
  });
  const interruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(desiredPricingModel);
  const spotRecoveryPolicy = spotRecoveryPolicyFromHost({
    status: normalizedStatus,
    metadata,
  });
  const spotRecoveryState = spotRecoveryStateFromHost({
    status: normalizedStatus,
    metadata,
  });
  const desiredState = desiredHostState({
    status: normalizedStatus,
    metadata,
  });
  return {
    id: row.id,
    name: row.name ?? "Host",
    owner: metadata.owner ?? "",
    bay_id: row.bay_id ?? null,
    region: row.region ?? "",
    size: metadata.size ?? "",
    host_cpu_count: parsePositiveInt(metadata.host_cpu_count),
    host_ram_gb: parsePositiveInt(metadata.host_ram_gb),
    gpu: !!metadata.gpu,
    status: normalizedStatus as HostStatus,
    updated: row.updated ? new Date(row.updated).toISOString() : undefined,
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
    pressure: normalizeHostPressureState(metadata.pressure),
    machine,
    provider_instance_id: metadata.runtime?.instance_id,
    public_ip: metadata.runtime?.public_ip,
    public_url: row.public_url ?? null,
    internal_url: row.internal_url ?? null,
    ssh_server: row.ssh_server ?? null,
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
    desired_pricing_model: desiredPricingModel,
    effective_pricing_model: effectivePricingModel,
    interruption_restore_policy: interruptionRestorePolicy,
    spot_recovery_policy: spotRecoveryPolicy as
      | HostSpotRecoveryPolicy
      | undefined,
    spot_recovery_state: spotRecoveryState as HostSpotRecoveryState | undefined,
    recovery_phase: spotRecoveryState?.phase,
    desired_state: desiredState,
    last_action: metadata.last_action,
    last_action_at: metadata.last_action_at,
    last_action_status: metadata.last_action_status,
    last_action_error: metadata.last_action_error,
    provider_observed_at: metadata.runtime?.observed_at,
    observed_host_agent: observedHostAgentFromMetadata(row),
    observed_components: normalizeObservedComponents(
      metadata.observed_components,
    ),
    runtime_exception_summary: opts.runtime_exception_summary,
    deleted: row.deleted ? new Date(row.deleted).toISOString() : undefined,
    backup_status: opts.backup_status,
    bootstrap: normalizedBootstrap,
    bootstrap_lifecycle: normalizedBootstrapLifecycle,
  };
}
