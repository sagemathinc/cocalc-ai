/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type {
  HostStorageAdmissionDecision,
  HostStorageAdmissionMetrics,
  HostStorageAdmissionMode,
  HostStoragePressureState,
} from "@cocalc/conat/hub/api/hosts";
import {
  configureBtrfsBackgroundMutationGuard,
  getBtrfsMutationLockStatus,
} from "@cocalc/file-server/btrfs/operation-cache";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseIoPressure } from "./io-metrics";
import { countProjectsByStates } from "./sqlite/projects";
import {
  getStorageOperationSpec,
  type StorageOperationKind,
  type StorageOperationPriority,
} from "./storage-operation-registry";

const logger = getLogger("project-host:storage-admission");

const PROJECT_POOL_IO_PRESSURE =
  "/sys/fs/cgroup/cocalc-project-pool/io.pressure";
const BEES_IO_PRESSURE = "/sys/fs/cgroup/cocalc-bees/io.pressure";
const RUNTIME_STORAGE = "/usr/local/sbin/cocalc-runtime-storage";
const DEFAULT_SAMPLE_MS = 5_000;
const DEFAULT_CONTENDED_FULL_AVG10 = 5;
const DEFAULT_EMERGENCY_FULL_AVG10 = 10;
const DEFAULT_RECOVERY_FULL_AVG10 = 1;
const DEFAULT_RECOVERY_MS = 60_000;
const DEFAULT_CONTENDED_SAMPLES = 2;
const DEFAULT_BACKGROUND_QUIET_MS = 2_000;

type StorageAdmissionInputs = {
  sampled_at_ms: number;
  host_io_full_avg10?: number;
  project_pool_io_full_avg10?: number;
  bees_io_full_avg10?: number;
  starting_projects: number;
  stopping_projects: number;
  btrfs_mutation_locks: number;
  btrfs_mutation_waiters: number;
  error?: string;
};

export type StorageAdmissionRequest = {
  operation_kind: StorageOperationKind;
  project_id?: string;
  allow_starvation_override?: boolean;
};

export type StorageAdmissionTicket = {
  admitted: boolean;
  would_defer: boolean;
  reason?: string;
  starvation_override: boolean;
  operation_id: string;
  release: () => void;
};

type StorageAdmissionControllerOptions = {
  mode?: HostStorageAdmissionMode;
  now?: () => number;
  readInputs?: () => StorageAdmissionInputs;
  contendedFullAvg10?: number;
  emergencyFullAvg10?: number;
  recoveryFullAvg10?: number;
  recoveryMs?: number;
  contendedSamples?: number;
  backgroundQuietMs?: number;
  onPressureStateChange?: (state: HostStoragePressureState) => void;
};

