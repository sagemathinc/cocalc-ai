/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  readFileSync,
} from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import getLogger from "@cocalc/backend/logger";
import { evaluatePersistMaintenanceCandidate } from "@cocalc/conat/persist/maintenance/candidates";
import type {
  PersistMaintenanceClose,
  PersistMaintenanceFileIdentity,
  PersistMaintenanceHooks,
  PersistMaintenanceStatus,
  PersistMaintenanceUse,
} from "@cocalc/conat/persist/maintenance/types";

import {
  PersistMaintenanceCatalog,
  type PersistMaintenanceDatabaseRow,
} from "./catalog";
import { runPersistMaintenanceWorker } from "./compact-worker";
import type { PersistMaintenanceWorkerResult } from "./compact-worker";
import type { PersistMaintenanceConfig } from "./config";
import { loadPersistMaintenanceConfig } from "./config";
import { fileIdentity, PersistMaintenancePathSafety } from "./path-safety";
import { PersistMaintenanceScanner } from "./scanner";

const logger = getLogger("backend:conat:persist-maintenance");

function readProcessIdentity(pid: number): {
  alive: boolean;
  startToken?: string;
} {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    return {
      alive: true,
      startToken: stat.slice(end + 2).split(" ")[19] || undefined,
    };
  } catch (err) {
    try {
      process.kill(pid, 0);
      return { alive: true };
    } catch (killError) {
      return {
        alive: (killError as NodeJS.ErrnoException).code !== "ESRCH",
      };
    }
  }
}

function processStartToken(pid = process.pid): string {
  return (
    readProcessIdentity(pid).startToken ??
    `${pid}-unavailable-${process.uptime().toFixed(3)}`
  );
}

function sameIdentity(
  row: PersistMaintenanceDatabaseRow,
  identity: PersistMaintenanceFileIdentity,
): boolean {
  return (
    row.device === identity.device &&
    row.inode === identity.inode &&
    row.file_size_bytes === identity.sizeBytes &&
    row.file_mtime_ms === identity.mtimeMs
  );
}

function maxTime(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value != null);
  return defined.length ? Math.max(...defined) : undefined;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some remote filesystems do not support directory fsync.
  }
}

interface ActiveRun {
  runId: string;
  physicalPath: string;
  phase: string;
  startedAt: number;
  sourceSizeBytes: number;
}

export class PersistMaintenanceCoordinator {
  readonly config: PersistMaintenanceConfig;
  readonly catalog: PersistMaintenanceCatalog;
  readonly safety: PersistMaintenancePathSafety;
  readonly scanner: PersistMaintenanceScanner;
  private readonly expectedWorkers = new Set<string>();
  private readonly registeredWorkers = new Set<string>();
  private readonly unhealthyWorkers = new Set<string>();
  private readonly mutationHints = new Map<string, number>();
  private scheduler?: NodeJS.Timeout;
  private runningTick = false;
  private stopped = false;
  private activeRun?: ActiveRun;
  private lastScanStartedAt?: number;
  private lastScanCompletedAt?: number;
  private scannedFiles = 0;
  private pauseReason?: string;
  private lastError?: string;
  private catalogHealthy = true;
  private readonly runWorker: (options: {
    sourcePath: string;
    outputPath?: string;
    timeoutMs: number;
  }) => Promise<PersistMaintenanceWorkerResult>;

  constructor({
    expectedWorkerIds,
    config = loadPersistMaintenanceConfig(),
    runWorker = runPersistMaintenanceWorker,
  }: {
    expectedWorkerIds: string[];
    config?: PersistMaintenanceConfig;
    runWorker?: (options: {
      sourcePath: string;
      outputPath?: string;
      timeoutMs: number;
    }) => Promise<PersistMaintenanceWorkerResult>;
  }) {
    this.config = config;
    this.catalog = new PersistMaintenanceCatalog(config.catalogPath);
    this.safety = new PersistMaintenancePathSafety({
      rootTemplates: config.rootTemplates,
      catalogPath: config.catalogPath,
    });
    this.scanner = new PersistMaintenanceScanner(
      this.catalog,
      this.safety,
      config,
    );
    this.runWorker = runWorker;
    for (const workerId of expectedWorkerIds) {
      this.expectedWorkers.add(workerId);
    }
    this.reconcileStaleOwners();
    this.cleanupAbandonedTemporaryFiles();
  }

