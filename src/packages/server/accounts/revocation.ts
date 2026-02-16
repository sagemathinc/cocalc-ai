import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

let ensured = false;

async function ensureTable() {
  if (ensured) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_revocations (
      account_id UUID PRIMARY KEY,
      revoked_before TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS account_revocations_updated_idx
    ON account_revocations(updated_at, account_id)
  `);
  ensured = true;
}

export async function recordAccountRevocation(
  account_id: string,
  revoked_before_ms = Date.now(),
): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id");
  }
  await ensureTable();
  const pool = getPool();
  const revokedBefore = new Date(revoked_before_ms);
  await pool.query(
    `
      INSERT INTO account_revocations(account_id, revoked_before, updated_at)
      VALUES($1::UUID, $2::TIMESTAMP, NOW())
      ON CONFLICT (account_id) DO UPDATE SET
        revoked_before = GREATEST(account_revocations.revoked_before, EXCLUDED.revoked_before),
        updated_at = NOW()
    `,
    [account_id, revokedBefore],
  );
}

export async function listAccountRevocationsSince({
  cursor_updated_ms = 0,
  cursor_account_id = "",
  limit = 500,
}: {
  cursor_updated_ms?: number;
  cursor_account_id?: string;
  limit?: number;
}): Promise<
  Array<{
    account_id: string;
    revoked_before_ms: number;
    updated_ms: number;
  }>
> {
  await ensureTable();
  const pool = getPool();
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(5000, Math.floor(limit)))
    : 500;
  const cursorUpdated = new Date(Math.max(0, Number(cursor_updated_ms) || 0));
  const rows = (
    await pool.query<{
      account_id: string;
      revoked_before_ms: string | number;
      updated_ms: string | number;
    }>(
      `
        SELECT
          account_id::text AS account_id,
          FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms,
          FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
        FROM account_revocations
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
    revoked_before_ms: Number(row.revoked_before_ms) || 0,
    updated_ms: Number(row.updated_ms) || 0,
  }));
}

export async function getAccountRevocationBefore(
  account_id: string,
): Promise<number | undefined> {
  if (!isValidUUID(account_id)) {
    return;
  }
  await ensureTable();
  const pool = getPool();
  const row = (
    await pool.query<{ revoked_before_ms: string | number }>(
      `
        SELECT FLOOR(EXTRACT(EPOCH FROM revoked_before) * 1000)::bigint AS revoked_before_ms
        FROM account_revocations
        WHERE account_id=$1::UUID
        LIMIT 1
      `,
      [account_id],
    )
  ).rows[0];
  const ms = Number(row?.revoked_before_ms);
  return Number.isFinite(ms) ? ms : undefined;
}