export interface StorageAdmissionController {
  sample: () => HostStorageAdmissionMetrics;
  admit: (request: StorageAdmissionRequest) => StorageAdmissionTicket;
  backgroundDeferralReason: (request?: {
    allow_starvation_override?: boolean;
  }) => string | undefined;
  getStatus: () => HostStorageAdmissionMetrics;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredMode(value: unknown): HostStorageAdmissionMode {
  const mode = `${value ?? ""}`.trim().toLowerCase();
  if (mode === "disabled" || mode === "enforce") return mode;
  return "observe";
}

function readIoFullAvg10(path: string): number | undefined {
  try {
    return parseIoPressure(readFileSync(path, "utf8")).fullPercent;
  } catch {
    return undefined;
  }
}

function defaultReadInputs(): StorageAdmissionInputs {
  const projectCounts = countProjectsByStates(["starting", "stopping"]);
  const locks = getBtrfsMutationLockStatus();
  const hostIoFullAvg10 = readIoFullAvg10("/proc/pressure/io");
  return {
    sampled_at_ms: Date.now(),
    host_io_full_avg10: hostIoFullAvg10,
    project_pool_io_full_avg10: readIoFullAvg10(PROJECT_POOL_IO_PRESSURE),
    bees_io_full_avg10: readIoFullAvg10(BEES_IO_PRESSURE),
    starting_projects: projectCounts.starting ?? 0,
    stopping_projects: projectCounts.stopping ?? 0,
    btrfs_mutation_locks: locks.length,
    btrfs_mutation_waiters: locks.reduce(
      (total, lock) => total + lock.queued,
      0,
    ),
    ...(hostIoFullAvg10 == null
      ? { error: "host I/O pressure is unavailable" }
      : {}),
  };
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function uncontainedIoFullAvg10(
  host: number | undefined,
  projectPool: number | undefined,
  bees: number | undefined,
): number | undefined {
  if (host == null || !Number.isFinite(host)) return undefined;
  // Root PSI includes project-pool stalls caused by our own io.max limits and
  // BEES workers waiting on their expected background reads. Neither should
  // be counted again as uncontained pressure. The maximum is used because
  // cgroup PSI intervals can overlap and therefore are not additive.
  return Math.max(0, host - (maxDefined(projectPool, bees) ?? 0));
}

function effectiveIoFullAvg10(
  inputs: StorageAdmissionInputs,
): number | undefined {
  if (inputs.bees_io_full_avg10 == null) {
    return maxDefined(
      inputs.host_io_full_avg10,
      inputs.project_pool_io_full_avg10,
    );
  }
  return maxDefined(
    inputs.project_pool_io_full_avg10,
    inputs.host_io_full_avg10 == null
      ? undefined
      : Math.max(0, inputs.host_io_full_avg10 - inputs.bees_io_full_avg10),
  );
}

function emptyActiveCounts(): Record<StorageOperationPriority, number> {
  return {
    lifecycle: 0,
    interactive: 0,
    scheduled: 0,
    scavenger: 0,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createStorageAdmissionController(
  options: StorageAdmissionControllerOptions = {},
): StorageAdmissionController {
  const mode =
    options.mode ??
    configuredMode(process.env.COCALC_PROJECT_HOST_STORAGE_ADMISSION_MODE);
  const now = options.now ?? Date.now;
  const readInputs = options.readInputs ?? defaultReadInputs;
  const contendedFullAvg10 =
    options.contendedFullAvg10 ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_CONTENDED_FULL_AVG10,
      DEFAULT_CONTENDED_FULL_AVG10,
    );
  const emergencyFullAvg10 =
    options.emergencyFullAvg10 ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_EMERGENCY_FULL_AVG10,
      DEFAULT_EMERGENCY_FULL_AVG10,
    );
  const recoveryFullAvg10 =
    options.recoveryFullAvg10 ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_RECOVERY_FULL_AVG10,
      DEFAULT_RECOVERY_FULL_AVG10,
    );
  const recoveryMs =
    options.recoveryMs ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_RECOVERY_MS,
      DEFAULT_RECOVERY_MS,
    );
  const contendedSamples =
    options.contendedSamples ??
    positiveInteger(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_CONTENDED_SAMPLES,
      DEFAULT_CONTENDED_SAMPLES,
    );
  const backgroundQuietMs =
    options.backgroundQuietMs ??
    positiveInteger(
      process.env.COCALC_PROJECT_HOST_STORAGE_BACKGROUND_QUIET_MS,
      DEFAULT_BACKGROUND_QUIET_MS,
    );

  let pressureState: HostStoragePressureState = "normal";
  let stateSince = now();
  let consecutiveContended = 0;
  let recoveryHealthySince: number | undefined;
  let transitionCount = 0;
  let lastTransitionReason: string | undefined;
  let lastInputs: StorageAdmissionInputs = {
    sampled_at_ms: stateSince,
    starting_projects: 0,
    stopping_projects: 0,
    btrfs_mutation_locks: 0,
    btrfs_mutation_waiters: 0,
  };
  let lastDecision: HostStorageAdmissionDecision | undefined;
  let lastLifecycleActiveAt: number | undefined;
  let admittedTotal = 0;
  let deferredTotal = 0;
  let observedDeferralTotal = 0;
  const activeByPriority = emptyActiveCounts();
  let starvationOverrideActive = false;

