/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { validateBackupOutcomeReceipt } from "@cocalc/backend/backup-producer-evidence";
import { backupReportHeaderSha256 } from "@cocalc/backend/backup-exclusion-report";
import type { BackupOutcomeReceipt } from "@cocalc/util/types/backup-evidence";
import { isValidUUID } from "@cocalc/util/misc";

let schema: Promise<void> | undefined;
export async function ensureBackupOutcomeSchema(): Promise<void> {
  if (!schema)
    schema = (async () => {
      await getPool()
        .query(`CREATE TABLE IF NOT EXISTS project_backup_outcomes (
      project_id UUID NOT NULL,
      backup_id TEXT NOT NULL,
      host_id UUID NOT NULL,
      bucket_id UUID NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial_policy_exclusions')),
      captured_at TIMESTAMPTZ NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      receipt JSONB NOT NULL CHECK (octet_length(receipt::text) <= 262144),
      created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, backup_id)
    )`);
      await getPool()
        .query(`CREATE INDEX IF NOT EXISTS project_backup_outcomes_latest_idx
      ON project_backup_outcomes (project_id, captured_at DESC, created DESC)`);
    })().catch((error) => {
      schema = undefined;
      throw error;
    });
  await schema;
}

// The caller is the host-authenticated owning-bay endpoint. These records survive
// project-host loss and browsing-index GC; they never advance source freshness.
// A captured snapshot's generation is NOT a later live-source generation.
export async function recordBackupOutcome({
  host_id,
  project_id,
  receipt,
  bucket,
}: {
  host_id?: string;
  project_id: string;
  receipt: BackupOutcomeReceipt;
  bucket: { id: string; name: string };
}): Promise<{ receipt_sha256: string }> {
  if (!host_id || !isValidUUID(host_id) || !isValidUUID(project_id))
    throw new Error("Invalid backup outcome owner");
  const captured = validateBackupOutcomeReceipt(receipt, project_id);
  if (!bucket || !isValidUUID(bucket.id) || bucket.name !== captured.bucket)
    throw new Error("Backup evidence bucket assignment changed");
  const encoded = JSON.stringify(captured);
  if (Buffer.byteLength(encoded) > 256 * 1024)
    throw new Error("Backup outcome metadata exceeds its bound");
  const receipt_sha256 = backupReportHeaderSha256(captured);
  const backup_id = captured.producer.binding.backup_id;
  await ensureBackupOutcomeSchema();
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT host_id FROM projects
      WHERE project_id=$1::UUID AND deleted IS NOT true
        AND COALESCE(owning_bay_id, $2)=$2 FOR SHARE`,
      [project_id, getConfiguredBayId()],
    );
    if (rows.length !== 1 || rows[0].host_id !== host_id)
      throw new Error("Backup outcome host placement or owning bay changed");
    await db.query(
      `INSERT INTO project_backup_outcomes
      (project_id, backup_id, host_id, outcome, captured_at, receipt_sha256, receipt, bucket_id)
      VALUES ($1::UUID, $2, $3::UUID, $4, $5::TIMESTAMPTZ, $6, $7::JSONB, $8::UUID)
      ON CONFLICT (project_id, backup_id) DO NOTHING`,
      [
        project_id,
        backup_id,
        host_id,
        captured.producer.outcome,
        captured.producer.binding.source.captured_at,
        receipt_sha256,
        encoded,
        bucket.id,
      ],
    );
    const existing = await db.query(
      `SELECT receipt_sha256 FROM project_backup_outcomes
      WHERE project_id=$1::UUID AND backup_id=$2`,
      [project_id, backup_id],
    );
    if (
      existing.rows.length !== 1 ||
      existing.rows[0].receipt_sha256 !== receipt_sha256
    )
      throw new Error(
        "Backup outcome conflicts with immutable recorded evidence",
      );
    await db.query("COMMIT");
    return { receipt_sha256 };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
