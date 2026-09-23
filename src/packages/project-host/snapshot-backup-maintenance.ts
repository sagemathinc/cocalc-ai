import * as fs from "node:fs";

import getLogger from "@cocalc/backend/logger";
import {
  createHostStatusClient,
  type HostProjectMaintenanceSchedule,
  type ProjectMaintenanceReport,
} from "@cocalc/conat/project-host/api";
import {
  BtrfsMutationDeferredError,
  withBtrfsMutationContext,
} from "@cocalc/file-server/btrfs/operation-cache";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  SNAPSHOT_INTERVALS_MS,
  type SnapshotCounts,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { getMasterConatClient } from "./master-status";
import {
  runScheduledBackupMaintenance,
  runScheduledSnapshotMaintenance,
} from "./file-server";
import {
  admitStorageOperation,
  getStorageAdmissionStatus,
} from "./storage-admission";
import type { StorageOperationKind } from "./storage-operation-registry";
import { orderProjectMaintenance } from "./maintenance-priority";
import {
  listPendingMaintenanceReports,
  markMaintenanceReportDelivered,
  saveMaintenanceReport,
} from "./sqlite/maintenance-ledger";

const logger = getLogger("project-host:snapshot-backup-maintenance");

const DEFAULT_ACTIVE_DAYS = 2;
const DEFAULT_SWEEP_MS = 15 * 60 * 1000;
// Btrfs metadata discovery is filesystem-wide enough that concurrent project
// scans amplify latency without increasing useful mutation throughput (the
// mutation lock is global). Operators can raise this only after qualification.
const DEFAULT_PARALLELISM = 1;
const DEFAULT_INITIAL_DELAY_MS = DEFAULT_SWEEP_MS;
const DEFAULT_CANDIDATE_LIMIT = 250;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_STARVATION_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STARVATION_OVERRIDES_PER_SWEEP = 1;
const MAX_STARVATION_OVERRIDES_PER_SWEEP = 4;
const GIB = 1024 ** 3;
const DEFAULT_MEMORY_AVAILABLE_RATIO = 0.25;
const DEFAULT_MEMORY_AVAILABLE_MIN_BYTES = 2 * GIB;
const DEFAULT_MEMORY_AVAILABLE_MAX_BYTES = 16 * GIB;
const DEFAULT_MEMORY_AVAILABLE_HARD_MIN_BYTES = 4 * GIB;
const DEFAULT_MEMORY_PSI_FULL_AVG10_MAX = 5;

const inFlightSnapshots = new Set<string>();
const inFlightBackups = new Set<string>();
let snapshotLaneRunning = false;
let backupLaneRunning = false;
let scheduleListing: Promise<HostProjectMaintenanceSchedule[]> | undefined;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseRatio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1
    ? parsed
    : fallback;
}

function parseMeminfo(text: string):
  | {
      totalBytes: number;
      availableBytes: number;
    }
  | undefined {
  let totalKb: number | undefined;
  let availableKb: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (match[1] === "MemTotal") totalKb = value;
    if (match[1] === "MemAvailable") availableKb = value;
  }
  if (totalKb == null || availableKb == null || totalKb <= 0) {
    return undefined;
  }
  return {
    totalBytes: totalKb * 1024,
    availableBytes: availableKb * 1024,
  };
}

function memoryMaintenanceThresholdBytes(totalBytes: number): number {
  const ratio = parseRatio(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MIN_MEMORY_AVAILABLE_RATIO,
    DEFAULT_MEMORY_AVAILABLE_RATIO,
  );
  const minBytes = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MIN_MEMORY_AVAILABLE_BYTES,
    DEFAULT_MEMORY_AVAILABLE_MIN_BYTES,
  );
  const maxBytes = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MAX_MEMORY_AVAILABLE_BYTES,
    DEFAULT_MEMORY_AVAILABLE_MAX_BYTES,
  );
  const ratioBytes = Math.floor(totalBytes * ratio);
  return Math.min(Math.max(minBytes, ratioBytes), maxBytes);
}