  start(): void {
    if (!this.config.enabled || this.scheduler || this.stopped) return;
    const initialDelay = Math.min(
      this.config.schedulerIntervalMs,
      1000 + Math.floor(Math.random() * 5000),
    );
    const first = setTimeout(() => {
      void this.tick();
      if (!this.stopped) {
        this.scheduler = setInterval(
          () => void this.tick(),
          this.config.schedulerIntervalMs,
        );
        this.scheduler.unref?.();
      }
    }, initialDelay);
    first.unref?.();
  }

  close(): void {
    this.stopped = true;
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
    this.catalog.close();
  }

  registerWorker(workerId: string): void {
    this.expectedWorkers.add(workerId);
    this.registeredWorkers.add(workerId);
    this.unhealthyWorkers.delete(workerId);
  }

  unregisterWorker(workerId: string): void {
    this.registeredWorkers.delete(workerId);
    this.unhealthyWorkers.delete(workerId);
    this.catalog.removeWorkerOwners(workerId);
  }

  trackingUnavailable(workerId: string, error: unknown): void {
    this.unhealthyWorkers.add(workerId);
    this.lastError = `${error}`;
  }

  get trackingCoverage(): boolean {
    return (
      this.expectedWorkers.size > 0 &&
      [...this.expectedWorkers].every(
        (workerId) =>
          this.registeredWorkers.has(workerId) &&
          !this.unhealthyWorkers.has(workerId),
      )
    );
  }

  beginOpen(use: PersistMaintenanceUse): void {
    this.safety.assertLexicallyAllowed(use.physicalPath);
    this.catalog.beginOpen(use);
    this.catalogHealthy = true;
  }

  openFailed(use: PersistMaintenanceUse): void {
    this.catalog.openFailed(use);
  }

  mutation(use: PersistMaintenanceUse): void {
    const now = Date.now();
    const last = this.mutationHints.get(use.physicalPath) ?? 0;
    if (now - last < this.config.mutationHintIntervalMs) return;
    this.mutationHints.set(use.physicalPath, now);
    this.catalog.mutation(use, now);
  }

  closed(close: PersistMaintenanceClose): void {
    this.mutationHints.delete(close.physicalPath);
    this.catalog.closed(close);
  }

  createLocalHooks(workerId: string): PersistMaintenanceHooks {
    const ownerId = `${workerId}:${process.pid}:${randomUUID()}`;
    const owner = {
      ownerId,
      workerId,
      pid: process.pid,
      processStartToken: processStartToken(),
    };
    this.registerWorker(workerId);
    return {
      beginOpen: async (path) => {
        const use: PersistMaintenanceUse = { ...path, ...owner };
        this.beginOpen(use);
        this.registerWorker(workerId);
        return {
          ownerId,
          onMutation: () => {
            try {
              this.mutation(use);
            } catch (err) {
              this.trackingUnavailable(workerId, err);
            }
          },
          onFinalClose: (dirty) => {
            try {
              this.closed({ ...use, dirty });
            } catch (err) {
              this.trackingUnavailable(workerId, err);
            }
          },
        };
      },
      openFailed: (path, error) => {
        try {
          this.openFailed({ ...path, ...owner });
        } catch (err) {
          this.trackingUnavailable(workerId, err ?? error);
        }
      },
      trackingUnavailable: (error) => this.trackingUnavailable(workerId, error),
    };
  }

  async tick(): Promise<void> {
    if (this.runningTick || this.stopped || !this.config.enabled) return;
    this.runningTick = true;
    try {
      const resourcePause = this.resourcePauseReason();
      if (resourcePause) {
        this.pauseReason = resourcePause;
        return;
      }
      await this.maybeScan();
      await this.retrySecondaryRefresh();
      await this.inspectAndMaybeCompact();
      this.catalog.expireMissing(Date.now() - this.config.missingRetentionMs);
      this.catalog.prune({
        before: Date.now() - this.config.runRetentionMs,
        keep: this.config.runRetentionCount,
      });
      this.cleanupFinishedCompactOutputs();
      this.catalogHealthy = true;
    } catch (err) {
      this.catalogHealthy = false;
      this.lastError = `${err}`;
      logger.warn("persist maintenance tick failed", { err });
    } finally {
      this.runningTick = false;
    }
  }