  const transition = (
    next: HostStoragePressureState,
    reason: string,
    at: number,
  ) => {
    if (next === pressureState) return;
    logger.info("storage pressure gate transition", {
      from: pressureState,
      to: next,
      reason,
      effective_io_full_avg10: effectiveIoFullAvg10(lastInputs),
      lifecycle_active:
        lastInputs.starting_projects + lastInputs.stopping_projects,
    });
    pressureState = next;
    stateSince = at;
    transitionCount += 1;
    lastTransitionReason = reason;
    options.onPressureStateChange?.(next);
  };

  const updateState = (inputs: StorageAdmissionInputs) => {
    const at = inputs.sampled_at_ms;
    const full = effectiveIoFullAvg10(inputs);
    const lifecycleActive = inputs.starting_projects + inputs.stopping_projects;
    if (full == null) {
      return;
    }
    if (full >= emergencyFullAvg10) {
      consecutiveContended = 0;
      recoveryHealthySince = undefined;
      transition("emergency", "io_full_emergency", at);
      return;
    }
    if (pressureState === "normal") {
      if (full >= contendedFullAvg10) {
        consecutiveContended += 1;
        if (consecutiveContended >= contendedSamples) {
          consecutiveContended = 0;
          transition("contended", "io_full_contended", at);
        }
      } else {
        consecutiveContended = 0;
      }
      return;
    }
    if (pressureState === "contended" || pressureState === "emergency") {
      if (full < contendedFullAvg10) {
        recoveryHealthySince =
          full < recoveryFullAvg10 && lifecycleActive === 0 ? at : undefined;
        transition("recovery", "io_pressure_below_enter_threshold", at);
      }
      return;
    }
    if (full >= contendedFullAvg10) {
      recoveryHealthySince = undefined;
      transition("contended", "io_pressure_recurred", at);
      return;
    }
    if (full < recoveryFullAvg10 && lifecycleActive === 0) {
      recoveryHealthySince ??= at;
      if (at - recoveryHealthySince >= recoveryMs) {
        recoveryHealthySince = undefined;
        transition("normal", "recovery_hysteresis_complete", at);
      }
    } else {
      recoveryHealthySince = undefined;
    }
  };

  const status = (): HostStorageAdmissionMetrics => {
    const effective = effectiveIoFullAvg10(lastInputs);
    const uncontained = uncontainedIoFullAvg10(
      lastInputs.host_io_full_avg10,
      lastInputs.project_pool_io_full_avg10,
      lastInputs.bees_io_full_avg10,
    );
    return {
      schema_version: 1,
      collected_at: iso(lastInputs.sampled_at_ms),
      mode,
      pressure_state: pressureState,
      state_since: iso(stateSince),
      ...(lastInputs.host_io_full_avg10 != null
        ? { host_io_full_avg10: lastInputs.host_io_full_avg10 }
        : {}),
      ...(lastInputs.project_pool_io_full_avg10 != null
        ? {
            project_pool_io_full_avg10: lastInputs.project_pool_io_full_avg10,
          }
        : {}),
      ...(lastInputs.bees_io_full_avg10 != null
        ? { bees_io_full_avg10: lastInputs.bees_io_full_avg10 }
        : {}),
      ...(uncontained != null
        ? { uncontained_io_full_avg10: uncontained }
        : {}),
      ...(effective != null ? { effective_io_full_avg10: effective } : {}),
      lifecycle_active:
        lastInputs.starting_projects + lastInputs.stopping_projects,
      starting_projects: lastInputs.starting_projects,
      stopping_projects: lastInputs.stopping_projects,
      active_by_priority: { ...activeByPriority },
      btrfs_mutation_locks: lastInputs.btrfs_mutation_locks,
      btrfs_mutation_waiters: lastInputs.btrfs_mutation_waiters,
      admitted_total: admittedTotal,
      deferred_total: deferredTotal,
      observed_deferral_total: observedDeferralTotal,
      transition_count: transitionCount,
      ...(lastTransitionReason
        ? { last_transition_reason: lastTransitionReason }
        : {}),
      ...(lastDecision ? { last_decision: { ...lastDecision } } : {}),
      ...(lastInputs.error ? { sample_error: lastInputs.error } : {}),
    };
  };

