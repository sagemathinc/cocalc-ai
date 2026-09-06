/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";
import { validateBackupOutcomeReceipt } from "@cocalc/backend/backup-producer-evidence";
import { backupReportHeaderSha256 } from "@cocalc/backend/backup-exclusion-report";
import type {
  BackupAttemptStatus,
  BackupAttemptUpdate,
} from "@cocalc/util/types/backup-attempt";
import { ensureBackupOutcomeSchema } from "./outcomes";

let schema: Promise<void> | undefined;
async function ensureSchema() {
  if (!schema)
    schema = (async () => {
      await ensureBackupOutcomeSchema();
      await getPool()
        .query(`CREATE TABLE IF NOT EXISTS project_backup_latest_attempts (
      project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
      host_id UUID NOT NULL,
      attempt_id UUID NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      finished_at TIMESTAMPTZ,
      outcome TEXT NOT NULL CHECK (outcome IN ('unconfirmed','failed','complete','partial_policy_exclusions')),
      backup_id TEXT CHECK (backup_id ~ '^[0-9a-f]{64}$')
    )`);
    })().catch((error) => {
      schema = undefined;
      throw error;
    });
  await schema;
}

function validateIdentity(host_id: string | undefined, project_id: string) {
  if (!host_id || !isValidUUID(host_id) || !isValidUUID(project_id))
    throw new Error("Invalid backup attempt identity");
}

// One row per project bounds telemetry growth. Historical receipts and the
// root-owned retry journal are separate; this row cannot clear either of them.
export async function recordBackupAttempt(
  opts: BackupAttemptUpdate,
): Promise<void> {
  const { host_id, project_id, attempt_id, action, backup_id } = opts;
  validateIdentity(host_id, project_id);
  if (
    !isValidUUID(attempt_id) ||
    !["start", "finish"].includes(action) ||
    (backup_id !== undefined &&
      (typeof backup_id !== "string" || !/^[0-9a-f]{64}$/.test(backup_id))) ||
    (action === "start" && backup_id !== undefined)
  )
    throw new Error("Invalid backup attempt update");
  await ensureSchema();
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT host_id FROM projects
      WHERE project_id=$1::UUID AND deleted IS NOT true
      AND COALESCE(owning_bay_id,$2)=$2 FOR SHARE`,
      [project_id, getConfiguredBayId()],
    );
    if (rows.length !== 1 || rows[0].host_id !== host_id)
      throw new Error("Backup attempt host placement or owning bay changed");
    if (action === "start") {
      await db.query(
        `INSERT INTO project_backup_latest_attempts
        (project_id,host_id,attempt_id,outcome) VALUES ($1::UUID,$2::UUID,$3::UUID,'unconfirmed')
        ON CONFLICT (project_id) DO UPDATE SET host_id=EXCLUDED.host_id,
          attempt_id=EXCLUDED.attempt_id,started_at=clock_timestamp(),
          finished_at=NULL,outcome='unconfirmed',backup_id=NULL
        WHERE project_backup_latest_attempts.attempt_id<>EXCLUDED.attempt_id`,
        [project_id, host_id, attempt_id],
      );
    } else {
      let outcome: BackupAttemptStatus["outcome"] = "failed";
      if (backup_id !== undefined) {
        const result = await db.query(
          `SELECT receipt,receipt_sha256 FROM project_backup_outcomes
          WHERE project_id=$1::UUID AND backup_id=$2 AND host_id=$3::UUID`,
          [project_id, backup_id, host_id],
        );
        if (result.rows.length !== 1)
          throw new Error("Backup attempt has no protected completion receipt");
        const receipt = validateBackupOutcomeReceipt(
          result.rows[0].receipt,
          project_id,
        );
        if (
          receipt.producer.binding.backup_id !== backup_id ||
          backupReportHeaderSha256(receipt) !== result.rows[0].receipt_sha256
        )
          throw new Error("Backup attempt completion evidence is invalid");
        outcome = receipt.producer.outcome;
      }
      // A late failure/completion from an old job cannot change a newer attempt;
      // a duplicate terminal event cannot overwrite confirmed partial/success.
      await db.query(
        `UPDATE project_backup_latest_attempts SET outcome=$4,backup_id=$5,
        finished_at=clock_timestamp() WHERE project_id=$1::UUID AND host_id=$2::UUID
        AND attempt_id=$3::UUID AND outcome='unconfirmed'`,
        [project_id, host_id, attempt_id, outcome, backup_id ?? null],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function getHostBackupAttempt({
  host_id,
  project_id,
}: {
  host_id?: string;
  project_id: string;
}): Promise<BackupAttemptStatus | null> {
  validateIdentity(host_id, project_id);
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT a.* FROM projects p
    LEFT JOIN project_backup_latest_attempts a ON a.project_id=p.project_id
    WHERE p.project_id=$1::UUID AND p.deleted IS NOT true
    AND COALESCE(p.owning_bay_id,$2)=$2 AND p.host_id=$3::UUID`,
    [project_id, getConfiguredBayId(), host_id],
  );
  if (rows.length !== 1)
    throw new Error("Backup attempt host placement or owning bay changed");
  const row = rows[0];
  if (row.attempt_id == null) return null;
  return {
    project_id,
    attempt_id: row.attempt_id,
    outcome: row.outcome,
    backup_id: row.backup_id,
    started_at: new Date(row.started_at).toISOString(),
    finished_at:
      row.finished_at == null ? null : new Date(row.finished_at).toISOString(),
  };
}