  private async maybeScan(): Promise<void> {
    const completed = Number(this.catalog.getState("scan_completed_at") ?? 0);
    const hasCursor = !!this.catalog.getState("scan_cursor");
    if (!hasCursor && Date.now() - completed < this.config.scanIntervalMs)
      return;
    const result = await this.scanner.scanBatch();
    this.lastScanStartedAt = result.startedAt;
    this.lastScanCompletedAt = result.completedAt;
    this.scannedFiles = result.files;
    if (result.errors.length) {
      logger.debug("persist maintenance scan had per-path errors", {
        count: result.errors.length,
        first: result.errors[0],
      });
    }
  }

  private candidatePolicy(now = Date.now()) {
    return {
      now,
      idleMs: this.config.idleMs,
      minFileBytes: this.config.minFileBytes,
      minReclaimBytes: this.config.minReclaimBytes,
      minReclaimRatio: this.config.minReclaimRatio,
      minBetweenMs: this.config.minBetweenMs,
      maxFileBytes: this.config.maxFileBytes,
    };
  }

  private candidate(row: PersistMaintenanceDatabaseRow) {
    const fileSizeBytes = row.file_size_bytes ?? 0;
    const reclaimableBytes = row.reclaimable_bytes ?? 0;
    return {
      physicalPath: row.physical_path,
      fileSizeBytes,
      reclaimableBytes,
      reclaimableRatio:
        fileSizeBytes > 0 ? reclaimableBytes / fileSizeBytes : 0,
      lastActivityAt: maxTime(
        row.last_opened_at,
        row.last_closed_at,
        row.last_mutation_at,
        row.file_mtime_ms,
      ),
      lastCompactedAt: row.last_compacted_at,
      retryAfter: row.retry_after,
      openOwners: row.open_owners,
    };
  }

  private async inspectAndMaybeCompact(): Promise<void> {
    this.pauseReason = this.schedulerPauseReason();
    const rows = this.catalog.listDatabases();
    const policy = this.candidatePolicy();
    for (const row of rows) {
      if (row.presence_state !== "present" || row.open_owners > 0) continue;
      const preliminary = this.candidate(row);
      if (
        preliminary.fileSizeBytes < this.config.minFileBytes ||
        preliminary.fileSizeBytes > this.config.maxFileBytes ||
        (preliminary.lastActivityAt != null &&
          policy.now - preliminary.lastActivityAt < policy.idleMs)
      ) {
        continue;
      }
      if (
        row.last_inspected_at == null ||
        row.file_mtime_ms == null ||
        row.last_inspected_at < row.file_mtime_ms
      ) {
        await this.inspect(row);
      }
      const current = this.catalog.getDatabase(row.physical_path);
      if (!current) continue;
      if (
        !evaluatePersistMaintenanceCandidate(this.candidate(current), policy)
          .eligible
      ) {
        continue;
      }
      if (this.pauseReason || this.config.dryRun) return;
      await this.compact(current);
      return;
    }
  }

  private async inspect(row: PersistMaintenanceDatabaseRow): Promise<void> {
    try {
      const checked = this.safety.assertExistingRegularFile(row.physical_path);
      const result = await this.runWorker({
        sourcePath: checked.path,
        timeoutMs: Math.min(this.config.jobTimeoutMs, 5 * 60 * 1000),
      });
      this.catalog.updateInspection(
        checked.path,
        result.beforeIdentity,
        result.beforeStats,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.catalog.markMissing(row.physical_path);
        return;
      }
      this.catalog.recordFailure(
        row.physical_path,
        err,
        Date.now() + 60 * 60 * 1000,
      );
    }
  }

  private schedulerPauseReason(): string | undefined {
    if (!this.catalogHealthy) return "catalog-unhealthy";
    if (!this.trackingCoverage) return "incomplete-worker-tracking";
    const resourcePause = this.resourcePauseReason();
    if (resourcePause) return resourcePause;
    const hour = this.catalog.budgetSince(Date.now() - 60 * 60 * 1000);
    if (hour.attempts >= this.config.maxAttemptsPerHour)
      return "hourly-attempt-budget";
    if (hour.bytes >= this.config.maxBytesPerHour) return "hourly-byte-budget";
    const day = this.catalog.budgetSince(Date.now() - 24 * 60 * 60 * 1000);
    if (day.bytes >= this.config.maxBytesPerDay) return "daily-byte-budget";
    return;
  }

