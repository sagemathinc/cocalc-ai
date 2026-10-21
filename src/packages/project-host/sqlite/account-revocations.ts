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
  const columns = db
    .prepare(`PRAGMA table_info(account_revocations)`)
    .all() as Array<{ name?: string }>;
  for (const column of [
    "content_revoked_before_ms",
    "browser_revoked_before_ms",
  ]) {
    if (columns.some((c) => c.name === column)) continue;
    try {
      db.exec(
        `ALTER TABLE account_revocations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      );
    } catch (err) {
      // Another process (the conat-router daemon) added it first.
      if (!`${err}`.includes("duplicate column")) throw err;
    }
  }
}

const nonNegative = (ms: unknown): number =>
  Math.max(0, Math.floor(Number(ms) || 0));

export function upsertAccountRevocation({
  account_id,
  revoked_before_ms,
  content_revoked_before_ms,
  browser_revoked_before_ms,
  updated_ms,
}: {
  account_id: string;
  revoked_before_ms: number;
  // Content-origin links only; never decreases.
  content_revoked_before_ms?: number;
  // Browser sessions and tokens on this host (not agents); never decreases.
  browser_revoked_before_ms?: number;
  updated_ms: number;
}) {
  if (!isValidUUID(account_id)) return;
  ensureTables();
  const db = getDatabase();
  const existing = db
    .prepare(
      `SELECT revoked_before_ms, content_revoked_before_ms, browser_revoked_before_ms, updated_ms FROM account_revocations WHERE account_id=?`,
    )
    .get(account_id) as
    | {
        revoked_before_ms?: number;
        content_revoked_before_ms?: number;
        browser_revoked_before_ms?: number;
        updated_ms?: number;
      }
    | undefined;
  const nextBrowserRevokedBeforeMs = Math.max(
    nonNegative(existing?.browser_revoked_before_ms),
    nonNegative(browser_revoked_before_ms),
  );
  const nextContentRevokedBeforeMs = Math.max(
    Number(existing?.content_revoked_before_ms ?? 0) || 0,
    Math.max(0, Math.floor(content_revoked_before_ms || 0)),
  );
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
      INSERT INTO account_revocations(account_id, revoked_before_ms, content_revoked_before_ms, browser_revoked_before_ms, updated_ms)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        revoked_before_ms=excluded.revoked_before_ms,
        content_revoked_before_ms=excluded.content_revoked_before_ms,
        browser_revoked_before_ms=excluded.browser_revoked_before_ms,
        updated_ms=excluded.updated_ms
    `,
  ).run(
    account_id,
    nextRevokedBeforeMs,
    nextContentRevokedBeforeMs,
    nextBrowserRevokedBeforeMs,
    nextUpdatedMs,
  );
}

// Credentials issued at or before this are revoked. Sign out everywhere, a ban
// or deletion revoke everything; a password change or "sign out other
// sessions" revokes browser credentials only, so an agent's own credentials
// (auth_actor "agent") carry on.
export function getAccountRevokedBeforeMs(
  account_id: string,
  { auth_actor }: { auth_actor?: string } = {},
): number | undefined {
  if (!isValidUUID(account_id)) return;
  ensureTables();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT revoked_before_ms, browser_revoked_before_ms FROM account_revocations WHERE account_id=? LIMIT 1`,
    )
    .get(account_id) as
    | { revoked_before_ms?: number; browser_revoked_before_ms?: number }
    | undefined;
  const ms = Math.max(
    nonNegative(row?.revoked_before_ms),
    auth_actor === "agent" ? 0 : nonNegative(row?.browser_revoked_before_ms),
  );
  // 0: the row only carries a content-only cutoff; sessions aren't revoked.
  return ms > 0 ? ms : undefined;
}

// Content-origin links issued at or before this were revoked: the later of
// the account's session revocation (sign out everywhere, ban, deletion) and
// its content-only one (password change, "sign out other sessions").
export function getAccountContentRevokedBeforeMs(
  account_id: string,
): number | undefined {
  if (!isValidUUID(account_id)) return;
  ensureTables();
  const row = getDatabase()
    .prepare(
      `SELECT revoked_before_ms, content_revoked_before_ms, browser_revoked_before_ms FROM account_revocations WHERE account_id=? LIMIT 1`,
    )
    .get(account_id) as
    | {
        revoked_before_ms?: number;
        content_revoked_before_ms?: number;
        browser_revoked_before_ms?: number;
      }
    | undefined;
  if (row == null) return;
  const ms = Math.max(
    nonNegative(row.revoked_before_ms),
    nonNegative(row.content_revoked_before_ms),
    nonNegative(row.browser_revoked_before_ms),
  );
  return ms > 0 ? ms : undefined;
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
