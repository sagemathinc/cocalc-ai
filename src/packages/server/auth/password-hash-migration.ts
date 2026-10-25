/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Strengthen every legacy password and recovery-code hash, without the
secrets: replace each `sha512$...` value by scrypt over it (scrypt-wrap$v1,
see backend/auth/password-hash.ts). Users who never sign in again are then
protected too; rehash-on-login alone would leave them on the weak format.

Runs only when the password_kdf site setting is "scrypt". Each row is
replaced by compare-and-set on its exact old value, so the job is idempotent
and resumable: rerunning it, a crash halfway, or a concurrent password change
never loses a hash. Rows are visited in primary-key order (index scans), and
counts are logged so operators can watch the migration.
*/

import {
  isPasswordHash,
  wrapLegacyPasswordHash,
} from "@cocalc/backend/auth/password-hash";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getPasswordKdf } from "@cocalc/database/settings/password-kdf";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

const log = getLogger("server:auth:password-hash-migration");

const BATCH_SIZE = 100;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
// Both columns are VARCHAR(173).
const MAX_HASH_LENGTH = 173;

// Legacy values are the only ones without one of these prefixes.
const STRONG_PREFIXES = ["scrypt$", "scrypt-wrap$"];
// SQL: `column` has none of STRONG_PREFIXES, passed as parameters from $first.
function notStrong(column: string, first: number): string {
  return STRONG_PREFIXES.map(
    (_, i) => `NOT starts_with(${column}, $${i + first})`,
  ).join(" AND ");
}

export interface MigrationStats {
  wrapped: number;
  skipped: number;
  done: boolean;
  last?: string;
}

type Table = "accounts" | "recovery_codes";

async function wrapValue(stored: string): Promise<string | undefined> {
  if (!isPasswordHash(stored)) return;
  const wrapped = await wrapLegacyPasswordHash(stored);
  if (wrapped == null || wrapped.length > MAX_HASH_LENGTH) return;
  return wrapped;
}

/** Wrap one batch of legacy account password hashes after `after`. */
export async function wrapAccountPasswordHashes({
  after = "00000000-0000-0000-0000-000000000000",
  limit = BATCH_SIZE,
}: { after?: string; limit?: number } = {}): Promise<MigrationStats> {
  const { rows } = await getPool().query<{
    account_id: string;
    password_hash: string;
  }>(
    `SELECT account_id, password_hash FROM accounts
      WHERE account_id > $1::UUID AND password_hash IS NOT NULL
        AND password_hash <> ''
        AND ${notStrong("password_hash", 2)}
      ORDER BY account_id LIMIT ${Math.max(1, Math.floor(limit))}`,
    [after, ...STRONG_PREFIXES],
  );
  const stats: MigrationStats = {
    wrapped: 0,
    skipped: 0,
    done: rows.length < limit,
  };
  for (const { account_id, password_hash } of rows) {
    stats.last = account_id;
    const wrapped = await wrapValue(password_hash);
    if (wrapped == null) {
      stats.skipped += 1;
      continue;
    }
    try {
      const rowCount = await withAccountRehomeWriteFence({
        account_id,
        action: "strengthen password hash",
        fn: async (db) =>
          (
            await db.query(
              "UPDATE accounts SET password_hash=$1 WHERE account_id=$2 AND password_hash=$3",
              [wrapped, account_id, password_hash],
            )
          ).rowCount,
      });
      if ((rowCount ?? 0) > 0) stats.wrapped += 1;
      else stats.skipped += 1; // changed meanwhile: the new value wins
    } catch {
      // Not homed here, or being rehomed: its home bay wraps it.
      stats.skipped += 1;
    }
  }
  return stats;
}

/** Wrap one batch of legacy 2FA/passkey recovery-code hashes after `after`. */
export async function wrapRecoveryCodeHashes({
  after = "00000000-0000-0000-0000-000000000000",
  limit = BATCH_SIZE,
}: { after?: string; limit?: number } = {}): Promise<MigrationStats> {
  const { rows } = await getPool().query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM account_second_factor_recovery_codes
      WHERE id > $1::UUID AND used_at IS NULL AND code_hash IS NOT NULL
        AND ${notStrong("code_hash", 2)}
      ORDER BY id LIMIT ${Math.max(1, Math.floor(limit))}`,
    [after, ...STRONG_PREFIXES],
  );
  const stats: MigrationStats = {
    wrapped: 0,
    skipped: 0,
    done: rows.length < limit,
  };
  for (const { id, code_hash } of rows) {
    stats.last = id;
    const wrapped = await wrapValue(code_hash);
    if (wrapped == null) {
      stats.skipped += 1;
      continue;
    }
    const { rowCount } = await getPool().query(
      "UPDATE account_second_factor_recovery_codes SET code_hash=$1 WHERE id=$2 AND code_hash=$3",
      [wrapped, id, code_hash],
    );
    if ((rowCount ?? 0) > 0) stats.wrapped += 1;
    else stats.skipped += 1;
  }
  return stats;
}

/** Remaining legacy hashes, for the log. */
export async function countLegacyPasswordHashes(): Promise<{
  accounts: number;
  recovery_codes: number;
}> {
  const pool = getPool();
  const [accounts, codes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM accounts
        WHERE password_hash IS NOT NULL AND password_hash <> ''
          AND ${notStrong("password_hash", 1)}`,
      STRONG_PREFIXES,
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM account_second_factor_recovery_codes
        WHERE used_at IS NULL AND code_hash IS NOT NULL
          AND ${notStrong("code_hash", 1)}`,
      STRONG_PREFIXES,
    ),
  ]);
  return {
    accounts: Number(accounts.rows[0]?.count ?? 0),
    recovery_codes: Number(codes.rows[0]?.count ?? 0),
  };
}

/** One full pass over both tables, logging progress. */
export async function runPasswordHashMigrationPass(): Promise<
  Record<Table, { wrapped: number; skipped: number }>
> {
  const totals = {
    accounts: { wrapped: 0, skipped: 0 },
    recovery_codes: { wrapped: 0, skipped: 0 },
  };
  for (const [table, batch] of [
    ["accounts", wrapAccountPasswordHashes],
    ["recovery_codes", wrapRecoveryCodeHashes],
  ] as const) {
    let after: string | undefined;
    for (;;) {
      if ((await getPasswordKdf()) !== "scrypt") return totals; // switched off
      const stats = await batch({ after });
      totals[table].wrapped += stats.wrapped;
      totals[table].skipped += stats.skipped;
      if (stats.wrapped > 0) {
        log.info("strengthened legacy hashes", {
          table,
          batch: stats.wrapped,
          total: totals[table].wrapped,
        });
      }
      if (stats.done || stats.last == null) break;
      after = stats.last;
    }
  }
  return totals;
}

let started = false;

// Started with the other account maintenance loops (primary conat-api bay
// worker, single-hub deployments). It does nothing unless password_kdf is
// "scrypt", and once every hash is strong each pass is two index scans.
export function initPasswordHashMigration(): void {
  if (started) return;
  started = true;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      if ((await getPasswordKdf()) !== "scrypt") return;
      const totals = await runPasswordHashMigrationPass();
      const remaining = await countLegacyPasswordHashes();
      if (
        totals.accounts.wrapped > 0 ||
        totals.recovery_codes.wrapped > 0 ||
        remaining.accounts > 0 ||
        remaining.recovery_codes > 0
      ) {
        log.info("password hash migration pass", { totals, remaining });
      }
    } catch (err) {
      log.error("password hash migration failed", `${err}`);
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), CHECK_INTERVAL_MS);
}