  private resourcePauseReason(): string | undefined {
    if (this.config.pauseFile && existsSync(this.config.pauseFile)) {
      return "operator-pause-file";
    }
    const cpuCount = Math.max(1, cpus().length);
    if (loadavg()[0] / cpuCount > this.config.maxLoadPerCpu) {
      return "host-load";
    }
    if (freemem() / totalmem() < this.config.minFreeMemoryRatio) {
      return "host-memory";
    }
    return;
  }

  private assertDiskHeadroom(path: string, sourceSize: number): void {
    const stat = statfsSync(dirname(path));
    const available = Number(stat.bavail) * Number(stat.bsize);
    const required = Math.max(
      this.config.minFreeBytes,
      sourceSize * this.config.freeSpaceMultiplier,
    );
    if (available < required) {
      throw new Error(
        `insufficient disk for SQLite maintenance: available=${available} required=${required}`,
      );
    }
  }

  private async compact(row: PersistMaintenanceDatabaseRow): Promise<void> {
    const checked = this.safety.assertExistingRegularFile(row.physical_path);
    const sourceIdentity = fileIdentity(checked.stat);
    if (!sameIdentity(row, sourceIdentity)) {
      this.catalog.observeFile(checked.path, sourceIdentity);
      return;
    }
    this.assertDiskHeadroom(checked.path, sourceIdentity.sizeBytes);
    const runId = this.catalog.createRun(row, "building");
    const outputPath = join(
      dirname(checked.path),
      `.${basename(checked.path)}.compact-${runId}.tmp`,
    );
    const startedAt = Date.now();
    this.activeRun = {
      runId,
      physicalPath: checked.path,
      phase: "building",
      startedAt,
      sourceSizeBytes: sourceIdentity.sizeBytes,
    };
    let secondary: Array<{ temporary: string; destination: string }> = [];
    try {
      rmSync(outputPath, { force: true });
      const result = await this.runWorker({
        sourcePath: checked.path,
        outputPath,
        timeoutMs: this.config.jobTimeoutMs,
      });
      if (!result.outputIdentity || !result.outputStats) {
        throw new Error("compact worker did not produce an output");
      }
      const saving = sourceIdentity.sizeBytes - result.outputIdentity.sizeBytes;
      if (
        saving < this.config.minReclaimBytes ||
        saving / sourceIdentity.sizeBytes < this.config.minReclaimRatio
      ) {
        this.catalog.updateRun(runId, "skipped", {
          finished: true,
          reason: "actual compact saving below threshold",
        });
        return;
      }
      this.activeRun.phase = "awaiting-promotion";
      this.catalog.updateRun(runId, "awaiting-promotion");
      const current = this.catalog.getDatabase(checked.path);
      const currentChecked = this.safety.assertExistingRegularFile(
        checked.path,
      );
      const currentIdentity = fileIdentity(currentChecked.stat);
      if (
        !current ||
        current.generation !== row.generation ||
        current.open_owners > 0 ||
        !sameIdentity(row, currentIdentity) ||
        !this.trackingCoverage
      ) {
        this.catalog.updateRun(runId, "invalidated", {
          finished: true,
          reason: "source opened, changed, or worker coverage was lost",
        });
        return;
      }
      this.activeRun.phase = "promoting";
      this.catalog.updateRun(runId, "promoting");
      secondary = await this.stageSecondaryCopies(row, outputPath, runId);
      this.promote({ row, outputPath, runId });
      for (const copy of secondary) {
        try {
          await rename(copy.temporary, copy.destination);
        } catch (err) {
          this.catalog.enqueueSecondaryRefresh(
            checked.path,
            copy.destination,
            err,
          );
          logger.warn("failed refreshing persist maintenance secondary copy", {
            source: checked.path,
            destination: copy.destination,
            err,
          });
        }
      }
      const promotedStat = lstatSync(checked.path);
      const promotedIdentity = fileIdentity(promotedStat);
      const after = promotedIdentity.sizeBytes;
      this.catalog.recordSuccess(
        checked.path,
        sourceIdentity.sizeBytes,
        promotedIdentity,
        Date.now() - startedAt,
      );
      this.catalog.updateRun(runId, "succeeded", {
        finished: true,
        reclaimedBytes: sourceIdentity.sizeBytes - after,
      });
      logger.info("compacted Conat persist SQLite database", {
        path: checked.path,
        beforeBytes: sourceIdentity.sizeBytes,
        afterBytes: after,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const timeout = `${err}`.includes("timed out");
      this.catalog.updateRun(runId, timeout ? "timeout" : "failed", {
        finished: true,
        error: `${err}`,
      });
      const failures = row.consecutive_failures + 1;
      this.catalog.recordFailure(
        checked.path,
        err,
        Date.now() + Math.min(24, 2 ** Math.min(failures, 5)) * 60 * 60 * 1000,
      );
      throw err;
    } finally {
      rmSync(outputPath, { force: true });
      for (const copy of secondary) {
        try {
          rmSync(copy.temporary, { force: true });
        } catch {}
      }
      this.activeRun = undefined;
    }
  }

  private async stageSecondaryCopies(
    row: PersistMaintenanceDatabaseRow,
    outputPath: string,
    runId: string,
  ): Promise<Array<{ temporary: string; destination: string }>> {
    const copies: Array<{ temporary: string; destination: string }> = [];
    for (const destination of [row.archive_path, row.backup_path]) {
      if (!destination) continue;
      const temporary = `${destination}.maintenance-${runId}.tmp`;
      try {
        await mkdir(dirname(destination), { recursive: true });
        await rm(temporary, { force: true }).catch(() => {});
        await copyFile(outputPath, temporary);
        copies.push({ temporary, destination });
      } catch (err) {
        await rm(temporary, { force: true }).catch(() => {});
        this.catalog.enqueueSecondaryRefresh(
          row.physical_path,
          destination,
          err,
        );
        logger.warn("failed staging persist maintenance secondary copy", {
          destination,
          err,
        });
      }
    }
    return copies;
  }

  private promote({
    row,
    outputPath,
    runId,
  }: {
    row: PersistMaintenanceDatabaseRow;
    outputPath: string;
    runId: string;
  }): void {
    const barrierStarted = Date.now();
    const current = this.catalog.getDatabase(row.physical_path);
    if (
      !current ||
      current.generation !== row.generation ||
      current.open_owners > 0 ||
      !this.trackingCoverage
    ) {
      throw new Error("promotion barrier rejected changed source state");
    }
    const checked = this.safety.assertExistingRegularFile(row.physical_path);
    const identity = fileIdentity(checked.stat);
    if (!sameIdentity(row, identity)) {
      throw new Error("promotion barrier rejected changed source identity");
    }

    // With no owners and worker opens waiting for begin-open acknowledgement,
    // this checkpoint is exclusive. It removes stale WAL state before swapping
    // the main database inode.
    const sourceDb = new DatabaseSync(checked.path);
    try {
      sourceDb.exec("PRAGMA busy_timeout=1000");
      sourceDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      sourceDb.close();
    }
    rmSync(`${checked.path}-wal`, { force: true });
    rmSync(`${checked.path}-shm`, { force: true });

    const sourceStat = lstatSync(checked.path);
    chmodSync(outputPath, sourceStat.mode);
    try {
      chownSync(outputPath, sourceStat.uid, sourceStat.gid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
    fsyncPath(outputPath);
    const rollbackPath = join(
      dirname(checked.path),
      `.${basename(checked.path)}.rollback-${runId}`,
    );
    rmSync(rollbackPath, { force: true });
    try {
      linkSync(checked.path, rollbackPath);
    } catch {
      renameSync(checked.path, rollbackPath);
    }
    try {
      renameSync(outputPath, checked.path);
      fsyncPath(checked.path);
      fsyncDirectory(dirname(checked.path));
      // The exact inode promoted here was quick-checked by the child worker
      // immediately before this barrier. Re-running a full synchronous check
      // here would stall every persist socket on a multi-gigabyte database.
      if (Date.now() - barrierStarted > this.config.promotionBarrierMs) {
        throw new Error("promotion barrier exceeded its time bound");
      }
      rmSync(rollbackPath, { force: true });
      fsyncDirectory(dirname(checked.path));
    } catch (err) {
      rmSync(checked.path, { force: true });
      renameSync(rollbackPath, checked.path);
      fsyncDirectory(dirname(checked.path));
      throw err;
    }
  }

  private cleanupAbandonedTemporaryFiles(): void {
    for (const run of this.catalog.unfinishedRuns()) {
      try {
        this.safety.assertLexicallyAllowed(run.physical_path);
        const outputPath = join(
          dirname(run.physical_path),
          `.${basename(run.physical_path)}.compact-${run.run_id}.tmp`,
        );
        const rollbackPath = join(
          dirname(run.physical_path),
          `.${basename(run.physical_path)}.rollback-${run.run_id}`,
        );
        let promoted = false;
        if (existsSync(rollbackPath)) {
          const sourceValid = this.quickCheck(run.physical_path);
          const rollbackValid = this.quickCheck(rollbackPath);
          if (!sourceValid && rollbackValid) {
            rmSync(run.physical_path, { force: true });
            renameSync(rollbackPath, run.physical_path);
            fsyncDirectory(dirname(run.physical_path));
          } else if (sourceValid) {
            const sourceStat = lstatSync(run.physical_path);
            promoted =
              run.state === "promoting" &&
              run.source_device != null &&
              run.source_inode != null &&
              (Number(sourceStat.dev) !== run.source_device ||
                Number(sourceStat.ino) !== run.source_inode);
            rmSync(rollbackPath, { force: true });
          } else {
            throw new Error("neither source nor rollback passed quick_check");
          }
        }
        for (const destination of [run.archive_path, run.backup_path]) {
          if (!destination) continue;
          const staged = `${destination}.maintenance-${run.run_id}.tmp`;
          if (existsSync(staged)) {
            if (promoted && this.quickCheck(staged)) {
              renameSync(staged, destination);
            } else {
              rmSync(staged, { force: true });
            }
          } else if (promoted) {
            this.catalog.enqueueSecondaryRefresh(
              run.physical_path,
              destination,
              "coordinator restarted before secondary refresh",
            );
          }
        }
        rmSync(outputPath, { force: true });
        if (this.quickCheck(run.physical_path)) {
          const identity = fileIdentity(lstatSync(run.physical_path));
          if (promoted) {
            this.catalog.recordSuccess(
              run.physical_path,
              run.source_size_bytes ?? identity.sizeBytes,
              identity,
              Math.max(0, Date.now() - run.started_at),
            );
          } else {
            this.catalog.observeFile(run.physical_path, identity);
          }
        }
        this.catalog.updateRun(run.run_id, "recovered-after-restart", {
          finished: true,
          reason: "coordinator restarted during maintenance",
        });
      } catch (err) {
        this.catalog.updateRun(run.run_id, "recovery-failed", {
          finished: true,
          error: `${err}`,
        });
        logger.error("failed recovering interrupted persist maintenance run", {
          run,
          err,
        });
      }
    }
  }

  private cleanupFinishedCompactOutputs(): void {
    for (const run of this.catalog.finishedArtifactRuns()) {
      if (run.run_id === this.activeRun?.runId) continue;
      try {
        this.safety.assertLexicallyAllowed(run.physical_path);
        const outputPath = join(
          dirname(run.physical_path),
          `.${basename(run.physical_path)}.compact-${run.run_id}.tmp`,
        );
        rmSync(outputPath, { force: true });
      } catch (err) {
        logger.debug("failed cleaning finished persist maintenance output", {
          physicalPath: run.physical_path,
          err,
        });
      }
    }
  }

  private quickCheck(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("PRAGMA quick_check").get() as Record<
          string,
          unknown
        >;
        return `${Object.values(row)[0]}` === "ok";
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  private async retrySecondaryRefresh(): Promise<void> {
    if (!this.trackingCoverage) return;
    const refresh = this.catalog.nextSecondaryRefresh();
    if (!refresh) return;
    const row = this.catalog.getDatabase(refresh.source_path);
    if (!row || row.presence_state !== "present" || row.open_owners > 0) return;
    const checked = this.safety.assertExistingRegularFile(refresh.source_path);
    const identity = fileIdentity(checked.stat);
    if (!sameIdentity(row, identity)) {
      this.catalog.observeFile(refresh.source_path, identity);
      return;
    }
    const temporary = `${refresh.destination_path}.maintenance-refresh.tmp`;
    try {
      await mkdir(dirname(refresh.destination_path), { recursive: true });
      await rm(temporary, { force: true }).catch(() => {});
      await copyFile(refresh.source_path, temporary);
      const current = this.catalog.getDatabase(refresh.source_path);
      const currentChecked = this.safety.assertExistingRegularFile(
        refresh.source_path,
      );
      if (
        !current ||
        current.generation !== row.generation ||
        current.open_owners > 0 ||
        !sameIdentity(row, fileIdentity(currentChecked.stat)) ||
        !this.trackingCoverage
      ) {
        throw new Error(
          "secondary refresh invalidated by a source open or change",
        );
      }
      await rename(temporary, refresh.destination_path);
      this.catalog.completeSecondaryRefresh(
        refresh.path_key,
        refresh.destination_path,
      );
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      this.catalog.failSecondaryRefresh(
        refresh.path_key,
        refresh.destination_path,
        err,
      );
    }
  }

  private reconcileStaleOwners(): void {
    for (const owner of this.catalog.listOwners()) {
      const current = readProcessIdentity(owner.pid);
      if (
        !current.alive ||
        (current.startToken != null &&
          current.startToken !== owner.process_start_token)
      ) {
        this.catalog.removeOwnerByKey(owner.path_key, owner.owner_id);
      }
    }
  }

  status(): PersistMaintenanceStatus {
    const rows = this.catalog.listDatabases();
    const policy = this.candidatePolicy();
    const eligible = rows.filter(
      (row) =>
        row.presence_state === "present" &&
        evaluatePersistMaintenanceCandidate(this.candidate(row), policy)
          .eligible,
    );
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      catalogHealthy: this.catalogHealthy,
      catalogPath: this.config.catalogPath,
      expectedWorkers: [...this.expectedWorkers].sort(),
      registeredWorkers: [...this.registeredWorkers].sort(),
      trackingCoverage: this.trackingCoverage,
      ...this.catalog.statusBase(),
      eligibleCandidates: eligible.length,
      estimatedReclaimableBytes: eligible.reduce(
        (sum, row) => sum + (row.reclaimable_bytes ?? 0),
        0,
      ),
      scanRoots: this.safety.rootTemplates,
      lastScanStartedAt:
        this.lastScanStartedAt ??
        (Number(this.catalog.getState("scan_started_at") ?? 0) || undefined),
      lastScanCompletedAt:
        this.lastScanCompletedAt ??
        (Number(this.catalog.getState("scan_completed_at") ?? 0) || undefined),
      scannedFiles:
        this.scannedFiles || Number(this.catalog.getState("scan_files") ?? 0),
      activeRun: this.activeRun,
      secondaryRefreshBacklog: this.catalog.secondaryRefreshBacklog(),
      pauseReason:
        this.pauseReason ??
        (!this.config.enabled
          ? "disabled"
          : this.config.dryRun
            ? "dry-run"
            : undefined),
      lastError: this.lastError,
    };
  }

  diagnostics() {
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      catalogHealthy: this.catalogHealthy,
      trackingCoverage: this.trackingCoverage,
      ...this.catalog.statusBase(),
      lastScanStartedAt:
        this.lastScanStartedAt ??
        (Number(this.catalog.getState("scan_started_at") ?? 0) || undefined),
      lastScanCompletedAt:
        this.lastScanCompletedAt ??
        (Number(this.catalog.getState("scan_completed_at") ?? 0) || undefined),
      scannedFiles:
        this.scannedFiles || Number(this.catalog.getState("scan_files") ?? 0),
      pauseReason:
        this.pauseReason ??
        (!this.config.enabled
          ? "disabled"
          : !this.trackingCoverage
            ? "tracking-coverage-incomplete"
            : undefined),
      lastError: this.lastError,
    };
  }
}

export function createPersistMaintenanceCoordinator(options: {
  expectedWorkerIds: string[];
  config?: PersistMaintenanceConfig;
  runWorker?: (options: {
    sourcePath: string;
    outputPath?: string;
    timeoutMs: number;
  }) => Promise<PersistMaintenanceWorkerResult>;
}): PersistMaintenanceCoordinator {
  try {
    return new PersistMaintenanceCoordinator(options);
  } catch (firstError) {
    const config = options.config ?? loadPersistMaintenanceConfig();
    const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    logger.error("persist maintenance catalog failed to open; rebuilding", {
      path: config.catalogPath,
      err: `${firstError}`,
    });
    for (const extension of ["", "-wal", "-shm"]) {
      const source = `${config.catalogPath}${extension}`;
      if (!existsSync(source)) continue;
      try {
        renameSync(source, `${source}${suffix}`);
      } catch (err) {
        logger.warn("failed preserving broken persist maintenance catalog", {
          source,
          err,
        });
      }
    }
    return new PersistMaintenanceCoordinator({ ...options, config });
  }
}
