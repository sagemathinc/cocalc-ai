/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";
import {
  MAX_BACKUP_ACKNOWLEDGEMENTS,
  validateBackupAcknowledgementKeys,
  validateBackupAcknowledgementScope,
} from "@cocalc/util/backup-acknowledgements";
import type { BackupAcknowledgementRequest } from "@cocalc/util/backup-acknowledgements";

let schema: Promise<void> | undefined;
export async function ensureBackupAcknowledgementsSchema() {
  if (!schema)
    schema = getPool()
      .query(
        `SELECT pg_advisory_xact_lock(hashtext('backup-warning-acknowledgements-schema'));
  CREATE TABLE IF NOT EXISTS account_backup_warning_acknowledgements (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, project_id, key)
  );
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid='account_backup_warning_acknowledgements'::regclass
        AND attname='scope' AND NOT attisdropped
    ) THEN
      ALTER TABLE account_backup_warning_acknowledgements
        ADD COLUMN scope TEXT NOT NULL DEFAULT 'version'
          CHECK (scope IN ('version','path')),
        DROP CONSTRAINT account_backup_warning_acknowledgements_pkey,
        ADD PRIMARY KEY (account_id,project_id,scope,key);
    END IF;
  END $$;`,
      )
      .then(() => {})
      .catch((error) => {
        schema = undefined;
        throw error;
      });
  await schema;
}

/** Internal home-bay storage. The account-facing entry point must authenticate
 * the account and authorize project access first. An arbitrary key only changes
 * this account's preference: readers intersect with verified report identities,
 * so it cannot authorize incomplete operations. Path preferences intentionally
 * survive file replacement, metadata changes and policy changes at that path.
 */
export async function backupAcknowledgementsLocal({
  account_id,
  project_id,
  key,
  scope: requestedScope,
  remove,
}: BackupAcknowledgementRequest): Promise<string[]> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id))
    throw new Error("Invalid backup acknowledgement identity");
  if (key !== undefined) validateBackupAcknowledgementKeys([key]);
  const scope = validateBackupAcknowledgementScope(requestedScope);
  if (remove !== undefined && typeof remove !== "boolean")
    throw new Error("Invalid backup acknowledgement removal");
  if (remove && key === undefined)
    throw new Error("A key is required to remove a backup acknowledgement");
  await ensureBackupAcknowledgementsSchema();
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await assertAccountNotRehoming({
      db,
      account_id,
      action: "change backup warning preferences",
    });
    await assertAccountWriteOnHomeBay({
      db,
      account_id,
      action: "access backup warning preferences",
    });
    // Serialize per-account admission with rehome and concurrent acknowledgements.
    // A lock on an existing row also protects the initially-empty preference set.
    const { rows: accounts } = await db.query(
      `SELECT account_id FROM accounts
      WHERE account_id=$1::UUID AND deleted IS NOT true AND COALESCE(home_bay_id,$2)=$2 FOR UPDATE`,
      [account_id, getConfiguredBayId()],
    );
    if (accounts.length !== 1)
      throw new Error("Backup acknowledgement account home bay changed");
    if (remove) {
      await db.query(
        `DELETE FROM account_backup_warning_acknowledgements
         WHERE account_id=$1::UUID AND project_id=$2::UUID AND key=$3 AND scope=$4`,
        [account_id, project_id, key, scope],
      );
    } else if (key !== undefined) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::TEXT AS count,
        COALESCE(BOOL_OR(project_id=$2::UUID AND key=$3 AND scope=$4),false) AS present
        FROM account_backup_warning_acknowledgements WHERE account_id=$1::UUID`,
        [account_id, project_id, key, scope],
      );
      if (
        !rows[0]?.present &&
        BigInt(rows[0]?.count ?? MAX_BACKUP_ACKNOWLEDGEMENTS) >=
          BigInt(MAX_BACKUP_ACKNOWLEDGEMENTS)
      )
        throw new Error(
          "Backup warning acknowledgement limit reached; existing warnings remain visible",
        );
      await db.query(
        `INSERT INTO account_backup_warning_acknowledgements (account_id,project_id,key,scope)
        VALUES ($1::UUID,$2::UUID,$3,$4) ON CONFLICT DO NOTHING`,
        [account_id, project_id, key, scope],
      );
    }
    const { rows } = await db.query(
      `SELECT key FROM account_backup_warning_acknowledgements
      WHERE account_id=$1::UUID AND project_id=$2::UUID AND scope=$4 ORDER BY key LIMIT $3`,
      [account_id, project_id, MAX_BACKUP_ACKNOWLEDGEMENTS + 1, scope],
    );
    const keys = validateBackupAcknowledgementKeys(rows.map((row) => row.key));
    await db.query("COMMIT");
    return keys;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