function parsePressureFullAvg10(text: string): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("full ")) continue;
    const match = line.match(/\bavg10=([0-9.]+)/);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

function readMemoryPressure(): string | undefined {
  try {
    return fs.readFileSync("/proc/pressure/memory", "utf8");
  } catch {
    return undefined;
  }
}

function maintenanceMemoryDecision({
  configuredParallelism,
  meminfoText = fs.readFileSync("/proc/meminfo", "utf8"),
  pressureText = readMemoryPressure(),
}: {
  configuredParallelism: number;
  meminfoText?: string;
  pressureText?: string;
}):
  | {
      skip: false;
      parallelism: number;
      availableBytes?: number;
      preferredBytes?: number;
      hardMinBytes?: number;
      pressureFullAvg10?: number;
    }
  | {
      skip: true;
      reason: "available_memory" | "memory_pressure";
      availableBytes?: number;
      preferredBytes?: number;
      hardMinBytes?: number;
      pressureFullAvg10?: number;
    } {
  const memory = parseMeminfo(meminfoText);
  if (!memory) {
    return { skip: false, parallelism: configuredParallelism };
  }
  const preferredBytes = memoryMaintenanceThresholdBytes(memory.totalBytes);
  // A zero preferred threshold is the documented escape hatch used by tests
  // and constrained development hosts to disable the memory guard.
  if (preferredBytes <= 0) {
    return {
      skip: false,
      parallelism: configuredParallelism,
      availableBytes: memory.availableBytes,
      preferredBytes,
      hardMinBytes: 0,
    };
  }
  const hardMinBytes = Math.min(
    preferredBytes,
    parseNonNegativeInteger(
      process.env
        .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_HARD_MIN_MEMORY_AVAILABLE_BYTES,
      DEFAULT_MEMORY_AVAILABLE_HARD_MIN_BYTES,
    ),
  );
  const pressureFullAvg10 = pressureText
    ? parsePressureFullAvg10(pressureText)
    : undefined;
  const pressureMax = Number(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_MEMORY_PSI_FULL_AVG10_MAX,
  );
  const effectivePressureMax =
    Number.isFinite(pressureMax) && pressureMax >= 0
      ? pressureMax
      : DEFAULT_MEMORY_PSI_FULL_AVG10_MAX;
  if (
    pressureFullAvg10 != null &&
    effectivePressureMax > 0 &&
    pressureFullAvg10 >= effectivePressureMax
  ) {
    return {
      skip: true,
      reason: "memory_pressure",
      availableBytes: memory.availableBytes,
      preferredBytes,
      hardMinBytes,
      pressureFullAvg10,
    };
  }
  if (memory.availableBytes < hardMinBytes) {
    return {
      skip: true,
      reason: "available_memory",
      availableBytes: memory.availableBytes,
      preferredBytes,
      hardMinBytes,
      pressureFullAvg10,
    };
  }
  return {
    skip: false,
    parallelism:
      memory.availableBytes < preferredBytes ? 1 : configuredParallelism,
    availableBytes: memory.availableBytes,
    preferredBytes,
    hardMinBytes,
    pressureFullAvg10,
  };
}

function mergeSchedule(
  defaults: SnapshotCounts,
  schedule: SnapshotSchedule | null | undefined,
): SnapshotSchedule {
  return {
    ...defaults,
    ...(schedule ?? {}),
  };
}

function scheduleToCounts(
  schedule: SnapshotSchedule,
  { allowFrequent = true }: { allowFrequent?: boolean } = {},
): SnapshotCounts {
  return {
    frequent: allowFrequent ? schedule.frequent : 0,
    daily: schedule.daily,
    weekly: schedule.weekly,
    monthly: schedule.monthly,
  };
}

async function runWithParallelism<T>(
  items: T[],
  parallelism: number,
  worker: (item: T) => Promise<void>,
) {
  let index = 0;
  const width = Math.max(1, parallelism);
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) {
          return;
        }
        await worker(items[current]);
      }
    }),
  );
}

