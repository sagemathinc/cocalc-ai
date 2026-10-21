/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Retention of personal data on deleted accounts.

A deleted account keeps its row, since projects, logs, purchases, etc. refer to
it. Deletion clears DELETED_ACCOUNT_CLEARED_FIELDS right away (see
markAccountDeleted and @cocalc/util/db-schema/deleted-account-fields, which
also lists what is kept and why), except the former email address, which is
kept for DELETED_ACCOUNT_EMAIL_RETENTION_DAYS to help with recovery requests and
abuse, then removed by this maintenance loop. The loop also clears those fields
for accounts deleted before deletion did that itself.
*/

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { DELETED_ACCOUNT_CLEARED_FIELDS } from "@cocalc/util/db-schema/deleted-account-fields";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { removeDeletedUsers } from "@cocalc/server/salesloft/sync";
import { ensureAccountRevocationsTable } from "./revocation";

const log = getLogger("server:accounts:deleted-account-retention");

export const DELETED_ACCOUNT_EMAIL_RETENTION_DAYS = 90;

export const CLEAR_DELETED_ACCOUNT_FIELDS_SQL =
  DELETED_ACCOUNT_CLEARED_FIELDS.map((field) => `${field}=NULL`).join(", ");

const HAS_UNCLEARED_FIELDS_SQL = DELETED_ACCOUNT_CLEARED_FIELDS.map(
  (field) => `${field} IS NOT NULL`,
).join(" OR ");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;

export async function purgeDeletedAccountPersonalData({
  retentionDays = DELETED_ACCOUNT_EMAIL_RETENTION_DAYS,
  batchSize = BATCH_SIZE,
}: {
  retentionDays?: number;
  batchSize?: number;
} = {}): Promise<{ cleared: number; emailsPurged: number }> {
  const pool = getPool();
  const { rowCount: cleared } = await pool.query(
    `UPDATE accounts SET ${CLEAR_DELETED_ACCOUNT_FIELDS_SQL}
      WHERE account_id IN (
        SELECT account_id FROM accounts
         WHERE deleted IS TRUE AND (${HAS_UNCLEARED_FIELDS_SQL})
         LIMIT $1)`,
    [batchSize],
  );
  // The deletion time is deleted_at, or for accounts deleted before that
  // existed, the revocation time that deletion records. Accounts with neither
  // were deleted before both existed, so are older than any retention period.
  await ensureAccountRevocationsTable();
  const { rowCount: emailsPurged } = await pool.query(
    `UPDATE accounts SET email_address_before_delete=NULL
      WHERE account_id IN (
        SELECT a.account_id FROM accounts a
          LEFT JOIN account_revocations r ON r.account_id = a.account_id
         WHERE a.deleted IS TRUE
           AND a.email_address_before_delete IS NOT NULL
           AND (COALESCE(a.deleted_at, r.revoked_before) IS NULL
                OR COALESCE(a.deleted_at, r.revoked_before)
                   < NOW() - make_interval(days => $1::INTEGER))
         LIMIT $2)`,
    [retentionDays, batchSize],
  );
  return { cleared: cleared ?? 0, emailsPurged: emailsPurged ?? 0 };
}

// Delete the Salesloft people of deleted accounts, if Salesloft is configured.
// Without an api key nothing is synced to Salesloft, and existing links are
// kept until it is configured again.
export async function purgeDeletedAccountSalesloftPeople(): Promise<{
  deleted: number;
  failed: number;
} | null> {
  const { salesloft_api_key } = await getServerSettings();
  if (!salesloft_api_key) {
    return null;
  }
  return await removeDeletedUsers();
}

let started = false;

// Started by the primary conat-api bay worker (server/conat/index.ts) and by
// single-hub deployments (hub maintenance block); it runs once per process.
// The purge is idempotent, so overlapping runs only repeat work.
export default function initDeletedAccountRetention(): void {
  if (started) return;
  started = true;
  log.info("starting deleted-account retention loop", {
    CHECK_INTERVAL_MS,
    DELETED_ACCOUNT_EMAIL_RETENTION_DAYS,
  });
  let running = false;
  const run = async () => {
    // a long Salesloft pass must not overlap the next run
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  };
  const runOnce = async () => {
    try {
      // repeat full batches, so a large backlog is cleared in one pass
      for (let i = 0; i < 100; i++) {
        const { cleared, emailsPurged } =
          await purgeDeletedAccountPersonalData();
        if (cleared > 0 || emailsPurged > 0) {
          log.info("cleared personal data of deleted accounts", {
            cleared,
            emailsPurged,
          });
        }
        if (cleared < BATCH_SIZE && emailsPurged < BATCH_SIZE) break;
      }
    } catch (err) {
      log.error("deleted-account retention failed", err);
    }
    try {
      const salesloft = await purgeDeletedAccountSalesloftPeople();
      if (
        salesloft != null &&
        (salesloft.deleted > 0 || salesloft.failed > 0)
      ) {
        log.info("deleted salesloft people of deleted accounts", salesloft);
      }
    } catch (err) {
      log.error("deleted-account salesloft purge failed", err);
    }
  };
  void run();
  setInterval(run, CHECK_INTERVAL_MS);
}
