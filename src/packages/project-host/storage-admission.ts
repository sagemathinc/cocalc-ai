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
const MAINTENANCE_IO_PRESSURE = "/sys/fs/cgroup/cocalc-maintenance/io.pressure";
const MAINTENANCE_IO_MAX = "/sys/fs/cgroup/cocalc-maintenance/io.max";
const MAINTENANCE_IO_STAT = "/sys/fs/cgroup/cocalc-maintenance/io.stat";
const DISKSTATS = "/proc/diskstats";
// Busy fraction below which a disk counts as idle for attributing a
// maintenance stall to its own io.max throttle.
const DEFAULT_MAINTENANCE_IDLE_UTILIZATION = 0.5;
const RUNTIME_STORAGE = "/usr/local/sbin/cocalc-runtime-storage";
const DEFAULT_SAMPLE_MS = 5_000;
const DEFAULT_CONTENDED_FULL_AVG10 = 5;
const DEFAULT_EMERGENCY_FULL_AVG10 = 10;
// Recovery ends after RECOVERY_MS below this, by default half the contended
// threshold. It was 1% with no project starting or stopping, which busy hosts
// (1-2% background stall, constant lifecycle) never met: they sat in
// recovery for hours, deferring scheduled snapshots and backups.
const DEFAULT_RECOVERY_FRACTION_OF_CONTENDED = 0.5;
const DEFAULT_RECOVERY_MS = 60_000;
// In recovery, scheduled snapshots (short btrfs metadata operations) are
// admitted at this pace instead of waiting for the next starvation override.
const DEFAULT_RECOVERY_SNAPSHOT_INTERVAL_MS = 20_000;
// Consecutive samples, at least MIN_STATE_SAMPLE_MS apart, that every
// escalation (to contended, back to contended from recovery, to emergency)
// needs: a single stall burst (a SQLite checkpoint, a btrfs commit) must not
// defer background work for the whole recovery interval.
const DEFAULT_CONTENDED_SAMPLES = 2;
// Admission checks sample too (for fresh lifecycle counts); only samples at
// least this far apart move the pressure state. Below the 5 s timer, for its
// jitter.
const DEFAULT_MIN_STATE_SAMPLE_MS = 4_000;
// And at least this long since the first of those samples: the count alone
// depends on when the samples fall (the timer's phase, admission checks).
const DEFAULT_ESCALATION_MS = 10_000;
// Disk activity is compared over at least this long (maintenance stalls on
// idle disks), not over the milliseconds between two admission checks.
const MIN_DISK_ACTIVITY_INTERVAL_MS = 1_000;
const DEFAULT_BACKGROUND_QUIET_MS = 2_000;

type StorageAdmissionInputs = {
  sampled_at_ms: number;
  host_io_full_avg10?: number;
  project_pool_io_full_avg10?: number;
  bees_io_full_avg10?: number;
  maintenance_io_full_avg10?: number;
  // the same, averaged over 60 s: sustained pressure made of bursts
  host_io_full_avg60?: number;
  project_pool_io_full_avg60?: number;
  bees_io_full_avg60?: number;
  maintenance_io_full_avg60?: number;
  // Whether cocalc-maintenance has a finite io.max. Only then is its stall
  // the throttle's own doing rather than real disk contention.
  maintenance_io_capped?: boolean;
  // Whether every disk maintenance did I/O on during the last interval was
  // mostly idle. cgroup PSI covers all devices and directions, and the cap
  // covers only some (rustic's cache is on the uncapped root disk), so a cap
  // alone does not prove a stall is the throttle's doing; a stall while the
  // disks it uses are idle does.
  maintenance_disks_idle?: boolean;
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
  /** A scheduled snapshot may take the recovery pace slot (default true). */
  allow_recovery_pace?: boolean;
};

