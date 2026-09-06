/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { BackupExclusionCache } from "@cocalc/backend/backup-exclusion-cache";
import type { BackupExclusionCacheLimits } from "@cocalc/backend/backup-exclusion-cache";
import { validateBackupOutcomeReceipt } from "@cocalc/backend/backup-producer-evidence";
import type { SignedR2ObjectDownload } from "@cocalc/backend/r2";
import type { BackupOutcomeReceipt } from "@cocalc/util/types/backup-evidence";
import type { BackupCoveragePage } from "@cocalc/util/types/backup-coverage";
import type { BackupCoverageReportChunk } from "@cocalc/util/types/backup-coverage";
import { validateBackupAcknowledgementKeys } from "@cocalc/util/backup-acknowledgements";

export interface BackupCoverageRequest {
  project_id: string;
  backup_id?: string;
  cursor?: string | null;
  acknowledgement_keys?: string[];
  path_acknowledgement_keys?: string[];
}

/** Owning-bay access must be resolved on EVERY request, including cache hits. */
export class ProjectBackupCoverage {
  private cache: BackupExclusionCache;
  constructor(
    private access: (opts: {
      project_id: string;
      backup_id?: string;
    }) => Promise<{
      receipt: BackupOutcomeReceipt;
      report_download?: SignedR2ObjectDownload;
    } | null>,
    limits: BackupExclusionCacheLimits,
  ) {
    this.cache = new BackupExclusionCache(limits);
  }

  async page({
    project_id,
    backup_id,
    cursor,
    acknowledgement_keys,
    path_acknowledgement_keys,
  }: BackupCoverageRequest): Promise<BackupCoveragePage | null> {
    if (
      typeof project_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        project_id,
      )
    )
      throw new Error("Invalid backup coverage project");
    if (
      backup_id != null &&
      (typeof backup_id !== "string" || !/^[0-9a-f]{64}$/.test(backup_id))
    )
      throw new Error("Invalid backup coverage snapshot");
    // Pagination must remain bound to the first page's snapshot, even if a new
    // backup arrives while a user browses. Never silently switch to the latest.
    if (cursor != null && !backup_id)
      throw new Error("Backup cursor requires an exact snapshot");
    const keys = validateBackupAcknowledgementKeys(acknowledgement_keys ?? []);
    const pathKeys = validateBackupAcknowledgementKeys(
      path_acknowledgement_keys ?? [],
    );
    const outcome = await this.access({ project_id, backup_id });
    if (!outcome) return null; // Unknown/legacy evidence is NOT complete coverage.
    const receipt = validateBackupOutcomeReceipt(outcome.receipt, project_id);
    const { producer } = receipt;
    if (backup_id && backup_id !== producer.binding.backup_id)
      throw new Error("Backup coverage snapshot mismatch");
    if (!outcome.report_download)
      throw new Error("Backup report access is unavailable");
    const page = await this.cache.page(
      {
        binding: producer.binding,
        download: outcome.report_download,
        limits: producer.read_limits,
        timeout_ms: 120000,
      },
      cursor,
      keys,
      pathKeys,
    );
    if (page.excluded_files !== producer.excluded_files)
      throw new Error("Backup report count does not match protected evidence");
    return {
      project_id,
      backup_id: producer.binding.backup_id,
      outcome: producer.outcome,
      captured_at: producer.binding.source.captured_at,
      policy_sha256: producer.binding.policy_sha256,
      exclude_larger_than_bytes: producer.exclude_larger_than_bytes,
      ...page,
    };
  }

  close() {
    return this.cache.close();
  }

  async reportChunk({
    project_id,
    backup_id,
    offset,
  }: {
    project_id: string;
    backup_id: string;
    offset: number;
  }): Promise<BackupCoverageReportChunk> {
    if (
      !/^[0-9a-f]{64}$/.test(backup_id) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid backup report download request");
    const outcome = await this.access({ project_id, backup_id });
    if (!outcome?.report_download)
      throw new Error("Backup report is unavailable");
    const receipt = validateBackupOutcomeReceipt(outcome.receipt, project_id);
    if (receipt.producer.binding.backup_id !== backup_id)
      throw new Error("Backup report snapshot mismatch");
    const chunk = await this.cache.reportChunk(
      {
        binding: receipt.producer.binding,
        download: outcome.report_download,
        limits: receipt.producer.read_limits,
        timeout_ms: 120000,
      },
      offset,
    );
    return { backup_id, ...chunk };
  }
  get status() {
    return this.cache.status;
  }
}
