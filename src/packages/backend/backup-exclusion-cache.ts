/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { BackupEvidenceCleanupError } from "./backup-exclusion-cleanup";
import { readIndexedBackupExclusionReport } from "./backup-exclusion-index";
import type { BackupExclusionIndex } from "./backup-exclusion-index";
import { backupExclusionObjectKey } from "./backup-exclusion-store";
import type { BackupExclusionStoreOptions } from "./backup-exclusion-store";
import { backupReportHeaderSha256 } from "./backup-exclusion-report";
import type { BackupExclusionSample } from "./backup-exclusion-report";

interface Entry {
  ready: Promise<BackupExclusionIndex>;
  done: Promise<void>;
  controller: AbortController;
  cleanupFailed: boolean;
}

export interface BackupExclusionCacheLimits {
  max_reports: number;
  max_report_bytes: number;
  max_index_bytes: number;
  lifetime_ms: number;
}

/**
 * Process-local bounded browsing leases. Authorization MUST happen before every
 * call, including cache hits. This stores only verified content, never account
 * acknowledgements or access decisions. Requests coalesce by immutable binding;
 * full capacity rejects rather than growing a queue of pending downloads.
 *
 * A slot reserves max_report_bytes + max_index_bytes (plus filesystem overhead)
 * until both nested scopes finish cleanup. A cleanup failure keeps the slot
 * charged. Host bootstrap must separately fence/reconcile crash leftovers before
 * activation; process-local limits alone cannot bound repeated service crashes.
 */
export class BackupExclusionCache {
  private entries = new Map<string, Entry>();
  private closed = false;
  private limits: BackupExclusionCacheLimits;

  constructor(limits: BackupExclusionCacheLimits) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid backup report cache limits");
    if (
      Object.keys(limits).length !== 4 ||
      !limits.max_reports ||
      !limits.max_report_bytes ||
      !limits.max_index_bytes ||
      !limits.lifetime_ms ||
      limits.max_reports > 100 ||
      limits.lifetime_ms > 0x7fffffff ||
      limits.max_index_bytes < 4096 ||
      !Number.isSafeInteger(
        limits.max_reports * (limits.max_report_bytes + limits.max_index_bytes),
      )
    )
      throw new Error("Invalid backup report cache limits");
    this.limits = { ...limits };
  }

  get status() {
    return {
      reports: this.entries.size,
      cleanup_failures: [...this.entries.values()].filter(
        (e) => e.cleanupFailed,
      ).length,
      reserved_bytes:
        this.entries.size *
        (this.limits.max_report_bytes + this.limits.max_index_bytes),
    };
  }

  async page(
    options: BackupExclusionStoreOptions,
    cursor?: string | null,
    acknowledgementKeys?: string[],
  ) {
    // Reject syntactically invalid/cross-report cursors before downloading.
    backupExclusionObjectKey(options.binding);
    if (
      cursor != null &&
      (typeof cursor !== "string" ||
        !/^[0-9a-f]{64}:[1-9][0-9]{0,15}$/.test(cursor) ||
        !cursor.startsWith(backupReportHeaderSha256(options.binding) + ":"))
    )
      throw new Error("Invalid backup report cursor");
    const index = await this.index(options);
    return {
      ...index.page(cursor),
      acknowledged_files: index.countAcknowledged(acknowledgementKeys ?? []),
    };
  }

  async has(
    options: BackupExclusionStoreOptions,
    entry: BackupExclusionSample,
  ) {
    return (await this.index(options)).has(entry);
  }

  async reportChunk(options: BackupExclusionStoreOptions, offset: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= options.binding.report.bytes
    )
      throw new Error("Invalid backup report offset");
    return (await this.index(options)).reportChunk(offset);
  }

  private async index(options: BackupExclusionStoreOptions) {
    if (this.closed) throw new Error("Backup report cache is closed");
    backupExclusionObjectKey(options.binding);
    if (
      options.binding.report.bytes > this.limits.max_report_bytes ||
      !Number.isSafeInteger(options.limits.max_record_bytes) ||
      options.limits.max_record_bytes > 65536
    )
      throw new Error("Backup report exceeds browser resource limits");
    // Never cache the request signal or credentials as authorization. The
    // lease's own deadline applies to shared work; callers authorize anew.
    const key = backupReportHeaderSha256({
      binding: options.binding,
      limits: options.limits,
    });
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.cleanupFailed) throw new BackupEvidenceCleanupError(undefined);
      entry.controller.signal.throwIfAborted();
      return await entry.ready;
    }
    if (this.entries.size >= this.limits.max_reports)
      throw new Error("Backup report browser is busy; try again shortly");
    // Capture before reserving a slot: even a rejected/non-cloneable request
    // must not leak admission capacity, and credentials must not mutate later.
    const request = {
      ...options,
      binding: structuredClone(options.binding),
      limits: { ...options.limits },
      auth: options.auth == null ? undefined : { ...options.auth },
      download:
        options.download == null
          ? undefined
          : {
              url: options.download.url,
              headers: { ...options.download.headers },
            },
    };
    const controller = new AbortController();
    let resolve!: (index: BackupExclusionIndex) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<BackupExclusionIndex>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    entry = {
      ready,
      done: Promise.resolve(),
      controller,
      cleanupFailed: false,
    };
    this.entries.set(key, entry);
    const captured = entry;
    const timer = setTimeout(
      () => controller.abort(new Error("Backup report browsing lease expired")),
      this.limits.lifetime_ms,
    );
    timer.unref();
    entry.done = readIndexedBackupExclusionReport(
      {
        ...request,
        timeout_ms: this.limits.lifetime_ms,
        max_index_bytes: this.limits.max_index_bytes,
        signal: controller.signal,
      },
      async (index) => {
        controller.signal.throwIfAborted();
        resolve(index);
        // The indexed reader enforces cancellation, including a non-settling
        // consumer. Hold its private resource scope until this lease is aborted.
        await new Promise<void>(() => {});
      },
    )
      .catch((error) => {
        captured.cleanupFailed = error instanceof BackupEvidenceCleanupError;
        reject(error);
      })
      .finally(() => {
        clearTimeout(timer);
        if (!captured.cleanupFailed && this.entries.get(key) === captured)
          this.entries.delete(key);
      });
    return await ready;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values())
      entry.controller.abort(new Error("Backup report cache closed"));
    for (const entry of this.entries.values()) await entry.done;
    if (this.entries.size) throw new BackupEvidenceCleanupError(undefined);
  }
}