export type StorageAdmissionTicket = {
  admitted: boolean;
  would_defer: boolean;
  reason?: string;
  starvation_override: boolean;
  // A scheduled snapshot admitted at the recovery pace.
  recovery_paced: boolean;
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
  // Also require no project starting or stopping to leave recovery (the old
  // behavior). Background work waits for lifecycle separately anyway.
  recoveryRequiresQuietLifecycle?: boolean;
  // 0 disables paced snapshots in recovery.
  recoverySnapshotIntervalMs?: number;
  contendedSamples?: number;
  minStateSampleMs?: number;
  escalationMs?: number;
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

function readIoFull(path: string): { avg10?: number; avg60?: number } {
  try {
    const parsed = parseIoPressure(readFileSync(path, "utf8"));
    return { avg10: parsed.fullPercent, avg60: parsed.fullAvg60Percent };
  } catch {
    return {};
  }
}

// io.max lines are "<major:minor> rbps=<n|max> wbps=... riops=... wiops=...";
// a cleared limit is all "max" (or no line at all).
function ioMaxCapped(text: string): boolean {
  for (const line of text.split("\n")) {
    for (const field of line.trim().split(/\s+/).slice(1)) {
      const value = field.split("=")[1];
      if (value && value !== "max") return true;
    }
  }
  return false;
}

function readIoMaxCapped(path: string): boolean {
  try {
    return ioMaxCapped(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

type DiskActivity = {
  at_ms: number;
  // Per "major:minor": milliseconds the device was busy (diskstats io_ticks).
  busy_ms: Map<string, number>;
  // Per "major:minor": I/Os maintenance completed there (io.stat).
  maintenance_ios: Map<string, number>;
};

function parseDiskstatsBusyMs(text: string): Map<string, number> {
  const busy = new Map<string, number>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 13) continue;
    const ticks = Number(fields[12]);
    if (Number.isFinite(ticks)) busy.set(`${fields[0]}:${fields[1]}`, ticks);
  }
  return busy;
}

function parseIoStatIos(text: string): Map<string, number> {
  const ios = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [device, ...fields] = line.trim().split(/\s+/);
    if (!device || !fields.length) continue;
    let total = 0;
    for (const field of fields) {
      const [key, value] = field.split("=");
      if (key === "rios" || key === "wios" || key === "dios") {
        const n = Number(value);
        if (Number.isFinite(n)) total += n;
      }
    }
    ios.set(device, total);
  }
  return ios;
}

function readDiskActivity(now: number): DiskActivity | undefined {
  try {
    return {
      at_ms: now,
      busy_ms: parseDiskstatsBusyMs(readFileSync(DISKSTATS, "utf8")),
      maintenance_ios: parseIoStatIos(
        readFileSync(MAINTENANCE_IO_STAT, "utf8"),
      ),
    };
  } catch {
    return undefined;
  }
}

// True only when maintenance did I/O in the interval and every device it used
// was busy less than maxUtilization of the time. Unknown means false, so the
// stall keeps counting as host pressure.
function maintenanceStallOnIdleDisks(
  previous: DiskActivity | undefined,
  next: DiskActivity | undefined,
  maxUtilization: number,
): boolean {
  if (!previous || !next) return false;
  const elapsed = next.at_ms - previous.at_ms;
  if (!(elapsed > 0)) return false;
  let used = 0;
  for (const [device, ios] of next.maintenance_ios) {
    if (ios - (previous.maintenance_ios.get(device) ?? 0) <= 0) continue;
    used++;
    const before = previous.busy_ms.get(device);
    const after = next.busy_ms.get(device);
    if (before == null || after == null) return false;
    if ((after - before) / elapsed >= maxUtilization) return false;
  }
  return used > 0;
}

let lastDiskActivity: DiskActivity | undefined;
let lastDisksIdle = false;

function readMaintenanceDisksIdle(): boolean {
  const at = Date.now();
  if (
    lastDiskActivity != null &&
    at - lastDiskActivity.at_ms < MIN_DISK_ACTIVITY_INTERVAL_MS
  ) {
    return lastDisksIdle;
  }
  const next = readDiskActivity(at);
  const idle = maintenanceStallOnIdleDisks(
    lastDiskActivity,
    next,
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_MAINTENANCE_IDLE_UTILIZATION,
      DEFAULT_MAINTENANCE_IDLE_UTILIZATION,
    ),
  );
  lastDiskActivity = next;
  lastDisksIdle = idle;
  return idle;
}