async function runScheduledStorageOperation({
  hostId,
  project_id,
  operation_kind,
  allowStarvationOverride = false,
  run,
}: {
  hostId: string;
  project_id: string;
  operation_kind: Extract<
    StorageOperationKind,
    "scheduled_snapshot" | "scheduled_backup"
  >;
  allowStarvationOverride?: boolean;
  run: () => Promise<void>;
}): Promise<{ ran: boolean; starvationOverride: boolean; reason?: string }> {
  const ticket = admitStorageOperation({
    operation_kind,
    project_id,
    allow_starvation_override: allowStarvationOverride,
  });
  if (!ticket.admitted) {
    logger.info("deferring scheduled project storage operation", {
      hostId,
      project_id,
      operation_kind,
      reason: ticket.reason,
    });
    return { ran: false, starvationOverride: false, reason: ticket.reason };
  }
  if (ticket.starvation_override) {
    logger.info("admitting overdue backup maintenance at low priority", {
      hostId,
      project_id,
      operation_kind,
      reason: ticket.reason,
    });
  }
  if (ticket.would_defer) {
    logger.info("scheduled project storage operation would be deferred", {
      hostId,
      project_id,
      operation_kind,
      reason: ticket.reason,
      admission_mode: "observe",
    });
  }
  try {
    try {
      await withBtrfsMutationContext(
        {
          operation_id: ticket.operation_id,
          project_id,
          priority: "scheduled",
          operation_class: operation_kind,
          cgroup_path: "/sys/fs/cgroup/cocalc-maintenance",
          checkpointable: true,
          starvation_override: ticket.starvation_override,
        },
        run,
      );
      return {
        ran: true,
        starvationOverride: ticket.starvation_override,
      };
    } catch (err) {
      if (!(err instanceof BtrfsMutationDeferredError)) throw err;
      logger.info("deferred scheduled storage operation at mutation boundary", {
        hostId,
        project_id,
        operation_kind,
        reason: err.reason,
      });
      return { ran: false, starvationOverride: false, reason: err.reason };
    }
  } finally {
    ticket.release();
  }
}

function parseTimestampMs(
  value: string | null | undefined,
): number | undefined {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function backupIsStarved({
  backupDueSince,
  nowMs = Date.now(),
  starvationAgeMs,
}: {
  backupDueSince: string | null | undefined;
  nowMs?: number;
  starvationAgeMs: number;
}): boolean {
  const dueSinceMs = parseTimestampMs(backupDueSince);
  return dueSinceMs != null && nowMs - dueSinceMs >= starvationAgeMs;
}

function backupDueAt(
  row: { backup_due_since?: string | null; last_backup?: string | null },
  schedule: SnapshotSchedule,
): number | undefined {
  const changedAt = parseTimestampMs(row.backup_due_since);
  if (changedAt == null) return undefined;
  const intervals = (
    Object.keys(SNAPSHOT_INTERVALS_MS) as Array<keyof SnapshotCounts>
  )
    .filter((kind) => kind !== "frequent" && schedule[kind] > 0)
    .map((kind) => SNAPSHOT_INTERVALS_MS[kind]);
  if (!intervals.length) return undefined;
  const lastBackup = parseTimestampMs(row.last_backup);
  return lastBackup == null
    ? changedAt
    : Math.max(changedAt, lastBackup + Math.min(...intervals));
}

function snapshotDueAt(
  row: HostProjectMaintenanceSchedule,
  schedule: SnapshotSchedule,
): number | undefined {
  const changedAt = parseTimestampMs(row.last_changed ?? row.last_edited);
  if (changedAt == null) return undefined;
  const reconciledChangeAt = parseTimestampMs(
    row.snapshot_reconciled_change_at,
  );
  if (
    reconciledChangeAt != null &&
    changedAt <= reconciledChangeAt &&
    row.snapshot_schedule_revision != null &&
    row.snapshot_schedule_revision === row.snapshot_reconciled_schedule_revision
  ) {
    return undefined;
  }
  const lastSnapshot = parseTimestampMs(row.last_snapshot);
  if (lastSnapshot != null && changedAt <= lastSnapshot) return undefined;
  const intervals = (
    Object.keys(SNAPSHOT_INTERVALS_MS) as Array<keyof SnapshotCounts>
  )
    .filter((kind) => schedule[kind] > 0)
    .map((kind) => SNAPSHOT_INTERVALS_MS[kind]);
  if (!intervals.length) return undefined;
  return lastSnapshot == null
    ? changedAt
    : Math.max(changedAt, lastSnapshot + Math.min(...intervals));
}

function retryAt(
  outcome: "succeeded" | "deferred" | "failed" | "skipped",
  failures: number,
): string | null {
  if (outcome === "succeeded" || outcome === "skipped") return null;
  const base =
    outcome === "deferred"
      ? 60_000
      : Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(failures, 7));
  return new Date(
    Date.now() + Math.floor(base * (0.8 + Math.random() * 0.4)),
  ).toISOString();
}

