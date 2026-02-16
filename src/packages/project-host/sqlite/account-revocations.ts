import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";

interface RevocationCursor {
  updated_ms: number;
  account_id: string;
}

function ensureTables() {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_revocations (
      account_id TEXT PRIMARY KEY,
      revoked_before_ms INTEGER NOT NULL,
      updated_ms INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_revocation_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS account_revocations_updated_idx
    ON account_revocations(updated_ms, account_id)
  `);
}

export function upsertAccountRevocation({
  account_id,
  revoked_before_ms,
  updated_ms,
}: {
  account_id: string;
  revoked_before_ms: number;
  updated_ms: number;
}) {
  if (!isValidUUID(account_id)) return;
  ensureTables();
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT revoked_before_ms, updated_ms FROM account_revocations WHERE account_id=?`,
    )
    .get(account_id) as { revoked_before_ms?: number; updated_ms?: number } | undefined;
  const nextRevokedBeforeMs = Math.max(
    Number(existing?.revoked_before_ms ?? 0) || 0,
    Math.max(0, Math.floor(revoked_before_ms || 0)),
  );
  const nextUpdatedMs = Math.max(
    Number(existing?.updated_ms ?? 0) || 0,
    Math.max(0, Math.floor(updated_ms || 0)),
  );
  db.prepare(
    `
      INSERT INTO account_revocations(account_id, revoked_before_ms, updated_ms)
      VALUES(?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        revoked_before_ms=excluded.revoked_before_ms,
        updated_ms=excluded.updated_ms
    `,
  ).run(account_id, nextRevokedBeforeMs, nextUpdatedMs);
}

export function getAccountRevokedBeforeMs(account_id: string): number | undefined {
  if (!isValidUUID(account_id)) return;
  ensureTables();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT revoked_before_ms FROM account_revocations WHERE account_id=? LIMIT 1`,
    )
    .get(account_id) as { revoked_before_ms?: number } | undefined;
  const ms = Number(row?.revoked_before_ms);
  return Number.isFinite(ms) ? ms : undefined;
}

export function getRevocationSyncCursor(): RevocationCursor | undefined {
  ensureTables();
  const db = getDatabase();
  const row = db
    .prepare(`SELECT v FROM account_revocation_meta WHERE k='cursor' LIMIT 1`)
    .get() as { v?: string } | undefined;
  if (!row?.v) return;
  try {
    const parsed = JSON.parse(row.v) as RevocationCursor;
    const updated_ms = Number(parsed?.updated_ms);
    const account_id = `${parsed?.account_id ?? ""}`;
    if (!Number.isFinite(updated_ms) || updated_ms < 0) return;
    return {
      updated_ms: Math.floor(updated_ms),
      account_id: account_id || "",
    };
  } catch {
    return;
  }
}

export function setRevocationSyncCursor(cursor: RevocationCursor) {
  ensureTables();
  const db = getDatabase();
  const next = JSON.stringify({
    updated_ms: Math.max(0, Math.floor(cursor.updated_ms || 0)),
    account_id: `${cursor.account_id ?? ""}`,
  });
  db.prepare(
    `
      INSERT INTO account_revocation_meta(k, v)
      VALUES('cursor', ?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v
    `,
  ).run(next);
}