function defaultReadInputs(): StorageAdmissionInputs {
  const projectCounts = countProjectsByStates(["starting", "stopping"]);
  const locks = getBtrfsMutationLockStatus();
  const host = readIoFull("/proc/pressure/io");
  const pool = readIoFull(PROJECT_POOL_IO_PRESSURE);
  const bees = readIoFull(BEES_IO_PRESSURE);
  const maintenance = readIoFull(MAINTENANCE_IO_PRESSURE);
  const hostIoFullAvg10 = host.avg10;
  return {
    sampled_at_ms: Date.now(),
    host_io_full_avg10: hostIoFullAvg10,
    project_pool_io_full_avg10: pool.avg10,
    bees_io_full_avg10: bees.avg10,
    maintenance_io_full_avg10: maintenance.avg10,
    host_io_full_avg60: host.avg60,
    project_pool_io_full_avg60: pool.avg60,
    bees_io_full_avg60: bees.avg60,
    maintenance_io_full_avg60: maintenance.avg60,
    maintenance_io_capped: readIoMaxCapped(MAINTENANCE_IO_MAX),
    maintenance_disks_idle: readMaintenanceDisksIdle(),
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

// A maintenance stall is discounted only with a finite cap AND idle disks:
// without a cap (I/O policy disabled or observe), or while a disk it uses is
// busy (e.g. rustic's cache on the uncapped root disk), it is real contention
// and must count as host pressure.
function throttledMaintenanceIoFullAvg10(
  inputs: StorageAdmissionInputs,
): number | undefined {
  return inputs.maintenance_io_capped && inputs.maintenance_disks_idle
    ? inputs.maintenance_io_full_avg10
    : undefined;
}

function uncontainedIoFullAvg10(
  inputs: StorageAdmissionInputs,
): number | undefined {
  const host = inputs.host_io_full_avg10;
  if (host == null || !Number.isFinite(host)) return undefined;
  // Root PSI includes project-pool stalls caused by our own io.max limits,
  // BEES workers waiting on their expected background reads, and backups or
  // snapshots stalled by the maintenance cgroup's io.max throttle. None of
  // these should be counted again as uncontained pressure. The maximum is used
  // because cgroup PSI intervals can overlap and therefore are not additive.
  return Math.max(
    0,
    host -
      (maxDefined(
        inputs.project_pool_io_full_avg10,
        inputs.bees_io_full_avg10,
        throttledMaintenanceIoFullAvg10(inputs),
      ) ?? 0),
  );
}

function effectiveIoFullAvg10(
  inputs: StorageAdmissionInputs,
): number | undefined {
  // A throttled BEES or maintenance task stalls on its own io.max limit even
  // on an idle disk; that wait is the containment working, not contention.
  const background = maxDefined(
    inputs.bees_io_full_avg10,
    throttledMaintenanceIoFullAvg10(inputs),
  );
  if (background == null) {
    return maxDefined(
      inputs.host_io_full_avg10,
      inputs.project_pool_io_full_avg10,
    );
  }
  return maxDefined(
    inputs.project_pool_io_full_avg10,
    inputs.host_io_full_avg10 == null
      ? undefined
      : Math.max(0, inputs.host_io_full_avg10 - background),
  );
}

// effectiveIoFullAvg10 over the 60 s averages
function effectiveIoFullAvg60(
  inputs: StorageAdmissionInputs,
): number | undefined {
  return effectiveIoFullAvg10({
    ...inputs,
    host_io_full_avg10: inputs.host_io_full_avg60,
    project_pool_io_full_avg10: inputs.project_pool_io_full_avg60,
    bees_io_full_avg10: inputs.bees_io_full_avg60,
    maintenance_io_full_avg10: inputs.maintenance_io_full_avg60,
  });
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
      contendedFullAvg10 * DEFAULT_RECOVERY_FRACTION_OF_CONTENDED,
    );
  const recoveryRequiresQuietLifecycle =
    options.recoveryRequiresQuietLifecycle ??
    process.env
      .COCALC_PROJECT_HOST_STORAGE_RECOVERY_REQUIRES_QUIET_LIFECYCLE === "1";
  const recoverySnapshotIntervalMs =
    options.recoverySnapshotIntervalMs ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_RECOVERY_SNAPSHOT_INTERVAL_MS,
      DEFAULT_RECOVERY_SNAPSHOT_INTERVAL_MS,
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
  const minStateSampleMs =
    options.minStateSampleMs ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_MIN_STATE_SAMPLE_MS,
      DEFAULT_MIN_STATE_SAMPLE_MS,
    );
  const escalationMs =
    options.escalationMs ??
    finiteNonNegative(
      process.env.COCALC_PROJECT_HOST_STORAGE_IO_ESCALATION_MS,
      DEFAULT_ESCALATION_MS,
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
  let consecutiveEmergency = 0;
  // when the current run of samples at/above each threshold began
  let contendedSince: number | undefined;
  let emergencySince: number | undefined;
  let lastStateSampleAt: number | undefined;
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
  let recoveryPacedActive = false;
  // One start clock for every scheduled snapshot admitted in recovery,
  // paced or starvation override, so together they keep the pace.
  let lastRecoverySnapshotAt: number | undefined;
  let recoveryPacedTotal = 0;
  let starvationOverrideTotal = 0;
  const deferredByReason: Record<string, number> = {};
  // Time spent in each pressure state, so how long a host sits in recovery
  // shows in its metrics.
  const stateMsTotal: Record<HostStoragePressureState, number> = {
    normal: 0,
    contended: 0,
    recovery: 0,
    emergency: 0,
  };
  const recoveryHealthy = (full: number, lifecycleActive: number) =>
    full < recoveryFullAvg10 &&
    (!recoveryRequiresQuietLifecycle || lifecycleActive === 0);

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
      effective_io_full_avg60: effectiveIoFullAvg60(lastInputs),
      lifecycle_active:
        lastInputs.starting_projects + lastInputs.stopping_projects,
    });
    stateMsTotal[pressureState] += Math.max(0, at - stateSince);
    pressureState = next;
    stateSince = at;
    transitionCount += 1;
    lastTransitionReason = reason;
    options.onPressureStateChange?.(next);
  };

  // No reading is no evidence: a run of high samples must be unbroken.
  const resetEscalation = () => {
    consecutiveContended = 0;
    consecutiveEmergency = 0;
    contendedSince = undefined;
    emergencySince = undefined;
  };

  const updateState = (inputs: StorageAdmissionInputs) => {
    const at = inputs.sampled_at_ms;
    const full = effectiveIoFullAvg10(inputs);
    const lifecycleActive = inputs.starting_projects + inputs.stopping_projects;
    // (a sample marked unavailable, e.g. no host PSI, is none, even if a
    // cgroup's PSI still gives a number)
    if (full == null || inputs.error) {
      resetEscalation();
      return;
    }
    // The 60 s average too: pressure made of bursts that never stay above a
    // threshold for consecutive 10 s averages is still sustained pressure.
    // It also holds contended/emergency until it is down too, so the gate
    // does not bounce between recovery and contended while it decays.
    const pressure = Math.max(full, effectiveIoFullAvg60(inputs) ?? 0);
    // Any fresh reading below a threshold ends that run, also between
    // state samples: a run must be unbroken.
    if (pressure < emergencyFullAvg10) {
      consecutiveEmergency = 0;
      emergencySince = undefined;
    }
    if (pressure < contendedFullAvg10) {
      consecutiveContended = 0;
      contendedSince = undefined;
    }
    // Admission checks sample as often as operations come (for fresh
    // lifecycle counts), so consecutive samples could be milliseconds apart
    // and read the same 10 s average: only samples at least
    // minStateSampleMs apart count, or move the state.
    if (
      lastStateSampleAt != null &&
      at - lastStateSampleAt < minStateSampleMs
    ) {
      return;
    }
    lastStateSampleAt = at;
    if (pressure >= emergencyFullAvg10) {
      consecutiveEmergency += 1;
      emergencySince ??= at;
    }
    if (pressure >= contendedFullAvg10) {
      consecutiveContended += 1;
      contendedSince ??= at;
    }
    const sustained = (count: number, since: number | undefined) =>
      count >= contendedSamples && since != null && at - since >= escalationMs;
    const emergencySustained = sustained(consecutiveEmergency, emergencySince);
    const contendedSustained = sustained(consecutiveContended, contendedSince);
    if (emergencySustained) {
      recoveryHealthySince = undefined;
      transition("emergency", "io_full_emergency", at);
      return;
    }
    if (pressureState === "normal") {
      if (contendedSustained) {
        transition("contended", "io_full_contended", at);
      }
      return;
    }
    if (pressureState === "contended" || pressureState === "emergency") {
      if (pressure < contendedFullAvg10) {
        recoveryHealthySince = recoveryHealthy(full, lifecycleActive)
          ? at
          : undefined;
        transition("recovery", "io_pressure_below_enter_threshold", at);
      }
      return;
    }
    if (contendedSustained) {
      recoveryHealthySince = undefined;
      transition("contended", "io_pressure_recurred", at);
      return;
    }
    // (recovery health is the 10 s average, as before: the 60 s one would
    // keep a host in recovery for minutes after a burst)
    if (
      pressure < contendedFullAvg10 &&
      recoveryHealthy(full, lifecycleActive)
    ) {
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
    const uncontained = uncontainedIoFullAvg10(lastInputs);
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
      ...(lastInputs.maintenance_io_full_avg10 != null
        ? {
            maintenance_io_full_avg10: lastInputs.maintenance_io_full_avg10,
          }
        : {}),
      ...(lastInputs.maintenance_io_capped != null
        ? { maintenance_io_capped: lastInputs.maintenance_io_capped }
        : {}),
      ...(lastInputs.maintenance_disks_idle != null
        ? { maintenance_disks_idle: lastInputs.maintenance_disks_idle }
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
      state_ms_total: {
        ...stateMsTotal,
        [pressureState]:
          stateMsTotal[pressureState] +
          Math.max(0, lastInputs.sampled_at_ms - stateSince),
      },
      recovery_paced_total: recoveryPacedTotal,
      ...(mode === "enforce" &&
      recoverySnapshotIntervalMs > 0 &&
      pressureState === "recovery"
        ? {
            recovery_snapshot_next_at: iso(
              lastRecoverySnapshotAt == null
                ? lastInputs.sampled_at_ms
                : lastRecoverySnapshotAt + recoverySnapshotIntervalMs,
            ),
          }
        : {}),
      starvation_override_total: starvationOverrideTotal,
      deferred_by_reason: { ...deferredByReason },
      ...(lastTransitionReason
        ? { last_transition_reason: lastTransitionReason }
        : {}),
      ...(lastDecision ? { last_decision: { ...lastDecision } } : {}),
      ...(lastInputs.error ? { sample_error: lastInputs.error } : {}),
    };
  };

  const sample = (): HostStorageAdmissionMetrics => {
    let read = true;
    try {
      lastInputs = readInputs();
    } catch (err) {
      // (background work stays deferred on the error; the previous
      // pressure values must not count as a new sample)
      read = false;
      lastInputs = {
        ...lastInputs,
        sampled_at_ms: now(),
        error: `${err}`,
      };
    }
    if (read) {
      updateState(lastInputs);
    } else {
      resetEscalation();
    }
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
    allow_recovery_pace = true,
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
    const decidedAtMs = now();
    const recoverySnapshot =
      operation_kind === "scheduled_snapshot" &&
      reason === "io_pressure_recovery" &&
      recoverySnapshotIntervalMs > 0;
    // The caller decides which snapshot gets the recovery slot (the one that
    // has waited longest); others wait, as overrides too.
    const recoverySnapshotDue =
      allow_recovery_pace &&
      (lastRecoverySnapshotAt == null ||
        decidedAtMs - lastRecoverySnapshotAt >= recoverySnapshotIntervalMs);
    const starvationOverride =
      mode === "enforce" &&
      background &&
      (operation_kind === "scheduled_backup" ||
        operation_kind === "scheduled_snapshot") &&
      wouldDefer &&
      !starvationOverrideActive &&
      activeByPriority.scheduled === 0 &&
      // An overdue snapshot in recovery also waits for the recovery pace.
      (!recoverySnapshot || recoverySnapshotDue) &&
      starvationOverrideAllowed(current, allow_starvation_override);
    // Scheduled snapshots keep flowing in recovery, one at a time at a
    // steady pace; never in contended or emergency, nor past lifecycle gates.
    const recoveryPaced =
      mode === "enforce" &&
      recoverySnapshot &&
      !starvationOverride &&
      !recoveryPacedActive &&
      // Never alongside other scheduled storage work, e.g. a backup admitted
      // before the host entered recovery (as for starvation overrides).
      activeByPriority.scheduled === 0 &&
      recoverySnapshotDue;
    const admitted =
      mode !== "enforce" || !wouldDefer || starvationOverride || recoveryPaced;
    if (admitted) {
      if (starvationOverride) {
        starvationOverrideActive = true;
        starvationOverrideTotal += 1;
      }
      if (recoveryPaced) {
        recoveryPacedActive = true;
        recoveryPacedTotal += 1;
      }
      if (recoverySnapshot && (recoveryPaced || starvationOverride)) {
        lastRecoverySnapshotAt = decidedAtMs;
      }
      admittedTotal += 1;
      activeByPriority[spec.priority] += 1;
    } else {
      deferredTotal += 1;
      if (reason)
        deferredByReason[reason] = (deferredByReason[reason] ?? 0) + 1;
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
      recovery_paced: recoveryPaced,
      operation_id: operationId,
      release: () => {
        if (released || !admitted) return;
        released = true;
        if (starvationOverride) starvationOverrideActive = false;
        if (recoveryPaced) recoveryPacedActive = false;
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
  ioMaxCapped,
  parseDiskstatsBusyMs,
  parseIoStatIos,
  maintenanceStallOnIdleDisks,
  maxDefined,
};