async function runProjectSnapshotBackupMaintenanceSweepUnlocked({
  hostId,
}: {
  hostId: string;
}) {
  const admission = getStorageAdmissionStatus();
  const sweepRestricted =
    admission?.mode === "enforce" &&
    (admission.lifecycle_active > 0 || admission.pressure_state !== "normal");
  const starvationOverrideEligible =
    admission == null ||
    (admission.pressure_state !== "emergency" && !admission.sample_error);
  if (sweepRestricted) {
    logger.info("restricting snapshot/backup maintenance sweep", {
      hostId,
      lifecycle_active: admission.lifecycle_active,
      pressure_state: admission.pressure_state,
      policy: "overdue-backup-only",
    });
  }
  const configuredParallelism = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_PARALLELISM,
    DEFAULT_PARALLELISM,
  );
  const memoryDecision = maintenanceMemoryDecision({ configuredParallelism });
  if (memoryDecision.skip) {
    logger.info("skipping snapshot/backup maintenance under memory pressure", {
      hostId,
      reason: memoryDecision.reason,
      memory_available_bytes: memoryDecision.availableBytes,
      preferred_bytes: memoryDecision.preferredBytes,
      hard_min_bytes: memoryDecision.hardMinBytes,
      memory_psi_full_avg10: memoryDecision.pressureFullAvg10,
    });
    return;
  }
  const client = getMasterConatClient();
  if (!client) {
    logger.debug("skipping maintenance sweep without master conat client");
    return;
  }
  const statusClient = createHostStatusClient({
    client,
    timeout: 60_000,
  });
  const report = async (value: ProjectMaintenanceReport) => {
    saveMaintenanceReport(value);
    await statusClient.reportProjectMaintenance(value);
    markMaintenanceReportDelivered(value);
  };
  for (const pending of listPendingMaintenanceReports()) {
    try {
      await statusClient.reportProjectMaintenance(pending);
      markMaintenanceReportDelivered(pending);
    } catch (err) {
      logger.warn("maintenance status replay paused", { hostId, err });
      break;
    }
  }
  const activeDays = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_MAINTENANCE_ACTIVE_DAYS,
    DEFAULT_ACTIVE_DAYS,
  );
  const candidateLimit = Math.min(
    MAX_CANDIDATE_LIMIT,
    parsePositiveInteger(
      process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_CANDIDATE_LIMIT,
      DEFAULT_CANDIDATE_LIMIT,
    ),
  );
  const starvationAgeMs = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_STARVATION_AGE_MS,
    DEFAULT_STARVATION_AGE_MS,
  );
  const starvationOverrideLimit = Math.min(
    MAX_STARVATION_OVERRIDES_PER_SWEEP,
    parsePositiveInteger(
      process.env
        .COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_STARVATION_OVERRIDES_PER_SWEEP,
      DEFAULT_STARVATION_OVERRIDES_PER_SWEEP,
    ),
  );
  const parallelism = memoryDecision.parallelism;
  if (parallelism < configuredParallelism) {
    logger.info("reducing snapshot/backup maintenance parallelism", {
      hostId,
      configured_parallelism: configuredParallelism,
      effective_parallelism: parallelism,
      memory_available_bytes: memoryDecision.availableBytes,
      preferred_bytes: memoryDecision.preferredBytes,
      hard_min_bytes: memoryDecision.hardMinBytes,
    });
  }
  const listing =
    scheduleListing ??
    (async () => {
      const rows: HostProjectMaintenanceSchedule[] = [];
      let cursor_project_id: string | undefined;
      while (true) {
        const page = await statusClient.listProjectMaintenanceSchedules({
          host_id: hostId,
          active_days: activeDays,
          limit: candidateLimit,
          ...(cursor_project_id ? { cursor_project_id } : {}),
        });
        rows.push(...page);
        if (page.length < candidateLimit) break;
        const next = page[page.length - 1]?.project_id;
        if (!next || next <= (cursor_project_id ?? "")) {
          throw new Error("maintenance project cursor did not advance");
        }
        cursor_project_id = next;
      }
      return rows;
    })();
  scheduleListing = listing;
  let rows: HostProjectMaintenanceSchedule[];
  try {
    rows = await listing;
  } finally {
    if (scheduleListing === listing) scheduleListing = undefined;
  }
  if (!rows.length) return;
  const snapshotRows = orderProjectMaintenance(rows, (row) => {
    const due = snapshotDueAt(
      row,
      mergeSchedule(DEFAULT_SNAPSHOT_COUNTS, row.snapshots),
    );
    return due == null ? null : new Date(due).toISOString();
  });
  const backupRows = orderProjectMaintenance(
    rows,
    (row) => row.backup_due_since,
  );
  const snapshotLane = async () => {
    if (snapshotLaneRunning) return;
    snapshotLaneRunning = true;
    try {
      await runWithParallelism(snapshotRows, parallelism, async (row) => {
        const project_id = row.project_id;
        const schedule = mergeSchedule(DEFAULT_SNAPSHOT_COUNTS, row.snapshots);
        const dueAt = snapshotDueAt(row, schedule);
        const lastObserved = parseTimestampMs(row.last_snapshot_observed_at);
        const reconciliationDue =
          lastObserved == null || Date.now() - lastObserved >= 24 * 60 * 60_000;
        if (
          !project_id ||
          schedule.disabled ||
          sweepRestricted ||
          (parseTimestampMs(row.snapshot_retry_at) ?? 0) > Date.now() ||
          ((dueAt == null || dueAt > Date.now()) && !reconciliationDue) ||
          inFlightSnapshots.has(project_id)
        ) {
          return;
        }
        inFlightSnapshots.add(project_id);
        const startedAt = Date.now();
        try {
          let latest_snapshot_at: string | null = null;
          let created_snapshot_at: string | null = null;
          let changed: boolean | null = null;
          let disabled = false;
          const result = await runScheduledStorageOperation({
            hostId,
            project_id,
            operation_kind: "scheduled_snapshot",
            run: async () => {
              const updated = await runScheduledSnapshotMaintenance({
                project_id,
                counts: scheduleToCounts(schedule),
                limit: row.max_snapshots_per_project ?? undefined,
              });
              latest_snapshot_at = updated?.latest_snapshot_at ?? null;
              created_snapshot_at = updated?.created_snapshot_at ?? null;
              changed = updated?.changed ?? null;
              disabled = updated?.disabled ?? false;
            },
          });
          const changedAt = parseTimestampMs(
            row.last_changed ?? row.last_edited,
          );
          const latestSnapshotAt = parseTimestampMs(latest_snapshot_at);
          const confirmedRecoveryPoint =
            created_snapshot_at != null ||
            (changed === false &&
              latestSnapshotAt != null &&
              (changedAt == null || latestSnapshotAt >= changedAt));
          const outcome = !result.ran
            ? "deferred"
            : disabled
              ? "deferred"
              : confirmedRecoveryPoint
                ? "succeeded"
                : changed === false
                  ? "skipped"
                  : "deferred";
          const reason =
            result.reason ??
            (disabled
              ? "snapshot_maintenance_disabled"
              : outcome === "skipped"
                ? "no_content_change"
                : outcome === "deferred"
                  ? "snapshot_not_created"
                  : undefined);
          await report({
            host_id: hostId,
            project_id,
            kind: "snapshot",
            storage_service_class: row.storage_service_class,
            observed_at: new Date().toISOString(),
            outcome,
            reason,
            latest_snapshot_at,
            reconciled_change_at:
              reason === "no_content_change"
                ? (row.last_changed ?? row.last_edited)
                : null,
            schedule_revision:
              reason === "no_content_change"
                ? row.snapshot_schedule_revision
                : null,
            due_at: result.ran
              ? reason === "no_content_change"
                ? null
                : (() => {
                    const next = snapshotDueAt(
                      { ...row, last_snapshot: latest_snapshot_at },
                      schedule,
                    );
                    return next == null ? null : new Date(next).toISOString();
                  })()
              : dueAt == null
                ? null
                : new Date(dueAt).toISOString(),
            duration_ms: Date.now() - startedAt,
            retry_at: retryAt(outcome, row.snapshot_failures ?? 0),
            consecutive_failures:
              outcome === "succeeded" ? 0 : (row.snapshot_failures ?? 0),
          }).catch((err) =>
            logger.warn("snapshot status report failed", { project_id, err }),
          );
        } catch (err) {
          logger.warn("scheduled snapshot maintenance failed", {
            hostId,
            project_id,
            err: `${err}`,
          });
          await report({
            host_id: hostId,
            project_id,
            kind: "snapshot",
            storage_service_class: row.storage_service_class,
            observed_at: new Date().toISOString(),
            outcome: "failed",
            reason: `${err}`,
            due_at: dueAt == null ? null : new Date(dueAt).toISOString(),
            duration_ms: Date.now() - startedAt,
            retry_at: retryAt("failed", (row.snapshot_failures ?? 0) + 1),
            consecutive_failures: (row.snapshot_failures ?? 0) + 1,
          }).catch(() => {});
        } finally {
          inFlightSnapshots.delete(project_id);
        }
      });
    } finally {
      snapshotLaneRunning = false;
    }
  };
  const backupLane = async () => {
    if (backupLaneRunning) return;
    backupLaneRunning = true;
    let starvationOverrideReservations = 0;
    try {
      await runWithParallelism(backupRows, parallelism, async (row) => {
        const project_id = row.project_id;
        const schedule = mergeSchedule(DEFAULT_BACKUP_COUNTS, row.backups);
        const dueAt = backupDueAt(row, schedule);
        const lastObserved = parseTimestampMs(row.last_backup_observed_at);
        const reconciliationDue =
          lastObserved == null || Date.now() - lastObserved >= 24 * 60 * 60_000;
        if (
          project_id &&
          !schedule.disabled &&
          (dueAt == null || dueAt > Date.now()) &&
          reconciliationDue
        ) {
          await report({
            host_id: hostId,
            project_id,
            kind: "backup",
            storage_service_class: row.storage_service_class,
            observed_at: new Date().toISOString(),
            outcome: "skipped",
            reason: dueAt == null ? "no_change_due" : "interval_not_due",
            due_at: dueAt == null ? null : new Date(dueAt).toISOString(),
            retry_at: null,
            consecutive_failures: 0,
          }).catch((err) =>
            logger.warn("backup status report failed", { project_id, err }),
          );
          return;
        }
        if (
          !project_id ||
          schedule.disabled ||
          dueAt == null ||
          dueAt > Date.now() ||
          (parseTimestampMs(row.backup_retry_at) ?? 0) > Date.now() ||
          inFlightBackups.has(project_id)
        ) {
          return;
        }
        const starved = backupIsStarved({
          backupDueSince: new Date(dueAt).toISOString(),
          starvationAgeMs,
        });
        const allowStarvationOverride =
          starved &&
          starvationOverrideEligible &&
          starvationOverrideReservations < starvationOverrideLimit;
        if (sweepRestricted && !allowStarvationOverride) return;
        if (allowStarvationOverride) starvationOverrideReservations += 1;
        inFlightBackups.add(project_id);
        const startedAt = Date.now();
        try {
          let created = false;
          const result = await runScheduledStorageOperation({
            hostId,
            project_id,
            operation_kind: "scheduled_backup",
            allowStarvationOverride,
            run: async () => {
              created = await runScheduledBackupMaintenance({
                project_id,
                counts: scheduleToCounts(schedule, { allowFrequent: false }),
                limit: row.max_backups_per_project ?? undefined,
                knownLastBackupAt: row.last_backup,
              });
            },
          });
          const outcome = result.ran
            ? created
              ? "succeeded"
              : "skipped"
            : "deferred";
          await report({
            host_id: hostId,
            project_id,
            kind: "backup",
            storage_service_class: row.storage_service_class,
            observed_at: new Date().toISOString(),
            outcome,
            reason: result.reason,
            due_at: created ? null : new Date(dueAt).toISOString(),
            duration_ms: Date.now() - startedAt,
            retry_at: retryAt(outcome, row.backup_failures ?? 0),
            consecutive_failures:
              outcome === "succeeded" ? 0 : (row.backup_failures ?? 0),
          }).catch((err) =>
            logger.warn("backup status report failed", { project_id, err }),
          );
        } catch (err) {
          logger.warn("scheduled backup maintenance failed", {
            hostId,
            project_id,
            err: `${err}`,
          });
          await report({
            host_id: hostId,
            project_id,
            kind: "backup",
            storage_service_class: row.storage_service_class,
            observed_at: new Date().toISOString(),
            outcome: "failed",
            reason: `${err}`,
            due_at: new Date(dueAt).toISOString(),
            duration_ms: Date.now() - startedAt,
            retry_at: retryAt("failed", (row.backup_failures ?? 0) + 1),
            consecutive_failures: (row.backup_failures ?? 0) + 1,
          }).catch(() => {});
        } finally {
          inFlightBackups.delete(project_id);
        }
      });
    } finally {
      backupLaneRunning = false;
    }
  };
  await Promise.all([snapshotLane(), backupLane()]);
}