  const sample = (): HostStorageAdmissionMetrics => {
    try {
      lastInputs = readInputs();
    } catch (err) {
      lastInputs = {
        ...lastInputs,
        sampled_at_ms: now(),
        error: `${err}`,
      };
    }
    updateState(lastInputs);
    if (lastInputs.starting_projects + lastInputs.stopping_projects > 0) {
      lastLifecycleActiveAt = lastInputs.sampled_at_ms;
    }
    return status();
  };

  const backgroundReason = (
    current: HostStorageAdmissionMetrics,
  ): string | undefined => {
    if (current.lifecycle_active > 0) {
      return "lifecycle_active";
    }
    if (
      lastLifecycleActiveAt != null &&
      now() - lastLifecycleActiveAt < backgroundQuietMs
    ) {
      return "lifecycle_settle";
    }
    if (current.sample_error) {
      return "io_pressure_unavailable";
    }
    if (current.pressure_state !== "normal") {
      return `io_pressure_${current.pressure_state}`;
    }
    return undefined;
  };

  const starvationOverrideAllowed = (
    current: HostStorageAdmissionMetrics,
    requested: boolean | undefined,
  ): boolean => {
    // Only the I/O hysteresis gate can be bypassed, never lifecycle settling,
    // unavailable samples, or emergency pressure, including during mutations.
    const reason = backgroundReason(current);
    return (
      requested === true &&
      (reason === "io_pressure_contended" || reason === "io_pressure_recovery")
    );
  };

  const backgroundDeferralReason = ({
    allow_starvation_override,
  }: {
    allow_starvation_override?: boolean;
  } = {}): string | undefined => {
    const current = sample();
    const reason = backgroundReason(current);
    return reason &&
      starvationOverrideAllowed(current, allow_starvation_override)
      ? undefined
      : reason;
  };

  const admit = ({
    operation_kind,
    project_id,
    allow_starvation_override,
  }: StorageAdmissionRequest): StorageAdmissionTicket => {
    const current = sample();
    const spec = getStorageOperationSpec(operation_kind);
    const background =
      spec.priority === "scheduled" || spec.priority === "scavenger";
    const reason = background
      ? starvationOverrideActive
        ? "maintenance_starvation_in_flight"
        : backgroundReason(current)
      : undefined;
    const wouldDefer = reason != null;
    const starvationOverride =
      mode === "enforce" &&
      background &&
      (operation_kind === "scheduled_backup" ||
        operation_kind === "scheduled_snapshot") &&
      wouldDefer &&
      !starvationOverrideActive &&
      activeByPriority.scheduled === 0 &&
      starvationOverrideAllowed(current, allow_starvation_override);
    const admitted = mode !== "enforce" || !wouldDefer || starvationOverride;
    if (admitted) {
      if (starvationOverride) starvationOverrideActive = true;
      admittedTotal += 1;
      activeByPriority[spec.priority] += 1;
    } else {
      deferredTotal += 1;
    }
    if (mode === "observe" && wouldDefer) {
      observedDeferralTotal += 1;
    }
    const decidedAt = now();
    lastDecision = {
      decided_at: iso(decidedAt),
      operation_kind,
      priority: spec.priority,
      ...(project_id ? { project_id } : {}),
      admitted,
      would_defer: wouldDefer,
      ...(reason ? { reason } : {}),
      pressure_state: current.pressure_state,
    };
    const operationId = randomUUID();
    let released = false;
    return {
      admitted,
      would_defer: wouldDefer,
      ...(reason ? { reason } : {}),
      starvation_override: starvationOverride,
      operation_id: operationId,
      release: () => {
        if (released || !admitted) return;
        released = true;
        if (starvationOverride) starvationOverrideActive = false;
        activeByPriority[spec.priority] = Math.max(
          0,
          activeByPriority[spec.priority] - 1,
        );
      },
    };
  };

