/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("server:accounts:security-state");

const DEFAULT_SYNC_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.COCALC_ACCOUNT_SECURITY_STATE_SYNC_MS) || 2000,
);

let ensured = false;
let syncRunning = false;
let syncCursor = { updated_ms: 0, account_id: "" };
let stopSyncLoop: (() => void) | undefined;
let initialSyncPromise: Promise<void> | undefined;

type AccountSecurityState = {
  banned: boolean;
  revoked_before_ms?: number;
  updated_ms: number;
};

const accountSecurityState = new Map<string, AccountSecurityState>();

async function ensureTable(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_security_state (
      account_id UUID PRIMARY KEY,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_before TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS account_security_state_updated_idx
    ON account_security_state(updated_at, account_id)
  `);
  // Seed the stream from durable account state so old bans/deletions are
  // visible to new hub API processes without per-request account table reads.
  await pool.query(`
    INSERT INTO account_security_state(account_id, banned, updated_at)
    SELECT account_id, TRUE, NOW()
      FROM accounts
     WHERE COALESCE(banned, FALSE) IS TRUE
        OR COALESCE(deleted, FALSE) IS TRUE
    ON CONFLICT (account_id) DO UPDATE SET
      banned = TRUE,
      updated_at = GREATEST(account_security_state.updated_at, EXCLUDED.updated_at)
  `);
  ensured = true;
}

export async function recordAccountSecurityState({
  account_id,
  banned,
  revoked_before_ms,
}: {
  account_id: string;
  banned?: boolean;
  revoked_before_ms?: number;
}): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  await ensureTable();
  const revokedBefore =
    revoked_before_ms != null ? new Date(revoked_before_ms) : null;
  const pool = getPool();
  const row = (
    await pool.query<{
      banned: boolean;
      revoked_before_ms: string | number | null;
      updated_ms: string | number;
    }>(
      `
        INSERT INTO account_security_state(
          account_id,
          banned,
          revoked_before,
          updated_at
        )
        VALUES(
          $1::UUID,
          COALESCE($2::BOOLEAN, FALSE),
          $3::TIMESTAMP,
          NOW()
        )
        ON CONFLICT (account_id) DO UPDATE SET
          banned = COALESCE($2::BOOLEAN, account_security_state.banned),
          revoked_before =
            CASE
              WHEN $3::TIMESTAMP IS NULL THEN account_security_state.revoked_before
              WHEN account_security_state.revoked_before IS NULL THEN $3::TIMESTAMP
              ELSE GREATEST(account_security_state.revoked_before, $3::TIMESTAMP)
            END,
          updated_at = NOW()
        RETURNING
          banned,
          FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
      `,
      [account_id, banned ?? null, revokedBefore],
    )
  ).rows[0];
  upsertAccountSecurityStateCache({
    account_id,
    banned: !!row?.banned,
    revoked_before_ms:
      row?.revoked_before_ms == null
        ? undefined
        : Number(row.revoked_before_ms) || undefined,
    updated_ms: Number(row?.updated_ms) || Date.now(),
  });
}

export async function listAccountSecurityStatesSince({
  cursor_updated_ms = 0,
  cursor_account_id = "",
  limit = 5000,
}: {
  cursor_updated_ms?: number;
  cursor_account_id?: string;
  limit?: number;
}): Promise<
  Array<{
    account_id: string;
    banned: boolean;
    revoked_before_ms?: number;
    updated_ms: number;
  }>
> {
  await ensureTable();
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(50_000, Math.floor(limit)))
    : 5000;
  const cursorUpdated = new Date(Math.max(0, Number(cursor_updated_ms) || 0));
  const rows = (
    await getPool().query<{
      account_id: string;
      banned: boolean;
      revoked_before_ms: string | number | null;
      updated_ms: string | number;
    }>(
      `
        SELECT
          account_id::text AS account_id,
          banned,
          FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
        FROM account_security_state
        WHERE
          (updated_at > $1::TIMESTAMP)
          OR (updated_at = $1::TIMESTAMP AND account_id::text > $2::text)
        ORDER BY updated_at ASC, account_id ASC
        LIMIT $3
      `,
      [cursorUpdated, cursor_account_id || "", n],
    )
  ).rows;
  return rows.map((row) => ({
    account_id: row.account_id,
    banned: !!row.banned,
    revoked_before_ms:
      row.revoked_before_ms == null
        ? undefined
        : Number(row.revoked_before_ms) || undefined,
    updated_ms: Number(row.updated_ms) || 0,
  }));
}

export function upsertAccountSecurityStateCache({
  account_id,
  banned,
  revoked_before_ms,
  updated_ms,
}: {
  account_id: string;
  banned: boolean;
  revoked_before_ms?: number;
  updated_ms: number;
}): void {
  if (!isValidUUID(account_id)) return;
  accountSecurityState.set(account_id, {
    banned,
    revoked_before_ms,
    updated_ms: Math.max(0, Math.floor(updated_ms || 0)),
  });
}

export function isAccountBannedCached(account_id: string | undefined): boolean {
  if (!account_id || !isValidUUID(account_id)) {
    return false;
  }
  return accountSecurityState.get(account_id)?.banned === true;
}

export function getAccountRevokedBeforeCached(
  account_id: string | undefined,
): number | undefined {
  if (!account_id || !isValidUUID(account_id)) {
    return;
  }
  return accountSecurityState.get(account_id)?.revoked_before_ms;
}

export function clearAccountSecurityStateCache(): void {
  accountSecurityState.clear();
  syncCursor = { updated_ms: 0, account_id: "" };
  initialSyncPromise = undefined;
  ensured = false;
}

export async function syncAccountSecurityStateOnce({
  limit = 5000,
  maxPages = 20,
}: {
  limit?: number;
  maxPages?: number;
} = {}): Promise<number> {
  if (syncRunning) return 0;
  syncRunning = true;
  let count = 0;
  try {
    for (let i = 0; i < Math.max(1, maxPages); i += 1) {
      const rows = await listAccountSecurityStatesSince({
        cursor_updated_ms: syncCursor.updated_ms,
        cursor_account_id: syncCursor.account_id,
        limit,
      });
      if (!rows.length) {
        return count;
      }
      for (const row of rows) {
        upsertAccountSecurityStateCache(row);
      }
      const last = rows[rows.length - 1];
      syncCursor = {
        updated_ms: last.updated_ms,
        account_id: last.account_id,
      };
      count += rows.length;
      if (rows.length < limit) {
        return count;
      }
    }
    return count;
  } finally {
    syncRunning = false;
  }
}

export async function ensureAccountSecurityStateReady(): Promise<void> {
  if (syncCursor.updated_ms > 0 || initialSyncPromise) {
    return await initialSyncPromise;
  }
  initialSyncPromise = syncAccountSecurityStateOnce({ maxPages: 1000 })
    .then(() => undefined)
    .catch((err) => {
      initialSyncPromise = undefined;
      throw err;
    });
  await initialSyncPromise;
}

export function startAccountSecurityStateSyncLoop({
  interval_ms = DEFAULT_SYNC_INTERVAL_MS,
}: {
  interval_ms?: number;
} = {}): () => void {
  if (stopSyncLoop) {
    return stopSyncLoop;
  }
  const sync = () => {
    void syncAccountSecurityStateOnce().catch((err) => {
      logger.debug("account security state sync failed", { err });
    });
  };
  sync();
  const timer = setInterval(sync, Math.max(1000, Math.floor(interval_ms)));
  timer.unref();
  stopSyncLoop = () => {
    clearInterval(timer);
    stopSyncLoop = undefined;
  };
  return stopSyncLoop;
}