export async function runProjectSnapshotBackupMaintenanceSweepOnce({
  hostId,
}: {
  hostId: string;
}) {
  await runProjectSnapshotBackupMaintenanceSweepUnlocked({ hostId });
}

export function startProjectSnapshotBackupMaintenance({
  hostId,
}: {
  hostId: string;
}) {
  if (parseBoolean(process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_DISABLE)) {
    logger.info("snapshot/backup maintenance disabled by env", { hostId });
    return () => {};
  }
  const sweepMs = parsePositiveInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS,
    DEFAULT_SWEEP_MS,
  );
  const initialDelayMs = parseNonNegativeInteger(
    process.env.COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
  );
  let closed = false;
  const runSweep = async () => {
    if (closed) {
      return;
    }
    try {
      await runProjectSnapshotBackupMaintenanceSweepOnce({ hostId });
    } catch (err) {
      logger.warn("snapshot/backup maintenance sweep failed", {
        hostId,
        err: `${err}`,
      });
    }
  };
  logger.info("snapshot/backup maintenance scheduled", {
    hostId,
    initial_delay_ms: initialDelayMs,
    sweep_ms: sweepMs,
  });
  const startRepeatingSweep = () => {
    if (closed) return;
    const timer = setInterval(() => {
      void runSweep();
    }, sweepMs);
    timer.unref();
    return timer;
  };
  const initialTimer = setTimeout(() => {
    if (closed) {
      return;
    }
    void runSweep();
    repeatingTimer = startRepeatingSweep();
  }, initialDelayMs);
  initialTimer.unref();
  let repeatingTimer: ReturnType<typeof setInterval> | undefined;
  return () => {
    closed = true;
    clearTimeout(initialTimer);
    if (repeatingTimer) {
      clearInterval(repeatingTimer);
    }
  };
}

export const _test = {
  parseMeminfo,
  parsePressureFullAvg10,
  maintenanceMemoryDecision,
  backupIsStarved,
  backupDueAt,
  snapshotDueAt,
  runScheduledStorageOperation,
};