  sample();
  return { sample, admit, backgroundDeferralReason, getStatus: status };
}

let activeController: StorageAdmissionController | undefined;
let activeTimer: ReturnType<typeof setInterval> | undefined;
let pressurePolicyQueue: Promise<void> = Promise.resolve();
let lastRequestedPressureMode: "normal" | "protect" | undefined;

function setProjectPoolPressurePolicy(state: HostStoragePressureState): void {
  const mode = state === "normal" ? "normal" : "protect";
  if (mode === lastRequestedPressureMode) return;
  lastRequestedPressureMode = mode;
  pressurePolicyQueue = pressurePolicyQueue
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve) => {
          execFile(
            "/usr/bin/sudo",
            ["-n", RUNTIME_STORAGE, "set-project-pool-pressure-mode", mode],
            { timeout: 5_000, maxBuffer: 1024 * 1024 },
            (err, _stdout, stderr) => {
              if (err) {
                logger.warn(
                  "failed to reconcile project pool pressure policy",
                  {
                    mode,
                    err: `${err}`,
                    stderr: `${stderr ?? ""}`.trim().slice(0, 2_000),
                  },
                );
                if (lastRequestedPressureMode === mode) {
                  lastRequestedPressureMode = undefined;
                  const retry = setTimeout(
                    () => setProjectPoolPressurePolicy(state),
                    5_000,
                  );
                  retry.unref?.();
                }
              }
              resolve();
            },
          );
        }),
    );
}

export function startStorageAdmissionController(): () => void {
  if (activeController) return () => {};
  activeController = createStorageAdmissionController({
    onPressureStateChange: setProjectPoolPressurePolicy,
  });
  configureBtrfsBackgroundMutationGuard((context) =>
    activeController?.backgroundDeferralReason({
      allow_starvation_override:
        (context.operation_class === "scheduled_backup" ||
          context.operation_class === "scheduled_snapshot") &&
        context.starvation_override,
    }),
  );
  // Reconcile even when the initial sample is normal; /run state may have
  // survived a project-host restart but not the controller's in-memory state.
  setProjectPoolPressurePolicy(activeController.getStatus().pressure_state);
  const sampleMs = positiveInteger(
    process.env.COCALC_PROJECT_HOST_STORAGE_IO_SAMPLE_MS,
    DEFAULT_SAMPLE_MS,
  );
  activeTimer = setInterval(() => activeController?.sample(), sampleMs);
  activeTimer.unref?.();
  logger.info("storage admission controller started", {
    mode: activeController.getStatus().mode,
    sample_ms: sampleMs,
  });
  return () => {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = undefined;
    configureBtrfsBackgroundMutationGuard(undefined);
    activeController = undefined;
    lastRequestedPressureMode = undefined;
  };
}

function controller(): StorageAdmissionController {
  if (!activeController) {
    activeController = createStorageAdmissionController({
      onPressureStateChange: setProjectPoolPressurePolicy,
    });
    setProjectPoolPressurePolicy(activeController.getStatus().pressure_state);
  }
  return activeController;
}

export function admitStorageOperation(
  request: StorageAdmissionRequest,
): StorageAdmissionTicket {
  return controller().admit(request);
}

export function getStorageAdmissionStatus():
  | HostStorageAdmissionMetrics
  | undefined {
  return activeController?.getStatus();
}

export function resetStorageAdmissionControllerForTest(): void {
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = undefined;
  configureBtrfsBackgroundMutationGuard(undefined);
  activeController = undefined;
}

export const _test = {
  configuredMode,
  maxDefined,
};
