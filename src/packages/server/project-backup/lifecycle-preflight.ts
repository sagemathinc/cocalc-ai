/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";
import { validateBackupOutcomeReceipt } from "@cocalc/backend/backup-producer-evidence";
import { backupReportHeaderSha256 } from "@cocalc/backend/backup-exclusion-report";
import { ensureBackupOutcomeSchema } from "./outcomes";

/** Early rejection only, NEVER authorization to delete the source. A legacy
 * project without native evidence still needs the existing freshness checks;
 * native activation additionally requires final host-side recovery fences.
 * Call on the owning bay before stopping, placement writes, or destination work.
 */
export async function assertNoKnownBackupExclusions({
  project_id,
  expected_host_id,
}: {
  project_id: string;
  expected_host_id: string | null;
}): Promise<void> {
  if (
    !isValidUUID(project_id) ||
    (expected_host_id !== null && !isValidUUID(expected_host_id))
  )
    throw new Error("Invalid backup lifecycle preflight identity");
  await ensureBackupOutcomeSchema();
  const { rows } = await getPool().query(
    `SELECT p.project_id, o.backup_id, o.receipt, o.receipt_sha256
     FROM projects p
     LEFT JOIN LATERAL (
       SELECT backup_id, receipt, receipt_sha256 FROM project_backup_outcomes
       WHERE project_id=p.project_id
       ORDER BY captured_at DESC, created DESC, backup_id DESC LIMIT 1
     ) o ON true
     WHERE p.project_id=$1::UUID AND p.deleted IS NOT true
       AND COALESCE(p.owning_bay_id, $2)=$2
       AND p.host_id IS NOT DISTINCT FROM $3::UUID`,
    [project_id, getConfiguredBayId(), expected_host_id],
  );
  if (rows.length !== 1)
    throw new Error("Backup preflight project placement or owning bay changed");
  const row = rows[0];
  if (row.backup_id == null) return;
  const receipt = validateBackupOutcomeReceipt(row.receipt, project_id);
  if (
    receipt.producer.binding.backup_id !== row.backup_id ||
    backupReportHeaderSha256(receipt) !== row.receipt_sha256
  )
    throw new Error("Backup preflight evidence failed integrity validation");
  if (receipt.producer.outcome !== "complete")
    throw new Error(
      "The latest verified backup excludes files. Resolve the excluded files and complete a new backup before moving or archiving this project. Acknowledging a backup warning does not permit omitting files from a move or archive.",
    );
}
