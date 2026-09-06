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
} from "@cocalc/util/backup-acknowledgements";
import type { BackupAcknowledgementRequest } from "@cocalc/util/backup-acknowledgements";

let schema: Promise<void> | undefined;
export async function ensureBackupAcknowledgementsSchema() {
  if (!schema)
    schema = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS account_backup_warning_acknowledgements (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, project_id, key)
  )`,
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
 * so it cannot hide unknown-version entries or authorize incomplete operations.
 */
export async function backupAcknowledgementsLocal({
  account_id,
  project_id,
  key,
}: BackupAcknowledgementRequest): Promise<string[]> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id))
    throw new Error("Invalid backup acknowledgement identity");
  if (key !== undefined) validateBackupAcknowledgementKeys([key]);
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
    if (key !== undefined) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::TEXT AS count,
        COALESCE(BOOL_OR(project_id=$2::UUID AND key=$3),false) AS present
        FROM account_backup_warning_acknowledgements WHERE account_id=$1::UUID`,
        [account_id, project_id, key],
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
        `INSERT INTO account_backup_warning_acknowledgements (account_id,project_id,key)
        VALUES ($1::UUID,$2::UUID,$3) ON CONFLICT DO NOTHING`,
        [account_id, project_id, key],
      );
    }
    const { rows } = await db.query(
      `SELECT key FROM account_backup_warning_acknowledgements
      WHERE account_id=$1::UUID AND project_id=$2::UUID ORDER BY key LIMIT $3`,
      [account_id, project_id, MAX_BACKUP_ACKNOWLEDGEMENTS + 1],
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
